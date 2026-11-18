import { DEFAULT_SETTINGS, SHARED_SETTING_KEYS, createDefaultData, isSharedSettingKey, normalizeSettings, type SharedSettingKey } from "./defaults";
import type {
  AnnotationDocuments,
  BookState,
  Bookmark,
  ReaderData,
  ReaderHighlight,
  ReadingStats,
  ReaderSettings,
  ReadingPosition,
  SourceSignature,
} from "./types";
import { isNoteLayout } from "./note-layout";
import { normalizeColorNames, normalizeColorOrder, normalizeExtraColors, toHighlightColor } from "./highlight-colors";
import { isValidCfi, normalizeVaultPath } from "./utils";

export interface DataAdapter {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export interface LegacyDataEntry {
  path: string;
  value: unknown;
}

const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const fraction = (value: unknown): number => Math.min(1, Math.max(0, finite(value)));

function normalizePosition(value: unknown): ReadingPosition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<ReadingPosition>;
  if (!isValidCfi(input.cfi)) return undefined;
  const page = typeof input.page === "string" && input.page.trim() ? input.page.trim().slice(0, 50) : "";
  return {
    cfi: input.cfi.trim(),
    fraction: fraction(input.fraction),
    updatedAt: finite(input.updatedAt, Date.now()),
    ...(page ? { page } : {}),
  };
}

/** A positive finite edit time, or undefined. */
function editTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Deletion tombstones by id: `{ id: deletedAt }`. */
function normalizeTombstones(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => Boolean(entry[0]) && editTime(entry[1]) !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeBookmark(value: unknown): Bookmark | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<Bookmark>;
  if (!isValidCfi(input.cfi) || typeof input.id !== "string") return null;
  return {
    id: input.id,
    cfi: input.cfi.trim(),
    fraction: fraction(input.fraction),
    chapter: typeof input.chapter === "string" ? input.chapter : "Untitled chapter",
    createdAt: finite(input.createdAt, Date.now()),
    updatedAt: editTime(input.updatedAt),
    stale: input.stale === true || undefined,
  };
}

function normalizeHighlight(value: unknown): ReaderHighlight | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ReaderHighlight>;
  if (!isValidCfi(input.cfi) || typeof input.id !== "string" || typeof input.text !== "string") return null;
  const styles = new Set(["highlight", "underline", "strikethrough", "squiggly"]);
  const tags = Array.isArray(input.tags)
    ? Array.from(new Set(input.tags
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.replace(/\s+/g, " ").trim().slice(0, 50))
      .filter(Boolean)))
      .slice(0, 20)
    : [];
  return {
    id: input.id,
    cfi: input.cfi.trim(),
    text: input.text.slice(0, 10000),
    chapter: typeof input.chapter === "string" ? input.chapter : "Untitled chapter",
    color: toHighlightColor(input.color),
    style: styles.has(String(input.style)) ? input.style as ReaderHighlight["style"] : "highlight",
    tags,
    sectionIndex: Math.max(0, Math.round(finite(input.sectionIndex))),
    createdAt: finite(input.createdAt, Date.now()),
    page: typeof input.page === "string" && input.page.trim()
      ? input.page.trim().slice(0, 50)
      : undefined,
    lookup: input.lookup === true || undefined,
    quote: input.quote === true || undefined,
    note: typeof input.note === "string" && input.note.trim()
      ? input.note.trim().slice(0, 20000)
      : undefined,
    noteUpdatedAt: typeof input.noteUpdatedAt === "number" && Number.isFinite(input.noteUpdatedAt)
      ? input.noteUpdatedAt
      : undefined,
    updatedAt: editTime(input.updatedAt),
    stale: input.stale === true || undefined,
  };
}

function normalizeAnnotationDocuments(value: unknown): AnnotationDocuments | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<AnnotationDocuments>;
  const highlightPath = normalizeVaultPath(input.highlightPath ?? "");
  const notePath = normalizeVaultPath(input.notePath ?? "");
  if (!highlightPath.toLowerCase().endsWith(".md") || !notePath.toLowerCase().endsWith(".md")) return undefined;
  return {
    highlightPath,
    notePath,
    createdDate: typeof input.createdDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.createdDate)
      ? input.createdDate
      : "",
  };
}

function normalizeReadingStats(value: unknown): ReadingStats | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<ReadingStats>;
  const totalReadingMs = Math.max(0, finite(input.totalReadingMs));
  const lastOpenedAt = Math.max(0, finite(input.lastOpenedAt));
  const lastReadAt = Math.max(0, finite(input.lastReadAt));
  const furthestFraction = fraction(input.furthestFraction);
  const completedAt = Math.max(0, finite(input.completedAt));
  const completedUpdatedAt = editTime(input.completedUpdatedAt);
  const deviceReadingMs = typeof input.deviceReadingMs === "number" && Number.isFinite(input.deviceReadingMs) && input.deviceReadingMs >= 0
    ? input.deviceReadingMs : undefined;
  const unrecordedReadingMs = editTime(input.unrecordedReadingMs);
  if (!totalReadingMs && !lastOpenedAt && !lastReadAt && !furthestFraction && !completedAt && !completedUpdatedAt) return undefined;
  return {
    totalReadingMs,
    lastOpenedAt,
    lastReadAt,
    furthestFraction,
    ...(completedAt ? { completedAt } : {}),
    ...(completedUpdatedAt ? { completedUpdatedAt } : {}),
    ...(deviceReadingMs !== undefined ? { deviceReadingMs } : {}),
    ...(unrecordedReadingMs ? { unrecordedReadingMs } : {}),
  };
}

/** A book's layout-related settings: heading order, color names and added colors, and when they changed. */
function noteSettings(input: Partial<BookState>): Partial<BookState> {
  const colorOrder = normalizeColorOrder(input.colorOrder);
  const colorNames = normalizeColorNames(input.colorNames);
  const extraColors = normalizeExtraColors(input.extraColors);
  const updatedAt = finite(input.noteSettingsUpdatedAt);
  return {
    ...(colorOrder.length ? { colorOrder } : {}),
    ...(Object.keys(colorNames).length ? { colorNames } : {}),
    ...(extraColors.length ? { extraColors } : {}),
    ...(updatedAt > 0 ? { noteSettingsUpdatedAt: updatedAt } : {}),
  };
}

function normalizeBookState(value: unknown): BookState {
  const input = value && typeof value === "object" ? value as Partial<BookState> : {};
  const signature = input.sourceSignature && typeof input.sourceSignature === "object"
    ? input.sourceSignature
    : { size: 0, mtime: 0 };
  const position = normalizePosition(input.position);
  const annotationDocuments = normalizeAnnotationDocuments(input.annotationDocuments);
  const readingStats = normalizeReadingStats(input.readingStats);
  const deletedHighlights = normalizeTombstones(input.deletedHighlights);
  const deletedBookmarks = normalizeTombstones(input.deletedBookmarks);
  const normalizedCoverPath = normalizeVaultPath(input.customCoverPath ?? "");
  const customCoverPath = /^(?:[A-Za-z]:|\/)/.test(normalizedCoverPath) ? "" : normalizedCoverPath;
  return {
    sourceSignature: {
      size: Math.max(0, finite(signature.size)),
      mtime: Math.max(0, finite(signature.mtime)),
    },
    ...(position ? { position } : {}),
    bookmarks: Array.isArray(input.bookmarks)
      ? input.bookmarks.map(normalizeBookmark).filter((item): item is Bookmark => item !== null)
      : [],
    highlights: Array.isArray(input.highlights)
      ? input.highlights.map(normalizeHighlight).filter((item): item is ReaderHighlight => item !== null)
      : [],
    ...(annotationDocuments ? { annotationDocuments } : {}),
    ...(isNoteLayout(input.noteLayout) ? { noteLayout: input.noteLayout } : {}),
    ...noteSettings(input),
    ...(readingStats ? { readingStats } : {}),
    ...(deletedHighlights ? { deletedHighlights } : {}),
    ...(deletedBookmarks ? { deletedBookmarks } : {}),
    ...(input.hiddenFromBookshelf === true ? { hiddenFromBookshelf: true } : {}),
    ...(input.inReadingList === true ? { inReadingList: true } : {}),
    ...(customCoverPath ? { customCoverPath } : {}),
  };
}

/** Union of two tombstone sets, keeping the later deletion time for each id. */
function mergeTombstones(left?: Record<string, number>, right?: Record<string, number>): Record<string, number> | undefined {
  const merged: Record<string, number> = { ...left };
  for (const [id, deletedAt] of Object.entries(right ?? {})) merged[id] = Math.max(merged[id] ?? 0, deletedAt);
  return Object.keys(merged).length ? merged : undefined;
}

function mergeById<T extends { id: string }>(legacy: T[], current: T[]): T[] {
  return Array.from(new Map([...legacy, ...current].map((item) => [item.id, item])).values());
}

function mergeReadingStats(current?: ReadingStats, legacy?: ReadingStats): ReadingStats | undefined {
  if (!current) return legacy;
  if (!legacy) return current;
  const completedAt = [current.completedAt, legacy.completedAt]
    .filter((value): value is number => typeof value === "number" && value > 0)
    .sort((left, right) => left - right)[0];
  return {
    totalReadingMs: Math.max(current.totalReadingMs, legacy.totalReadingMs),
    lastOpenedAt: Math.max(current.lastOpenedAt, legacy.lastOpenedAt),
    lastReadAt: Math.max(current.lastReadAt, legacy.lastReadAt),
    furthestFraction: Math.max(current.furthestFraction, legacy.furthestFraction),
    ...(completedAt ? { completedAt } : {}),
  };
}

export function mergeReaderData(currentValue: unknown, legacyValue: unknown): ReaderData {
  const current = normalizeReaderData(currentValue);
  const legacy = normalizeReaderData(legacyValue);
  const books = structuredClone(current.books);
  for (const [path, legacyState] of Object.entries(legacy.books)) {
    const currentState = books[path];
    if (!currentState) {
      books[path] = structuredClone(legacyState);
      continue;
    }
    const position = [currentState.position, legacyState.position]
      .filter((item): item is ReadingPosition => Boolean(item))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    const currentSignatureIsEmpty = currentState.sourceSignature.size === 0 && currentState.sourceSignature.mtime === 0;
    books[path] = {
      sourceSignature: currentSignatureIsEmpty ? legacyState.sourceSignature : currentState.sourceSignature,
      ...(position ? { position } : {}),
      bookmarks: mergeById(legacyState.bookmarks, currentState.bookmarks),
      highlights: mergeById(legacyState.highlights, currentState.highlights),
      annotationDocuments: currentState.annotationDocuments ?? legacyState.annotationDocuments,
      ...(currentState.noteLayout ?? legacyState.noteLayout ? { noteLayout: currentState.noteLayout ?? legacyState.noteLayout } : {}),
      ...noteSettings(currentState.noteSettingsUpdatedAt ? currentState : legacyState.noteSettingsUpdatedAt ? legacyState : currentState),
      readingStats: mergeReadingStats(currentState.readingStats, legacyState.readingStats),
      deletedHighlights: mergeTombstones(currentState.deletedHighlights, legacyState.deletedHighlights),
      deletedBookmarks: mergeTombstones(currentState.deletedBookmarks, legacyState.deletedBookmarks),
      ...(currentState.hiddenFromBookshelf || legacyState.hiddenFromBookshelf ? { hiddenFromBookshelf: true } : {}),
      ...(currentState.inReadingList || legacyState.inReadingList ? { inReadingList: true } : {}),
      customCoverPath: currentState.customCoverPath ?? legacyState.customCoverPath,
    };
  }
  return { ...current, books };
}

export function normalizeReaderData(value: unknown): ReaderData {
  if (!value || typeof value !== "object") return createDefaultData();
  const input = value as Partial<ReaderData> & { schemaVersion?: number };
  const books: Record<string, BookState> = {};
  if (input.books && typeof input.books === "object") {
    for (const [path, state] of Object.entries(input.books)) {
      const normalizedPath = normalizeVaultPath(path);
      if (normalizedPath) books[normalizedPath] = normalizeBookState(state);
    }
  }
  const previousSettings: Partial<ReaderSettings> = input.settings && typeof input.settings === "object" ? input.settings : {};
  const migrateLegacyTypography = (input.schemaVersion ?? 0) < 4;
  const migratedSettings = migrateLegacyTypography ? {
    ...previousSettings,
    font: previousSettings.font === "publisher" ? "obsidian" : previousSettings.font,
    lineHeight: previousSettings.lineHeight === 1.6 ? 1.7 : previousSettings.lineHeight,
    contentWidth: previousSettings.contentWidth === 760 ? 720 : previousSettings.contentWidth,
    pageMargin: previousSettings.pageMargin === 32 ? 48 : previousSettings.pageMargin,
  } : previousSettings;
  return {
    schemaVersion: 5,
    settings: normalizeSettings(migratedSettings),
    books,
    importedLegacyDataPaths: Array.isArray(input.importedLegacyDataPaths)
      ? Array.from(new Set(input.importedLegacyDataPaths
        .filter((path): path is string => typeof path === "string")
        .map(normalizeVaultPath)
        .filter(Boolean)))
        .slice(0, 50)
      : [],
  };
}

/** Where this device keeps its own book state. Never a synced location. */
export interface BookStorage {
  /** The stored books, or null when this device has never stored any (first run of this version). */
  load(): Promise<unknown>;
  save(books: Record<string, BookState>): Promise<void>;
}

/** Per-device key-value storage (Obsidian's `app.loadLocalStorage` / `saveLocalStorage`). */
export interface DeviceStorage {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
}

export interface StoreOptions {
  books?: BookStorage;
  device?: DeviceStorage;
  /** Whether this device runs background tasks unless told otherwise (on for desktop, off for mobile). */
  defaultBackgroundTasks?: boolean;
}

/** What a data change was, so listeners can tell user edits from reading progress. */
export type ChangeKind = "edit" | "progress";

const DEVICE_SETTINGS_KEY = "omni-book-reader-mod-device-settings";
const BACKGROUND_TASKS_KEY = "omni-book-reader-mod-background-tasks";
const IMPORTED_LEGACY_KEY = "omni-book-reader-mod-imported-legacy-data";
const BOOKS_SAVE_DELAY_MS = 1000;

export function memoryBookStorage(): BookStorage {
  let stored: unknown = null;
  return {
    load: async () => stored === null ? null : structuredClone(stored),
    save: async (books) => {
      stored = structuredClone(books);
    },
  };
}

export function memoryDeviceStorage(): DeviceStorage {
  const values = new Map<string, unknown>();
  return {
    load: (key) => values.get(key) ?? null,
    save: (key, value) => void values.set(key, value),
  };
}

type SharedSettings = Pick<ReaderSettings, SharedSettingKey>;
type SharedTimes = Partial<Record<SharedSettingKey, number>>;

function sharedPart(settings: ReaderSettings): SharedSettings {
  return Object.fromEntries(SHARED_SETTING_KEYS.map((key) => [key, settings[key]])) as SharedSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sharedTimes(value: unknown): SharedTimes {
  const times: SharedTimes = {};
  if (!isRecord(value)) return times;
  for (const key of SHARED_SETTING_KEYS) {
    const time = value[key];
    if (typeof time === "number" && Number.isFinite(time) && time > 0) times[key] = time;
  }
  return times;
}

/** Sorted-key JSON, so equal content always compares equal. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => isRecord(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item);
}

/**
 * Merges shared settings from two copies, per key, keeping the later edit. A key with no edit time on
 * either side (written by an older version) takes `incoming`'s value: it is the copy a person changed
 * on another device. Returns the merged values and times.
 */
export function mergeSharedSettings(
  current: SharedSettings,
  currentTimes: SharedTimes,
  incoming: SharedSettings,
  incomingTimes: SharedTimes,
): { settings: SharedSettings; times: SharedTimes } {
  const settings = { ...current } as Record<SharedSettingKey, unknown>;
  const times: SharedTimes = { ...currentTimes };
  for (const key of SHARED_SETTING_KEYS) {
    const incomingTime = incomingTimes[key] ?? 0;
    if (incomingTime >= (currentTimes[key] ?? 0)) {
      settings[key] = incoming[key];
      if (incomingTime) times[key] = incomingTime;
    }
  }
  return { settings: settings as SharedSettings, times };
}

/**
 * Reader data, split by who may see it:
 * - shared settings live in `data.json`, which Obsidian Sync copies between devices. It is written only
 *   when a shared setting changes, always by re-reading it from disk and merging per key by edit time,
 *   and never when nothing changed. Any `books` an older version stored there is left untouched.
 * - this device's settings live in local storage (never synced).
 * - book state (positions, highlights, stats) lives in this device's own storage and reaches other
 *   devices only through the per-device reading-sync files.
 */
export class ReaderDataStore {
  private books: Record<string, BookState> = {};
  private shared: SharedSettings = sharedPart(DEFAULT_SETTINGS);
  private sharedEditTimes: SharedTimes = {};
  private device: ReaderSettings = { ...DEFAULT_SETTINGS };
  private combined: ReaderSettings = { ...DEFAULT_SETTINGS };
  private importedLegacyDataPaths: string[] = [];
  private backgroundTasks: boolean;
  private booksTimer: number | null = null;
  private booksDirty = false;
  private booksSaveChain: Promise<void> = Promise.resolve();
  private settingsSaveChain: Promise<void> = Promise.resolve();
  private readonly changeListeners = new Set<(kind: ChangeKind) => void>();
  private readonly bookStorage: BookStorage;
  private readonly deviceStorage: DeviceStorage;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly onError: (error: unknown) => void = console.error,
    options: StoreOptions = {},
  ) {
    this.bookStorage = options.books ?? memoryBookStorage();
    this.deviceStorage = options.device ?? memoryDeviceStorage();
    this.backgroundTasks = options.defaultBackgroundTasks ?? false;
  }

  /** Loads everything. Writes nothing to `data.json`; a first run of this version seeds local storage once. */
  async load(): Promise<void> {
    let disk: unknown = null;
    try {
      disk = await this.adapter.loadData();
    } catch (error) {
      this.onError(error);
    }
    const legacy = normalizeReaderData(disk);
    const diskSettings = isRecord(disk) && isRecord(disk.settings) ? disk.settings : {};
    this.shared = sharedPart(normalizeSettings({ ...DEFAULT_SETTINGS, ...diskSettings }));
    this.sharedEditTimes = isRecord(disk) ? sharedTimes(disk.settingsUpdatedAt) : {};

    const storedDevice = this.deviceStorage.load(DEVICE_SETTINGS_KEY);
    if (isRecord(storedDevice)) {
      this.device = normalizeSettings(storedDevice);
    } else {
      // First run of this version on this device: start from what data.json held.
      this.device = legacy.settings;
      this.deviceStorage.save(DEVICE_SETTINGS_KEY, this.device);
    }
    const background = this.deviceStorage.load(BACKGROUND_TASKS_KEY);
    if (typeof background === "boolean") this.backgroundTasks = background;
    const imported = this.deviceStorage.load(IMPORTED_LEGACY_KEY);
    this.importedLegacyDataPaths = Array.isArray(imported)
      ? imported.filter((path): path is string => typeof path === "string")
      : legacy.importedLegacyDataPaths;

    let storedBooks: unknown = null;
    let loadFailed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        storedBooks = await this.bookStorage.load();
        loadFailed = false;
        break;
      } catch (error) {
        loadFailed = true;
        if (attempt) this.onError(error);
      }
    }
    if (loadFailed) {
      // This device's storage is unreadable: read from data.json's copy, but do not overwrite storage
      // that may still hold newer data until something actually changes.
      this.books = legacy.books;
    } else if (storedBooks === null || storedBooks === undefined) {
      // First run of this version on this device: take the books data.json held. Stale or foreign
      // copies are harmless: merging uses edit times and explicit tombstones, never this snapshot.
      this.books = legacy.books;
      this.booksDirty = true;
      void this.persistBooks();
    } else {
      this.books = normalizeReaderData({ books: storedBooks }).books;
    }
    this.rebuildSettings();
  }

  mergeLegacyData(entries: readonly LegacyDataEntry[]): number {
    const imported = new Set(this.importedLegacyDataPaths);
    let importedCount = 0;
    for (const entry of entries) {
      const path = normalizeVaultPath(entry.path);
      if (!path || imported.has(path)) continue;
      const isFreshInstall = !imported.size && !importedCount && !Object.keys(this.books).length;
      this.books = mergeReaderData({ books: this.books }, entry.value).books;
      if (isFreshInstall) {
        // Take over the earlier install's reader settings, but keep this plugin's own sync folder
        // so it never shares sync files with the original plugin.
        const settings = normalizeReaderData(entry.value).settings;
        this.device = { ...settings, syncFolder: this.device.syncFolder };
        this.deviceStorage.save(DEVICE_SETTINGS_KEY, this.device);
        const { syncFolder: _syncFolder, ...rest } = sharedPart(settings);
        this.shared = { ...this.shared, ...rest };
        this.rebuildSettings();
      }
      imported.add(path);
      importedCount += 1;
    }
    if (!importedCount) return 0;
    this.importedLegacyDataPaths = [...imported];
    this.deviceStorage.save(IMPORTED_LEGACY_KEY, this.importedLegacyDataPaths);
    this.markChanged(0);
    return importedCount;
  }

  get settings(): ReaderSettings {
    return this.combined;
  }

  get snapshot(): ReaderData {
    return structuredClone({
      schemaVersion: 5,
      settings: this.combined,
      books: this.books,
      importedLegacyDataPaths: this.importedLegacyDataPaths,
    });
  }

  /** Whether this device runs background work (book notes, migrations). Stored per device. */
  get runBackgroundTasks(): boolean {
    return this.backgroundTasks;
  }

  setRunBackgroundTasks(value: boolean): void {
    this.backgroundTasks = value;
    this.deviceStorage.save(BACKGROUND_TASKS_KEY, value);
  }

  updateSettings(patch: Partial<ReaderSettings>): ReaderSettings {
    const next = normalizeSettings({ ...this.combined, ...patch });
    const deviceChanged = (Object.keys(patch) as Array<keyof ReaderSettings>)
      .some((key) => !isSharedSettingKey(key) && next[key] !== this.device[key]);
    if (deviceChanged) {
      this.device = { ...next };
      this.deviceStorage.save(DEVICE_SETTINGS_KEY, this.device);
    }
    const now = Date.now();
    let sharedChanged = false;
    for (const key of SHARED_SETTING_KEYS) {
      if (key in patch && next[key] !== this.shared[key]) {
        (this.shared as Record<SharedSettingKey, unknown>)[key] = next[key];
        this.sharedEditTimes[key] = now;
        sharedChanged = true;
      }
    }
    this.rebuildSettings();
    if (sharedChanged) void this.saveSharedSettings();
    return this.combined;
  }

  /**
   * `data.json` changed on disk (another device's settings arrived through Sync). Merges it with the
   * in-memory shared settings per key by edit time. Returns true when the settings in use changed.
   * Writes back only if this device holds newer edits than the disk copy.
   */
  async reloadSharedSettings(): Promise<boolean> {
    let disk: unknown;
    try {
      disk = await this.adapter.loadData();
    } catch (error) {
      this.onError(error);
      return false;
    }
    if (!isRecord(disk)) return false;
    const diskShared = sharedPart(normalizeSettings({ ...DEFAULT_SETTINGS, ...(isRecord(disk.settings) ? disk.settings : {}) }));
    const diskTimes = sharedTimes(disk.settingsUpdatedAt);
    const merged = mergeSharedSettings(this.shared, this.sharedEditTimes, diskShared, diskTimes);
    const changed = stableJson(merged.settings) !== stableJson(this.shared);
    this.shared = merged.settings;
    this.sharedEditTimes = merged.times;
    if (changed) this.rebuildSettings();
    if (stableJson(merged.settings) !== stableJson(diskShared) || stableJson(merged.times) !== stableJson(diskTimes)) {
      await this.saveSharedSettings();
    }
    return changed;
  }

  /** Read, merge, write: re-reads `data.json`, merges shared settings into it, writes only if it changes. */
  private saveSharedSettings(): Promise<void> {
    this.settingsSaveChain = this.settingsSaveChain
      .catch(() => undefined)
      .then(async () => {
        const disk = await this.adapter.loadData();
        const base = isRecord(disk) ? disk : {};
        const diskSettings = isRecord(base.settings) ? base.settings : {};
        const diskShared = sharedPart(normalizeSettings({ ...DEFAULT_SETTINGS, ...diskSettings }));
        const merged = mergeSharedSettings(diskShared, sharedTimes(base.settingsUpdatedAt), this.shared, this.sharedEditTimes);
        this.shared = merged.settings;
        this.sharedEditTimes = merged.times;
        this.rebuildSettings();
        // Keep everything else on disk as it is, including a `books` key older versions still use.
        const next = {
          ...base,
          settings: { ...diskSettings, ...merged.settings },
          settingsUpdatedAt: merged.times,
        };
        if (stableJson(next) === stableJson(base)) return;
        await this.adapter.saveData(next);
      })
      .catch((error) => this.onError(error));
    return this.settingsSaveChain;
  }

  private rebuildSettings(): void {
    this.combined = { ...this.device, ...this.shared };
  }

  ensureBook(path: string, signature: SourceSignature): BookState {
    const key = normalizeVaultPath(path);
    let state = this.books[key];
    if (!state) {
      state = normalizeBookState({ sourceSignature: signature });
      this.books[key] = state;
      this.markChanged(100, "progress");
    } else if (state.sourceSignature.size !== signature.size || state.sourceSignature.mtime !== signature.mtime) {
      state.sourceSignature = { ...signature };
      this.markChanged(100, "progress");
    }
    return state;
  }

  getBook(path: string): BookState | undefined {
    return this.books[normalizeVaultPath(path)];
  }

  /** Live book states keyed by vault path. Mutations must be followed by `markChanged`. */
  liveBooks(): Array<[string, BookState]> {
    return Object.entries(this.books);
  }

  /** Registers a listener for data changes. Returns an unsubscribe function. */
  onChange(listener: (kind: ChangeKind) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  renameBook(oldPath: string, newPath: string): void {
    const oldKey = normalizeVaultPath(oldPath);
    const newKey = normalizeVaultPath(newPath);
    if (!oldKey || !newKey || oldKey === newKey) return;
    const oldState = this.books[oldKey];
    if (!oldState) return;
    const existing = this.books[newKey];
    this.books[newKey] = existing ? {
      sourceSignature: oldState.sourceSignature,
      position: [oldState.position, existing.position]
        .filter((item): item is ReadingPosition => Boolean(item))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0],
      bookmarks: mergeById(existing.bookmarks, oldState.bookmarks),
      highlights: mergeById(existing.highlights, oldState.highlights),
      annotationDocuments: oldState.annotationDocuments ?? existing.annotationDocuments,
      noteLayout: oldState.noteLayout ?? existing.noteLayout,
      colorOrder: oldState.colorOrder ?? existing.colorOrder,
      colorNames: oldState.colorNames ?? existing.colorNames,
      extraColors: oldState.extraColors ?? existing.extraColors,
      noteSettingsUpdatedAt: oldState.noteSettingsUpdatedAt ?? existing.noteSettingsUpdatedAt,
      hiddenFromBookshelf: oldState.hiddenFromBookshelf ?? existing.hiddenFromBookshelf,
      inReadingList: oldState.inReadingList ?? existing.inReadingList,
      customCoverPath: oldState.customCoverPath ?? existing.customCoverPath,
      readingStats: [oldState.readingStats, existing.readingStats]
        .filter((item): item is ReadingStats => Boolean(item))
        .sort((a, b) => b.lastReadAt - a.lastReadAt)[0],
      deletedHighlights: mergeTombstones(existing.deletedHighlights, oldState.deletedHighlights),
      deletedBookmarks: mergeTombstones(existing.deletedBookmarks, oldState.deletedBookmarks),
    } : oldState;
    delete this.books[oldKey];
    this.markChanged(0);
  }

  removeBook(path: string): void {
    const key = normalizeVaultPath(path);
    if (!key || !this.books[key]) return;
    delete this.books[key];
    this.markChanged(0);
  }

  /**
   * Book state changed. It is saved to this device's own storage shortly after; listeners (reading
   * sync) decide when other devices hear about it. `kind` is "edit" for things a person changed
   * (highlights, bookmarks, settings of a book) and "progress" for reading position and time.
   */
  markChanged(delayMs = 250, kind: ChangeKind = "edit"): void {
    this.booksDirty = true;
    for (const listener of this.changeListeners) listener(kind);
    if (this.booksTimer !== null) window.clearTimeout(this.booksTimer);
    this.booksTimer = window.setTimeout(() => {
      this.booksTimer = null;
      void this.persistBooks();
    }, Math.max(delayMs, BOOKS_SAVE_DELAY_MS));
  }

  /** Saves book state to this device's own storage (never synced). */
  persist(): Promise<void> {
    return this.persistBooks();
  }

  private persistBooks(): Promise<void> {
    if (!this.booksDirty) return this.booksSaveChain;
    this.booksDirty = false;
    const snapshot = structuredClone(this.books);
    this.booksSaveChain = this.booksSaveChain
      .catch(() => undefined)
      .then(() => this.bookStorage.save(snapshot))
      .catch((error) => {
        this.booksDirty = true;
        this.onError(error);
      });
    return this.booksSaveChain;
  }

  async flush(): Promise<void> {
    if (this.booksTimer !== null) {
      window.clearTimeout(this.booksTimer);
      this.booksTimer = null;
    }
    await this.persistBooks();
    await this.booksSaveChain;
    await this.settingsSaveChain;
  }
}
