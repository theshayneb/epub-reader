# Stop Obsidian Sync churn and cross-device overwrites

Status: Completed (1.1.38)
Started: 2026-11-18

## Problem (confirmed)

- `tickReadingStats` (reader-view.ts) runs every 15 s while reading and calls `store.markChanged(250)`; `ReaderDataStore.persist()` rewrites the whole `ReaderData` (settings and every book) into `data.json` with no change check.
- Every store change also schedules a reading-sync record (3 s delay, 15 s cap), so the device's sync file is rewritten about every 15 s while reading, each time after saving `data.json` again.
- `recordLocalBook` infers this device's edits by diffing the book state loaded from `data.json` against the device's sync file: differences are stamped "now", absences become deletions "now". Obsidian Sync replaces `data.json`'s `books` key with another device's copy, so foreign, stale state becomes fresh local edits: deleted highlights return, highlights only one device had are deleted, older edits win, reading time is double-counted, completion flips.
- No `onExternalSettingsChange`. Per-device UI state (sidebar tab, remembered colour, tutorial flag, bookshelf view, typography) lives in synced `data.json` and is rewritten during ordinary use.
- Every device rewrites book notes (Markdown): the highlights callout on book open, `Progress` every 3 min and on close, `Quotes` on save-with-tags.
- Nothing waits for Obsidian Sync to settle.

## Decisions (owner, 2026-11-18)

- Book notes (highlights callout, `Progress`, `Quotes`) are written only by the device with "Run background tasks on this device" on (local storage; default on for desktop, off for mobile). Phone and tablet highlights reach the note when the desktop receives their sync file.
- `Progress` comes from the newest synced position, so positions carry the page label.
- `Quotes` is derived: highlights saved with "Highlight and add tags" carry `quote: true`; the desktop adds, updates and removes their entries, wherever the highlight was made, edited or deleted. Hand-written entries are kept.
- Per device (local storage): display/typography, reader UI state, bookshelf view, remembered highlight colour/style, "Hide Android's text menu", background-tasks switch. Shared (`data.json`, merged per key by edit time): "Merge adjacent highlights", reading sync on/off and folder.
- Bookshelf hidden/reading-list/cover choices stay per device and are not synced.
- Release notes stay GitHub-generated (no CHANGELOG).

## Plan

1. Storage split: books in IndexedDB (memory fallback in tests), device settings in local storage, shared settings in `data.json` with per-key edit times. `data.json` is written only when a shared setting changes, read-merge-write, keeping any `books` key on disk untouched for older versions. Migration seeds local books and device settings from `data.json` once per device.
2. Edit times: highlights and bookmarks carry `updatedAt` set at edit time; deletions are local tombstones with `deletedAt`; completion carries its own edit time; this device's reading time is its own counter. `recordLocalBook` uses these, never "now", and never infers deletion from absence.
3. Calm sync writes: edits are recorded after a short debounce; reading progress at most every 2 min, on 60 s pause, on leaving/closing the book and on backgrounding. Merging another device's file never writes this device's file.
4. `onExternalSettingsChange`: merge disk shared settings per key; save only if the merge changed the disk copy.
5. Background device: after Sync settles (60 s without vault changes and core Sync not syncing, guarded), updates book notes (callout, `Progress`, `Quotes`) for books changed by any device, migrations, and legacy link rewrite. Other devices never write book notes automatically.
6. Tests reproducing each overwrite scenario; README and design docs.

## Validation

- Released as 1.1.38. `npm run verify:full` passes (lint, types, 163 tests, build, release validation).
- `tests/reading-sync-model.test.ts` "devices that sync late or hold stale copies": stale `data.json` copies, late tablet, deletion vs late edit, reading time and completion; three of these failed on 1.1.37.
- `tests/reading-sync.test.ts`: receiving another device's file does not rewrite this device's file; starting with nothing new writes nothing; progress written at most every 2 minutes while reading, after a 60-second pause, and on flush.
- `tests/store.test.ts`: no `data.json` write on load or while reading; read-merge-write keeps `books` and other keys; per-key merge on external change; background switch per device.
- `tests/book-notes.test.ts`: notes written only after Sync settles and only on the background device; Quotes add/remove/adopt; Progress.
- Manual (owner): update every device; on the phone, highlight and mark a Quote; confirm the desktop's book note gains it about a minute after the phone's sync file arrives, and that `data.json` does not change while reading.
