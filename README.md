# My5TB

A self-hosted 3D asset catalog with a Windows ingestion app, searchable web interface, public downloads, and owner-reviewed community submissions.

## Run locally

Use Node.js 22.12+ and Python 3.12+ (Windows dependency lock tested with Python 3.14).

```powershell
.\scripts\Setup.ps1
.\scripts\Start-Demo.ps1
```

Open http://127.0.0.1:8787. The demo generates sample assets and uses local Cloudflare emulation. Open the desktop app using `Start-My5TB.bat` or `scripts/Start-Desktop.ps1`. Configuration defaults to offline mode. Copy `config.example.toml` to ignored `config.toml` and set your collection root.

## Features

- Search and filter characters by style, source, artist, world and file format; advanced exclusions.
- Responsive light/dark catalog, image galleries, animated GIF previews and model permalinks.
- Read-only source scanning; underscore-prefixed folders are excluded.
- Journaled uploads, pause/resume, publication controls and recovery tools.
- Google Drive for model downloads; Cloudflare R2 for images and manifests; D1 for metadata.
- Private submission inbox for ZIP, RAR and 7z uploads; owner review before publication.

See [usage and architecture](docs/USAGE.md) and [deployment](docs/DEPLOY.md).

## Development and reports

```powershell
npm ci
npm run build
npm test
.\.venv\Scripts\python.exe -m pytest -q
```

Report bugs through this repository's GitHub Issues. Include reproduction steps, browser/OS, expected behavior, and sanitized logs. Never attach credentials, access tokens, private collection files or personal data.

This public repository is a curated source release. Production data, credentials and internal planning documents are not included. Third-party artwork and test fixtures retain their respective rights; this repository does not grant rights to redistribute those materials. No project-wide license grant is currently provided.
