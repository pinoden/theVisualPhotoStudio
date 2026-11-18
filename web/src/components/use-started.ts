import { useSyncExternalStore } from "react";

const nothingToWatch = () => () => {};

/**
 * False in the HTML the server sends and while the page is starting, true
 * once it has started in the browser. A control whose work is done by the
 * page's code in the browser, such as a file input, is disabled until then:
 * a file chosen before would be lost without a word.
 */
export function useStarted(): boolean {
  return useSyncExternalStore(nothingToWatch, () => true, () => false);
}
