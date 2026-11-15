# Highlights panel shared with PDF Annotator

The sidebar opens on the **right**, like PDF Annotator's Annotations panel (CSS `order` on desktop; it slides in from the right edge at narrow widths).

The highlights tab uses `src/annotation-filters.ts`, a **verbatim copy** of PDF Annotator's file (see [`note-layouts.md`](note-layouts.md) for how the two plugins are kept aligned), with the `af-*` CSS block at the end of `styles.css`. `FilterBar` is built once per panel and refreshed with `update`, so typing in its search box never loses focus.

Filters, in this order: search (passage, note, chapter, tags), color chips with the book's color names and counts (plus a **Colors** button for the "Highlight colors" window; right-click a chip does the same), tag, chapter, notes (with / without; PDFs also offer page notes), date (today, 7 or 30 days) and sort: **reading order** (default; grouped under chapter headings), newest, oldest, by color (`compareColors`, then reading order). Filters are per view and reset when another book opens; a color, tag or chapter filter that no longer matches anything is dropped.

## Look (1.1.35)

At the owner's request the reader uses PDF Annotator's look wherever the two overlap (end of `styles.css`, "PDF Annotator's look"): the sidebar floats over the page on the right on desktop (rounded, shadowed, 340px), highlights are cards (color strip, tinted border, a meta line with page, chapter, kind, tags and color name, the passage in semi-bold, the note under a rule, an edit button), the selection toolbar is a rounded bar with square color chips and accent icons, and Close is red. Colors still come from Obsidian's theme variables.

## Header (1.1.37)

The sidebar starts with a header like PDF Annotator's panel header: the Contents, Annotations and Bookmarks tabs (styled like the filter menus, with counts), an export button shown on the Annotations tab, and a close (×) button. The book's cover, title, author and progress slider were removed from the sidebar; the reading area already shows them. The filter bar's color chips and Colors button have no outlines in either plugin.
