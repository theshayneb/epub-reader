import { describe, expect, it } from "vitest";
import { ReaderDataStore, memoryDeviceStorage, mergeReaderData, normalizeReaderData, type BookStorage, type DataAdapter } from "../src/store";

class CountingBooks implements BookStorage {
  value: unknown = null;
  saves = 0;
  active = 0;
  maxConcurrent = 0;

  async load(): Promise<unknown> {
    return this.value === null ? null : structuredClone(this.value);
  }

  async save(books: unknown): Promise<void> {
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    await Promise.resolve();
    this.value = structuredClone(books);
    this.saves += 1;
    this.active -= 1;
  }
}

class MemoryAdapter implements DataAdapter {
  value: unknown = null;
  saves: unknown[] = [];
  activeSaves = 0;
  maxConcurrentSaves = 0;

  async loadData(): Promise<unknown> {
    return this.value;
  }

  async saveData(data: unknown): Promise<void> {
    this.activeSaves += 1;
    this.maxConcurrentSaves = Math.max(this.maxConcurrentSaves, this.activeSaves);
    await Promise.resolve();
    this.saves.push(data);
    this.value = data;
    this.activeSaves -= 1;
  }
}

describe("reader data store", () => {
  it("normalizes persisted values and drops invalid CFIs", () => {
    const data = normalizeReaderData({
      schemaVersion: 3,
      settings: { theme: "dark", font: "publisher", fontSizePercent: 20, lineHeight: 1.6, contentWidth: 760, pageMargin: 32 },
      books: {
        "Books\\book.epub": {
          sourceSignature: { size: 100, mtime: 200 },
          position: { cfi: "not-a-cfi", fraction: 0.5, updatedAt: 1 },
          bookmarks: [
            { id: "b1", cfi: "epubcfi(/6/2!/4/2:0)", fraction: 2, chapter: "One", createdAt: 2 },
          ],
          highlights: [{
            id: "h1",
            cfi: "epubcfi(/6/2!/4/2:0)",
            text: "Excerpt",
            chapter: "Chapter 1",
            color: "blue",
            style: "invalid",
            tags: [" archetype ", "archetype", "social psychology"],
            sectionIndex: 1,
            createdAt: 3,
            page: "  42 ",
          }],
          annotationDocuments: {
            highlightPath: "Books\\book\\book-Highlight-2026-08-01.md",
            notePath: "Books\\book\\book-Note-2026-08-01.md",
            createdDate: "2026-08-01",
          },
          readingStats: {
            totalReadingMs: -10,
            lastOpenedAt: 100,
            lastReadAt: 120,
            furthestFraction: 2,
          },
        },
      },
    });
    expect(data.settings.fontSizePercent).toBe(80);
    expect(data.settings).toMatchObject({ font: "obsidian", lineHeight: 1.7, contentWidth: 720, pageMargin: 48 });
    expect(data.books["Books/book.epub"]?.position).toBeUndefined();
    expect(data.books["Books/book.epub"]?.bookmarks[0]?.fraction).toBe(1);
    expect(data.books["Books/book.epub"]?.annotationDocuments?.notePath).toBe("Books/book/book-Note-2026-08-01.md");
    expect(data.books["Books/book.epub"]?.highlights[0]?.style).toBe("highlight");
    expect(data.books["Books/book.epub"]?.highlights[0]?.tags).toEqual(["archetype", "social psychology"]);
    expect(data.books["Books/book.epub"]?.highlights[0]?.page).toBe("42");
    expect(data.books["Books/book.epub"]?.readingStats).toMatchObject({ totalReadingMs: 0, furthestFraction: 1 });
    expect(data.schemaVersion).toBe(5);
  });

  it("preserves book data when the source signature changes", async () => {
    const adapter = new MemoryAdapter();
    const store = new ReaderDataStore(adapter);
    await store.load();
    const state = store.ensureBook("Books/book.epub", { size: 100, mtime: 1 });
    state.bookmarks.push({
      id: "b1",
      cfi: "epubcfi(/6/2!/4/2:0)",
      fraction: 0.25,
      chapter: "Chapter 1",
      createdAt: 1,
    });
    store.markChanged(0);
    store.ensureBook("Books/book.epub", { size: 120, mtime: 2 });
    await store.flush();

    expect(store.getBook("Books/book.epub")?.sourceSignature).toEqual({ size: 120, mtime: 2 });
    expect(store.getBook("Books/book.epub")?.bookmarks).toHaveLength(1);
  });

  it("persists bookshelf-only metadata without trusting invalid cover paths", () => {
    const data = normalizeReaderData({
      books: {
        "Books/book.epub": {
          sourceSignature: { size: 1, mtime: 2 },
          bookmarks: [],
          highlights: [],
          hiddenFromBookshelf: true,
          inReadingList: true,
          customCoverPath: "C:\\outside.png",
        },
        "Books/cover.epub": {
          sourceSignature: { size: 1, mtime: 2 },
          bookmarks: [],
          highlights: [],
          customCoverPath: "Images\\cover.png",
        },
      },
    });

    expect(data.books["Books/book.epub"]).toMatchObject({ hiddenFromBookshelf: true, inReadingList: true });
    expect(data.books["Books/book.epub"]?.customCoverPath).toBeUndefined();
    expect(data.books["Books/cover.epub"]?.customCoverPath).toBe("Images/cover.png");
  });

  it("migrates state on rename and serializes overlapping saves", async () => {
    const adapter = new MemoryAdapter();
    const books = new CountingBooks();
    const store = new ReaderDataStore(adapter, console.error, { books });
    await store.load();
    store.ensureBook("Old/book.epub", { size: 1, mtime: 1 });
    const first = store.persist();
    store.renameBook("Old/book.epub", "New/book.epub");
    const second = store.persist();
    await Promise.all([first, second]);
    await store.flush();

    expect(store.getBook("Old/book.epub")).toBeUndefined();
    expect(store.getBook("New/book.epub")).toBeDefined();
    expect(books.maxConcurrent).toBe(1);
    expect(adapter.saves).toHaveLength(0);
  });

  it("merges data from a previous plugin folder without losing newer state", async () => {
    const merged = mergeReaderData({
      settings: { theme: "dark" },
      books: {
        "Books/shared.epub": {
          sourceSignature: { size: 10, mtime: 20 },
          position: { cfi: "epubcfi(/6/2!/4/2:2)", fraction: 0.8, updatedAt: 200 },
          bookmarks: [],
          highlights: [{
            id: "current-highlight",
            cfi: "epubcfi(/6/2!/4/2:2)",
            text: "Current",
            chapter: "Chapter",
            color: "yellow",
            style: "highlight",
            tags: [],
            sectionIndex: 0,
            createdAt: 200,
          }],
          readingStats: { totalReadingMs: 100, lastOpenedAt: 200, lastReadAt: 200, furthestFraction: 0.8 },
        },
      },
    }, {
      settings: { theme: "light" },
      books: {
        "Books/shared.epub": {
          sourceSignature: { size: 8, mtime: 10 },
          position: { cfi: "epubcfi(/6/2!/4/2:1)", fraction: 0.5, updatedAt: 100 },
          bookmarks: [{ id: "legacy-bookmark", cfi: "epubcfi(/6/2!/4/2:1)", fraction: 0.5, chapter: "Chapter", createdAt: 100 }],
          highlights: [],
          readingStats: { totalReadingMs: 300, lastOpenedAt: 100, lastReadAt: 100, furthestFraction: 0.5 },
        },
        "Books/legacy.epub": {
          sourceSignature: { size: 5, mtime: 6 },
          bookmarks: [],
          highlights: [],
        },
      },
    });

    expect(merged.settings.theme).toBe("dark");
    expect(merged.books["Books/shared.epub"]?.position?.fraction).toBe(0.8);
    expect(merged.books["Books/shared.epub"]?.bookmarks).toHaveLength(1);
    expect(merged.books["Books/shared.epub"]?.highlights).toHaveLength(1);
    expect(merged.books["Books/shared.epub"]?.readingStats).toMatchObject({
      totalReadingMs: 300,
      lastOpenedAt: 200,
      furthestFraction: 0.8,
    });
    expect(merged.books["Books/legacy.epub"]).toBeDefined();

    const adapter = new MemoryAdapter();
    adapter.value = merged;
    const store = new ReaderDataStore(adapter);
    await store.load();
    const legacyEntry = { path: ".obsidian/plugins/omni-reader/data.json", value: merged };
    expect(store.mergeLegacyData([legacyEntry])).toBe(1);
    await store.flush();
    expect(store.mergeLegacyData([legacyEntry])).toBe(0);
  });

  it("takes over the original plugin's settings on a fresh install, except the sync folder", async () => {
    const store = new ReaderDataStore(new MemoryAdapter());
    await store.load();
    const original = { settings: { theme: "sepia", defaultHighlightColor: "blue", syncFolder: "Omni Book Reader/Sync" }, books: {} };
    expect(store.mergeLegacyData([{ path: ".obsidian/plugins/omni-book-reader/data.json", value: original }])).toBe(1);
    expect(store.settings).toMatchObject({ theme: "sepia", defaultHighlightColor: "#6f9fe8", syncFolder: "Utilities/Omni Book Reader Mod/Sync" });

    const other = { settings: { theme: "dark" }, books: {} };
    store.mergeLegacyData([{ path: ".obsidian/plugins/another-copy/data.json", value: other }]);
    expect(store.settings.theme).toBe("sepia");
  });
});

describe("data.json holds only shared settings", () => {
  const oldDataJson = () => ({
    schemaVersion: 5,
    settings: { theme: "dark", fontSizePercent: 120, connectAdjacentHighlights: false, syncFolder: "Sync" },
    books: {
      "Books/a.epub": { sourceSignature: { size: 1, mtime: 1 }, bookmarks: [], highlights: [], position: { cfi: "epubcfi(/6/2!/4/2:0)", fraction: 0.3, updatedAt: 5 } },
    },
    importedLegacyDataPaths: [],
  });

  it("never writes data.json on load or while reading, and seeds local storage once", async () => {
    const adapter = new MemoryAdapter();
    adapter.value = oldDataJson();
    const books = new CountingBooks();
    const device = memoryDeviceStorage();
    const store = new ReaderDataStore(adapter, console.error, { books, device });
    await store.load();
    expect(store.settings).toMatchObject({ theme: "dark", fontSizePercent: 120, connectAdjacentHighlights: false, syncFolder: "Sync" });
    expect(store.getBook("Books/a.epub")?.position?.fraction).toBe(0.3);

    store.getBook("Books/a.epub")!.position = { cfi: "epubcfi(/6/2!/4/2:1)", fraction: 0.6, updatedAt: 9 };
    store.markChanged(0, "progress");
    store.updateSettings({ theme: "light", fontSizePercent: 140, defaultHighlightColor: "#6f9fe8" });
    await store.flush();
    expect(adapter.saves).toHaveLength(0);
    expect(books.saves).toBeGreaterThan(0);

    // A later start reads this device's own copies, not data.json's stale ones.
    adapter.value = { ...oldDataJson(), settings: { ...oldDataJson().settings, theme: "sepia" } };
    const again = new ReaderDataStore(adapter, console.error, { books, device });
    await again.load();
    expect(again.settings).toMatchObject({ theme: "light", fontSizePercent: 140 });
    expect(again.getBook("Books/a.epub")?.position?.fraction).toBe(0.6);
    expect(adapter.saves).toHaveLength(0);
  });

  it("writes a shared setting by re-reading disk, keeping other keys and older versions' books", async () => {
    const adapter = new MemoryAdapter();
    adapter.value = oldDataJson();
    const store = new ReaderDataStore(adapter);
    await store.load();
    // Another device changed the folder on disk meanwhile.
    adapter.value = { ...oldDataJson(), settings: { ...oldDataJson().settings, syncFolder: "Elsewhere" }, settingsUpdatedAt: { syncFolder: 1 } };
    store.updateSettings({ connectAdjacentHighlights: true });
    await store.flush();
    expect(adapter.saves).toHaveLength(1);
    const saved = adapter.value as ReturnType<typeof oldDataJson> & { settingsUpdatedAt: Record<string, number> };
    expect(saved.books).toEqual(oldDataJson().books);
    expect(saved.settings).toMatchObject({ connectAdjacentHighlights: true, syncFolder: "Elsewhere", theme: "dark" });
    expect(saved.settingsUpdatedAt.connectAdjacentHighlights).toBeGreaterThan(0);
    expect(store.settings.syncFolder).toBe("Elsewhere");

    // Setting the same value again writes nothing.
    store.updateSettings({ connectAdjacentHighlights: true });
    await store.flush();
    expect(adapter.saves).toHaveLength(1);
  });

  it("merges settings another device synced per key by edit time, saving only when this device is newer", async () => {
    const adapter = new MemoryAdapter();
    adapter.value = { settings: { connectAdjacentHighlights: true, syncFolder: "A" }, settingsUpdatedAt: { connectAdjacentHighlights: 10, syncFolder: 10 } };
    const store = new ReaderDataStore(adapter);
    await store.load();

    adapter.value = { settings: { connectAdjacentHighlights: false, syncFolder: "A" }, settingsUpdatedAt: { connectAdjacentHighlights: 20, syncFolder: 10 } };
    expect(await store.reloadSharedSettings()).toBe(true);
    expect(store.settings.connectAdjacentHighlights).toBe(false);
    expect(adapter.saves).toHaveLength(0);

    // Unchanged disk: nothing changes, nothing is written.
    expect(await store.reloadSharedSettings()).toBe(false);
    expect(adapter.saves).toHaveLength(0);

    // An older copy arriving late does not undo the newer edit, and this device writes its newer value back.
    adapter.value = { settings: { connectAdjacentHighlights: true, syncFolder: "A" }, settingsUpdatedAt: { connectAdjacentHighlights: 15, syncFolder: 10 } };
    expect(await store.reloadSharedSettings()).toBe(false);
    expect(store.settings.connectAdjacentHighlights).toBe(false);
    expect(adapter.saves).toHaveLength(1);
    expect((adapter.value as { settings: { connectAdjacentHighlights: boolean } }).settings.connectAdjacentHighlights).toBe(false);
  });

  it("keeps the background-tasks switch on this device only", async () => {
    const adapter = new MemoryAdapter();
    const device = memoryDeviceStorage();
    const mobile = new ReaderDataStore(adapter, console.error, { device, defaultBackgroundTasks: false });
    await mobile.load();
    expect(mobile.runBackgroundTasks).toBe(false);
    mobile.setRunBackgroundTasks(true);
    const again = new ReaderDataStore(adapter, console.error, { device, defaultBackgroundTasks: false });
    await again.load();
    expect(again.runBackgroundTasks).toBe(true);
    expect(adapter.saves).toHaveLength(0);
    const desktop = new ReaderDataStore(adapter, console.error, { defaultBackgroundTasks: true });
    await desktop.load();
    expect(desktop.runBackgroundTasks).toBe(true);
  });
});

describe("highlight colors from before 1.1.29", () => {
  it("turns stored color words into the shared palette's values", () => {
    const data = normalizeReaderData({
      schemaVersion: 5,
      settings: { defaultHighlightColor: "pink" },
      books: {
        "Books/Old.epub": {
          sourceSignature: { size: 1, mtime: 1 },
          bookmarks: [],
          highlights: [
            { id: "a", cfi: "epubcfi(/6/2!/4/2:0)", text: "A", chapter: "C", color: "green", style: "highlight", tags: [], sectionIndex: 0, createdAt: 1 },
            { id: "b", cfi: "epubcfi(/6/2!/4/2:1)", text: "B", chapter: "C", color: "#B197FC", style: "highlight", tags: [], sectionIndex: 0, createdAt: 2 },
          ],
          colorOrder: ["blue", "#b197fc"],
          colorNames: { "#83CB67": "Costs" },
          noteSettingsUpdatedAt: 5,
        },
      },
      importedLegacyDataPaths: [],
    });
    const book = data.books["Books/Old.epub"]!;
    expect(data.settings.defaultHighlightColor).toBe("#e463a1");
    expect(book.highlights.map((highlight) => highlight.color)).toEqual(["#83cb67", "#b197fc"]);
    expect(book.colorOrder).toEqual(["#6f9fe8", "#b197fc"]);
    expect(book.colorNames).toEqual({ "#83cb67": "Costs" });
    expect(book.noteSettingsUpdatedAt).toBe(5);
  });

  it("keeps edit times, tombstones, the quote flag and reading bookkeeping through a save and load", () => {
    const data = normalizeReaderData({
      books: {
        "Books/b.epub": {
          sourceSignature: { size: 1, mtime: 1 },
          position: { cfi: "epubcfi(/6/2!/4/2:0)", fraction: 0.5, updatedAt: 7, page: " 12 " },
          bookmarks: [{ id: "m", cfi: "epubcfi(/6/2!/4/2:0)", fraction: 0.1, chapter: "C", createdAt: 2, updatedAt: 3 }],
          highlights: [{ id: "h", cfi: "epubcfi(/6/2!/4/2:0)", text: "T", chapter: "C", color: "#ffd12d", style: "highlight", tags: [], sectionIndex: 0, createdAt: 4, updatedAt: 5, quote: true }],
          deletedHighlights: { gone: 9, bad: "x" },
          deletedBookmarks: { old: 8 },
          readingStats: { totalReadingMs: 10, lastOpenedAt: 1, lastReadAt: 1, furthestFraction: 0.5, completedUpdatedAt: 6, deviceReadingMs: 4, unrecordedReadingMs: 2 },
        },
      },
    });
    const book = data.books["Books/b.epub"]!;
    expect(book.position).toMatchObject({ page: "12", updatedAt: 7 });
    expect(book.bookmarks[0]?.updatedAt).toBe(3);
    expect(book.highlights[0]).toMatchObject({ updatedAt: 5, quote: true });
    expect(book.deletedHighlights).toEqual({ gone: 9 });
    expect(book.deletedBookmarks).toEqual({ old: 8 });
    expect(book.readingStats).toMatchObject({ completedUpdatedAt: 6, deviceReadingMs: 4, unrecordedReadingMs: 2 });
    expect(normalizeReaderData(JSON.parse(JSON.stringify(data)))).toEqual(data);
  });
});
