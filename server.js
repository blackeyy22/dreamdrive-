const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ENV_FILE = path.join(__dirname, '.env');
try {
  const content = fsSync.readFileSync(ENV_FILE, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch {}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const VAULT_ROOT = path.join(__dirname, 'vault');
const PROJECTS_FILE = path.join(__dirname, 'projects.json');
const INBOX = '00_INBOX';
const INDEX_NAME = '.dreamsync-index.json';
const UNDO_FILE = '.dreamsync-undo.json';

const ARCHIVE_FOLDERS = [
  '01_MEDIA/CAMERA',
  '01_MEDIA/STILLS',
  '01_MEDIA/PROXIES',
  '02_AUDIO',
  '03_STORY',
  '04_STORYBOARD',
  '05_ART_DIRECTION',
  '06_ARCHIVE'
];

const VIDEO_EXTS = new Set(['.mp4','.mov','.m4v','.mkv','.avi','.webm','.mpeg','.mpg','.mts','.m2ts','.mxf','.braw','.r3d','.ari']);
const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.webp','.gif','.heic','.tif','.tiff','.bmp','.svg','.dng','.arw','.cr2','.nef','.orf','.rw2']);
const AUDIO_EXTS = new Set(['.wav','.mp3','.aac','.m4a','.flac','.ogg','.aiff','.aif']);
const TEXT_EXTS = new Set(['.txt','.md','.csv','.json','.xml','.html','.htm','.srt','.vtt','.ass','.sub','.rtf','.log']);
const DOC_EXTS = new Set(['.pdf','.doc','.docx']);
const DESIGN_EXTS = new Set(['.psd','.ai','.indd','.svg','.fig','.sketch','.xd','.blend']);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

function safeSegment(v) {
  return String(v || '').replace(/[\\:*?"<>|]/g, '_').replace(/^\.+$/, '_').slice(0, 180);
}
function safeRel(rel) {
  return String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean)
    .filter(x => x !== '.' && x !== '..').map(safeSegment).join('/');
}
function projectDir(projectId) { return path.join(VAULT_ROOT, safeSegment(projectId)); }
function indexPath(projectId) { return path.join(projectDir(projectId), INDEX_NAME); }
function undoPath(projectId) { return path.join(projectDir(projectId), UNDO_FILE); }
function generateId() { return Date.now().toString(36) + crypto.randomBytes(5).toString('hex'); }

async function saveProjects(data) { await fs.writeFile(PROJECTS_FILE, JSON.stringify(data, null, 2)); }
async function loadProjects() {
  try { return JSON.parse(await fs.readFile(PROJECTS_FILE, 'utf8')); }
  catch { return { projects: {}, activeProject: null }; }
}
async function ensureFolders(projectId) {
  const dir = projectDir(projectId);
  for (const f of [INBOX, ...ARCHIVE_FOLDERS]) {
    await fs.mkdir(path.join(dir, f), { recursive: true });
  }
}
function ensureInside(projectId, rel) {
  const base = projectDir(projectId);
  const full = path.resolve(base, rel);
  if (full !== path.resolve(base) && !full.startsWith(path.resolve(base) + path.sep)) throw new Error('Invalid path');
  return full;
}
async function readIndex(projectId) {
  try { return JSON.parse(await fs.readFile(indexPath(projectId), 'utf8')); } catch { return {}; }
}
async function writeIndex(projectId, idx) { await fs.writeFile(indexPath(projectId), JSON.stringify(idx, null, 2)); }
async function readUndo(projectId) {
  try { return JSON.parse(await fs.readFile(undoPath(projectId), 'utf8')); } catch { return { moves: [] }; }
}
async function writeUndo(projectId, data) {
  data.moves = data.moves.slice(0, 50);
  await fs.writeFile(undoPath(projectId), JSON.stringify(data, null, 2));
}

function extOf(name) { return path.extname(name).toLowerCase(); }
function categoryOf(name) {
  const e = extOf(name);
  if (VIDEO_EXTS.has(e)) return 'video';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (DOC_EXTS.has(e)) return 'document';
  if (TEXT_EXTS.has(e)) return 'text';
  if (DESIGN_EXTS.has(e)) return 'design';
  return 'other';
}
function isMedia(name) { const c = categoryOf(name); return c === 'video' || c === 'image'; }
async function statSafe(file) { try { return await fs.stat(file); } catch { return null; } }
function fmtDate(d) { return d ? new Date(d).toISOString() : null; }

const summaryCache = new Map();
const CACHE_TTL = 10000;
async function directorySummary(dir, depth = 0) {
  const cached = summaryCache.get(dir);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;
  let files = 0, folders = 0, bytes = 0, media = 0;
  try {
    const entries = await fs.readdir(dir);
    for (const n of entries) {
      if (n === INDEX_NAME || n === UNDO_FILE) continue;
      const p = path.join(dir, n);
      const s = await statSafe(p);
      if (!s) continue;
      if (s.isDirectory()) {
        folders++;
        if (depth < 3) {
          const sub = await directorySummary(p, depth + 1);
          files += sub.files; folders += sub.folders; bytes += sub.bytes; media += sub.media;
        }
      } else {
        files++; bytes += s.size; if (isMedia(n)) media++;
      }
    }
  } catch {}
  const result = { files, folders, bytes, media };
  summaryCache.set(dir, { data: result, time: Date.now() });
  return result;
}
function invalidateCache(projectId) {
  const prefix = projectDir(projectId);
  for (const key of summaryCache.keys()) { if (key.startsWith(prefix)) summaryCache.delete(key); }
}

function readVideoMetadata(filePath) {
  if (!VIDEO_EXTS.has(extOf(filePath))) return null;
  try {
    const r = spawnSync('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams',filePath], { encoding:'utf8', timeout:30000, maxBuffer:5*1024*1024 });
    if (r.status !== 0 || !r.stdout) return null;
    const j = JSON.parse(r.stdout);
    const v = (j.streams || []).find(s => s.codec_type === 'video');
    const a = (j.streams || []).find(s => s.codec_type === 'audio');
    const width = Number(v?.width || 0), height = Number(v?.height || 0);
    let fps = null;
    if (v?.r_frame_rate) { const parts = String(v.r_frame_rate).split('/').map(Number); if (parts[1]) fps = +(parts[0]/parts[1]).toFixed(3); }
    const format = j.format || {};
    return {
      width, height, resolution: width && height ? width+'x'+height : null, fps,
      durationSec: format.duration ? Number(format.duration) : null,
      sizeBytes: Number(format.size || 0), format: format.format_name || null,
      codec: v?.codec_name || null, profile: v?.profile || null, pixelFormat: v?.pix_fmt || null,
      audioCodec: a?.codec_name || null, audioChannels: a?.channels || null,
      cameraMeta: Object.fromEntries(Object.entries(format.tags || {}).filter(([k]) => /camera|make|model|lens|timecode|creation|encoder/i.test(k)))
    };
  } catch { return null; }
}

async function extractText(filePath) {
  try {
    const ext = extOf(filePath);
    if (TEXT_EXTS.has(ext)) return (await fs.readFile(filePath, 'utf8')).slice(0, 40000);
    if (ext === '.pdf') {
      const r = spawnSync('pdftotext', ['-layout', filePath, '-'], { encoding:'utf8', timeout:30000, maxBuffer:2*1024*1024 });
      if (r.status === 0) return String(r.stdout || '').slice(0, 40000);
    }
  } catch {}
  return '';
}

async function fileInfo(projectId, relPath) {
  const full = ensureInside(projectId, relPath);
  const s = await statSafe(full);
  if (!s) return null;
  const isFolder = s.isDirectory();
  const idx = await readIndex(projectId);
  return {
    name: path.basename(relPath), path: relPath.replace(/\\/g,'/'), isFolder,
    type: isFolder ? 'folder' : categoryOf(relPath),
    size: s.size, modified: fmtDate(s.mtime),
    inside: isFolder ? await directorySummary(full) : undefined,
    metadata: !isFolder ? idx[relPath.replace(/\\/g,'/')] || null : undefined
  };
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = path.join(projectDir(req.params.projectId), INBOX, '.uploading');
    await fs.mkdir(dir, { recursive: true }); cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now()+'__'+crypto.randomBytes(4).toString('hex')+'__'+safeSegment(path.basename(file.originalname)))
});
const upload = multer({ storage, limits: { fileSize: 20*1024*1024*1024, files: 300 } });

const jobs = new Map();

// ─── Routes: Projects ────────────────────────────────────────────────────────

app.get('/api/projects', async (req, res) => {
  try {
    const data = await loadProjects();
    const projects = [];
    for (const [id, p] of Object.entries(data.projects)) {
      const summary = await directorySummary(projectDir(id));
      projects.push({ id, ...p, fileCount: summary.files });
    }
    res.json({ projects, activeProject: data.activeProject });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const data = await loadProjects();
    const id = generateId();
    const name = String(req.body.name || 'New Production').trim();
    data.projects[id] = { name, description: req.body.description||'', created: new Date().toISOString(), color: req.body.color||'#8b5cf6', icon: '🎬' };
    data.activeProject = id;
    await fs.mkdir(projectDir(id), { recursive: true });
    await ensureFolders(id);
    await writeIndex(id, {});
    await saveProjects(data);
    res.json({ id, ...data.projects[id] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/projects/active/:id', async (req, res) => {
  try {
    const d = await loadProjects();
    if (!d.projects[req.params.id]) return res.status(404).json({ error: 'Project not found' });
    d.activeProject = req.params.id;
    await saveProjects(d);
    res.json({ activeProject: d.activeProject });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    const d = await loadProjects();
    if (!d.projects[req.params.id]) return res.status(404).json({ error: 'Project not found' });
    const { name, description, color } = req.body;
    if (name) d.projects[req.params.id].name = name;
    if (description !== undefined) d.projects[req.params.id].description = description;
    if (color) d.projects[req.params.id].color = color;
    await saveProjects(d);
    res.json({ id: req.params.id, ...d.projects[req.params.id] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const d = await loadProjects();
    if (!d.projects[req.params.id]) return res.status(404).json({ error: 'Project not found' });
    await fs.rm(projectDir(req.params.id), { recursive: true, force: true });
    delete d.projects[req.params.id];
    d.activeProject = Object.keys(d.projects)[0] || null;
    await saveProjects(d);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Routes: Browse / Tree ──────────────────────────────────────────────────

app.get('/api/vault/:projectId/tree', async (req, res) => {
  try {
    await ensureFolders(req.params.projectId);
    res.json(await buildTree(projectDir(req.params.projectId), req.params.projectId, ''));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/vault/:projectId/browse', async (req, res) => {
  try {
    await ensureFolders(req.params.projectId);
    const rel = safeRel(req.query.path || '');
    const full = ensureInside(req.params.projectId, rel);
    if (!(await statSafe(full))) return res.status(404).json({ error: 'Path not found' });
    const entries = await fs.readdir(full);
    const items = [];
    for (const n of entries) {
      if (n === INDEX_NAME || n === UNDO_FILE || n === '.uploading') continue;
      const p = rel ? rel+'/'+n : n;
      const info = await fileInfo(req.params.projectId, p);
      if (info) items.push(info);
    }
    items.sort((a, b) => a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1);
    res.json({ path: rel, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Routes: Folder CRUD ────────────────────────────────────────────────────

app.post('/api/vault/:projectId/folder', async (req, res) => {
  try {
    await ensureFolders(req.params.projectId);
    const base = safeRel(req.body.path || '');
    const name = safeSegment(req.body.name);
    if (!name) return res.status(400).json({ error: 'Folder name required' });
    const rel = base ? base+'/'+name : name;
    const full = ensureInside(req.params.projectId, rel);
    if (await statSafe(full)) return res.status(409).json({ error: 'Folder exists' });
    await fs.mkdir(full, { recursive: true });
    invalidateCache(req.params.projectId);
    res.json({ success: true, path: rel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Routes: Upload ─────────────────────────────────────────────────────────

app.post('/api/vault/:projectId/upload', upload.array('files', 300), async (req, res) => {
  try {
    await ensureFolders(req.params.projectId);
    const projectId = req.params.projectId;
    const raws = req.files || [];
    let relativePaths = [];
    try { relativePaths = JSON.parse(req.body.relativePaths || '[]'); } catch {}
    const uploaded = [];
    const idx = await readIndex(projectId);
    for (let i = 0; i < raws.length; i++) {
      const f = raws[i];
      const rel = safeRel(relativePaths[i] || f.originalname);
      const finalRel = INBOX+'/'+rel;
      const final = ensureInside(projectId, finalRel);
      await fs.mkdir(path.dirname(final), { recursive: true });
      let target = final;
      if (await statSafe(target)) {
        const ext = path.extname(target), base = target.slice(0, -ext.length);
        target = base+' ('+Date.now()+')'+ext;
      }
      await fs.rename(f.path, target);
      const storedRel = path.relative(projectDir(projectId), target).replace(/\\/g, '/');
      const info = {
        id: generateId(), name: path.basename(storedRel), originalName: f.originalname,
        path: storedRel, status: 'received', receivedAt: new Date().toISOString(),
        size: f.size, type: categoryOf(f.originalname), previousPath: null,
        destination: null, ai: null, manual: false, tags: []
      };
      idx[storedRel] = info;
      uploaded.push(info);
    }
    await writeIndex(projectId, idx);
    invalidateCache(projectId);
    res.json({ success: true, uploaded, message: uploaded.length+' file'+(uploaded.length===1?'':'s')+' received' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Routes: Organize ───────────────────────────────────────────────────────

app.post('/api/vault/:projectId/organize/start', async (req, res) => {
  const id = req.params.projectId;
  const job = jobs.get(id);
  if (!job || !job.running) startJob(id);
  res.json({ success: true, running: true });
});

app.get('/api/vault/:projectId/organize/status', (req, res) => {
  res.json(jobs.get(req.params.projectId) || { running: false, queue: [], history: [] });
});

app.get('/api/vault/:projectId/history', async (req, res) => {
  const idx = await readIndex(req.params.projectId);
  const items = Object.values(idx)
    .filter(x => x.organizedAt || x.receivedAt)
    .sort((a, b) => new Date(b.organizedAt || b.receivedAt) - new Date(a.organizedAt || a.receivedAt));
  res.json({ items: items.slice(0, 100) });
});

// ─── Routes: AI Health ──────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

app.get('/api/ai/health', (req, res) => res.json({
  configured: Boolean(GEMINI_API_KEY), model: GEMINI_MODEL,
  provider: 'Google Gemini', videoMode: 'metadata-only'
}));

// ─── Routes: Tags ────────────────────────────────────────────────────────────

app.post('/api/vault/:projectId/tags', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const { filePath, tags } = req.body;
    const rel = safeRel(filePath);
    const idx = await readIndex(projectId);
    if (!idx[rel]) return res.status(404).json({ error: 'File not found in index' });
    idx[rel].tags = (tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean);
    await writeIndex(projectId, idx);
    res.json({ success: true, tags: idx[rel].tags });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/vault/:projectId/tags', async (req, res) => {
  try {
    const idx = await readIndex(req.params.projectId);
    const tagMap = {};
    for (const [rel, info] of Object.entries(idx)) {
      for (const t of (info.tags || [])) {
        if (!tagMap[t]) tagMap[t] = { tag: t, count: 0, files: [] };
        tagMap[t].count++;
        if (tagMap[t].files.length < 5) tagMap[t].files.push({ name: info.name, path: rel });
      }
    }
    res.json({ tags: Object.values(tagMap).sort((a, b) => b.count - a.count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Routes: Undo ────────────────────────────────────────────────────────────

app.post('/api/vault/:projectId/undo', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const undoData = await readUndo(projectId);
    if (!undoData.moves.length) return res.status(400).json({ error: 'Nothing to undo' });
    const last = undoData.moves.pop();
    const srcFull = ensureInside(projectId, last.to);
    const destDir = ensureInside(projectId, path.dirname(last.from));
    if (!(await statSafe(srcFull))) return res.status(404).json({ error: 'File no longer exists at destination' });
    await fs.mkdir(destDir, { recursive: true });
    let target = ensureInside(projectId, last.from);
    if (await statSafe(target)) {
      const ext = path.extname(target), base = target.slice(0, -ext.length);
      target = base+' (restored '+Date.now()+')'+ext;
    }
    await fs.rename(srcFull, target);
    const idx = await readIndex(projectId);
    const restoredRel = path.relative(projectDir(projectId), target).replace(/\\/g, '/');
    if (idx[last.to]) {
      idx[restoredRel] = { ...idx[last.to], path: restoredRel, previousPath: last.to, restoredAt: new Date().toISOString() };
      delete idx[last.to];
    }
    await writeIndex(projectId, idx);
    await writeUndo(projectId, undoData);
    invalidateCache(projectId);
    res.json({ success: true, restored: path.basename(restoredRel) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Routes: Batch Operations ───────────────────────────────────────────────

app.post('/api/vault/:projectId/batch/move', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const { files, destPath } = req.body;
    const dest = safeRel(destPath);
    const destFull = ensureInside(projectId, dest);
    await fs.mkdir(destFull, { recursive: true });
    const undoData = await readUndo(projectId);
    const results = [];
    for (const filePath of (files || [])) {
      try {
        const srcRel = safeRel(filePath);
        const srcFull = ensureInside(projectId, srcRel);
        if (!(await statSafe(srcFull))) { results.push({ path: srcRel, error: 'Not found' }); continue; }
        const name = path.basename(srcRel);
        let target = path.join(destFull, name);
        if (await statSafe(target)) {
          const ext = path.extname(target), base = target.slice(0, -ext.length);
          target = base+' ('+Date.now()+')'+ext;
        }
        await fs.rename(srcFull, target);
        const newRel = path.relative(projectDir(projectId), target).replace(/\\/g, '/');
        const idx = await readIndex(projectId);
        if (idx[srcRel]) {
          undoData.moves.push({ from: srcRel, to: newRel, time: new Date().toISOString() });
          idx[newRel] = { ...idx[srcRel], path: newRel, previousPath: srcRel, destination: dest, manual: true, movedAt: new Date().toISOString() };
          delete idx[srcRel];
          await writeIndex(projectId, idx);
        }
        results.push({ path: srcRel, success: true, newPath: newRel });
      } catch (e) { results.push({ path: filePath, error: e.message }); }
    }
    await writeUndo(projectId, undoData);
    invalidateCache(projectId);
    res.json({ success: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/vault/:projectId/batch/delete', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const { files } = req.body;
    const results = [];
    const idx = await readIndex(projectId);
    for (const filePath of (files || [])) {
      try {
        const rel = safeRel(filePath);
        const full = ensureInside(projectId, rel);
        if (!(await statSafe(full))) { results.push({ path: rel, error: 'Not found' }); continue; }
        await fs.rm(full, { recursive: true, force: true });
        delete idx[rel];
        results.push({ path: rel, success: true });
      } catch (e) { results.push({ path: filePath, error: e.message }); }
    }
    await writeIndex(projectId, idx);
    invalidateCache(projectId);
    res.json({ success: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/vault/:projectId/batch/tag', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const { files, tag } = req.body;
    const idx = await readIndex(projectId);
    const t = String(tag || '').trim().toLowerCase();
    if (!t) return res.status(400).json({ error: 'Tag required' });
    for (const filePath of (files || [])) {
      const rel = safeRel(filePath);
      if (idx[rel]) {
        if (!idx[rel].tags) idx[rel].tags = [];
        if (!idx[rel].tags.includes(t)) idx[rel].tags.push(t);
      }
    }
    await writeIndex(projectId, idx);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Routes: Single File Operations ─────────────────────────────────────────

app.post('/api/vault/:projectId/move', async (req, res) => {
  try {
    const id = req.params.projectId;
    const src = safeRel(req.body.sourcePath), dest = safeRel(req.body.destPath);
    const sf = ensureInside(id, src), df = ensureInside(id, dest);
    if (!(await statSafe(sf))) return res.status(404).json({ error: 'Source not found' });
    await fs.mkdir(path.dirname(df), { recursive: true });
    if (await statSafe(df)) return res.status(409).json({ error: 'Destination exists' });
    await fs.rename(sf, df);
    const undoData = await readUndo(id);
    undoData.moves.push({ from: src, to: dest, time: new Date().toISOString() });
    await writeUndo(id, undoData);
    const idx = await readIndex(id);
    if (idx[src]) {
      idx[dest] = { ...idx[src], path: dest, previousPath: src, destination: path.dirname(dest), manual: true, movedAt: new Date().toISOString() };
      delete idx[src];
      await writeIndex(id, idx);
    }
    invalidateCache(id);
    res.json({ success: true, path: dest });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/vault/:projectId/rename', async (req, res) => {
  try {
    const id = req.params.projectId;
    const old = safeRel(req.body.oldPath), newName = safeSegment(req.body.newName);
    if (!newName) return res.status(400).json({ error: 'New name required' });
    const of2 = ensureInside(id, old), nf = path.join(path.dirname(of2), newName);
    if (!(await statSafe(of2))) return res.status(404).json({ error: 'Not found' });
    if (await statSafe(nf)) return res.status(409).json({ error: 'Exists' });
    await fs.rename(of2, nf);
    const idx = await readIndex(id);
    const newRel = path.relative(projectDir(id), nf).replace(/\\/g, '/');
    if (idx[old]) {
      idx[newRel] = { ...idx[old], path: newRel, name: newName };
      delete idx[old];
      await writeIndex(id, idx);
    }
    invalidateCache(id);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/vault/:projectId/delete', async (req, res) => {
  try {
    const f = ensureInside(req.params.projectId, safeRel(req.body.path));
    if (!(await statSafe(f))) return res.status(404).json({ error: 'Not found' });
    await fs.rm(f, { recursive: true, force: true });
    const idx = await readIndex(req.params.projectId);
    delete idx[safeRel(req.body.path)];
    await writeIndex(req.params.projectId, idx);
    invalidateCache(req.params.projectId);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Routes: Search ─────────────────────────────────────────────────────────

app.post('/api/vault/:projectId/search', async (req, res) => {
  const q = String(req.body.query || '').trim().toLowerCase();
  if (!q) return res.json({ results: [] });
  try {
    const idx = await readIndex(req.params.projectId);
    const results = [];
    for (const [rel, m] of Object.entries(idx)) {
      const hay = [m.name, m.originalName, rel, m.destination, m.asset_type, m.content_summary, m.searchText, (m.tags||[]).join(' '), JSON.stringify(m.metadata||{}), JSON.stringify(m.ai||{})].join(' ').toLowerCase();
      if (hay.includes(q)) results.push({ ...m, path: rel });
    }
    for (const rel of await filesystemSearch(projectDir(req.params.projectId), q)) {
      if (!results.some(r => r.path === rel)) {
        const f = await fileInfo(req.params.projectId, rel);
        if (f) results.push(f);
      }
    }
    res.json({ results: results.slice(0, 200) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function filesystemSearch(dir, q) {
  const out = [];
  async function walk(d, rel) {
    try {
      const entries = await fs.readdir(d);
      for (const n of entries) {
        if (n === INDEX_NAME || n === UNDO_FILE || n === '.uploading') continue;
        const p = path.join(d, n), s = await statSafe(p);
        if (!s) continue;
        const r = rel ? rel+'/'+n : n;
        if (n.toLowerCase().includes(q)) out.push(r);
        if (s.isDirectory()) await walk(p, r);
      }
    } catch {}
  }
  await walk(dir, '');
  return out;
}

// ─── Routes: Download / Preview ─────────────────────────────────────────────

app.get('/api/vault/:projectId/download/*', async (req, res) => {
  try {
    const f = ensureInside(req.params.projectId, safeRel(req.params[0]));
    if (!(await statSafe(f))) return res.status(404).end();
    res.download(f);
  } catch (e) { res.status(400).end(); }
});

app.get('/api/vault/:projectId/preview/*', async (req, res) => {
  try {
    const f = ensureInside(req.params.projectId, safeRel(req.params[0]));
    if (!(await statSafe(f))) return res.status(404).end();
    const m = guessMime(f);
    res.type(m).set('Content-Disposition', 'inline');
    fsSync.createReadStream(f).pipe(res);
  } catch (e) { res.status(400).end(); }
});

// ─── Gemini Integration ─────────────────────────────────────────────────────

const MIME_BY_EXT = {'.mp4':'video/mp4','.mov':'video/quicktime','.m4v':'video/mp4','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.webm':'video/webm','.mpeg':'video/mpeg','.mpg':'video/mpeg','.mts':'video/mp2t','.m2ts':'video/mp2t','.mxf':'application/mxf','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.heic':'image/heic','.tif':'image/tiff','.tiff':'image/tiff','.bmp':'image/bmp','.svg':'image/svg+xml','.dng':'image/x-adobe-dng','.arw':'image/x-sony-arw','.cr2':'image/x-canon-cr2','.nef':'image/x-nikon-nef','.wav':'audio/wav','.mp3':'audio/mpeg','.aac':'audio/aac','.m4a':'audio/mp4','.flac':'audio/flac','.ogg':'audio/ogg','.pdf':'application/pdf','.txt':'text/plain','.md':'text/plain','.csv':'text/csv','.json':'application/json','.xml':'application/xml','.srt':'text/plain'};

function guessMime(name) { return MIME_BY_EXT[extOf(name)] || 'application/octet-stream'; }

function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = require('https').request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search,
      method: options.method || 'GET', headers: options.headers || {}
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function geminiUploadFile(filePath, mime, displayName) {
  const size = (await fs.stat(filePath)).size;
  const start = await httpsRequest(GEMINI_BASE+'/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json'
    }
  }, Buffer.from(JSON.stringify({ file: { display_name: displayName } })));
  if (start.status < 200 || start.status >= 300) throw new Error('Gemini upload start '+start.status);
  const uploadUrl = start.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new Error('Gemini upload URL missing');
  const u = new URL(uploadUrl);
  const fin = await new Promise((resolve, reject) => {
    const r = require('https').request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Length': String(size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'Content-Type': mime }
    }, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => resolve({ status: x.statusCode, body: Buffer.concat(c) })); });
    r.on('error', reject);
    fsSync.createReadStream(filePath).pipe(r);
  });
  if (fin.status < 200 || fin.status >= 300) throw new Error('Gemini upload '+fin.status);
  return JSON.parse(fin.body.toString()).file;
}

async function waitGemini(name) {
  for (let i = 0; i < 120; i++) {
    const r = await httpsRequest(GEMINI_BASE+'/v1beta/'+name, { headers: { 'x-goog-api-key': GEMINI_API_KEY } });
    if (r.status < 200 || r.status >= 300) throw new Error('Gemini file status '+r.status);
    const f = JSON.parse(r.body.toString());
    if (f.state === 'ACTIVE') return f;
    if (f.state === 'FAILED') throw new Error('Gemini file processing failed');
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Gemini file timeout');
}

async function geminiJson(parts) {
  const body = Buffer.from(JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json' } }));
  const r = await httpsRequest(GEMINI_BASE+'/v1beta/models/'+encodeURIComponent(GEMINI_MODEL)+':generateContent', {
    method: 'POST', headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' }
  }, body);
  if (r.status < 200 || r.status >= 300) throw new Error('Gemini generate '+r.status+': '+r.body.toString().slice(0, 400));
  const d = JSON.parse(r.body.toString());
  const text = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return JSON.parse(text);
}

// ─── AI Analysis Logic ──────────────────────────────────────────────────────

function cameraLike(meta, name) {
  const n = name.toLowerCase();
  if (meta?.cameraMeta && Object.keys(meta.cameraMeta).length) return true;
  return /(?:xdcam|xavc|fx3|fx30|a7|alpha|sony|canon|nikon|arri|red|blackmagic|braw|raw|r3d|prores|cinema|cam|camera|c000|a0\d{3}|clip)/i.test(n);
}

function isVeryLowRes(meta) {
  return !!meta && (Number(meta.width||0) < 426 || Number(meta.height||0) < 240 || (Number(meta.width||0) && Number(meta.height||0) < 240));
}

function ruleDestination(rel, meta, ai) {
  const name = path.basename(rel).toLowerCase(), cat = categoryOf(name);
  if (cat === 'video') {
    if (isVeryLowRes(meta)) return '01_MEDIA/PROXIES';
    return cameraLike(meta, name) ? '01_MEDIA/CAMERA' : (ai?.destination || '01_MEDIA/CAMERA');
  }
  if (cat === 'image') {
    if (ai?.destination && ['04_STORYBOARD','05_ART_DIRECTION','01_MEDIA/STILLS'].includes(ai.destination)) return ai.destination;
    return '01_MEDIA/STILLS';
  }
  if (cat === 'audio') return '02_AUDIO';
  const n = name+' '+JSON.stringify(meta?.text||'');
  if (/storyboard|story board|shot division|shot-division|shotlist|shot list|animatic|coverage|scene breakdown|shot breakdown|frame board/.test(n)) return '04_STORYBOARD';
  if (/script|screenplay|treatment|logline|synopsis|story|character|dialogue|beat sheet/.test(n)) return '03_STORY';
  if (cat === 'design' || /concept art|art direction|moodboard|lookbook|poster|key art|graphic/.test(n)) return '05_ART_DIRECTION';
  return ai?.destination || '06_ARCHIVE';
}

async function analyzeWithGemini(fullPath, info, metadata, text) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
  const cat = info.type;
  if (cat === 'video') {
    const prompt = 'You are DreamSync\'s film archivist. A VIDEO arrived in the production inbox. Do not infer visual content because you are NOT receiving the video. Review ONLY the metadata and name. Recommend one of: 01_MEDIA/CAMERA, 01_MEDIA/PROXIES, 06_ARCHIVE. Rules: videos below 240p => 01_MEDIA/PROXIES; normal camera/source footage => CAMERA; anything clearly a generated export/final/odd archive asset => ARCHIVE. Return JSON: {"destination":"...","asset_type":"...","confidence":0.0,"reason":"...","tags":["..."]}.\nFILE: '+info.originalName+'\nPATH: '+info.path+'\nMETADATA: '+JSON.stringify(metadata||{});
    return geminiJson([{ text: prompt }]);
  }
  if (cat === 'image' || cat === 'audio' || cat === 'document' || cat === 'text' || cat === 'design') {
    const mime = guessMime(info.originalName);
    const uploaded = await geminiUploadFile(fullPath, mime, info.originalName);
    const active = await waitGemini(uploaded.name);
    const prompt = 'You are DreamSync\'s production-house archivist. Decide the best destination for this asset using ONLY these allowed folders: 01_MEDIA/STILLS, 02_AUDIO, 03_STORY, 04_STORYBOARD, 05_ART_DIRECTION, 06_ARCHIVE. Never choose CAMERA or PROXIES for non-video assets. Critical rule: material about shot division, shot lists, coverage, animatics, storyboard frames, scene breakdowns, or storyboard planning belongs in 04_STORYBOARD. Story/script/treatment/logline/characters/dialogue planning belongs in 03_STORY. Design/concept art/moodboards/key art belongs in 05_ART_DIRECTION. Return ONLY JSON with destination, asset_type, confidence, reason, tags, content_summary and search_terms.\nNAME: '+info.originalName+'\nPATH: '+info.path+'\nLOCAL_TEXT_PREVIEW: '+(text||'').slice(0, 12000);
    return geminiJson([{ fileData: { fileUri: active.uri, mimeType: active.mimeType || mime } }, { text: prompt }]);
  }
  return null;
}

async function organizeFile(projectId, rel) {
  const full = ensureInside(projectId, rel);
  const idx = await readIndex(projectId);
  const info = idx[rel] || { name: path.basename(rel), originalName: path.basename(rel), path: rel, type: categoryOf(rel), receivedAt: new Date().toISOString(), tags: [] };
  const metadata = info.type === 'video' ? readVideoMetadata(full) : null;
  const text = await extractText(full);
  let ai = null, err = null;
  try { ai = await analyzeWithGemini(full, info, metadata, text); } catch (e) { err = e.message; }
  const dest = ruleDestination(rel, metadata, { ...(ai||{}), destination: ai?.destination && ARCHIVE_FOLDERS.includes(ai.destination) ? ai.destination : null });
  const destDir = ensureInside(projectId, dest);
  await fs.mkdir(destDir, { recursive: true });
  const base = path.basename(rel), ext = path.extname(base);
  let target = path.join(destDir, base), n = 2;
  while (await statSafe(target)) { target = path.join(destDir, path.basename(base, ext)+' ('+n+++')'+ext); }
  await fs.rename(full, target);
  const finalRel = path.relative(projectDir(projectId), target).replace(/\\/g, '/');
  const updated = {
    ...info, path: finalRel, previousPath: rel, destination: dest,
    status: 'organized', organizedAt: new Date().toISOString(),
    metadata: metadata || null, ai: ai || null, error: err || null,
    tags: info.tags || [],
    searchText: [info.originalName, rel, text, ai?.content_summary||'', ...(ai?.search_terms||[]), ...(ai?.tags||[])].join(' ').slice(0, 60000)
  };
  delete idx[rel];
  idx[finalRel] = updated;
  await writeIndex(projectId, idx);
  invalidateCache(projectId);
  return updated;
}

function getInboxFiles(projectId) {
  const dir = path.join(projectDir(projectId), INBOX);
  const out = [];
  function walk(d, rel) {
    try {
      const entries = fsSync.readdirSync(d);
      for (const n of entries) {
        if (n === '.uploading') continue;
        const p = path.join(d, n), s = statSafeSync(p);
        if (!s) continue;
        const r = rel ? rel+'/'+n : n;
        if (s.isDirectory()) walk(p, r);
        else out.push(INBOX+'/'+r);
      }
    } catch {}
  }
  walk(dir, '');
  return out;
}

function statSafeSync(file) { try { return fsSync.statSync(file); } catch { return null; } }

function startJob(projectId) {
  const existing = jobs.get(projectId);
  if (existing?.running) return;
  const state = { runId: generateId(), running: true, queue: [], history: [], startedAt: new Date().toISOString() };
  jobs.set(projectId, state);
  setImmediate(async () => {
    try {
      const files = getInboxFiles(projectId);
      state.queue = files.map(p => ({ path: p, name: path.basename(p), status: 'queued' }));
      state.total = state.queue.length;
      for (const row of state.queue) {
        row.status = 'scanning';
        state.current = row;
        try {
          const result = await organizeFile(projectId, row.path);
          row.status = 'done';
          row.destination = result.destination;
          row.ai = result.ai;
          row.error = result.error;
          state.history.unshift(result);
        } catch (e) {
          row.status = 'error';
          row.error = e.message;
        }
        state.completed = (state.completed || 0) + 1;
        state.current = null;
      }
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  });
}

async function buildTree(dir, projectId, rel) {
  const items = [];
  try {
    const entries = await fs.readdir(dir);
    for (const n of entries) {
      if (n === INDEX_NAME || n === UNDO_FILE || n === '.uploading') continue;
      const p = path.join(dir, n), s = await statSafe(p);
      if (!s) continue;
      const r = rel ? rel+'/'+n : n;
      if (s.isDirectory()) {
        const inside = await directorySummary(p);
        const children = (await buildTree(p, projectId, r)).items;
        items.push({ name: n, path: r, type: 'folder', isFolder: true, inside, children });
      } else {
        const fi = await fileInfo(projectId, r);
        if (fi) items.push(fi);
      }
    }
  } catch {}
  items.sort((a, b) => a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1);
  return { items };
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

let server;
function shutdown() {
  console.log('\nShutting down DreamSync...');
  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Init & Start ───────────────────────────────────────────────────────────

(async () => {
  await fs.mkdir(VAULT_ROOT, { recursive: true });
  const data = await loadProjects();
  for (const id of Object.keys(data.projects)) {
    await fs.mkdir(projectDir(id), { recursive: true });
    await ensureFolders(id);
    if (!(await statSafe(indexPath(id)))) await writeIndex(id, {});
  }
  server = app.listen(PORT, () => console.log('DreamSync running on http://localhost:'+PORT));
})();
