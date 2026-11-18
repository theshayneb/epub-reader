import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import type { App, Vault } from "obsidian";
import { AnnotationDocumentService } from "../src/annotation-documents";
import { BookNoteUpdater, SETTLE_MAX_WAIT_MS, SETTLE_QUIET_MS, SyncSettleTracker, setProgressInFrontmatter } from "../src/book-notes";
import { ReaderDataStore, memoryDeviceStorage } from "../src/store";
import type { ReaderHighlight } from "../src/types";

const BOOK = "Books/Dune.epub";
const NOTE = "Notes/Dune.md";

function file(path: string): TFile {
  const item = new TFile();
  item.path = path;
  item.name = path.split("/").pop() ?? path;
  item.basename = item.name.replace(/\.[^.]+$/, "");
  item.extension = item.name.split(".").pop() ?? "";
  return item;
}

function highlight(id: string, overrides: Partial<ReaderHighlight> = {}): ReaderHighlight {
  return {
    id, cfi: `epubcfi(/6/2!/4/2:${id.length})`, text: `Passage ${id}`, chapter: "One", color: "#ffd12d",
    style: "highlight", tags: [], sectionIndex: 0, createdAt: 1, ...overrides,
  };
}

async function setup(note: string, runBackgroundTasks: boolean) {
  const files = new Map<string, string>([[BOOK, ""], [NOTE, note]]);
  const writes: string[] = [];
  const vault = {
    getAbstractFileByPath: (path: string) => files.has(path) ? file(path) : null,
    cachedRead: async (item: TFile) => files.get(item.path) ?? "",
    modify: async (item: TFile, content: string) => {
      writes.push(item.path);
      files.set(item.path, content);
    },
    getName: () => "Vault",
  };
  const store = new ReaderDataStore({ loadData: async () => null, saveData: async () => undefined }, console.error, {
    defaultBackgroundTasks: runBackgroundTasks,
  });
  await store.load();
  const annotationDocuments = new AnnotationDocumentService(vault as unknown as Vault, async () => undefined, () => file(NOTE));
  const updater = new BookNoteUpdater({
    app: { vault } as unknown as App,
    store,
    annotationDocuments,
    device: memoryDeviceStorage(),
    findBookNote: () => file(NOTE),
    migrateLegacyLinks: async () => undefined,
  });
  return { files, writes, store, updater };
}

describe("book notes on the background device", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for Sync to settle, then writes the callout, Progress and Quotes once", async () => {
    vi.useFakeTimers();
    const { files, writes, store, updater } = await setup("---\nQuotes:\n  - \"hand\"\n---\n# Dune\n", true);
    const state = store.ensureBook(BOOK, { size: 1, mtime: 1 });
    state.highlights.push(highlight("a", { quote: true }), highlight("b"));
    state.position = { cfi: "epubcfi(/6/2!/4/2:0)", fraction: 0.5, updatedAt: 1, page: "42" };
    updater.start();
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS - 1000);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    await updater.updateNow();
    const note = files.get(NOTE) ?? "";
    expect(note).toContain("Progress: 42");
    expect(note).toContain('Quotes:\n  - "hand"\n  - "Passage a #quote"');
    expect(note).toContain("Passage b");
    const count = writes.length;

    // Nothing changed: nothing is written.
    await updater.updateNow();
    expect(writes).toHaveLength(count);

    // The quote highlight was deleted on another device: its entry goes, the hand-written one stays.
    state.highlights = state.highlights.filter((item) => item.id !== "a");
    await updater.updateNow();
    expect(files.get(NOTE)).toContain('Quotes:\n  - "hand"\nProgress: 42\n---');
    updater.stop();
  });

  it("fills a Quotes property Obsidian left as an empty one-line list", async () => {
    const { files, store, updater } = await setup("---\nQuotes: []\n---\n# Dune\n", true);
    store.ensureBook(BOOK, { size: 1, mtime: 1 }).highlights.push(highlight("a", { quote: true, tags: ["insightful"] }));
    updater.start();
    const report = await updater.updateNow();
    expect(files.get(NOTE)).toContain('Quotes:\n  - "Passage a #quote #insightful"\n---');
    expect(report?.quoteCount).toBe(1);
    updater.stop();
  });

  it("adopts Quotes entries written before highlights carried the quote flag", async () => {
    const { files, store, updater } = await setup("---\nQuotes:\n  - \"Passage a #quote\"\n---\n", true);
    const state = store.ensureBook(BOOK, { size: 1, mtime: 1 });
    state.highlights.push(highlight("a"));
    updater.start();
    await updater.updateNow();
    expect(files.get(NOTE)).toContain('  - "Passage a #quote"');
    state.highlights = [];
    await updater.updateNow();
    expect(files.get(NOTE)).not.toContain("Passage a");
    updater.stop();
  });

  it("keeps updating other books when one book's note fails, and reports both", async () => {
    const { files, store, updater } = await setup("# Dune\n", true);
    files.set("Books/Broken.epub", "");
    const broken = store.ensureBook("Books/Broken.epub", { size: 1, mtime: 1 });
    broken.position = { cfi: "epubcfi(/6/2!/4/2:0)", fraction: 0.1, updatedAt: 1, page: "3" };
    broken.highlights.push(highlight("x"));
    // A highlight whose rendering throws stands in for any failure while writing that book's note.
    Object.defineProperty(broken.highlights[0]!, "text", { get: () => { throw new Error("boom"); } });
    store.ensureBook(BOOK, { size: 1, mtime: 1 }).position = { cfi: "epubcfi(/6/2!/4/2:0)", fraction: 0.5, updatedAt: 1, page: "42" };
    updater.start();
    const report = await updater.updateNow();
    expect(files.get(NOTE)).toContain("Progress: 42");
    expect(report?.failed.map((item) => item.path)).toEqual(["Books/Broken.epub"]);
    expect(report?.updated).toEqual([NOTE]);
    updater.stop();
  });

  it("never writes on a device without background tasks", async () => {
    vi.useFakeTimers();
    const { writes, store, updater } = await setup("# Dune\n", false);
    store.ensureBook(BOOK, { size: 1, mtime: 1 }).highlights.push(highlight("a", { quote: true }));
    updater.start();
    await vi.advanceTimersByTimeAsync(10 * SETTLE_QUIET_MS);
    await updater.updateNow();
    expect(writes).toHaveLength(0);
  });
});

describe("waiting for Sync to settle", () => {
  it("needs a quiet minute after startup, and core Sync idle", () => {
    let now = 0;
    let busy = false;
    const tracker = new SyncSettleTracker(() => busy, () => now);
    now = SETTLE_QUIET_MS - 1;
    expect(tracker.remaining()).toBe(1);
    tracker.touch();
    now += SETTLE_QUIET_MS - 1;
    busy = true;
    expect(tracker.remaining()).toBeGreaterThan(0);
    now += 1;
    expect(tracker.remaining()).toBeGreaterThan(0);
    busy = false;
    expect(tracker.remaining()).toBe(0);
    // Once settled, later vault changes (other devices' files arriving) do not hold notes back.
    tracker.touch();
    expect(tracker.remaining()).toBe(0);
    // Resuming the app waits again.
    tracker.restart();
    expect(tracker.remaining()).toBe(SETTLE_QUIET_MS);
  });

  it("stops waiting after five minutes even if the vault never goes quiet or Sync always looks busy", () => {
    let now = 0;
    const tracker = new SyncSettleTracker(() => true, () => now);
    for (; now < SETTLE_MAX_WAIT_MS; now += 20_000) {
      tracker.touch();
      expect(tracker.remaining()).toBeGreaterThan(0);
    }
    tracker.touch();
    expect(tracker.remaining()).toBe(0);
  });
});

describe("Progress property", () => {
  it("sets the page, keeping other properties, and writes nothing when it already matches", () => {
    expect(setProgressInFrontmatter("# B\n", 12)).toBe("---\nProgress: 12\n---\n# B\n");
    const note = "---\nstatus: reading\nProgress: 12\n---\n# B\n";
    expect(setProgressInFrontmatter(note, 12)).toBe(note);
    expect(setProgressInFrontmatter(note, 13)).toBe("---\nstatus: reading\nProgress: 13\n---\n# B\n");
    expect(setProgressInFrontmatter(note, "xii")).toBe("---\nstatus: reading\nProgress: \"xii\"\n---\n# B\n");
  });
});
