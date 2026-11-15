# Chapter loading

Status: Accepted
Date: 2026-11-15

## Context

Every chapter Foliate loads goes through `inlineFoliateBlobMarkup` (`src/foliate-blob-markup-normalizer.ts`), which turns the chapter's Blob URL resources into a self-contained `srcdoc` (needed because Android revokes the Blob URLs). It converted each stylesheet, image and embedded font to a data URL on every chapter load, one resource after another, and Foliate gives the same resource a new Blob URL whenever it reloads it. On phones and tablets, chapter changes felt frozen.

## Decision

- Converted resources are cached for the open book, keyed by the SHA-256 of their content (`crypto.subtle`), not by Blob URL, so a revisited chapter or a stylesheet shared by every chapter is converted once. Normalized stylesheets are cached by their text. The cache is bounded (48M characters, least recently used first) and cleared when the book closes (`clearInlinedResourceCache` in `cleanupReader`). Without `crypto.subtle` nothing is cached and behaviour is as before.
- A chapter's images, stylesheets and the resources inside a stylesheet are converted concurrently instead of sequentially.
- The reading position is saved 2 seconds after page turning pauses (was 0.5 s), because each save copies and writes the whole plugin data file; closing the book still saves immediately.

Sanitization is unchanged.

## Validation

`tests/foliate-runtime-patches.test.ts` checks that the same image and font under new Blob URLs are converted once, give identical output, and are converted again after the cache is cleared. Not profiled on a device.
