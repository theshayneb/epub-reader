import type { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
  AnnotationDocumentService,
  BY_COLOR_END,
  BY_COLOR_START,
  HIGHLIGHTS_CALLOUT,
  buildCfiLink,
  detectNoteLayout,
  renderByColorLines,
  replaceByColorRegionWithCallout,
  updateByColorRegion,
} from "../src/annotation-documents";
import { byColorItem, calloutLine } from "../src/note-layout";
import type { BookState, ReaderHighlight } from "../src/types";

const sourceFile = { path: "Books/Test Book.epub", basename: "Test Book" } as TFile;
const link = (cfi: string) => buildCfiLink("Test Vault", sourceFile.path, cfi);

function highlight(overrides: Partial<ReaderHighlight> = {}): ReaderHighlight {
  return {
    id: "h1",
    cfi: "epubcfi(/6/2!/4/2:0)",
    text: "First passage",
    chapter: "Chapter 1",
    page: "3",
    color: "yellow",
    style: "highlight",
    tags: [],
    sectionIndex: 0,
    createdAt: 1,
    ...overrides,
  };
}

const yellow = highlight({ tags: ["idea"], note: "my note" });
const green = highlight({ id: "h2", cfi: "epubcfi(/6/4!/4/2:0)", text: "Second passage", page: "9", color: "green", sectionIndex: 1, createdAt: 2 });

describe("shared note layouts", () => {
  it("writes the same by-color item shape as PDF Annotator", () => {
    expect(byColorItem({ text: "Passage", tags: ["#idea"], note: "my note", color: "#fff", pages: ["3", "4"], link: "L" }))
      .toEqual(["- Passage #idea *([pgs. 3, 4](L))*", "\t- [\"] *my note*"]);
  });

  it("writes the same callout line shape as before", () => {
    expect(calloutLine({ text: "Passage", tags: ["#quote", "#idea"], note: "n", color: "#fff", pages: ["3"], chapter: "Ch", link: "L" }))
      .toBe("> > - Passage #quote #idea *-- n* *(Ch, [p. 3](L))*");
  });

  it("orders color headings as chosen, highlights in book order under each", () => {
    const lines = renderByColorLines([green, yellow], sourceFile.path, "Test Vault", ["green"]);
    expect(lines).toEqual([
      "# <span style=\"color: #81c784\">Green</span>",
      "",
      `- Second passage *(Chapter 1, [pg. 9](${link(green.cfi)}))*`,
      "",
      "# <span style=\"color: #ffd54f\">Yellow</span>",
      "",
      `- First passage #idea *(Chapter 1, [pg. 3](${link(yellow.cfi)}))*`,
      "\t- [\"] *my note*",
      "",
    ]);
  });
});

describe("switching a book note between layouts", () => {
  const userNote = [
    "---",
    "Progress: 3",
    "---",
    "My own intro.",
    "",
    HIGHLIGHTS_CALLOUT,
    `> > - Old line #quote *([p. 3](${link(yellow.cfi)}))*`,
    "> > - A line I wrote myself",
    "",
    "My closing thoughts.",
  ].join("\n");

  it("detects the layout a note is already in", () => {
    expect(detectNoteLayout(userNote)).toBe("callout");
    expect(detectNoteLayout("Just my note.")).toBeNull();
    expect(detectNoteLayout(`${HIGHLIGHTS_CALLOUT}\n> > - A line I wrote myself`)).toBeNull();
    expect(detectNoteLayout(`Intro\n\n${BY_COLOR_START}\n\n${BY_COLOR_END}\n`)).toBe("by-color");
  });

  it("moves to by-color without touching the person's own lines", () => {
    const next = updateByColorRegion(userNote, ["# Yellow", "", "- passage"]);
    expect(next).toContain("My own intro.");
    expect(next).toContain("> > - A line I wrote myself");
    expect(next).toContain("My closing thoughts.");
    expect(next).not.toContain("Old line");
    expect(next).toContain(`${BY_COLOR_START}\n\n# Yellow\n\n- passage\n${BY_COLOR_END}`);
    // Rewriting replaces only the section.
    const again = updateByColorRegion(next, ["# Green", "", "- other"]);
    expect(again).not.toContain("# Yellow");
    expect(again.split(BY_COLOR_START).length).toBe(2);
    expect(again).toContain("My closing thoughts.");
  });

  it("removes an emptied callout and puts the section in its place", () => {
    const note = `Intro\n\n${HIGHLIGHTS_CALLOUT}\n> > - Old #quote *([p. 3](${link(yellow.cfi)}))*\n\nOutro`;
    const next = updateByColorRegion(note, ["- passage"]);
    expect(next).not.toContain(HIGHLIGHTS_CALLOUT);
    expect(next.indexOf(BY_COLOR_START)).toBeGreaterThan(next.indexOf("Intro"));
    expect(next.indexOf(BY_COLOR_START)).toBeLessThan(next.indexOf("Outro"));
  });

  it("moves back to the callout where the section was", () => {
    const byColor = `Intro\n\n${BY_COLOR_START}\n\n- passage\n${BY_COLOR_END}\n\nOutro`;
    const back = replaceByColorRegionWithCallout(byColor);
    expect(back).toBe(`Intro\n\n${HIGHLIGHTS_CALLOUT}\n\nOutro`);
  });
});

describe("choosing a layout for a book", () => {
  function setup(content: string) {
    const note = { path: "Test Book.md", extension: "md", basename: "Test Book", content };
    const vault = {
      getAbstractFileByPath: vi.fn(() => null),
      modify: vi.fn(async (file: typeof note, next: string) => { file.content = next; }),
      cachedRead: vi.fn(async (file: typeof note) => file.content),
      getName: vi.fn(() => "Test Vault"),
    };
    const choose = vi.fn(async () => ({ layout: "by-color" as const, order: ["green" as const] }));
    const service = new AnnotationDocumentService(vault as never, vi.fn(), () => note as unknown as TFile, choose);
    return { note, choose, service };
  }
  const state = (): BookState => ({ sourceSignature: { size: 1, mtime: 1 }, bookmarks: [], highlights: [yellow, green] });

  it("asks once for a new book, then remembers the choice", async () => {
    const { note, choose, service } = setup("My note.");
    const book = state();
    await service.sync({ sourceFile, state: book, title: "Test Book", author: "" });
    await service.sync({ sourceFile, state: book, title: "Test Book", author: "" });
    expect(choose).toHaveBeenCalledTimes(1);
    expect(book.noteLayout).toBe("by-color");
    expect(book.colorOrder).toEqual(["green"]);
    expect(note.content.indexOf("Green")).toBeLessThan(note.content.indexOf("Yellow"));
  });

  it("follows a note already in the callout layout without asking", async () => {
    const { choose, service } = setup(`${HIGHLIGHTS_CALLOUT}\n> > - Old #quote *([p. 3](${link(yellow.cfi)}))*`);
    const book = state();
    await service.sync({ sourceFile, state: book, title: "Test Book", author: "" });
    expect(choose).not.toHaveBeenCalled();
    expect(book.noteLayout).toBe("callout");
  });

  it("does not ask before the book has highlights", async () => {
    const { choose, service } = setup("My note.");
    await service.sync({ sourceFile, state: { sourceSignature: { size: 1, mtime: 1 }, bookmarks: [], highlights: [] }, title: "Test Book", author: "" });
    expect(choose).not.toHaveBeenCalled();
  });
});
