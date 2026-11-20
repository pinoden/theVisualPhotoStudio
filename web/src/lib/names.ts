/**
 * A full name as the client typed it, split as a card processor wants it: the first word is the given name, the rest
 * the family name. One word alone is the given name, as Square asks for a single name. Spaces around and between the
 * words do not count. Used for Square's customer (`createCustomer`) and for the bank's check of a card payment
 * (`buyerVerification`), so that both split a name the same way.
 */
export function splitName(full: string): { given: string; family: string } {
  const [given = "", ...rest] = full.trim().split(/\s+/);
  return { given, family: rest.join(" ") };
}
