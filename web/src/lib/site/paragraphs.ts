/** Formatted text from plain words, one paragraph for each line: for the text a block starts with. */
export function paragraphs(...lines: string[]): string {
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return lines.map((line) => `<p>${escape(line)}</p>`).join("");
}
