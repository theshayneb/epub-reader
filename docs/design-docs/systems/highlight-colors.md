# Highlight colors shared with PDF Annotator

`src/highlight-colors.ts` is a **verbatim copy** of the same file in PDF Annotator (see [`note-layouts.md`](note-layouts.md) for how the two plugins are kept aligned). It holds the palette, color names and ordering, added colors, and the "Highlight colors" window; the `hl-colors-*` CSS block at the end of `styles.css` goes with it.

## Palette and stored values

- Five built-in colors, in this default order: yellow `#ffd12d`, green `#83cb67`, blue `#6f9fe8`, purple `#aa78df`, pink `#e463a1` (PDF Annotator's values, which its per-PDF color names are keyed by).
- Highlights, `defaultHighlightColor`, `colorOrder`, `colorNames` keys and `extraColors` store lower-case `#rrggbb` values.
- Up to 12 added colors per book (`BookState.extraColors`): presets that read well on light pages, or any hex value. Changing an added color recolors its highlights; removing one keeps existing highlights in it.
- Before 1.1.29 highlights stored the words `yellow`, `green`, `blue` and `pink` (shown as `#ffd54f`, `#81c784`, `#64b5f6`, `#f48fb1`). `toHighlightColor` maps the words to the palette's values when data is loaded, in settings, and in sync files from devices that have not updated. The shades therefore change slightly.

## Names and order

`BookState.colorNames` maps a color value to the book's own name for it ("Costs"). Names label the selection toolbar, filters, the edit window, and headings in the by-color note layout. A color named "important" sorts first, then other named colors alphabetically, then palette order (`compareColors`); a chosen heading order (`colorOrder`) overrides that for the note.

## Sync

`noteLayout`, `colorOrder`, `colorNames` and `extraColors` sync between devices as one unit (`SyncedBook.noteSettings`), last writer wins by `noteSettingsUpdatedAt`. A device on a version before 1.1.29 reads the new color values as yellow and writes that back with the original edit's time. Since 1.1.36 highlights read with a color word are marked `legacyColor`, and on a tie in time the copy from an up-to-date device wins (`newerEntry`), so an outdated device cannot turn recolored highlights back to yellow; it still shows them as yellow itself until it is updated.

Highlights saved from **Define** are always blue (`#6f9fe8`) and do not change the last color used.
