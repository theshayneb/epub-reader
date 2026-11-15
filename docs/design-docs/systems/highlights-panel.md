# Highlights panel shared with PDF Annotator

The sidebar opens on the **right**, like PDF Annotator's Annotations panel (CSS `order` on desktop; it slides in from the right edge at narrow widths).

The highlights tab uses `src/annotation-filters.ts`, a **verbatim copy** of PDF Annotator's file (see [`note-layouts.md`](note-layouts.md) for how the two plugins are kept aligned), with the `af-*` CSS block at the end of `styles.css`. `FilterBar` is built once per panel and refreshed with `update`, so typing in its search box never loses focus.

Filters, in this order: search (passage, note, chapter, tags), color chips with the book's color names and counts (plus a **Colors** button for the "Highlight colors" window; right-click a chip does the same), tag, chapter, notes (with / without; PDFs also offer page notes), date (today, 7 or 30 days) and sort: **reading order** (default; grouped under chapter headings), newest, oldest, by color (`compareColors`, then reading order). Filters are per view and reset when another book opens; a color, tag or chapter filter that no longer matches anything is dropped.
