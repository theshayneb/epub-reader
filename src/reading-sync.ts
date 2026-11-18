import { normalizePath, TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import { ensureVaultFolder } from "./media-utils";
import {
  applySyncedBook,
  canonicalJson,
  createSyncDocument,
  hasVisibleChanges,
  mergeSyncDocumentInto,
  parseSyncDocument,
  recordLocalBook,
} from "./reading-sync-model";
import type { AppliedBookChange, SyncDocument } from "./reading-sync-model";
import type { ChangeKind, ReaderDataStore } from "./store";
import type { ReaderSettings } from "./types";

export interface ReadingSyncHost {
  app: App;
  store: ReaderDataStore;
  getReaderSettings(): ReaderSettings;
  /** Called after synced changes from another device were applied to local book state. */
  onSyncedBookChanges(changes: AppliedBookChange[]): void;
}

const DEVICE_ID_KEY = "omni-book-reader-mod-sync-device-id";
/** A person's edits (highlights, bookmarks, completion) reach the sync file after this pause... */
const EDIT_DELAY_MS = 3000;
/** ...or at most this long after the first one. */
const EDIT_MAX_WAIT_MS = 15000;
/** Reading progress (position, time) is written after this long without new progress... */
const PROGRESS_PAUSE_MS = 60_000;
/** ...and at most this often while reading continues. Closing the book or backgrounding the app writes at once. */
const PROGRESS_MAX_WAIT_MS = 120_000;

function createDeviceId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Syncs reading progress, highlights, bookmarks, and reading statistics across devices through
 * vault files. Each device owns one file, `<sync folder>/<device id>.json`, and only ever writes
 * that file. Other devices' files are read and merged, so a file sync service such as Obsidian
 * Sync never has to resolve conflicting edits. See `reading-sync-model.ts` for the merge rules.
 */
export class ReadingSyncService {
  private deviceId = "";
  private folder = "";
  private doc: SyncDocument | null = null;
  private lastWrittenBooks = "";
  private queue: Promise<void> = Promise.resolve();
  private recordTimer: number | null = null;
  private firstPendingChangeAt = 0;
  private pendingEdit = false;
  /** This device recorded changes that its sync file does not have yet. */
  private localPending = false;
  /** Set while another device's changes are applied, so they do not schedule a write of this device's file. */
  private applying = false;
  private unsubscribeStore: (() => void) | null = null;
  private generation = 0;

  constructor(private readonly host: ReadingSyncHost) {}

  get running(): boolean {
    return this.doc !== null;
  }

  /** Starts syncing if it is enabled in settings. Safe to call again after settings change. */
  start(): Promise<void> {
    const generation = ++this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      this.stopTimers();
      this.doc = null;
      const settings = this.host.getReaderSettings();
      if (!settings.syncEnabled) return;
      this.deviceId = this.loadDeviceId();
      this.folder = normalizePath(settings.syncFolder);
      const doc = await this.readOwnDocument();
      if (generation !== this.generation) return;
      this.doc = doc ?? createSyncDocument(this.deviceId);
      this.lastWrittenBooks = doc ? canonicalJson(doc.books) : "";
      const others = await this.readOtherDocuments();
      if (generation !== this.generation) return;
      const changedPaths = new Set<string>();
      for (const other of others) {
        for (const path of mergeSyncDocumentInto(this.doc, other)) changedPaths.add(path);
      }
      // Merge everyone else's files first, so what this device only received from them does not look
      // like a local change. Edits carry their own times, so the order does not change the result.
      const localChanged = this.recordLocalChanges();
      this.applyToLocal([...changedPaths]);
      if (localChanged) await this.writeOwnDocument();
      else this.lastWrittenBooks = canonicalJson(this.doc.books);
      this.unsubscribeStore ??= this.host.store.onChange((kind) => this.scheduleRecord(kind));
    });
  }

  stop(): void {
    this.generation++;
    this.stopTimers();
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.doc = null;
  }

  /** Records and writes pending local changes immediately, e.g. before the app is backgrounded or closed. */
  flush(): Promise<void> {
    if (!this.doc) return this.queue;
    this.stopTimers();
    return this.enqueue(async () => {
      if (!this.doc) return;
      if (this.recordLocalChanges()) await this.writeOwnDocument();
    });
  }

  /** Vault event handler for created or modified files. */
  handleVaultChange(file: TAbstractFile): void {
    if (!this.doc || !(file instanceof TFile) || !this.isOtherDeviceFile(file)) return;
    void this.enqueue(async () => {
      if (!this.doc) return;
      const incoming = parseSyncDocument(await this.host.app.vault.read(file));
      if (!this.doc || !incoming || incoming.deviceId === this.deviceId) return;
      // Merging another device's file never rewrites this device's file: what it brings is already
      // in that device's own file. Local edits recorded here are written on their own schedule.
      this.recordLocalChanges();
      const changedPaths = mergeSyncDocumentInto(this.doc, incoming);
      if (!changedPaths.length) return;
      this.applyToLocal(changedPaths);
    });
  }

  /** Keeps synced data attached to a book when its EPUB is renamed or moved on this device. */
  handleBookRename(oldPath: string, newPath: string): void {
    const doc = this.doc;
    const book = doc?.books[normalizePath(oldPath)];
    if (!doc || !book) return;
    const target = normalizePath(newPath);
    const merged = createSyncDocument(this.deviceId);
    merged.books[target] = book;
    mergeSyncDocumentInto(doc, merged);
    this.scheduleRecord("edit");
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch((error) => {
      console.error("[Omni Book Reader] Reading sync failed", error);
    });
    this.queue = run;
    return run;
  }

  private scheduleRecord(kind: ChangeKind): void {
    if (!this.doc || this.applying) return;
    const now = Date.now();
    if (!this.firstPendingChangeAt) this.firstPendingChangeAt = now;
    if (kind === "edit") this.pendingEdit = true;
    if (this.recordTimer !== null) window.clearTimeout(this.recordTimer);
    const [pause, maxWait] = this.pendingEdit ? [EDIT_DELAY_MS, EDIT_MAX_WAIT_MS] : [PROGRESS_PAUSE_MS, PROGRESS_MAX_WAIT_MS];
    const delay = Math.max(0, Math.min(pause, this.firstPendingChangeAt + maxWait - now));
    this.recordTimer = window.setTimeout(() => {
      this.recordTimer = null;
      this.firstPendingChangeAt = 0;
      void this.flush();
    }, delay);
  }

  private stopTimers(): void {
    if (this.recordTimer !== null) window.clearTimeout(this.recordTimer);
    this.recordTimer = null;
    this.firstPendingChangeAt = 0;
    this.pendingEdit = false;
  }

  /** Copies this device's edits into the sync document. True when that changed it. */
  private recordLocalChanges(): boolean {
    const doc = this.doc;
    if (!doc) return false;
    let changed = false;
    for (const [path, state] of this.host.store.liveBooks()) {
      if (recordLocalBook(doc, path, state, this.deviceId)) changed = true;
    }
    if (changed) this.localPending = true;
    return this.localPending;
  }

  /** Makes local book state match the sync document for the given paths. */
  private applyToLocal(paths: string[]): void {
    const doc = this.doc;
    if (!doc || !paths.length) return;
    const changes: AppliedBookChange[] = [];
    for (const path of paths) {
      const book = doc.books[path];
      // Only materialize books whose EPUB exists on this device; the data stays in the sync file either way.
      if (!book || !(this.host.app.vault.getAbstractFileByPath(path) instanceof TFile)) continue;
      const state = this.host.store.getBook(path) ?? this.host.store.ensureBook(path, { size: 0, mtime: 0 });
      const change = applySyncedBook(path, state, book, this.deviceId);
      if (hasVisibleChanges(change)) changes.push(change);
    }
    if (!changes.length) return;
    this.applying = true;
    try {
      this.host.store.markChanged(0, "progress");
    } finally {
      this.applying = false;
    }
    this.host.onSyncedBookChanges(changes);
  }

  private async writeOwnDocument(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const books = canonicalJson(doc.books);
    if (books === this.lastWrittenBooks) {
      this.localPending = false;
      return;
    }
    // Keep this device's own copy at least as new as what its sync file says.
    await this.host.store.flush();
    doc.updatedAt = Date.now();
    const content = canonicalJson(doc);
    const vault = this.host.app.vault;
    await ensureVaultFolder(vault, this.folder);
    const path = this.ownPath();
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await vault.modify(existing, content);
    else if (!existing) await vault.create(path, content);
    else throw new Error(`The reading sync path is not a file: ${path}`);
    this.lastWrittenBooks = books;
    this.localPending = false;
  }

  private async readOwnDocument(): Promise<SyncDocument | null> {
    const file = this.host.app.vault.getAbstractFileByPath(this.ownPath());
    if (!(file instanceof TFile)) return null;
    const doc = parseSyncDocument(await this.host.app.vault.read(file));
    return doc && doc.deviceId === this.deviceId ? doc : null;
  }

  private async readOtherDocuments(): Promise<SyncDocument[]> {
    const folder = this.host.app.vault.getAbstractFileByPath(this.folder);
    if (!(folder instanceof TFolder)) return [];
    const docs: SyncDocument[] = [];
    for (const child of folder.children) {
      if (!(child instanceof TFile) || !this.isOtherDeviceFile(child)) continue;
      const doc = parseSyncDocument(await this.host.app.vault.read(child));
      if (doc && doc.deviceId !== this.deviceId) docs.push(doc);
    }
    return docs;
  }

  private isOtherDeviceFile(file: TFile): boolean {
    return file.extension.toLowerCase() === "json"
      && file.parent?.path === this.folder
      && file.path !== this.ownPath();
  }

  private ownPath(): string {
    return normalizePath(`${this.folder}/${this.deviceId}.json`);
  }

  private loadDeviceId(): string {
    const stored: unknown = this.host.app.loadLocalStorage(DEVICE_ID_KEY);
    if (typeof stored === "string" && /^[0-9a-f]{16}$/.test(stored)) return stored;
    const id = createDeviceId();
    this.host.app.saveLocalStorage(DEVICE_ID_KEY, id);
    return id;
  }
}
