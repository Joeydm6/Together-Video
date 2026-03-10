Current restore point:

- `stable-sync-polish`

Files:

- Manifest: `releases/manifest.json`
- Backup archive: `backups/togethervideo-2026-03-10_23-41-40-stable-sync-polish.zip`
- Create backup: `scripts/create-project-backup.ps1`
- Restore backup: `scripts/restore-project-backup.ps1`

Create a new snapshot:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-project-backup.ps1 -Label "my-label"
```

Restore a snapshot:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-project-backup.ps1 -ArchivePath ".\backups\togethervideo-2026-03-10_23-41-40-stable-sync-polish.zip"
```
