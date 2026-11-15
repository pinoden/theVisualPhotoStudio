/** Sentences that carry a number the owner can change: the words have to follow the number. */

/** "1 day", "2 days", "0 days". */
export function count(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** Hours the way a person says them: "7 days" for 168, "36 hours" for 36, "1 hour" for 1. */
export function hoursInWords(hours: number): string {
  return hours >= 48 && hours % 24 === 0 ? count(hours / 24, "day") : count(hours, "hour");
}

/** "A", "A and B", "A, B and C". */
export function listInWords(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
