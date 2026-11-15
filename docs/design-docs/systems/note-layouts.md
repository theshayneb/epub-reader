# Note layouts shared with PDF Annotator

ePub Reader and PDF Annotator (a separate plugin by the same person) write highlights into Markdown notes. They are kept visually and behaviourally aligned so books and PDFs can be used interchangeably; they are not combined into one plugin.

## Shared module

`src/note-layout.ts` is a **verbatim copy** of the same file in PDF Annotator. It holds:

- the two layouts and their line formats (`calloutLine`, `byColorItem`, `byColorLines`, `colorHeading`);
- the window that asks which layout a book uses (`chooseNoteLayout`);
- the window that orders color headings (`chooseColorOrder`).

Change it in one plugin, then copy it to the other unchanged, together with the `note-layout-*` CSS block at the end of `styles.css`. The module only uses Obsidian theme variables and `Modal`/`Setting`/`setIcon`, so it fits both plugins' interface rules. Tests import it through `tests/obsidian-stub.ts`, which has minimal `Modal`, `Setting`, `App` and `setIcon` stand-ins.

## Layouts

Chosen per book the first time highlights are written to its note (or with **Change note layout for this book**):

- **Quotes callout** (`callout`), the original format: one line per highlight under `> > > [!quotenew] Quotes & References`, in book order: `> > - passage #quote #tags *-- note* *(Chapter, [p. 14](link))*`. Only lines with a link back into a book are the plugin's; other lines under the callout are kept.
- **Headings by color** (`by-color`): `# <span style="color: …">Yellow</span>` per color in the book's chosen order, then `- passage #tags *(Chapter, [pg. 14](link))*` with the note as `\t- ["] *note*`. In the book note this sits between `%% ePub Reader highlights: start %%` and `%% ePub Reader highlights: end … %%`; only that section is rewritten.

Each layout looks the same in both plugins (`p.` in the callout, `pg.` under color headings), so a note's look depends on the layout, not on the plugin.

## Stored state and other devices

`BookState.noteLayout` and `BookState.colorOrder` are kept with the book's other per-device data (like the bookshelf fields; not part of reading sync). A device without a stored layout reads it from the note (`detectNoteLayout`: the by-color section, or plugin lines in the callout), so a choice made on one device is followed on the others through the synced note. Books whose note already has plugin lines in the callout are treated as `callout` without asking.

## Switching

- callout → by-color: the plugin's callout lines are removed (the callout header too when nothing else is under it) and the section goes where the callout was, else at the end.
- by-color → callout: the section is replaced by the callout header (or removed, when another callout exists), then the callout is filled as usual.

## Asking

The layout window appears only when there is something to write (the book has highlights). Closing it without choosing keeps the quotes callout and remembers it. With headings by color, the heading order window follows when the book uses two or more colors; the manual export shows it again each time, as PDF Annotator does.
