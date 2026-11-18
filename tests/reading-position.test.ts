import { describe, expect, it } from "vitest";
import { isReadingMove } from "../src/reading-position";
describe("which reader moves count as reading", () => {
  it("counts page turns, scrolling and links, but not re-layouts or restoring the saved place", () => {
    expect(isReadingMove("page", false)).toBe(true);
    expect(isReadingMove("snap", true)).toBe(true);
    expect(isReadingMove("scroll", false)).toBe(true);
    expect(isReadingMove("navigation", false)).toBe(true);
    expect(isReadingMove("navigation", true)).toBe(false);
    expect(isReadingMove("anchor", false)).toBe(false);
    expect(isReadingMove("selection", false)).toBe(false);
    expect(isReadingMove(undefined, false)).toBe(false);
  });
});
