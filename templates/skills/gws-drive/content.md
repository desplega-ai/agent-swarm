# gws-drive — Google Drive CLI Reference

You have read-write access to Google Drive via the `gws` CLI and a GCP service account.
The SA is configured globally — credentials are available at container boot.

## Installing gws

`gws` (Google Workspace CLI) is a Go binary. Install it via:

```bash
# macOS / Linux (via go install)
go install github.com/nicholasgasior/gws@latest

# Or download a pre-built binary from the releases page:
# https://github.com/nicholasgasior/gws/releases
```

If `go` is not available, download the binary for your platform from the releases page
and place it on your `$PATH`.

## Setup

The service account credentials are stored encrypted in `swarm_config` under key
`GOOGLE_DRIVE_SA_CREDENTIALS`. At boot, the entrypoint writes them to
`~/.config/gws/credentials.json` and sets `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`.

The integration also checks Google's standard Application Default Credentials (ADC) paths:
`GOOGLE_APPLICATION_CREDENTIALS` env var and `~/.config/gcloud/application_default_credentials.json`.

The default Shared Drive ID (if configured) is in `GOOGLE_DRIVE_SHARED_DRIVE_ID`.

## Common Operations

### List / Search files

```bash
gws drive files list --driveId "$GOOGLE_DRIVE_SHARED_DRIVE_ID" --corpora drive \
  --query "<query>" --fields "files(id,name,mimeType,modifiedTime,webViewLink)"
```

Query examples:
- All Google Docs: `mimeType='application/vnd.google-apps.document'`
- By name: `name contains 'PRD'`
- Recently modified: `modifiedTime > '2026-05-01T00:00:00'`
- In a specific folder: `'<folderId>' in parents`
- Combined: `name contains 'sprint' and mimeType='application/vnd.google-apps.spreadsheet'`

### Read / Export a file

```bash
# Google Docs → plain text
gws drive files export <fileId> --mimeType text/plain

# Google Sheets → CSV
gws drive files export <fileId> --mimeType text/csv

# Any format → PDF
gws drive files export <fileId> --mimeType application/pdf

# Binary files (PDFs, images) — download directly
gws drive files get <fileId> --alt media > output-file.ext
```

### Create / Upload a file

```bash
# Upload a local file to a folder
gws drive files create --name "Report.md" --parents <folderId> \
  --media ./local-file.md --supportsAllDrives true

# Create an empty Google Doc (editable in browser)
gws drive files create --name "New Doc" --parents <folderId> \
  --mimeType application/vnd.google-apps.document --supportsAllDrives true
```

### Update a file's content

```bash
gws drive files update <fileId> --media ./updated-file.md --supportsAllDrives true
```

### Comments

```bash
# Leave a comment on a file
gws drive comments create <fileId> --content "Your comment text here."

# Reply to an existing comment
gws drive replies create <fileId> <commentId> --content "Updated per feedback."

# List comments on a file
gws drive comments list <fileId> --fields "comments(id,author,content,createdTime)"
```

## Common Gotchas

1. **Always pass `--supportsAllDrives true`** for Shared Drive operations (create, update, delete). Without it, the API silently ignores Shared Drive files.

2. **Google Docs/Sheets/Slides cannot be downloaded directly** — use `export` with a target MIME type instead of `get --alt media`.

3. **Folder creation** uses `mimeType application/vnd.google-apps.folder`:
   ```bash
   gws drive files create --name "Reports" --parents <parentFolderId> \
     --mimeType application/vnd.google-apps.folder --supportsAllDrives true
   ```

4. **Search is eventual-consistency** — a newly created file may not appear in search results for a few seconds. If you just created a file, use the returned file ID directly rather than searching for it.

5. **The SA can only see Shared Drives it's been added to** as a member. If a file isn't found, verify the SA email has access.

6. **File IDs are stable** — once you have a file ID, you can read/write it indefinitely without re-searching. Cache IDs for files you access repeatedly.
