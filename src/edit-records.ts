import type { Bookmark, BookState, ReaderHighlight, ReadingStats } from "./types";

/**
 * Edit bookkeeping for cross-device merging. Every user edit stamps the time it was made, and every
 * deletion leaves a dated tombstone, so merges compare when edits happened instead of when a device
 * last synced. See `recordLocalBook` in `reading-sync-model.ts`.
 */

export function markHighlightEdited(highlight: ReaderHighlight, now = Date.now()): void {
  highlight.updatedAt = now;
}

export function markBookmarkEdited(bookmark: Bookmark, now = Date.now()): void {
  bookmark.updatedAt = now;
}

export function recordHighlightDeletion(state: BookState, id: string, now = Date.now()): void {
  state.deletedHighlights = { ...state.deletedHighlights, [id]: Math.max(now, state.deletedHighlights?.[id] ?? 0) };
}

export function recordBookmarkDeletion(state: BookState, id: string, now = Date.now()): void {
  state.deletedBookmarks = { ...state.deletedBookmarks, [id]: Math.max(now, state.deletedBookmarks?.[id] ?? 0) };
}

/** Marks a book finished (`completedAt`) or unfinished (`undefined`), recording when that was decided. */
export function setCompletion(stats: ReadingStats, completedAt: number | undefined, now = Date.now()): void {
  if (completedAt) stats.completedAt = completedAt;
  else delete stats.completedAt;
  stats.completedUpdatedAt = now;
}

/** Adds reading time spent on this device to its own counter (see `knowDeviceReadingTime`). */
export function addDeviceReadingTime(stats: ReadingStats, elapsed: number): void {
  if (stats.deviceReadingMs !== undefined) stats.deviceReadingMs += elapsed;
  else stats.unrecordedReadingMs = (stats.unrecordedReadingMs ?? 0) + elapsed;
}

/**
 * Starts this device's own reading counter from what its sync file already credits it with, plus any
 * time read before that was known. Until then the counter is unknown, and counting from zero would
 * under-report this device's time.
 */
export function knowDeviceReadingTime(stats: ReadingStats, recordedMs: number): void {
  if (stats.deviceReadingMs !== undefined) return;
  stats.deviceReadingMs = recordedMs + (stats.unrecordedReadingMs ?? 0);
  delete stats.unrecordedReadingMs;
}
