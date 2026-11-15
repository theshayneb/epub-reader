# Align ePub Reader with PDF Annotator

## Scope

Make ePub Reader and PDF Annotator look and behave alike wherever they overlap, without merging them. Decisions from the owner (2026-11-15): note layout chosen per book at first export in both plugins; panels on the right, as in PDF Annotator; both repositories edited together.

## Stages

1. **Note layouts** (this release): shared `note-layout.ts`, per-book layout choice, headings-by-color layout for EPUBs, quotes-callout layout for PDFs. Design: [`../../design-docs/systems/note-layouts.md`](../../design-docs/systems/note-layouts.md).
2. Colors: the same palette, per-book color names and added colors.
3. Selection toolbar: same order, icons and actions (tag and note buttons in both).
4. Highlights panel: on the right; same filters and sort choices.
5. Highlight styles: matching names and icons where shared.
6. Define/translate result: same placement and wording.

## Acceptance criteria (stage 1)

- A new book asks for its layout once, when its note is first written; existing books keep the callout without asking.
- Headings by color: color order chosen at first choice and on each manual export; only the marked section of the note is rewritten.
- Switching layouts keeps everything the person wrote.
- Callout output is unchanged for existing books.

## Validation

- 2026-11-15: `npm run verify:full`, see release notes. Not tried on a device.
