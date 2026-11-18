import { describe, expect, it } from "vitest";
import {
  applySyncedBook,
  canonicalJson,
  createSyncDocument,
  emptySyncedBook,
  mergeSyncDocumentInto,
  mergeSyncedBooks,
  parseSyncDocument,
  recordLocalBook,
} from "../src/reading-sync-model";
import type { SyncDocument } from "../src/reading-sync-model";
import type { BookState, Bookmark, ReaderHighlight } from "../src/types";

const BOOK = "Books/Test Book.epub";

function highlight(id: string, overrides: Partial<ReaderHighlight> = {}): ReaderHighlight {
  return {
    id,
    cfi: `epubcfi(/6/4!/4/2/1:${id.length})`,
    text: `Text ${id}`,
    chapter: "Chapter 1",
    color: "#ffd12d",
    style: "highlight",
    tags: [],
    sectionIndex: 1,
    createdAt: 1000,
    ...overrides,
  };
}

function bookmark(id: string, createdAt = 1000): Bookmark {
  return { id, cfi: "epubcfi(/6/4!/4/2/1:0)", fraction: 0.1, chapter: "Chapter 1", createdAt };
}

function bookState(overrides: Partial<BookState> = {}): BookState {
  return { sourceSignature: { size: 1, mtime: 1 }, bookmarks: [], highlights: [], ...overrides };
}

/** One simulated device: local book state plus its own sync document, synced the way the service does it. */
class Device {
  doc: SyncDocument;

  constructor(readonly id: string, readonly state: BookState = bookState()) {
    this.doc = createSyncDocument(id);
  }

  /** Records local edits, then merges other devices' files, then applies the result locally. */
  sync(_now: number, ...others: Device[]): void {
    recordLocalBook(this.doc, BOOK, this.state, this.id);
    for (const other of others) mergeSyncDocumentInto(this.doc, structuredClone(other.doc));
    const book = this.doc.books[BOOK];
    if (book) applySyncedBook(BOOK, this.state, book, this.id);
  }

  /** Deletes a highlight the way the reader does: removes it and keeps a dated tombstone. */
  deleteHighlight(id: string, at: number): void {
    this.state.highlights = this.state.highlights.filter((item) => item.id !== id);
    this.state.deletedHighlights = { ...this.state.deletedHighlights, [id]: at };
  }

  highlightIds(): string[] {
    return this.state.highlights.map((item) => item.id).sort();
  }
}

describe("reading sync model", () => {
  it("combines highlights added on different devices", () => {
    const desktop = new Device("desktop", bookState({ highlights: [highlight("a")] }));
    const phone = new Device("phone", bookState({ highlights: [highlight("b")] }));

    desktop.sync(2000);
    phone.sync(2000, desktop);
    desktop.sync(3000, phone);

    expect(desktop.highlightIds()).toEqual(["a", "b"]);
    expect(phone.highlightIds()).toEqual(["a", "b"]);
  });

  it("propagates deletions and does not resurrect deleted highlights", () => {
    const desktop = new Device("desktop", bookState({ highlights: [highlight("a"), highlight("b")] }));
    const phone = new Device("phone");
    desktop.sync(2000);
    phone.sync(2000, desktop);
    expect(phone.highlightIds()).toEqual(["a", "b"]);

    phone.deleteHighlight("a", 3000);
    phone.sync(3000, desktop);
    desktop.sync(4000, phone);
    phone.sync(5000, desktop);

    expect(desktop.highlightIds()).toEqual(["b"]);
    expect(phone.highlightIds()).toEqual(["b"]);
  });

  it("keeps the newest edit of the same highlight", () => {
    const desktop = new Device("desktop", bookState({ highlights: [highlight("a")] }));
    const phone = new Device("phone");
    desktop.sync(2000);
    phone.sync(2000, desktop);

    Object.assign(desktop.state.highlights[0]!, { note: "Older note", updatedAt: 3000 });
    desktop.sync(3000, phone);
    Object.assign(phone.state.highlights[0]!, { note: "Newer note", color: "#6f9fe8", updatedAt: 4000 });
    phone.sync(4000, desktop);
    desktop.sync(5000, phone);

    expect(desktop.state.highlights[0]).toMatchObject({ note: "Newer note", color: "#6f9fe8" });
    expect(phone.state.highlights[0]).toMatchObject({ note: "Newer note", color: "#6f9fe8" });
  });

  it("does not delete or override other devices' data on a device's first sync", () => {
    const desktop = new Device("desktop", bookState({
      highlights: [highlight("a", { note: "Edited on desktop", noteUpdatedAt: 5000 })],
      bookmarks: [bookmark("m")],
    }));
    desktop.sync(6000);

    // The phone has an older copy of the same highlight and nothing else.
    const phone = new Device("phone", bookState({ highlights: [highlight("a", { note: "Old note", noteUpdatedAt: 2000 })] }));
    phone.sync(7000, desktop);

    expect(phone.state.highlights[0]?.note).toBe("Edited on desktop");
    expect(phone.state.bookmarks.map((item) => item.id)).toEqual(["m"]);
    desktop.sync(8000, phone);
    expect(desktop.state.highlights[0]?.note).toBe("Edited on desktop");
    expect(desktop.state.bookmarks.map((item) => item.id)).toEqual(["m"]);
  });

  it("uses the most recent reading position and sums reading time across devices", () => {
    const desktop = new Device("desktop", bookState({
      position: { cfi: "epubcfi(/6/10!/4/2/1:0)", fraction: 0.2, updatedAt: 1000 },
      readingStats: { totalReadingMs: 60000, deviceReadingMs: 60000, lastOpenedAt: 1000, lastReadAt: 1000, furthestFraction: 0.2 },
    }));
    const phone = new Device("phone", bookState({
      position: { cfi: "epubcfi(/6/20!/4/2/1:0)", fraction: 0.4, updatedAt: 2000 },
      readingStats: { totalReadingMs: 30000, deviceReadingMs: 30000, lastOpenedAt: 2000, lastReadAt: 2000, furthestFraction: 0.4 },
    }));

    desktop.sync(3000);
    phone.sync(3000, desktop);
    desktop.sync(4000, phone);

    expect(desktop.state.position?.cfi).toBe("epubcfi(/6/20!/4/2/1:0)");
    expect(desktop.state.readingStats).toMatchObject({ totalReadingMs: 90000, furthestFraction: 0.4, lastReadAt: 2000 });
    expect(phone.state.readingStats?.totalReadingMs).toBe(90000);

    // Further reading on one device adds only that device's new time.
    desktop.state.readingStats!.totalReadingMs += 10000;
    desktop.state.readingStats!.deviceReadingMs! += 10000;
    desktop.sync(5000, phone);
    phone.sync(6000, desktop);
    expect(phone.state.readingStats?.totalReadingMs).toBe(100000);
  });

  it("syncs marking a book unfinished after it was finished elsewhere", () => {
    const desktop = new Device("desktop", bookState({
      readingStats: { totalReadingMs: 1, lastOpenedAt: 1, lastReadAt: 1, furthestFraction: 1, completedAt: 1000 },
    }));
    const phone = new Device("phone");
    desktop.sync(2000);
    phone.sync(2000, desktop);
    expect(phone.state.readingStats?.completedAt).toBe(1000);

    delete phone.state.readingStats!.completedAt;
    phone.state.readingStats!.completedUpdatedAt = 3000;
    phone.sync(3000, desktop);
    desktop.sync(4000, phone);
    expect(desktop.state.readingStats?.completedAt).toBeUndefined();
  });

  it("mutates the existing book state object so open views keep a valid reference", () => {
    const desktop = new Device("desktop", bookState({ highlights: [highlight("a")] }));
    const phoneState = bookState();
    const phone = new Device("phone", phoneState);
    desktop.sync(2000);
    phone.sync(2000, desktop);
    expect(phone.state).toBe(phoneState);
    expect(phoneState.highlights.map((item) => item.id)).toEqual(["a"]);
  });

  it("merges in any order to the same result", () => {
    const a = new Device("a", bookState({ highlights: [highlight("1")], bookmarks: [bookmark("x")] }));
    const b = new Device("b", bookState({ highlights: [highlight("2", { createdAt: 3000 })] }));
    a.sync(2000);
    b.sync(2500);
    const left = a.doc.books[BOOK]!;
    const right = b.doc.books[BOOK]!;

    expect(canonicalJson(mergeSyncedBooks(left, right))).toBe(canonicalJson(mergeSyncedBooks(right, left)));
    const once = mergeSyncedBooks(left, right);
    expect(canonicalJson(mergeSyncedBooks(once, right))).toBe(canonicalJson(once));
  });

  it("syncs a book's color names, added colors, heading order and layout, newest wins", () => {
    const desktop = new Device("desktop", bookState({ highlights: [highlight("a")] }));
    const phone = new Device("phone");
    desktop.sync(2000);
    phone.sync(2000, desktop);

    Object.assign(desktop.state, {
      noteLayout: "by-color",
      colorNames: { "#83cb67": "Costs" },
      extraColors: ["#ffa94d"],
      colorOrder: ["#83cb67"],
      noteSettingsUpdatedAt: 3000,
    });
    desktop.sync(3000, phone);
    phone.sync(3500, desktop);
    expect(phone.state).toMatchObject({ noteLayout: "by-color", colorNames: { "#83cb67": "Costs" }, extraColors: ["#ffa94d"], colorOrder: ["#83cb67"] });

    // A newer rename on the phone wins on both devices; an older one would not.
    phone.state.colorNames = { "#83cb67": "Budget" };
    phone.state.noteSettingsUpdatedAt = 4000;
    phone.sync(4000, desktop);
    desktop.sync(5000, phone);
    expect(desktop.state.colorNames).toEqual({ "#83cb67": "Budget" });
  });

  it("does not let an outdated device turn a recolored highlight back to yellow", () => {
    const tablet = new Device("tablet", bookState({ highlights: [highlight("a", { color: "#ffd12d" })] }));
    const phone = new Device("phone");
    tablet.sync(2000);
    phone.sync(2000, tablet);

    Object.assign(tablet.state.highlights[0]!, { color: "#6f9fe8", updatedAt: 3000 });
    tablet.sync(3000, phone);
    // A desktop on a version before 1.1.29 reads the blue value as "yellow" and writes its file back
    // with the tablet's edit time.
    const desktopFile = JSON.parse(JSON.stringify(tablet.doc)) as SyncDocument;
    desktopFile.deviceId = "desktop";
    const entry = desktopFile.books[BOOK]!.highlights.a!;
    if ("value" in entry) (entry.value as { color: string }).color = "yellow";
    const desktop = parseSyncDocument(JSON.stringify(desktopFile))!;

    // Whichever arrives first, the phone and the tablet keep blue.
    for (const order of [[tablet.doc, desktop], [desktop, tablet.doc]]) {
      const merged = createSyncDocument("phone-check");
      for (const doc of order) mergeSyncDocumentInto(merged, structuredClone(doc));
      const state = bookState({ highlights: [] });
      applySyncedBook(BOOK, state, merged.books[BOOK]!);
      expect(state.highlights[0]?.color).toBe("#6f9fe8");
      expect("legacyColor" in (state.highlights[0] ?? {})).toBe(false);
    }
  });

  it("reads color words from devices that have not updated yet", () => {
    const parsed = parseSyncDocument(JSON.stringify({
      format: "omni-book-reader-mod-sync",
      version: 1,
      deviceId: "old",
      updatedAt: 1,
      books: { [BOOK]: { highlights: { a: { updatedAt: 1, value: { ...highlight("a"), color: "blue" } } }, bookmarks: {}, readingMsByDevice: {}, lastOpenedAt: 0, lastReadAt: 0, furthestFraction: 0 } },
    }));
    const entry = parsed?.books[BOOK]?.highlights.a;
    expect(entry && "value" in entry ? entry.value.color : null).toBe("#6f9fe8");
  });

  it("parses its own output and rejects files that are not sync documents", () => {
    const device = new Device("device", bookState({ highlights: [highlight("a", { note: "Note" })], bookmarks: [bookmark("m")] }));
    device.sync(2000);
    const parsed = parseSyncDocument(canonicalJson(device.doc));

    expect(parsed && canonicalJson(parsed.books)).toBe(canonicalJson(device.doc.books));
    expect(parseSyncDocument("not json")).toBeNull();
    expect(parseSyncDocument(JSON.stringify({ format: "something-else", version: 1, deviceId: "x", books: {} }))).toBeNull();
    expect(parseSyncDocument(JSON.stringify({ format: "omni-book-reader-sync", version: 1, books: {} }))).toBeNull();
  });

  it("prefers the single annotation file over an older highlight/note pair in any merge order", () => {
    const pair = { ...emptySyncedBook(), annotationDocuments: { highlightPath: "Books/a/a-Highlight-2026-01-01.md", notePath: "Books/a/a-Note-2026-01-01.md", createdDate: "2026-01-01" } };
    const single = { ...emptySyncedBook(), annotationDocuments: { highlightPath: "Media/Books/Attachments/A Notes.md", notePath: "Media/Books/Attachments/A Notes.md", createdDate: "2026-01-01" } };

    expect(mergeSyncedBooks(pair, single).annotationDocuments).toEqual(single.annotationDocuments);
    expect(mergeSyncedBooks(single, pair).annotationDocuments).toEqual(single.annotationDocuments);

    const bookNote = { ...emptySyncedBook(), annotationDocuments: { highlightPath: "Media/Books/A.md", notePath: "Media/Books/A.md", createdDate: "2026-01-01" } };
    expect(mergeSyncedBooks(single, bookNote).annotationDocuments).toEqual(bookNote.annotationDocuments);
    expect(mergeSyncedBooks(bookNote, single).annotationDocuments).toEqual(bookNote.annotationDocuments);
  });

  it("syncs the page a highlight was made on", () => {
    const device = new Device("device", bookState({ highlights: [highlight("a", { page: "12" })] }));
    device.sync(2000);
    const parsed = parseSyncDocument(canonicalJson(device.doc));
    const highlights = Object.values(Object.values(parsed?.books ?? {})[0]?.highlights ?? {});
    expect(highlights[0] && "value" in highlights[0] ? highlights[0].value.page : undefined).toBe("12");
  });

  describe("devices that sync late or hold stale copies", () => {
    it("never brings back a highlight deleted elsewhere when a stale copy of it shows up locally", () => {
      const desktop = new Device("desktop", bookState({ highlights: [highlight("a"), highlight("b")] }));
      const phone = new Device("phone");
      desktop.sync(2000);
      phone.sync(2000, desktop);

      desktop.deleteHighlight("a", 3000);
      desktop.sync(3000, phone);
      phone.sync(3500, desktop);
      expect(phone.highlightIds()).toEqual(["b"]);
      // Then Obsidian Sync drops an old copy of the books (still holding "a") into the phone's local data.
      phone.state.highlights = [highlight("a"), highlight("b")];
      phone.sync(4000, desktop);
      desktop.sync(5000, phone);

      expect(phone.highlightIds()).toEqual(["b"]);
      expect(desktop.highlightIds()).toEqual(["b"]);
    });

    it("never deletes a highlight just because a stale copy of the books lacks it", () => {
      const desktop = new Device("desktop", bookState({ highlights: [highlight("a")] }));
      const phone = new Device("phone");
      desktop.sync(2000);
      phone.sync(2000, desktop);

      phone.state.highlights.push(highlight("p", { createdAt: 2500, updatedAt: 2500 }));
      phone.sync(2500, desktop);
      // The phone's local books are replaced by the desktop's older copy, which never had "p".
      phone.state.highlights = [highlight("a")];
      phone.sync(3000, desktop);
      desktop.sync(4000, phone);

      expect(phone.highlightIds()).toEqual(["a", "p"]);
      expect(desktop.highlightIds()).toEqual(["a", "p"]);
    });

    it("merges a tablet's one real edit from days ago without its stale copies overriding newer edits", () => {
      const desktop = new Device("desktop", bookState({ highlights: [highlight("a"), highlight("b"), highlight("c")] }));
      const tablet = new Device("tablet");
      desktop.sync(1000);
      tablet.sync(1000, desktop);

      // The tablet goes offline. Days of edits happen on the desktop meanwhile.
      Object.assign(tablet.state.highlights.find((item) => item.id === "b")!, { note: "Tablet note", updatedAt: 5000 });
      Object.assign(desktop.state.highlights.find((item) => item.id === "a")!, { note: "Desktop note", updatedAt: 8000 });
      desktop.deleteHighlight("c", 9000);
      desktop.sync(9000);

      // The tablet comes back with its stale copies of "a" and "c" plus its real edit to "b".
      tablet.sync(200000, desktop);
      desktop.sync(200001, tablet);

      for (const device of [desktop, tablet]) {
        expect(device.highlightIds()).toEqual(["a", "b"]);
        expect(device.state.highlights.find((item) => item.id === "a")?.note).toBe("Desktop note");
        expect(device.state.highlights.find((item) => item.id === "b")?.note).toBe("Tablet note");
      }
    });

    it("keeps a deletion even when the deleting device's tombstone reaches a tablet days later", () => {
      const phone = new Device("phone", bookState({ highlights: [highlight("x")] }));
      const tablet = new Device("tablet");
      phone.sync(1000);
      tablet.sync(1000, phone);
      phone.deleteHighlight("x", 2000);
      phone.sync(2000);
      // Days pass; the tablet re-records its untouched copy many times before it sees the tombstone.
      tablet.sync(50000);
      tablet.sync(90000);
      tablet.sync(100000, phone);
      phone.sync(100001, tablet);
      expect(tablet.highlightIds()).toEqual([]);
      expect(phone.highlightIds()).toEqual([]);
    });

    it("never double-counts reading time from a stale total", () => {
      const desktop = new Device("desktop", bookState({
        readingStats: { totalReadingMs: 60000, deviceReadingMs: 60000, lastOpenedAt: 1, lastReadAt: 1, furthestFraction: 0.1 },
      }));
      const phone = new Device("phone", bookState({
        readingStats: { totalReadingMs: 10000, deviceReadingMs: 10000, lastOpenedAt: 1, lastReadAt: 1, furthestFraction: 0.1 },
      }));
      desktop.sync(1);
      phone.sync(2, desktop);
      // A stale merged total lands in the phone's local stats; its own counter is unchanged.
      phone.state.readingStats!.totalReadingMs = 140000;
      phone.sync(3, desktop);
      desktop.sync(4, phone);
      expect(desktop.state.readingStats?.totalReadingMs).toBe(70000);
    });
  });
});
