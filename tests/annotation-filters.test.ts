import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, isUnfiltered, matchesDate } from "../src/annotation-filters";

describe("shared highlight filters", () => {
  const now = new Date(2026, 10, 15, 15, 0, 0).getTime();

  it("filters by date the same way in both plugins", () => {
    expect(matchesDate(now - 1000, "today", now)).toBe(true);
    expect(matchesDate(new Date(2026, 10, 14, 23, 0, 0).getTime(), "today", now)).toBe(false);
    expect(matchesDate(now - 6 * 86_400_000, "7d", now)).toBe(true);
    expect(matchesDate(now - 8 * 86_400_000, "7d", now)).toBe(false);
    expect(matchesDate(now - 29 * 86_400_000, "30d", now)).toBe(true);
    expect(matchesDate(0, "all", now)).toBe(true);
  });

  it("treats only sorting as unfiltered", () => {
    expect(isUnfiltered({ ...DEFAULT_FILTERS, sort: "color" })).toBe(true);
    expect(isUnfiltered({ ...DEFAULT_FILTERS, query: "  " })).toBe(true);
    expect(isUnfiltered({ ...DEFAULT_FILTERS, query: "fox" })).toBe(false);
    expect(isUnfiltered({ ...DEFAULT_FILTERS, color: "#ffd12d" })).toBe(false);
    expect(isUnfiltered({ ...DEFAULT_FILTERS, note: "with-note" })).toBe(false);
    expect(DEFAULT_FILTERS.sort).toBe("reading");
  });
});
