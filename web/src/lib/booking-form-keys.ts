/**
 * What the booking page and the server share of Booking Forms & Agreements (src/server/booking-forms.ts): the kinds
 * of question, the keys by which a client's acceptance of a version is sent and checked, and a client's initials.
 */

/**
 * "initials" is not asked a question: it is a statement the client initials with one click at the policies step, the
 * initials taken from their full name (the owner, 2026-11-27).
 */
export type QuestionKind = "text" | "checkbox" | "dropdown" | "choice" | "initials";

/** The website's Policies page, as published in this version. */
export const policiesKey = (versionId: string) => `page:${versionId}`;
/** A version of an agreement beside the policies. */
export const agreementKey = (versionId: string) => `agreement:${versionId}`;

/**
 * A statement the client initialed, with the very words they were shown: the statement's figures are today's
 * settings, and the owners can change its words, so the server takes the initials only for the words it would show
 * now. The mark tells one wording from another; it protects nothing.
 */
export const initialsKey = (questionId: string, words: string) => `initials:${questionId}:${markOf(words)}`;

/** A short mark of some words (FNV-1a, 32 bits), the same in the browser and on the server. */
function markOf(words: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < words.length; index++) {
    hash ^= words.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** At most this many letters: a first name, two middle names, a last name. */
const INITIALS_MAX = 4;

/**
 * A client's initials, from the full name they gave: the first letter of each word, in capitals ("Jane Smith" is JS,
 * "Mary-Jane O'Neil" is MO). Of more than four words, the first three and the last. A word without a letter or a
 * digit gives its first character, so that only an empty name has no initials.
 */
export function initialsOf(fullName: string): string {
  const letters = fullName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? Array.from(word)[0])
    .map((letter) => letter.toUpperCase());
  const kept = letters.length > INITIALS_MAX ? [...letters.slice(0, INITIALS_MAX - 1), letters[letters.length - 1]] : letters;
  return kept.join("");
}
