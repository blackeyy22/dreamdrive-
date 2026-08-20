# DreamSync Production Archive — Google Drive Style Ingest

DreamSync is a production-house media archive with a Google Drive-inspired workspace and Gemini-assisted ingest.

## UX
- Google Drive-style left navigation and clean file workspace.
- Reference palette: soft white/blue background, blue line accents, green status/actions, compact panels.
- Grid and list file views.
- Drag-and-drop rectangle selection.
- Drag/drop files or complete folders.
- Upload receipt opens immediately and confirms when bytes are fully received.
- One persistent AI progress bar shows the current file, completed count, percent, and AI state.

## AI ingest
- Files are uploaded to `00_INBOX` first.
- AI only starts after the upload request succeeds.
- Files are processed sequentially.
- A new upload creates a new AI run even after an earlier run has finished.
- Video is metadata-only for AI; video bytes are not reviewed by Gemini.
- The backend records the destination, confidence, reason, tags and content summary for searchable history.

## Archive folders
- `00_INBOX`
- `01_MEDIA/CAMERA`
- `01_MEDIA/PROXIES`
- `01_MEDIA/STILLS`
- `02_AUDIO`
- `03_STORY`
- `04_STORYBOARD`
- `05_ART_DIRECTION`
- `06_ARCHIVE`

## Start

```powershell
npm install
npm start
```

Open `http://localhost:3000`.

Keep `.env` private because it contains the Gemini API key.
