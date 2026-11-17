/**
 * Characters that show nothing on a page: spaces of every kind, the
 * characters Unicode says to leave out when drawing text (joiners, marks of
 * direction, soft hyphens, fillers, invisible operators), and a blank braille
 * cell.
 */
const SHOWS_NOTHING = /[\s\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** True when `text` has something a reader can see: a description, a review, a name. */
export function hasVisibleText(text: string): boolean {
  return text.replace(SHOWS_NOTHING, "") !== "";
}
