# Keep Notes — Google Keep import (Google Takeout)

Google Keep has **no official public API**, so the supported path to copy your Keep
notes into Dashbird's Keep Notes feature is a **Google Takeout export**.

## Steps

1. Go to [Google Takeout](https://takeout.google.com/), deselect everything, and
   select only **Keep**. Create and download the export (a `.zip`).
2. **Unzip** the download. Inside you'll find `Takeout/Keep/` with one file per
   note: a canonical `<note>.json`, a mirror `<note>.html`, and any attached
   images as sibling files.
3. Copy those note files into Dashbird's import folder:

   ```
   data/keep-import/
   ```

   You can drop the whole `Takeout/Keep/` contents in — subfolders are scanned
   recursively. (Override the location with the `KEEP_IMPORT_ROOT` env var.)
4. In Dashbird, open the **Keep Notes** panel and click **Import Google Keep…**.
   The dialog shows how many files are staged; click **Run import**.

## What happens

- Each note's `title` + `textContent` (or checklist `listContent`, rendered as
  `☐ / ☑` lines) becomes a Keep note. Web-link annotations are appended.
- Pinned notes stay pinned. **Trashed** and **Archived** notes are skipped by
  default (POST `{"includeArchived": true}` to `/api/keep-notes/import` to include
  archived ones).
- The first image attachment per note is attached best-effort (subject to the
  8 MB image limit).
- After a successful run the processed files are moved into
  `data/keep-import/imported/<timestamp>/` so re-running never double-imports.
- Original Keep timestamps are not preserved — imported notes are created "now".

## Endpoints

- `GET /api/keep-notes/import` — staged file counts + import folder path.
- `POST /api/keep-notes/import` — parse staged files and create notes.

The import is a local file parse: **no paid API, no cost change.**
