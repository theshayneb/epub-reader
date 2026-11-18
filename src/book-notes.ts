import { TFile } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import { mergeQuotes, quoteEntry, readQuotesFromFrontmatter, setQuotesInFrontmatter, QUOTES_PROPERTY } from "./annotation-documents";
import type { AnnotationDocumentService } from "./annotation-documents";
import type { DeviceStorage, ReaderDataStore } from "./store";
import type { BookState } from "./types";
import { progressValue } from "./utils";

/** Book note property that holds the page last read. */
export const PROGRESS_PROPERTY = "Progress";

/** Obsidian Sync counts as settled once the vault has been quiet this long after startup or resume. */
export const SETTLE_QUIET_MS = 60_000;
/** Book notes follow highlight edits after this pause... */
const EDIT_DELAY_MS = 5_000;
/** ...and reading progress at most this often. */
const PROGRESS_DELAY_MS = 120_000;
const QUOTES_KEY = "omni-book-reader-mod-generated-quotes";

interface QuoteRecord {
  /** Entries this device last wrote for the book; only these are ever removed. */
  generated: string[];
  /** Highlights whose entry was already in `Quotes` before highlights carried the quote flag. */
  adopted: string[];
}

export interface BookNoteHost {
  app: App;
  store: ReaderDataStore;
  annotationDocuments: AnnotationDocumentService;
  device: DeviceStorage;
  findBookNote(sourceFile: TFile): TFile | null;
  /** Rewrites links from earlier versions in book notes, once per start. */
  migrateLegacyLinks(): Promise<void>;
}

/**
 * Whether Obsidian's core Sync plugin says it is syncing right now. Uses undocumented internals, so
 * anything unexpected reads as "not syncing" and the quiet-vault rule alone decides.
 */
export function coreSyncBusy(app: App): boolean {
  try {
    const internal = (app as unknown as { internalPlugins?: { getPluginById?: (id: string) => unknown } }).internalPlugins;
    const plugin = internal?.getPluginById?.("sync") as { enabled?: boolean; instance?: Record<string, unknown> } | undefined;
    const instance = plugin?.enabled ? plugin.instance : undefined;
    if (!instance) return false;
    if (instance.syncing === true) return true;
    const status = typeof instance.getStatus === "function" ? (instance.getStatus as () => unknown).call(instance) : instance.syncStatus;
    return typeof status === "string" && status.toLowerCase() === "syncing";
  } catch {
    return false;
  }
}

/**
 * Tracks when Obsidian Sync has settled: no vault changes for `SETTLE_QUIET_MS` since startup or the
 * last resume, and the core Sync plugin not syncing.
 */
export class SyncSettleTracker {
  private quietSince: number;

  constructor(private readonly busy: () => boolean, private readonly now: () => number = Date.now) {
    this.quietSince = now();
  }

  /** A vault file changed, or the app started or resumed. */
  touch(): void {
    this.quietSince = this.now();
  }

  /** Milliseconds until settled, or 0 when settled now. */
  remaining(): number {
    const left = this.quietSince + SETTLE_QUIET_MS - this.now();
    if (left > 0) return left;
    return this.busy() ? SETTLE_QUIET_MS / 4 : 0;
  }
}

/**
 * Keeps book notes (the highlights callout or by-color region, `Progress` and `Quotes`) in step with
 * every device's reading data. Runs only on the device with "Run background tasks on this device" on,
 * and only after Obsidian Sync settles, so a note is only ever written by one device. Every write is
 * skipped when the note already says the same thing.
 */
export class BookNoteUpdater {
  private timer: number | null = null;
  private dueAt = 0;
  private running: Promise<void> = Promise.resolve();
  private migrated = false;
  private readonly settle: SyncSettleTracker;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly host: BookNoteHost) {
    this.settle = new SyncSettleTracker(() => coreSyncBusy(host.app));
  }

  get enabled(): boolean {
    return this.host.store.runBackgroundTasks;
  }

  start(): void {
    this.unsubscribe ??= this.host.store.onChange((kind) => this.schedule(kind === "edit" ? EDIT_DELAY_MS : PROGRESS_DELAY_MS));
    this.settle.touch();
    this.schedule(0);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = 0;
  }

  /** The app came back to the foreground: Sync may now bring a backlog, so wait for it again. */
  resumed(): void {
    this.settle.touch();
    if (this.timer !== null) this.schedule(0);
  }

  /** Vault event handler. Changes to other files restart the quiet period. */
  vaultChanged(_file: TAbstractFile): void {
    this.settle.touch();
  }

  /** Books changed by another device's sync file. */
  booksChanged(): void {
    this.schedule(EDIT_DELAY_MS);
  }

  /** Writes now (after a local edit made on this device), without waiting for the debounce. */
  updateNow(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = 0;
    return this.enqueuePass();
  }

  private schedule(delayMs: number): void {
    if (!this.enabled || !this.unsubscribe) return;
    const due = Date.now() + delayMs;
    if (this.timer !== null && this.dueAt <= due) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.dueAt = due;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.dueAt = 0;
      const wait = this.settle.remaining();
      if (wait > 0) {
        this.schedule(wait);
        return;
      }
      void this.enqueuePass();
    }, Math.max(0, delayMs));
  }

  private enqueuePass(): Promise<void> {
    this.running = this.running
      .catch(() => undefined)
      .then(() => this.pass())
      .catch((error) => console.error("[Omni Book Reader] Could not update book notes", error));
    return this.running;
  }

  private async pass(): Promise<void> {
    if (!this.enabled) return;
    if (!this.migrated) {
      this.migrated = true;
      await this.host.migrateLegacyLinks();
    }
    let stateChanged = false;
    for (const [path, state] of this.host.store.liveBooks()) {
      const file = this.host.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const note = this.host.findBookNote(file);
      if (!note) continue;
      if (await this.updateNote(file, note, state)) stateChanged = true;
    }
    if (stateChanged) this.host.store.markChanged(0, "progress");
  }

  /** Brings one book note up to date. True when the book state itself was changed (layout, paths). */
  private async updateNote(file: TFile, note: TFile, state: BookState): Promise<boolean> {
    const before = JSON.stringify([state.annotationDocuments, state.noteLayout, state.colorOrder]);
    if (state.highlights.length || state.annotationDocuments || state.noteLayout) {
      await this.host.annotationDocuments.sync({ sourceFile: file, state, title: file.basename, author: "", interactive: false });
    }
    await this.host.annotationDocuments.updateNote(note, (content) => {
      let next = content;
      const quotes = this.quotesFor(file.path, state, content);
      if (quotes) {
        const updated = setQuotesInFrontmatter(next, quotes);
        if (updated !== null) next = updated;
      }
      const page = state.position?.page;
      if (page) next = setProgressInFrontmatter(next, progressValue(page));
      return next;
    });
    return JSON.stringify([state.annotationDocuments, state.noteLayout, state.colorOrder]) !== before;
  }

  /** The note's new `Quotes` list, or null when nothing about it is managed here. */
  private quotesFor(path: string, state: BookState, content: string): string[] | null {
    const records = this.loadQuoteRecords();
    const record = records[path] ?? { generated: [], adopted: [] };
    const current = readQuotesFromFrontmatter(content) ?? [];
    const currentSet = new Set(current);
    const adopted = new Set(record.adopted);
    // Highlights added to Quotes before highlights carried the flag: adopt them once, so deleting
    // the highlight later also removes its entry.
    for (const highlight of state.highlights) {
      if (!highlight.quote && !adopted.has(highlight.id) && currentSet.has(quoteEntry(highlight))) adopted.add(highlight.id);
    }
    const wanted = [...new Set(state.highlights
      .filter((highlight) => highlight.quote || adopted.has(highlight.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((highlight) => quoteEntry(highlight)))];
    const liveIds = new Set(state.highlights.map((highlight) => highlight.id));
    const nextRecord: QuoteRecord = { generated: wanted, adopted: [...adopted].filter((id) => liveIds.has(id)).sort() };
    if (JSON.stringify(nextRecord) !== JSON.stringify(record)) {
      if (nextRecord.generated.length || nextRecord.adopted.length) records[path] = nextRecord;
      else delete records[path];
      this.host.device.save(QUOTES_KEY, records);
    }
    if (!wanted.length && !record.generated.length) return null;
    return mergeQuotes(current, wanted, record.generated);
  }

  private loadQuoteRecords(): Record<string, QuoteRecord> {
    const value = this.host.device.load(QUOTES_KEY);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const records: Record<string, QuoteRecord> = {};
    for (const [path, record] of Object.entries(value as Record<string, unknown>)) {
      if (!record || typeof record !== "object") continue;
      const { generated, adopted } = record as Partial<QuoteRecord>;
      records[path] = {
        generated: Array.isArray(generated) ? generated.filter((item): item is string => typeof item === "string") : [],
        adopted: Array.isArray(adopted) ? adopted.filter((item): item is string => typeof item === "string") : [],
      };
    }
    return records;
  }
}

/**
 * Sets `Progress` in a note's frontmatter, leaving everything else as it is. A page number is written
 * as a number, a page label as a quoted string. Unchanged content when it already says so.
 */
export function setProgressInFrontmatter(content: string, value: number | string): string {
  const yaml = typeof value === "number" ? String(value) : JSON.stringify(value);
  const text = content.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/.exec(text);
  if (!match) return `---\n${PROGRESS_PROPERTY}: ${yaml}\n---\n${text}`;
  const lines = (match[1] ?? "").split("\n").filter((line, index, all) => line || index < all.length - 1);
  const keyPattern = new RegExp(`^${PROGRESS_PROPERTY}:(.*)$`);
  const index = lines.findIndex((line) => keyPattern.test(line));
  if (index >= 0) {
    const existing = (keyPattern.exec(lines[index] ?? "")?.[1] ?? "").trim();
    const existingValue = existing.startsWith("\"") || existing.startsWith("'") ? existing.slice(1, -1) : existing;
    if (existingValue === String(value)) return content;
    lines[index] = `${PROGRESS_PROPERTY}: ${yaml}`;
  } else {
    lines.push(`${PROGRESS_PROPERTY}: ${yaml}`);
  }
  return `---\n${lines.join("\n")}\n---\n${text.slice(match[0].length)}`;
}

export { QUOTES_PROPERTY };
