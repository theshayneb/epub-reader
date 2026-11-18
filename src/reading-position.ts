/**
 * Whether a Foliate renderer relocation is the person reading on: turning a page ("page", "snap"),
 * scrolling ("scroll") or following a link, contents entry or search result ("navigation"). "anchor"
 * (re-layout after a resize or settings change) and "selection" are not.
 */
export function isReadingMove(reason: string | undefined, passive: boolean): boolean {
  if (reason === "page" || reason === "snap" || reason === "scroll") return true;
  return reason === "navigation" && !passive;
}
