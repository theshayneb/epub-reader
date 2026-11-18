# Device storage, shared settings and the background device

Status: Accepted
Date: 2026-11-18
Plan: [sync-churn.md](../../exec-plans/completed/sync-churn.md)

## Context

The owner reads on a desktop that is always on, a phone that syncs every few hours and a tablet that syncs every few days, all through Obsidian Sync. Sync copies `data.json` and vault files by "newest file wins" (JSON settings files merge top-level keys). Before 1.1.38 the plugin rewrote the whole `data.json` (settings and every book) every 15 seconds while reading, and every device rewrote book notes. Devices overwrote each other's books, settings and notes.

## Decision

Data is split by who may see it (`src/store.ts`):

| Data | Where | Synced |
| --- | --- | --- |
| Book state (positions, highlights, bookmarks, stats, tombstones, bookshelf choices) | IndexedDB on this device (`src/local-book-storage.ts`), database name remembered in local storage | Only through the per-device reading-sync files |
| Display, typography, reader UI state, bookshelf view, remembered highlight colour/style, "Hide Android's text menu", tutorial seen | `app.saveLocalStorage` | No |
| "Run background tasks on this device" | `app.saveLocalStorage`; default on for desktop, off for mobile | No |
| "Merge adjacent highlights", reading sync on/off, sync folder | `data.json` `settings`, with per-key edit times in `settingsUpdatedAt` | Yes |

Rules for `data.json`:

- Nothing is written on load or while reading. It is written only when a shared setting changes, by re-reading it from disk, merging per key by edit time, and writing only if that changes the file.
- `onExternalSettingsChange` re-reads it, merges per key (newer edit time wins; a key with no time, written by an older version, never beats a timed one), applies the result to open readers and restarts reading sync if its folder or switch changed. It writes back only when this device holds newer edits than the disk copy.
- Everything else on disk is kept as it is, including the `books` key older versions still read and write.

Migration: the first start of 1.1.38 on a device seeds its book storage and device settings from `data.json` once. A stale or foreign copy is harmless, because merging uses edit times and tombstones, never that snapshot.

### Background device

Book notes (the highlights callout or by-colour region, `Progress` and `Quotes`) are written only by the device with "Run background tasks on this device" on (`src/book-notes.ts`), so each note has one writer:

- It waits for Obsidian Sync to settle after startup and every resume: no vault changes for 60 seconds and the core Sync plugin not reporting that it is syncing (undocumented internals, guarded; anything unexpected counts as idle). It waits at most 5 minutes, because other plugins may change the vault more often than once a minute; 1.1.38 had no such limit and could wait forever. Once settled, it stays settled until the next resume.
- Each book is updated on its own: one note that cannot be written never stops the others (in 1.1.38 it stopped the whole pass).
- **ePub Reader: Update book notes now** re-reads every device's sync file, updates all notes at once and reports how many changed, which failed and which books have no note.
- It then updates every book that has a note, after changes from any device: 5 seconds after an edit, at most every 2 minutes for reading progress. Each write is skipped when the note already says the same thing. Local edits on that device update the note at once.
- `Progress` comes from the newest synced position's page label.
- `Quotes` is derived: highlights saved with "Highlight and add tags" carry `quote: true`. The background device adds, updates and removes their entries, wherever the highlight was made, edited or deleted. It remembers (in local storage) which entries it generated and removes only those; hand-written entries stay. Entries added by older versions are adopted when they match a highlight.
- It runs the one-off rewrite of old book links in notes.
- Other devices never write book notes on their own. Their export button opens the note as it is.

## Consequences

- Highlights made on the phone or tablet reach the book note when the desktop receives that device's sync file.
- Every device must run 1.1.38 or later; an older version keeps rewriting `data.json` and its own sync file the old way until updated, though the newer devices tolerate what it writes.
- Bookshelf hidden/reading-list/cover choices are per device and not synced.

## Validation

- `tests/store.test.ts` ("data.json holds only shared settings"): no `data.json` write on load or while reading, read-merge-write keeping other keys and `books`, per-key merge on external change, background switch per device.
- `tests/book-notes.test.ts`: waits for settle, writes callout/Progress/Quotes once, removes only generated entries, adopts old entries, never writes on a device without background tasks.
