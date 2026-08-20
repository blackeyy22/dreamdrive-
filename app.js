// DreamSync Client - Production Archive Manager

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let projects = [];
let activeProject = null;
let currentPath = '00_INBOX';
let selected = new Set();
let moveTarget = null;
let marquee = null;
let searchTimer = null;
let lastJob = null;
let viewMode = 'grid';
let undoAvailable = false;
let geminiConfigured = false;
let suppressCardClick = false;
const HISTORY_CLEARED_KEY = 'dreamsync.historyClearedAt';
const LAST_UPLOAD_KEY = 'dreamsync.lastUpload';

// API Helper
async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(opts.headers || {})
    }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}

// Utilities
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window._toast);
  window._toast = setTimeout(() => el.classList.remove('show'), 3000);
}

function toastUndo(msg, onUndo) {
  const el = $('#toast');
  el.innerHTML = esc(msg) + ' <button class="toast-undo" id="toastUndoBtn">Undo</button>';
  el.classList.add('show');
  clearTimeout(window._toast);
  const btn = $('#toastUndoBtn');
  if (btn && onUndo) btn.onclick = () => { onUndo(); el.classList.remove('show'); };
  window._toast = setTimeout(() => el.classList.remove('show'), 6000);
}

function fmtSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (x < 10 && i ? x.toFixed(1) : Math.round(x)) + ' ' + u[i];
}

function fmtTime(x) {
  if (!x) return '';
  return new Date(x).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function icon(type) {
  return ({ video: '\u25B6', image: '\u25EB', audio: '\u266A', document: '\u25A4', text: '\u2261', design: '\u2726', folder: '\u25B8', other: '\u2022' })[type] || '\u2022';
}

function pathLast(p) { return p.split('/').filter(Boolean).pop() || ''; }
function pathDir(p) { const a = p.split('/'); a.pop(); return a.join('/') || ''; }

// Projects
async function loadProjects() {
  const d = await api('/api/projects');
  projects = d.projects;
  activeProject = d.activeProject || projects[0]?.id;
  const sel = $('#projectSelect');
  sel.innerHTML = projects.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
  if (activeProject) sel.value = activeProject;
  await refreshAll();
}

async function switchProject(id) {
  activeProject = id;
  currentPath = '00_INBOX';
  selected.clear();
  await refreshAll();
}

async function createProject() {
  const name = $('#projectName').value.trim();
  if (!name) return;
  try {
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
    closeModal('projectModal');
    $('#projectName').value = '';
    activeProject = p.id;
    currentPath = '00_INBOX';
    await loadProjects();
    toast('Project created');
  } catch (e) { toast(e.message); }
}

function requestDeleteProject() {
  if (!activeProject) return toast('There is no production to delete');
  const project = projects.find(p => p.id === activeProject);
  $('#deleteProjectMessage').textContent = 'Delete "' + (project?.name || 'this production') + '" and all files inside it? This cannot be undone.';
  openModal('deleteProjectModal');
}

async function deleteProject() {
  if (!activeProject) return;
  try {
    await api('/api/projects/' + encodeURIComponent(activeProject), { method: 'DELETE' });
    closeModal('deleteProjectModal');
    selected.clear();
    toast('Production deleted');
    await loadProjects();
  } catch (e) { toast(e.message); }
}

// Tree Navigation
async function loadTree() {
  if (!activeProject) return;
  try {
    const d = await api('/api/vault/' + activeProject + '/tree');
    const roots = d.items.filter(x => x.isFolder || x.path.startsWith('01_'));
    $('#treeNav').innerHTML = '<div class="tree">' + roots.map(treeNode).join('') + '</div>';
    $$('#treeNav button').forEach(b => b.classList.toggle('active', b.dataset.path === currentPath));
  } catch {}
}

function treeNode(n) {
  const count = n.inside?.files ?? '';
  const depth = (n.path.match(/\//g) || []).length;
  const indent = Math.min(depth, 4) * 12;
  return '<button data-path="' + esc(n.path) + '" style="padding-left:' + (10 + indent) + 'px">' +
    '<span class="folder-icon">' + icon('folder') + '</span>' +
    '<span class="folder-name">' + esc(n.name) + '</span>' +
    '<span class="folder-count">' + count + '</span></button>';
}

// Browse / Grid
async function openPath(p) {
  currentPath = p || '';
  if (!activeProject) return;
  try {
    const d = await api('/api/vault/' + activeProject + '/browse?path=' + encodeURIComponent(currentPath));
    $('#locationLabel').textContent = currentPath || 'ROOT';
    $('#crumbTitle').textContent = pathLast(currentPath) || 'VAULT';
    $('#crumbPath').textContent = currentPath === '00_INBOX'
      ? 'Everything uploaded is visible here before AI moves it.'
      : 'Inside ' + currentPath;
    renderGrid(d.items);
  } catch (e) { toast(e.message); }
}

async function refreshAll() {
  if (!activeProject) return;
  await loadTree();
  await openPath(currentPath);
  await refreshInbox();
  await loadPersistentHistory();
  await pollJob(true);
}

// Grid Rendering
function renderGrid(items) {
  selected.clear();
  updateSelection();
  const grid = $('#grid');
  grid.classList.toggle('list-mode', viewMode === 'list');

  if (!items.length) {
    grid.innerHTML = '<div class="empty">' +
      '<div class="empty-icon">\u2726</div>' +
      '<strong>Nothing here yet</strong>' +
      '<span>Drop files or a folder above to start the ingest.</span></div>';
    return;
  }

  grid.innerHTML = '<div class="grid-inner">' + items.map(renderCard).join('') + '</div>';
  wireCards();
}

function thumbFor(i) {
  if (i.isFolder) return '<div class="thumb folder-thumb">' + icon('folder') + '</div>';
  const base = '/api/vault/' + activeProject + '/preview/';
  if (i.type === 'image') {
    return '<div class="thumb"><img src="' + base + encodeURIComponent(i.path).replace(/%2F/g, '/') + '" loading="lazy" alt=""></div>';
  }
  if (i.type === 'video') {
    return '<div class="thumb"><video preload="metadata" src="' + base + encodeURIComponent(i.path).replace(/%2F/g, '/') + '"></video></div>';
  }
  return '<div class="thumb">' + icon(i.type) + '</div>';
}

function renderCard(i) {
  const ai = i.ai ? 'ai' : 'manual';
  const move = i.destination || '';
  const extra = i.inside ? i.inside.files + ' files \u00B7 ' + i.inside.media + ' media' : fmtSize(i.size);
  const summary = i.ai?.content_summary || i.ai?.reason || '';
  const tags = (i.tags || []).map(t => '<span class="tag-chip">' + esc(t) + '</span>').join('');
  const duration = i.metadata?.durationSec ? '<span class="meta-duration">' + fmtDuration(i.metadata.durationSec) + '</span>' : '';
  const res = i.metadata?.resolution ? '<span>' + esc(i.metadata.resolution) + '</span>' : '';
  const fps = i.metadata?.fps ? '<span>' + esc(i.metadata.fps) + ' fps</span>' : '';

  return '<article class="card" data-path="' + esc(i.path) + '" data-folder="' + i.isFolder + '">' +
    (i.isFolder ? '' : '<span class="badge ' + ai + '">' + (i.ai ? 'AI' : 'LOCAL') + '</span>') +
    thumbFor(i) + duration +
    '<div class="card-body">' +
    '<div class="card-name">' + esc(i.name) + '</div>' +
    '<div class="card-meta"><span>' + esc(i.type) + '</span><span>' + extra + '</span></div>' +
    (move ? '<div class="card-path">\u2192 ' + esc(move) + '</div>' : '<div class="card-path">' + esc(i.path) + '</div>') +
    (res || fps ? '<div class="card-meta">' + res + fps + '</div>' : '') +
    (tags ? '<div class="card-tags">' + tags + '</div>' : '') +
    (summary ? '<div class="card-summary">' + esc(summary) + '</div>' : '') +
    '</div></article>';
}

function wireCards() {
  $$('.card').forEach(c => {
    c.addEventListener('click', e => {
      if (suppressCardClick) {
        suppressCardClick = false;
        return;
      }
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        toggleSelect(c.dataset.path);
      } else if (c.dataset.folder === 'true') {
        openPath(c.dataset.path);
      } else {
        toggleSelect(c.dataset.path);
      }
    });
    c.addEventListener('dblclick', () => {
      if (c.dataset.folder === 'true') openPath(c.dataset.path);
      else preview(c.dataset.path);
    });
  });
}

// Selection
function toggleSelect(p) {
  if (selected.has(p)) selected.delete(p);
  else selected.add(p);
  $$('.card').forEach(c => c.classList.toggle('selected', selected.has(c.dataset.path)));
  updateSelection();
}

function updateSelection() {
  const info = $('#selectionInfo');
  if (selected.size) {
    info.textContent = selected.size + ' selected \u2014 choose Move, Download, Tag or Delete.';
  } else {
    info.textContent = 'Click a file or drag a rectangle across cards.';
  }
  ['moveSelected', 'downloadSelected', 'deleteSelected', 'tagSelected'].forEach(id => {
    const el = $('#' + id);
    if (el) el.disabled = !selected.size;
  });
}

// Preview
async function preview(rel) {
  const ext = rel.toLowerCase();
  const url = '/api/vault/' + activeProject + '/preview/' + encodeURIComponent(rel).replace(/%2F/g, '/');
  let html = '';
  if (/\.(mp4|mov|m4v|mkv|webm|mts|m2ts|mxf)$/i.test(ext)) {
    html = '<video controls autoplay style="max-width:100%;max-height:70vh" src="' + url + '"></video>';
  } else if (/\.(jpg|jpeg|png|webp|gif|heic|tif|tiff|bmp|svg)$/i.test(ext)) {
    html = '<img style="max-width:100%;max-height:70vh;object-fit:contain" src="' + url + '">';
  } else {
    window.open(url, '_blank');
    return;
  }
  const w = window.open('', '_blank');
  w.document.write('<title>' + esc(pathLast(rel)) + '</title><body style="margin:0;background:#090a0f;display:grid;place-items:center">' + html + '</body>');
  w.document.close();
}

// Upload
async function uploadFiles(files) {
  const arr = [...files];
  if (!arr.length) return;
  const rels = arr.map(f => f.webkitRelativePath || f.name);
  openUploadDrawer(arr);
  const fd = new FormData();
  arr.forEach(f => fd.append('files', f, f.name));
  fd.append('relativePaths', JSON.stringify(rels));
  try {
    const d = await xhrUpload(fd);
    showUploadDone(d.uploaded);
    setTimeout(() => startOrganizer(), 250);
    await openPath('00_INBOX');
    await refreshInbox();
  } catch (e) { showUploadError(e.message); }
}

function xhrUpload(fd) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/vault/' + activeProject + '/upload');
    x.upload.onprogress = e => {
      if (e.lengthComputable) {
        const p = e.loaded / e.total * 100;
        $('#uploadPercent').textContent = Math.round(p) + '%';
        $('#uploadBar').style.width = p + '%';
      }
    };
    x.onload = () => {
      try {
        const d = JSON.parse(x.responseText);
        if (x.status >= 200 && x.status < 300) resolve(d);
        else reject(new Error(d.error || 'Upload failed'));
      } catch { reject(new Error('Invalid upload response')); }
    };
    x.onerror = () => reject(new Error('Network error during upload'));
    x.send(fd);
  });
}

function openUploadDrawer(arr) {
  const drawer = $('#uploadDrawer');
  drawer.classList.remove('hidden');
  $('#drawerClose').disabled = true;
  $('#uploadBadge').textContent = 'UPLOADING';
  $('#uploadTitle').textContent = 'Receiving ' + arr.length + ' item' + (arr.length > 1 ? 's' : '');
  $('#uploadMessage').textContent = 'Copying safely into 00_INBOX...';
  $('#uploadList').innerHTML = arr.map(f =>
    '<div class="upload-row"><div class="upload-icon">' + icon(fileType(f.name)) +
    '</div><div><strong>' + esc(f.webkitRelativePath || f.name) +
    '</strong><small>' + fmtSize(f.size) + ' \u00B7 upload pending</small></div><span>0%</span></div>'
  ).join('');
  $('#uploadPercent').textContent = '0%';
  $('#uploadBar').style.width = '0%';
}

function showUploadDone(items) {
  $('#uploadBadge').textContent = 'RECEIVED';
  $('#uploadTitle').textContent = items.length + ' item' + (items.length > 1 ? 's' : '') + ' safely received';
  $('#uploadMessage').textContent = 'Nothing has moved yet. The AI pass starts separately.';
  $('#drawerClose').disabled = false;
  $('#uploadBar').style.width = '100%';
  $('#uploadPercent').textContent = '100%';
  localStorage.setItem(LAST_UPLOAD_KEY, JSON.stringify({
    count: items.length,
    names: items.slice(0, 5).map(item => item.originalName || item.name),
    totalSize: items.reduce((sum, item) => sum + (item.size || 0), 0),
    uploadedAt: new Date().toISOString()
  }));
  toast(items.length + ' item' + (items.length > 1 ? 's' : '') + ' uploaded to 00_INBOX');
}

function showUploadError(msg) {
  $('#uploadBadge').textContent = 'ERROR';
  $('#uploadTitle').textContent = 'Upload failed';
  $('#uploadMessage').textContent = msg;
  $('#drawerClose').disabled = false;
  toast('Upload failed: ' + msg);
}

function fileType(n) {
  const e = (n.toLowerCase().match(/\.[^.]+$/) || [''])[0];
  if (['.mp4','.mov','.m4v','.mkv','.avi','.webm','.mts','.m2ts','.mxf','.braw','.r3d'].includes(e)) return 'video';
  if (['.jpg','.jpeg','.png','.webp','.gif','.heic','.tif','.tiff','.dng','.arw','.cr2','.nef'].includes(e)) return 'image';
  if (['.wav','.mp3','.aac','.m4a','.flac','.ogg','.aiff','.aif'].includes(e)) return 'audio';
  if (['.pdf','.doc','.docx'].includes(e)) return 'document';
  return 'other';
}

// AI Organizer
async function startOrganizer() {
  if (!geminiConfigured) {
    toast('Gemini key is not connected. Add GEMINI_API_KEY to organize with AI.');
    return;
  }
  try {
    await api('/api/vault/' + activeProject + '/organize/start', { method: 'POST' });
    toast('AI organizer started');
    showAIBar(true);
    pollJob();
  } catch (e) { toast(e.message); }
}

async function pollJob(force = false) {
  if (!activeProject) return;
  try {
    const d = await api('/api/vault/' + activeProject + '/organize/status');
    lastJob = d;
    const q = d.queue || [];
    const total = d.total || q.length || 0;
    const completed = d.completed ?? q.filter(x => x.status === 'done' || x.status === 'error').length;
    const pct = total ? Math.min(100, Math.round(completed / total * 100)) : d.running ? 5 : 100;
    const cur = d.current || q.find(x => x.status === 'scanning');

    $('#jobState').className = 'status-dot ' + (d.running ? 'running' : total && completed >= total ? 'done' : 'idle');
    $('#flowAi').classList.toggle('on', !!d.running);
    $('#flowAi').classList.toggle('done', !d.running && total > 0);
    $('#flowAi span').textContent = d.running ? 'AI sorting' : total && completed >= total ? 'AI complete' : 'AI sorting';

    renderAIBar(d, pct, cur, total, completed);
    renderHistory(d);

    if (d.running) {
      setTimeout(() => pollJob(), 900);
    } else {
      if (total) showAIBar(false);
      await refreshInbox();
      await loadPersistentHistory();
      if (force || d.history?.length) await openPath(currentPath);
    }
  } catch {}
}

function showAIBar(show) { $('#aiProgress').classList.toggle('hidden', !show); }

function renderAIBar(d, pct, cur, total, completed) {
  if (!$('#aiProgress')) return;
  $('#aiProgressPercent').textContent = pct + '%';
  $('#aiProgressBar').style.width = pct + '%';
  $('#aiProgressTitle').textContent = d.running ? 'AI is organizing your archive' : 'AI organizer complete';
  $('#aiProgressFile').textContent = cur ? 'Analyzing ' + cur.name : d.running ? 'Preparing the next file...' : 'No file in queue';
  $('#aiProgressStatus').textContent = d.running ? completed + ' of ' + total + ' completed' : (completed || 0) + ' file' + ((completed || 0) === 1 ? '' : 's') + ' processed';
  $('#aiProgressDestination').textContent = cur?.destination ? '\u2192 ' + cur.destination : 'Gemini + production rules';
}

function renderHistory(d) {
  const rows = (d.history || []).slice(0, 15);
  $('#history').innerHTML = rows.length ? rows.map(r =>
    '<div class="history-item"><div class="history-row"><strong>' + esc(r.name || r.originalName) + '</strong>' +
    '<button class="ghost btn-sm history-location" data-history-path="' + esc(r.destination || pathDir(r.path || '00_INBOX')) + '">Location</button></div><small>' +
    (r.status === 'organized' ? 'Moved to ' + esc(r.destination || 'archive') : 'Error: ' + esc(r.error || 'unknown')) +
    ' \u00B7 ' + fmtTime(r.organizedAt || r.receivedAt) + '</small></div>'
  ).join('') : '<div class="selection-info">No AI moves yet.</div>';
}

async function loadPersistentHistory() {
  if (!activeProject) return;
  try {
    const d = await api('/api/vault/' + activeProject + '/history');
    const clearedAt = Number(localStorage.getItem(HISTORY_CLEARED_KEY) || 0);
    const items = d.items.filter(r => new Date(r.organizedAt || r.receivedAt).getTime() > clearedAt);
    $('#history').innerHTML = items.length ? items.slice(0, 15).map(r =>
      '<div class="history-item"><div class="history-row"><strong>' + esc(r.originalName || r.name) + '</strong>' +
      '<button class="ghost btn-sm history-location" data-history-path="' + esc(r.destination || pathDir(r.path || '00_INBOX')) + '">Location</button></div><small>' +
      (r.destination ? 'Moved to ' + esc(r.destination) : 'Received in ' + esc(r.path || 'inbox')) +
      ' \u00B7 ' + fmtTime(r.organizedAt || r.receivedAt) +
      (r.manual ? ' \u00B7 manual override' : '') + '</small></div>'
    ).join('') : '<div class="selection-info">No moves recorded yet.</div>';
  } catch {}
}

// Inbox
async function refreshInbox() {
  if (!activeProject) return;
  try {
    const d = await api('/api/vault/' + activeProject + '/browse?path=00_INBOX');
    const n = d.items.reduce((a, x) => a + (x.isFolder ? (x.inside?.files || 0) : 1), 0);
    $('#inboxCount').textContent = n;
  } catch {}
}

// Search
async function smartSearch(q) {
  if (!q.trim()) {
    $('#smartResults').classList.add('hidden');
    await openPath(currentPath);
    return;
  }
  try {
    const d = await api('/api/vault/' + activeProject + '/search', {
      method: 'POST', body: JSON.stringify({ query: q })
    });
    $('#smartResults').classList.remove('hidden');
    $('#smartResults').innerHTML = '<h3>SEARCH RESULTS \u00B7 ' + d.results.length + ' matches</h3>' +
      (d.results.length
        ? d.results.slice(0, 30).map(r =>
          '<div class="result-row"><span>' + icon(r.isFolder ? 'folder' : r.type) + '</span>' +
          '<div class="result-info"><strong>' + esc(r.name) + '</strong><small>' + esc(r.path) +
          (r.content_summary ? ' \u00B7 ' + esc(r.content_summary) : '') + '</small></div>' +
          '<button class="ghost btn-sm" data-result="' + esc(r.path) + '">Open</button></div>'
        ).join('')
        : '<div class="selection-info">No content matched "' + esc(q) + '".</div>');
    $$('[data-result]').forEach(b => b.onclick = () => openPath(pathDir(b.dataset.result)));
  } catch {}
}

// Tags
async function tagSelectedItems() {
  if (!selected.size) return;
  const tag = prompt('Enter tag for ' + selected.size + ' item(s):');
  if (!tag || !tag.trim()) return;
  try {
    await api('/api/vault/' + activeProject + '/batch/tag', {
      method: 'POST',
      body: JSON.stringify({ files: [...selected], tag: tag.trim() })
    });
    toast('Tagged with "' + tag.trim() + '"');
    await openPath(currentPath);
  } catch (e) { toast(e.message); }
}

// Undo
async function undoLastMove() {
  try {
    const d = await api('/api/vault/' + activeProject + '/undo', { method: 'POST' });
    toast('Restored: ' + d.restored);
    await refreshAll();
  } catch (e) { toast('Cannot undo: ' + e.message); }
}

// File Operations
async function moveSelectedItems() {
  if (!selected.size || !moveTarget) return toast('Choose a destination folder');
  try {
    await api('/api/vault/' + activeProject + '/batch/move', {
      method: 'POST',
      body: JSON.stringify({ files: [...selected], destPath: moveTarget })
    });
    closeModal('moveModal');
    toast(selected.size + ' item(s) moved');
    selected.clear();
    await refreshAll();
  } catch (e) { toast(e.message); }
}

async function deleteSelectedItems() {
  if (!selected.size) return;
  if (!confirm('Delete ' + selected.size + ' item(s)? This cannot be undone.')) return;
  try {
    await api('/api/vault/' + activeProject + '/batch/delete', {
      method: 'POST',
      body: JSON.stringify({ files: [...selected] })
    });
    selected.clear();
    toast('Deleted');
    await refreshAll();
  } catch (e) { toast(e.message); }
}

async function downloadSelectedItems() {
  selected.forEach(p =>
    window.open('/api/vault/' + activeProject + '/download/' + encodeURIComponent(p).replace(/%2F/g, '/'), '_blank')
  );
}

// Folder / Modal
async function createFolder() {
  const name = $('#folderName').value.trim();
  if (!name) return;
  try {
    await api('/api/vault/' + activeProject + '/folder', {
      method: 'POST', body: JSON.stringify({ path: currentPath, name })
    });
    $('#folderName').value = '';
    closeModal('folderModal');
    toast('Folder created');
    await openPath(currentPath);
    await loadTree();
  } catch (e) { toast(e.message); }
}

function openModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModal(id) { $('#' + id).classList.add('hidden'); }

async function openMoveModal() {
  const d = await api('/api/vault/' + activeProject + '/tree');
  $('#moveTree').innerHTML = buildMoveTree(d.items);
  openModal('moveModal');
  moveTarget = null;
  $$('.move-node').forEach(n => n.onclick = () => {
    $$('.move-node').forEach(x => x.classList.remove('active'));
    n.classList.add('active');
    moveTarget = n.dataset.path;
  });
}

function buildMoveTree(items) {
  return items.filter(x => x.isFolder).map(x =>
    '<div class="move-node" data-path="' + esc(x.path) + '">' +
    icon('folder') + ' ' + esc(x.name) +
    ' <span class="move-count">' + (x.inside?.files ?? 0) + '</span></div>'
  ).join('');
}

// Marquee Selection
function installMarquee() {
  const area = $('#grid');
  let start = null;
  area.addEventListener('pointerdown', e => {
    if (e.target.closest('button') || e.target.closest('img') || e.target.closest('video')) return;
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
      selected.clear();
      updateSelection();
      $$('.card').forEach(c => c.classList.remove('selected'));
    }
    start = { x: e.clientX, y: e.clientY };
    suppressCardClick = false;
    marquee = document.createElement('div');
    marquee.className = 'marquee';
    document.body.appendChild(marquee);
    const move = ev => {
      if (!start) return;
      if (Math.abs(ev.clientX - start.x) > 4 || Math.abs(ev.clientY - start.y) > 4) suppressCardClick = true;
      const x = Math.min(start.x, ev.clientX), y = Math.min(start.y, ev.clientY);
      const w = Math.abs(ev.clientX - start.x), h = Math.abs(ev.clientY - start.y);
      Object.assign(marquee.style, { left: x+'px', top: y+'px', width: w+'px', height: h+'px' });
      const r = { left: x, right: x+w, top: y, bottom: y+h };
      $$('.card').forEach(c => {
        const b = c.getBoundingClientRect();
        if (b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) selected.add(c.dataset.path);
        c.classList.toggle('selected', selected.has(c.dataset.path));
      });
      updateSelection();
    };
    const up = () => {
      start = null;
      if (marquee) { marquee.remove(); marquee = null; }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

async function clearHistory() {
  localStorage.setItem(HISTORY_CLEARED_KEY, String(Date.now()));
  await loadPersistentHistory();
}

function showVisitUploadSummary() {
  const raw = localStorage.getItem(LAST_UPLOAD_KEY);
  if (!raw) return;
  try {
    const upload = JSON.parse(raw);
    const names = upload.names?.join(', ');
    $('#visitSummaryMessage').textContent = upload.count + ' file' + (upload.count === 1 ? '' : 's') +
      ' uploaded on ' + fmtTime(upload.uploadedAt) + (names ? ': ' + names : '.') +
      (upload.count > 5 ? ' and more.' : '.');
    openModal('visitSummaryModal');
  } catch { localStorage.removeItem(LAST_UPLOAD_KEY); }
}

// Keyboard Shortcuts
function installKeyboard() {
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#searchInput').focus();
    }
    if (e.key === 'Escape') {
      ['moveModal', 'folderModal', 'projectModal', 'deleteProjectModal', 'visitSummaryModal'].forEach(closeModal);
      $('#smartResults').classList.add('hidden');
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (selected.size === 0) { e.preventDefault(); undoLastMove(); }
    }
  });
}

// Drag & Drop File Walking
async function getDroppedFiles(dt) {
  const out = [];
  const items = [...dt.items].filter(i => i.kind === 'file');
  async function walk(entry, prefix) {
    if (entry.isFile) {
      await new Promise(resolve => entry.file(file => {
        try { Object.defineProperty(file, 'webkitRelativePath', { value: prefix + file.name }); } catch {}
        out.push(file);
        resolve();
      }));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      await new Promise(resolve => reader.readEntries(async entries => {
        for (const child of entries) await walk(child, prefix + entry.name + '/');
        resolve();
      }));
    }
  }
  for (const it of items) {
    const entry = it.webkitGetAsEntry?.();
    if (entry) await walk(entry, '');
    else { const f = it.getAsFile(); if (f) out.push(f); }
  }
  return out.length ? out : [...dt.files];
}

// Init
async function init() {
  $('#projectSelect').onchange = e => switchProject(e.target.value);
  $('#uploadBtn').onclick = () => $('#fileInput').click();
  $('#chooseFiles').onclick = () => $('#fileInput').click();
  $('#chooseFolder').onclick = () => $('#folderInput').click();
  $('#fileInput').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };
  $('#folderInput').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };

  const dz = $('#dropZone');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('hot'); }));
  dz.addEventListener('drop', async e => { const files = await getDroppedFiles(e.dataTransfer); uploadFiles(files); });

  $('#upBtn').onclick = () => openPath(pathDir(currentPath));
  $('#refreshBtn').onclick = refreshAll;
  $('#organizeBtn').onclick = startOrganizer;
  $('#drawerClose').onclick = () => $('#uploadDrawer').classList.add('hidden');
  $('#undoBtn').onclick = undoLastMove;
  $('#newFolderBtn').onclick = () => openModal('folderModal');
  $('#folderConfirm').onclick = createFolder;
  $('#newProjectBtn').onclick = () => openModal('projectModal');
  $('#projectConfirm').onclick = createProject;
  $('#deleteProjectBtn').onclick = requestDeleteProject;
  $('#deleteProjectConfirm').onclick = deleteProject;
  $('#clearHistoryBtn').onclick = clearHistory;
  $('#visitSummaryCancel').onclick = () => { localStorage.removeItem(LAST_UPLOAD_KEY); closeModal('visitSummaryModal'); };
  $('#visitSummaryOpen').onclick = () => { localStorage.removeItem(LAST_UPLOAD_KEY); closeModal('visitSummaryModal'); openPath('00_INBOX'); };

  $('#moveSelected').onclick = openMoveModal;
  $('#moveConfirm').onclick = moveSelectedItems;
  $('#deleteSelected').onclick = deleteSelectedItems;
  $('#downloadSelected').onclick = downloadSelectedItems;
  $('#tagSelected').onclick = tagSelectedItems;

  document.addEventListener('click', e => {
    const pathBtn = e.target.closest('[data-path]');
    if (pathBtn && pathBtn.closest('#treeNav')) openPath(pathBtn.dataset.path);
    const close = e.target.closest('[data-close]');
    if (close) closeModal(close.dataset.close);
    const location = e.target.closest('[data-history-path]');
    if (location) openPath(location.dataset.historyPath);
  });

  $('#searchInput').oninput = e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => smartSearch(e.target.value), 260);
  };

  $$('.view').forEach(b => b.onclick = () => {
    viewMode = b.dataset.view;
    $$('.view').forEach(x => x.classList.toggle('active', x === b));
    openPath(currentPath);
  });

  installKeyboard();
  installMarquee();

  try {
    const h = await api('/api/ai/health');
    geminiConfigured = h.configured;
    const b = $('#aiBadge');
    b.textContent = h.configured ? 'GEMINI \u00B7 ' + h.model : 'GEMINI KEY MISSING';
    b.classList.toggle('online', h.configured);
    b.classList.toggle('offline', !h.configured);
    $('#organizeBtn').disabled = !h.configured;
    $('#organizeBtn').title = h.configured ? 'Organize with Gemini AI' : 'Connect GEMINI_API_KEY to enable AI organizing';
  } catch {}

  await loadProjects();
  showVisitUploadSummary();
}

init().catch(e => { console.error(e); toast(e.message); });
