import { normalizePath } from "obsidian";
import type { TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import { compare as compareCfi } from "foliate-js/epubcfi.js";
import type { AnnotationDocuments, BookState, HighlightColor, ReaderHighlight } from "./types";
import { colorName, orderColors, type ColorNames } from "./highlight-colors";
import { byColorLines, calloutLine, CALLOUT_HEADER, CALLOUT_ITEM_PREFIX } from "./note-layout";
import type { LayoutEntry, NoteLayout } from "./note-layout";

const LEGACY_GENERATED_MARKER = "<!-- omni-book-reader:generated -->";

/** Marker comments from the generated files of earlier versions; only read when moving those files. */
type AnnotationDocumentKind = "annotations" | "highlights" | "notes";

/** Where earlier versions kept a separate `<title> Notes.md` file per book. */
export const ANNOTATION_FOLDER = "Media/Books/Attachments";

/** The callout in each book note that holds the highlights. */
export const HIGHLIGHTS_CALLOUT = CALLOUT_HEADER;
/** Every highlight is one line under the callout, starting with this. */
export const HIGHLIGHT_LINE_PREFIX = CALLOUT_ITEM_PREFIX;

/**
 * In the "by-color" layout, the highlights sit between these two lines of the
 * book note; everything between them is rewritten, everything else is left alone.
 */
export const BY_COLOR_START = "%% ePub Reader highlights: start %%";
export const BY_COLOR_END = "%% ePub Reader highlights: end (the lines between these two are rewritten) %%";
const BY_COLOR_START_PREFIX = "%% ePub Reader highlights: start";
const BY_COLOR_END_PREFIX = "%% ePub Reader highlights: end";

/** A leading YAML frontmatter block. */
const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n?---[ \t]*(?:\r?\n|$)/;

/** A layout chosen for a book, with its heading order for the by-color layout. */
export interface LayoutChoice {
  layout: NoteLayout;
  order?: HighlightColor[];
}

export interface AnnotationDocumentInput {
  sourceFile: TFile;
  state: BookState;
  title: string;
  author: string;
}

function isFile(value: TAbstractFile | null): value is TFile {
  return Boolean(value && "extension" in value);
}

function isFolder(value: TAbstractFile | null): value is TFolder {
  return Boolean(value && "children" in value);
}

function dateStamp(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function singleLine(value: string, fallback = ""): string {
  return value.replace(/\s+/g, " ").trim() || fallback;
}

/** Turns a highlight tag into an Obsidian tag: spaces become `_` and characters tags cannot hold are dropped. */
export function toObsidianTag(tag: string): string {
  const body = tag.trim().replace(/^#+/, "").replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_/-]/gu, "");
  return body ? `#${body}` : "";
}

/** Every highlighted passage is followed by this tag. */
const QUOTE_TAG = "#quote";

function tagText(highlight: ReaderHighlight): string {
  const tags = new Set(highlight.tags.map(toObsidianTag).filter(Boolean));
  tags.delete(QUOTE_TAG);
  return Array.from(tags).join(" ");
}

/** Builds a vault file name from the EPUB title, dropping characters that file names and links cannot hold. */
export function annotationFileName(title: string, fallback: string): string {
  const clean = (value: string): string => value
    .replace(/[\\/:*?"<>|#^[\]\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[\s.]+$/, "")
    .slice(0, 180)
    .trim();
  return clean(title) || clean(fallback) || "Untitled book";
}

/** The separate notes files earlier versions wrote for a book (`<title> Notes.md`, and `<title>-Notes.md` before that). */
function companionPaths(title: string, sourceFile: TFile): string[] {
  const name = annotationFileName(title, sourceFile.basename);
  return [`${name} Notes.md`, `${name}-Notes.md`].map((file) => normalizePath(`${ANNOTATION_FOLDER}/${file}`));
}

function comparePosition(left: ReaderHighlight, right: ReaderHighlight): number {
  if (left.sectionIndex !== right.sectionIndex) return left.sectionIndex - right.sectionIndex;
  try {
    const order = compareCfi(left.cfi, right.cfi);
    if (order) return order;
  } catch {
    // Fall back to creation order when a CFI cannot be parsed.
  }
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

/** `obsidian://` action for links back into a book. Separate from the original plugin's `omni-book-reader`. */
export const PROTOCOL_ACTION = "omni-book-reader-mod";
const PROTOCOL_PREFIXES = [`obsidian://${PROTOCOL_ACTION}?`, "obsidian://omni-book-reader?"];
/** A Markdown link made by this plugin (or, from before it became separate, by the original one). */
const BOOK_LINK = /\]\(obsidian:\/\/omni-book-reader(?:-mod)?\?[^)\s]*\)/;

/** True for links made by this plugin or, from before it became separate, by the original one. */
export function isBookLink(href: string): boolean {
  return PROTOCOL_PREFIXES.some((prefix) => href.startsWith(prefix));
}

export function buildCfiLink(vaultName: string, sourcePath: string, cfi: string): string {
  const encode = (value: string): string => encodeURIComponent(value)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const params = [
    // `vault` is reserved by Obsidian and is resolved before custom protocol
    // handlers run. Keep the source Vault as plugin-owned metadata instead.
    vaultName ? `sourceVault=${encode(vaultName)}` : "",
    `path=${encode(normalizePath(sourcePath))}`,
    `cfi=${encode(cfi)}`,
  ].filter(Boolean).join("&");
  return `obsidian://${PROTOCOL_ACTION}?${params}`;
}

/** A highlight in the shared note-layout form (see `note-layout.ts`). */
function layoutEntry(highlight: ReaderHighlight, sourcePath: string, vaultName: string): LayoutEntry {
  const chapter = singleLine(highlight.chapter);
  return {
    text: singleLine(highlight.text, "(empty excerpt)"),
    tags: highlight.tags.map(toObsidianTag).filter(Boolean),
    note: singleLine(highlight.note ?? ""),
    color: highlight.color,
    pages: highlight.page ? [singleLine(highlight.page)] : [],
    chapter: chapter && chapter !== "Untitled chapter" ? chapter : "",
    link: buildCfiLink(vaultName, sourcePath, highlight.cfi),
    plain: Boolean(highlight.lookup),
  };
}

/**
 * One highlight as a line under the book note's callout:
 * `> > - passage #quote #tags *-- note* *(Chapter, [p. 14](link))*`.
 * A saved word lookup is `> > - word *-- definition (Chapter, [p. 14](link))*` instead.
 * The link back into the book is what marks the line as the plugin's.
 */
export function renderHighlightLine(highlight: ReaderHighlight, sourcePath: string, vaultName = ""): string {
  return calloutLine(layoutEntry(highlight, sourcePath, vaultName));
}

/** Book note list property that collects highlights saved with "Highlight and add tags". */
export const QUOTES_PROPERTY = "Quotes";

/**
 * A highlight as a `Quotes` entry: `passage #quote #tags`. Double quotes inside the passage become single
 * quotes ("…" → '…', “…” → ‘…’) so they never clash with the quotation marks around the entry.
 */
export function quoteEntry(highlight: ReaderHighlight): string {
  const passage = singleLine(highlight.text, "(empty excerpt)").replace(/"/g, "'").replace(/“/g, "‘").replace(/”/g, "’");
  return [passage, QUOTE_TAG, tagText(highlight)].filter(Boolean).join(" ");
}

/**
 * Adds `entry` to the `Quotes` list in a note's frontmatter, always as a double-quoted YAML string so the
 * `#` tags stay part of the value (unquoted, YAML would read ` #…` as a comment). Other properties and
 * existing entries are left as they are. Returns the content unchanged when the entry is already there,
 * and `null` when `Quotes` exists in a form this cannot extend safely (inline `[…]` or a single value).
 */
export function addQuoteToFrontmatter(content: string, entry: string): string | null {
  const item = JSON.stringify(entry.replace(/\s+/g, " ").trim());
  const text = content.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/.exec(text);
  if (!match) return `---\n${QUOTES_PROPERTY}:\n  - ${item}\n---\n${text}`;
  const lines = (match[1] ?? "").split("\n").filter((line, index, all) => line || index < all.length - 1);
  const keyIndex = lines.findIndex((line) => new RegExp(`^${QUOTES_PROPERTY}:\\s*$`).test(line));
  if (keyIndex < 0) {
    if (lines.some((line) => new RegExp(`^${QUOTES_PROPERTY}:`).test(line))) return null;
    lines.push(`${QUOTES_PROPERTY}:`, `  - ${item}`);
  } else {
    let end = keyIndex + 1;
    let indent = "  ";
    while (end < lines.length && /^\s*-(\s|$)/.test(lines[end] ?? "")) {
      const value = (lines[end] ?? "").replace(/^\s*-\s*/, "").trim();
      if (value === item || value.replace(/^["']|["']$/g, "") === entry.trim()) return content;
      indent = /^(\s*)-/.exec(lines[end] ?? "")?.[1] ?? indent;
      end += 1;
    }
    lines.splice(end, 0, `${indent}- ${item}`);
  }
  return `---\n${lines.join("\n")}\n---\n${text.slice(match[0].length)}`;
}

/** A color's name as heading text that Markdown shows as written (never as a tag or formatting). */
function headingLabel(color: string, names: ColorNames): string {
  return colorName(color, names)
    .replace(/[\\`*_{}<>|[\]]/g, "\\$&")
    .replace(/(^|\s)#/g, "$1\\#");
}

/**
 * The book's highlights in the "by-color" layout: a heading per color, in
 * `order` and then the default color order, highlights in book order under each.
 */
export function renderByColorLines(
  highlights: ReaderHighlight[],
  sourcePath: string,
  vaultName = "",
  order: HighlightColor[] = [],
  names: ColorNames = {},
): string[] {
  const colors = orderColors(Array.from(new Set(highlights.map((highlight) => highlight.color))), names, order);
  return byColorLines(
    [...highlights].sort(comparePosition).map((highlight) => layoutEntry(highlight, sourcePath, vaultName)),
    colors,
    (color) => headingLabel(color, names),
  );
}

/** The book's highlights as callout lines, in book order. */
export function renderHighlightLines(highlights: ReaderHighlight[], sourcePath: string, vaultName = ""): string[] {
  return [...highlights].sort(comparePosition).map((highlight) => renderHighlightLine(highlight, sourcePath, vaultName));
}

function isPluginLine(line: string): boolean {
  return BOOK_LINK.test(line);
}

/** A line that continues the callout's list: another `> > -` item or an indented continuation of one. */
function isCalloutListLine(line: string): boolean {
  return /^> > (?:-|\s{2,}\S)/.test(line);
}

/**
 * Puts the plugin's highlight lines under the highlights callout, leaving every other line alone.
 * The plugin's existing lines (those with a link back into a book) are replaced in place, in book order;
 * extra lines go after the last one, or at the end of the callout's list. A missing callout is added at the end.
 */
export function updateHighlightsCallout(content: string, lines: string[]): string {
  const all = content.replace(/\r\n?/g, "\n").split("\n");
  const header = all.findIndex((line) => line.trim() === HIGHLIGHTS_CALLOUT.trim());
  if (header < 0) {
    if (!lines.length) return content;
    const body = content.replace(/\s+$/, "");
    return `${body}${body ? "\n\n" : ""}${[HIGHLIGHTS_CALLOUT, ...lines].join("\n")}\n`;
  }
  let end = header + 1;
  while (end < all.length && isCalloutListLine(all[end] ?? "")) end += 1;
  const region = all.slice(header + 1, end);
  const slots = region.flatMap((line, index) => isPluginLine(line) ? [index] : []);
  const lastSlot = slots[slots.length - 1];
  const next: string[] = [];
  let used = 0;
  region.forEach((line, index) => {
    if (!isPluginLine(line)) {
      next.push(line);
      return;
    }
    if (used < lines.length) next.push(lines[used] ?? "");
    used += 1;
    if (index === lastSlot) next.push(...lines.slice(used));
  });
  if (lastSlot === undefined) next.push(...lines);
  const updated = [...all.slice(0, header + 1), ...next, ...all.slice(end)].join("\n");
  return updated === content.replace(/\r\n?/g, "\n") ? content : updated;
}

function lineIndex(lines: string[], prefix: string, from = 0): number {
  for (let index = from; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim().startsWith(prefix)) return index;
  }
  return -1;
}

/** The by-color section's first and last line, or null when the note has none. */
function byColorRegion(lines: string[]): { start: number; end: number } | null {
  const start = lineIndex(lines, BY_COLOR_START_PREFIX);
  if (start < 0) return null;
  const end = lineIndex(lines, BY_COLOR_END_PREFIX, start + 1);
  return { start, end: end < 0 ? start : end };
}

/** The layout a book note is already in, or null when it holds no highlights yet. */
export function detectNoteLayout(content: string): NoteLayout | null {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (byColorRegion(lines)) return "by-color";
  const header = lines.findIndex((line) => line.trim() === HIGHLIGHTS_CALLOUT.trim());
  if (header < 0) return null;
  for (let index = header + 1; index < lines.length && isCalloutListLine(lines[index] ?? ""); index += 1) {
    if (isPluginLine(lines[index] ?? "")) return "callout";
  }
  return null;
}

/**
 * Writes the by-color section with `lines`. The plugin's lines under the
 * quotes callout are removed (and the callout too, when nothing else is in it),
 * so a book never lists its highlights twice. A new section goes where the
 * callout was, or at the end of the note.
 */
export function updateByColorRegion(content: string, lines: string[]): string {
  const original = content.replace(/\r\n?/g, "\n");
  const all = original.split("\n");
  const block = [BY_COLOR_START, "", ...lines, BY_COLOR_END];
  while (block.length > 2 && block[block.length - 2] === "") block.splice(block.length - 2, 1);
  let insertAt = -1;
  const header = all.findIndex((line) => line.trim() === HIGHLIGHTS_CALLOUT.trim());
  if (header >= 0) {
    let end = header + 1;
    while (end < all.length && isCalloutListLine(all[end] ?? "")) end += 1;
    const kept = all.slice(header + 1, end).filter((line) => !isPluginLine(line));
    if (kept.length) {
      all.splice(header + 1, end - header - 1, ...kept);
      insertAt = header + 1 + kept.length;
    } else {
      all.splice(header, end - header);
      insertAt = header;
    }
  }
  const region = byColorRegion(all);
  if (region) {
    all.splice(region.start, region.end - region.start + 1, ...block);
  } else if (insertAt >= 0) {
    const before = insertAt > 0 && (all[insertAt - 1] ?? "").trim() ? [""] : [];
    const after = insertAt < all.length && (all[insertAt] ?? "").trim() ? [""] : [];
    all.splice(insertAt, 0, ...before, ...block, ...after);
  } else {
    while (all.length && !(all[all.length - 1] ?? "").trim()) all.pop();
    if (all.length) all.push("");
    all.push(...block, "");
  }
  const updated = all.join("\n");
  return updated === original ? content : updated;
}

/** Turns the by-color section back into the quotes callout header, so the callout takes its place. */
export function replaceByColorRegionWithCallout(content: string): string {
  const all = content.replace(/\r\n?/g, "\n").split("\n");
  const region = byColorRegion(all);
  if (!region) return content;
  const hasCallout = all.some((line, index) => (index < region.start || index > region.end) && line.trim() === HIGHLIGHTS_CALLOUT.trim());
  all.splice(region.start, region.end - region.start + 1, ...(hasCallout ? [] : [HIGHLIGHTS_CALLOUT]));
  return all.join("\n").replace(/\n{3,}/g, "\n\n");
}

function managedStart(kind: AnnotationDocumentKind): string {
  return `<!-- omni-book-reader:${kind}:start -->`;
}

function managedEnd(kind: AnnotationDocumentKind): string {
  return `<!-- omni-book-reader:${kind}:end -->`;
}

/** True for a file the plugin generated in an earlier version; nothing else is ever moved or trashed. */
function isGeneratedDocument(content: string): boolean {
  return content.includes("<!-- omni-book-reader:");
}

/** What the person wrote in an earlier generated file, without the plugin's blocks or its frontmatter. */
export function userContent(content: string): string {
  if (content.trimStart().startsWith(LEGACY_GENERATED_MARKER)) return "";
  let rest = content.replace(FRONTMATTER_BLOCK, "");
  for (const kind of ["annotations", "highlights", "notes"] as const) {
    const start = managedStart(kind);
    const end = managedEnd(kind);
    const startIndex = rest.indexOf(start);
    const endIndex = startIndex >= 0 ? rest.indexOf(end, startIndex + start.length) : -1;
    if (endIndex >= 0) rest = `${rest.slice(0, startIndex)}${rest.slice(endIndex + end.length)}`;
  }
  return rest.replace(/\n{3,}/g, "\n\n").trim();
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

export class AnnotationDocumentService {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly vault: Vault,
    /** Should be `app.fileManager.trashFile`, which respects the person's deletion preference. */
    private readonly trashFile: (file: TAbstractFile) => Promise<void>,
    /** Finds the Markdown note named like the EPUB (`Dune.epub` → `Dune.md`). */
    private readonly findBookNote: (sourceFile: TFile) => TFile | null,
    /**
     * Asks which layout a book's note uses, the first time highlights are
     * written for it. Null (window closed) keeps the quotes callout.
     */
    private readonly chooseLayout: (input: AnnotationDocumentInput) => Promise<LayoutChoice | null> = async () => null,
  ) {}

  sync(input: AnnotationDocumentInput): Promise<void> {
    const job = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const note = this.findBookNote(input.sourceFile);
        if (!note) {
          throw new Error(`No note named "${input.sourceFile.basename}" was found to hold this book's highlights.`);
        }
        const previous = input.state.annotationDocuments;
        const oldFiles = await this.oldDocumentFiles(input, previous, note.path);
        const current = await this.vault.cachedRead(note);
        // The layout chosen for this book, else the one its note is already in
        // (so other devices follow the note), else ask once there is something to write.
        let layout = input.state.noteLayout ?? detectNoteLayout(current);
        if (!layout && input.state.highlights.length) {
          const choice = await this.chooseLayout(input);
          layout = choice?.layout ?? "callout";
          if (choice?.order?.length) input.state.colorOrder = choice.order;
          input.state.noteSettingsUpdatedAt = Date.now();
        }
        if (layout) input.state.noteLayout = layout;
        let next = layout === "by-color"
          ? updateByColorRegion(current, renderByColorLines(
            input.state.highlights,
            input.sourceFile.path,
            this.vault.getName(),
            input.state.colorOrder,
            input.state.colorNames,
          ))
          : updateHighlightsCallout(
            replaceByColorRegionWithCallout(current),
            renderHighlightLines(input.state.highlights, input.sourceFile.path, this.vault.getName()),
          );
        for (const file of oldFiles) {
          const text = userContent(await this.vault.cachedRead(file));
          if (text && !next.includes(text)) next = `${next.trimEnd()}\n\n${text}\n`;
        }
        if (next !== current) await this.vault.modify(note, next);
        input.state.annotationDocuments = {
          highlightPath: note.path,
          notePath: note.path,
          createdDate: previous?.createdDate || dateStamp(Date.now()),
        };
        await this.removeOldDocuments(oldFiles);
      });
    this.writeChain = job.catch(() => undefined);
    return job;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Adds a highlight to the book note's `Quotes` property. Runs in the same queue as the callout writes,
   * so the two never overwrite each other. Falls back to Obsidian's frontmatter API when the property
   * is in a form that cannot be extended as text.
   */
  addQuote(
    sourceFile: TFile,
    highlight: ReaderHighlight,
    processFrontMatter: (note: TFile, update: (frontmatter: Record<string, unknown>) => void) => Promise<void>,
  ): Promise<void> {
    const job = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const note = this.findBookNote(sourceFile);
        if (!note) throw new Error(`No note named "${sourceFile.basename}" was found for this book's Quotes`);
        const entry = quoteEntry(highlight);
        const current = await this.vault.cachedRead(note);
        const next = addQuoteToFrontmatter(current, entry);
        if (next === null) {
          await processFrontMatter(note, (frontmatter) => {
            const value: unknown = frontmatter[QUOTES_PROPERTY];
            const list: unknown[] = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
            if (!list.includes(entry)) list.push(entry);
            frontmatter[QUOTES_PROPERTY] = list;
          });
        } else if (next !== current) {
          await this.vault.modify(note, next);
        }
      });
    this.writeChain = job.catch(() => undefined);
    return job;
  }

  migrateLegacyProtocolLinks(documents: Iterable<AnnotationDocuments | undefined>): Promise<void> {
    const paths = new Set<string>();
    for (const item of documents) {
      if (item?.highlightPath) paths.add(normalizePath(item.highlightPath));
      if (item?.notePath) paths.add(normalizePath(item.notePath));
    }
    const job = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        for (const path of paths) {
          const file = this.vault.getAbstractFileByPath(path);
          if (!isFile(file) || file.extension.toLowerCase() !== "md") continue;
          const current = await this.vault.cachedRead(file);
          // Older links used `vault=` (reserved by Obsidian) and the original plugin's action.
          const next = current
            .replace(/obsidian:\/\/omni-book-reader(?:-mod)?\?vault=/g, `obsidian://${PROTOCOL_ACTION}?sourceVault=`)
            .replaceAll("obsidian://omni-book-reader?", `obsidian://${PROTOCOL_ACTION}?`);
          if (next !== current) await this.vault.modify(file, next);
        }
      });
    this.writeChain = job.catch(() => undefined);
    return job;
  }

  /** Generated files from earlier versions (Highlight/Note pairs, `<title> Notes.md`) to fold into the book note. */
  private async oldDocumentFiles(
    input: AnnotationDocumentInput,
    previous: AnnotationDocuments | undefined,
    notePath: string,
  ): Promise<TFile[]> {
    const candidates = new Set([
      ...(previous ? [previous.highlightPath, previous.notePath] : []),
      ...companionPaths(input.title, input.sourceFile),
    ].map((path) => normalizePath(path)));
    candidates.delete(normalizePath(notePath));
    const files: TFile[] = [];
    for (const path of candidates) {
      const file = this.vault.getAbstractFileByPath(path);
      if (!isFile(file) || file.extension.toLowerCase() !== "md") continue;
      if (isGeneratedDocument(await this.vault.cachedRead(file))) files.push(file);
    }
    return files;
  }

  private async removeOldDocuments(files: TFile[]): Promise<void> {
    const folders = new Set(files.map((file) => parentPath(file.path)));
    for (const file of files) await this.trashFile(file);
    for (const folderPath of folders) {
      if (!folderPath || normalizePath(folderPath) === normalizePath(ANNOTATION_FOLDER)) continue;
      const folder = this.vault.getAbstractFileByPath(folderPath);
      if (isFolder(folder) && !folder.children.length) await this.trashFile(folder);
    }
  }
}
