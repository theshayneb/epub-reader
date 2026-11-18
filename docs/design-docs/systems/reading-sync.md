# Cross-Device Reading Sync

Status: Accepted
Date: 2026-09-24
Updated: 2026-11-18 (explicit edit times and tombstones, calm write schedule; see [device-storage.md](device-storage.md))

## Context

Reading progress, highlights, notes, bookmarks, and reading statistics live in the plugin's `data.json`. Users who read the same vault on several devices (typically a desktop and a phone kept in sync by Obsidian Sync) expect these to follow them.

Syncing `data.json` itself is unreliable:

- Obsidian Sync only syncs plugin data when "Installed community plugins" sync is enabled.
- For settings JSON files, Obsidian Sync resolves conflicts by applying the local file's top-level keys on top of the remote file. All books live under one `books` key, so edits made on two devices before they sync can silently discard one device's highlights or position.
- The plugin only read `data.json` at startup, so a file replaced by a sync service had no effect until reload and could be overwritten by the next save.

## Decision

Sync reading data through per-device files in a vault folder (setting `syncFolder`, default `Utilities/Omni Book Reader Mod/Sync`; toggle `syncEnabled`, default on).

- Each device has a random 16-hex-character ID kept in Obsidian's per-device local storage (`app.loadLocalStorage`), never in synced data.
- Each device writes only `<syncFolder>/<deviceId>.json`. Because every file has exactly one writer, a file sync service never has to resolve conflicting edits, so "last modified wins" is always correct.
- Each file holds that device's view of the merged state of all books, so data keeps propagating even after the device that created it goes offline.
- Other devices' files are read at startup and whenever the vault reports them created or modified, then merged.
- Book state lives in this device's own storage (IndexedDB, see [device-storage.md](device-storage.md)), never in `data.json`; only the sync files carry it to other devices.

Merge rules (`src/reading-sync-model.ts`) are commutative, associative, and idempotent, so all devices converge regardless of delivery order:

| Data | Rule |
| --- | --- |
| Highlights, bookmarks | Last-writer-wins per id; deletions are kept as timestamped tombstones so they are not resurrected. Ties prefer deletion, then a deterministic value order. |
| Reading position | Most recent `updatedAt` wins. |
| Reading time | One grow-only counter per device; the total is their sum. |
| Last opened/read, furthest progress | Maximum. |
| Finished state | Last-writer-wins, so "mark as unfinished" syncs too. |
| Annotation export document paths | A single-file location (`highlightPath` equals `notePath`) beats an old Highlight/Note pair; otherwise the earliest created wins. The file path itself is derived from the book title, so this only records where the file was last written. |

Local edits carry their own times (`src/edit-records.ts`): highlights and bookmarks get `updatedAt` when edited, deletions leave local tombstones (`deletedHighlights`/`deletedBookmarks` with the deletion time), completion carries `completedUpdatedAt`, and this device's reading time is its own counter (`deviceReadingMs`). `recordLocalBook` merges these into the sync document with the same per-entry rules as any other device's file. It never stamps "now" and never reads a missing entry as a deletion.

Before 1.1.38, `recordLocalBook` inferred edits by diffing the book state loaded from `data.json` against the device's sync file. Obsidian Sync replaced `data.json`'s `books` key with another device's copy, so foreign, stale state became fresh local edits: deleted highlights came back, highlights only one device had were deleted, older edits won, reading time was counted twice and completion flipped. `tests/reading-sync-model.test.ts` ("devices that sync late or hold stale copies") reproduces each case.

Local-only fields are never synced: highlight/bookmark `stale` flags, bookshelf metadata (hidden, reading list, custom cover), and the EPUB source signature.

### Write schedule and ordering (`src/reading-sync.ts`)

1. **Merge, then record.** At start, other devices' files are merged first, then local edits are recorded. With explicit edit times the order does not change the result; it only means data merely received from others does not count as a local change, so starting writes nothing.
2. **Only local changes write.** The device's own file is rewritten only when recording local edits changed it. Merging another device's file never rewrites this device's file.
3. **Calm writes.** A person's edits (highlights, bookmarks, completion) are written after 3 seconds of quiet, at most 15 seconds after the first. Reading progress (position, time) is written after 60 seconds without progress, at most every 2 minutes while reading, and at once when the book is closed or switched, the app is backgrounded, or the plugin unloads.
4. **All work is serialized** through one promise queue.

### Open readers

Applied changes mutate the live `BookState` in place so open views keep valid references. `OmniBookReaderView.applySyncedChanges` redraws changed annotations, sidebar lists, the bookmark button, and statistics. A newer position from another device moves the reader there (unless a selection is in progress); the resulting position save keeps the remote timestamp for a few seconds so two open devices do not echo each other's positions back as newer.

## Alternatives considered

- **Sync `data.json` via "Installed community plugins" and merge on external change.** No new files, but requires a setting that also syncs plugin code, and Obsidian Sync's top-level-key JSON merge can still drop one device's edits before the plugin sees them.
- **One shared sync file per book.** Fewer files, but concurrent edits to the same book would again depend on the sync service's conflict handling.
- **Markdown sync files.** Markdown always syncs, but it would clutter notes, search, and graph, and Obsidian Sync's text merge could corrupt JSON.

## Consequences

- With Obsidian Sync, users must enable "Sync all other types" so `.json` files are included. Obsidian's file explorer hides `.json` files by default, so only the folder is visible.
- Works with any file-based sync (Obsidian Sync, iCloud, Syncthing) because it only relies on files being copied.
- Tombstones are kept indefinitely; each is a few dozen bytes. A device on an old version may send old copies for days; they lose to newer edit times and tombstones.
- Correctness depends on device clocks being roughly right; a device with a badly wrong clock can win or lose last-writer-wins comparisons incorrectly.
- Renaming an EPUB carries its synced data to the new path on the renaming device; edits another device makes under the old path before it sees the rename stay under the old path.
- A device's reading counter starts from what its own sync file already credits it with, so time from before 1.1.38 is neither lost nor counted twice.

## Validation

- `tests/reading-sync-model.test.ts`: two-device convergence for additions, deletions, edits, first sync, positions, reading time, completion, in-place mutation, merge order independence, and parsing.
- `tests/reading-sync.test.ts`: the service against an in-memory shared vault, including a restart after another device added data, receiving without writing, and the progress write schedule.
- Manual: with Obsidian Sync "Sync all other types" enabled, highlight on one device and confirm it appears on the other; turn pages on the phone, then open the desktop and confirm it resumes there.
