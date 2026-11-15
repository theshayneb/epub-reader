export type ReaderTheme = "auto" | "light" | "dark" | "sepia";
export type ReaderLayout = "paginated" | "scrolled";
export type ReaderFont = "obsidian" | "publisher" | "serif" | "sans";
export type ReaderWidthMode = "standard" | "wide" | "full" | "edge";
import type { NoteLayout } from "./note-layout";
import type { ColorNames } from "./highlight-colors";

/**
 * A highlight color as a lower-case `#rrggbb` value: one of the shared
 * palette's colors (`highlight-colors.ts`) or one the book added. Data from
 * before 1.1.29 stored color words ("yellow"); `toHighlightColor` maps them.
 */
export type HighlightColor = string;
export type HighlightStyle = "highlight" | "underline" | "strikethrough" | "squiggly";
export type BookshelfDisplayMode = "list" | "grid" | "covers";
export type BookshelfFilter = "all" | "reading" | "finished" | "reading-list";
export type BookshelfSort = "recent" | "title" | "progress";
export type SidebarPreference = "toc" | "highlights" | "bookmarks";
export type ReadingPreset = "custom" | "comfortable" | "compact" | "large";
export type InterfaceDensity = "comfortable" | "compact";

export interface ReaderSettings {
  theme: ReaderTheme;
  layout: ReaderLayout;
  tapToTurnPages: boolean;
  font: ReaderFont;
  fontSizePercent: number;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing: number;
  widthMode: ReaderWidthMode;
  contentWidth: number;
  pageMargin: number;
  bookshelfDisplayMode: BookshelfDisplayMode;
  bookshelfFilter: BookshelfFilter;
  bookshelfSort: BookshelfSort;
  lastSidebarTab: SidebarPreference;
  readerChromeAutoHide: boolean;
  readingPreset: ReadingPreset;
  defaultHighlightColor: HighlightColor;
  defaultHighlightStyle: HighlightStyle;
  connectAdjacentHighlights: boolean;
  /** On Android, dismiss the system Copy/Share/Select all bar once a touch selection settles. */
  hideAndroidTextMenu: boolean;
  interfaceDensity: InterfaceDensity;
  hasSeenReaderTutorial: boolean;
  syncEnabled: boolean;
  syncFolder: string;
}

export interface SourceSignature {
  size: number;
  mtime: number;
}

export interface ReadingPosition {
  cfi: string;
  fraction: number;
  updatedAt: number;
}

export interface Bookmark {
  id: string;
  cfi: string;
  fraction: number;
  chapter: string;
  createdAt: number;
  stale?: boolean;
}

export interface ReaderHighlight {
  id: string;
  cfi: string;
  text: string;
  chapter: string;
  color: HighlightColor;
  style: HighlightStyle;
  tags: string[];
  sectionIndex: number;
  createdAt: number;
  /** Page label shown in the reader when the highlight was made; absent for older highlights. */
  page?: string;
  /** True when the highlight was saved from a word lookup; its note is the definition or translation. */
  lookup?: boolean;
  note?: string;
  noteUpdatedAt?: number;
  stale?: boolean;
}

export interface AnnotationDocuments {
  highlightPath: string;
  notePath: string;
  createdDate: string;
}

export interface ReadingStats {
  totalReadingMs: number;
  lastOpenedAt: number;
  lastReadAt: number;
  furthestFraction: number;
  completedAt?: number;
}

export interface BookState {
  sourceSignature: SourceSignature;
  position?: ReadingPosition;
  bookmarks: Bookmark[];
  highlights: ReaderHighlight[];
  annotationDocuments?: AnnotationDocuments;
  /** How highlights are laid out in the book note; unset until chosen (or read from the note). */
  noteLayout?: NoteLayout;
  /** The order of color headings when `noteLayout` is "by-color" (color values). */
  colorOrder?: HighlightColor[];
  /** This book's names for its highlight colors, keyed by color value. */
  colorNames?: ColorNames;
  /** Colors added to the palette for this book. */
  extraColors?: HighlightColor[];
  /** When the layout, heading order, color names or added colors last changed; they sync as one unit. */
  noteSettingsUpdatedAt?: number;
  readingStats?: ReadingStats;
  /** User-managed bookshelf metadata. These fields never affect the EPUB itself. */
  hiddenFromBookshelf?: boolean;
  inReadingList?: boolean;
  customCoverPath?: string;
}

export interface ReaderData {
  schemaVersion: 5;
  settings: ReaderSettings;
  books: Record<string, BookState>;
  importedLegacyDataPaths: string[];
}

export interface FoliateTocItem {
  label?: unknown;
  href?: string;
  subitems?: FoliateTocItem[];
}

export interface FoliateMetadata {
  title?: unknown;
  author?: unknown;
  language?: unknown;
}

export interface FoliateBook {
  toc?: FoliateTocItem[];
  metadata?: FoliateMetadata;
  dir?: "ltr" | "rtl";
  rendition?: { layout?: string };
  transformTarget?: EventTarget;
  getCover?: () => Promise<Blob | null>;
  destroy?: () => void;
  sections?: Array<{ unload?: () => void }>;
}

export interface FoliateRenderer extends HTMLElement {
  page?: number;
  pages?: number;
  setStyles?: (css: string) => void;
  getContents?: () => Array<{ doc: Document; index: number; overlayer?: FoliateOverlayer }>;
}

export interface FoliateOverlayer {
  hitTest(point: { x: number; y: number }): readonly [] | readonly [string, Range];
}

export interface FoliateLocation {
  cfi?: string;
  fraction?: number;
  tocItem?: { label?: unknown; href?: string };
  pageItem?: { label?: unknown };
  location?: { current?: number; total?: number };
}

export interface FoliateSearchExcerpt {
  pre?: string;
  match?: string;
  post?: string;
}

export interface FoliateSearchItem {
  cfi: string;
  excerpt?: string | FoliateSearchExcerpt;
}

export type FoliateSearchResult =
  | "done"
  | { progress: number }
  | { label?: string; subitems: FoliateSearchItem[] };

export interface FoliateViewElement extends HTMLElement {
  book: FoliateBook;
  renderer: FoliateRenderer;
  isFixedLayout?: boolean;
  lastLocation?: FoliateLocation;
  open(source: File | FoliateBook): Promise<void>;
  init(options: { lastLocation?: string; showTextStart: boolean }): Promise<void>;
  close(): void;
  goLeft(): Promise<void> | void;
  goRight(): Promise<void> | void;
  prev(): Promise<void> | void;
  next(): Promise<void> | void;
  goToTextStart(): Promise<void>;
  goTo(target: string | number): Promise<unknown>;
  goToFraction(fraction: number): Promise<void>;
  select(target: string): Promise<void>;
  deselect(): void;
  getCFI(index: number, range?: Range): string;
  resolveNavigation(target: string | number): { index: number; anchor?: unknown } | undefined;
  addAnnotation(annotation: { value: string; color?: string; style?: HighlightStyle }): Promise<unknown>;
  deleteAnnotation(annotation: { value: string }): Promise<unknown>;
  search(options: {
    query: string;
    matchCase: boolean;
    matchDiacritics: boolean;
    matchWholeWords: boolean;
  }): AsyncGenerator<FoliateSearchResult>;
  clearSearch(): void;
}

export interface PublicationTransformDetail {
  data: string | Blob | Promise<string | Blob>;
  type?: string;
  name?: string;
}
