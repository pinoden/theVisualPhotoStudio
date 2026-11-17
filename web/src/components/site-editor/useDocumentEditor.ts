"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { checkPathsAction, discardAction, publishAction, restoreVersionAction, saveDraftAction, type DocumentKind } from "@/app/admin/website/actions";
import { checkWebsiteOnPhones } from "./phone-check";

/** How long after the last change the draft is saved by itself. */
const AUTOSAVE_MS = 900;

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** The keys that only move about a page, which a busy editor lets through in a place that takes typing. */
const MOVES = /^(Tab|Escape|Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End|F\d{1,2}|Shift|Control|Alt|Meta|CapsLock)$/;

export type SaveStatus = "clean" | "waiting" | "saving" | "saved" | "error" | "conflict";

export interface DocumentEditor<T> {
  value: T;
  /** Take a change: the editor shows it at once and saves it as the draft a moment later. */
  change(next: T): void;
  status: SaveStatus;
  /** Why the last save, publish, discard or restore did not happen. */
  problem: string;
  /** True while the stored draft differs from what is published. */
  hasDraft: boolean;
  savedAt: string | null;
  /** Who changed the draft somewhere else, when a save was refused for that reason. */
  conflict: { by: string | null; at: string | null } | null;
  /**
   * True while publishing, discarding or restoring, until the editor has
   * started again from what is stored. Nothing can be changed meanwhile: a
   * change would be lost when it starts again, or published unchecked.
   */
  busy: boolean;
  mayPublish: boolean;
  /** Counts the saves that went through, so a preview knows when to load again. */
  saves: number;
  saveNow(): Promise<boolean>;
  /** Save this version over the one made somewhere else. */
  overwrite(): Promise<boolean>;
  /** Give up this version and load the one made somewhere else. */
  reload(): void;
  publish(): Promise<void>;
  discard(): Promise<void>;
  restore(versionId: string): Promise<void>;
}

/** What an editor starts from. The design, the frame and every page give this. */
export interface DraftStart<T> {
  content: T;
  hasDraft: boolean;
  revision: number;
  draftAt: string | null;
  may: { publish: boolean };
}

type Outcome = { ok: true } | { ok: false; message: string };

export type SaveOutcome =
  | { ok: true; revision: number; hasDraft: boolean; savedAt: string }
  | { ok: false; reason: "conflict"; message: string; by: string | null; at: string | null; waiting: boolean }
  | { ok: false; reason: "forbidden" | "missing"; message: string };

/** What an editor asks of the server. Each answers with a result and never redirects. */
export interface DraftActions<T> {
  save(content: T, basedOn: number, force: boolean): Promise<SaveOutcome>;
  /** Publish the draft, if it is still revision `basedOn`: the one that was checked. */
  publish(basedOn: number): Promise<Outcome>;
  discard(): Promise<Outcome>;
  restore(versionId: string): Promise<Outcome>;
  /**
   * Run after the draft is saved and before it is published: what would be
   * wrong with it on the website, in sentences (`problems`), and what was
   * wrong before it and is not its doing (`already`, said once it is
   * published). Nothing is published while there are problems. The phone
   * checks of phone-check.ts.
   */
  check?: {
    /** What the editor says while the check runs. */
    busy: string;
    /** What would be hard to use on a phone: "this page", "the website with this design". */
    subject: string;
    run(): Promise<{ problems: string[]; already?: string[] }>;
  };
}

/** What a change of the design, or of the header, menu and footer, would break: it reaches every page. */
const WEBSITE_SUBJECT: Record<DocumentKind, string> = {
  design: "the website with this design",
  frame: "the website with this header, menu and footer",
};

/** The pages a change reaches, as they are when it is published: a page published meanwhile is among them. */
async function pagesToCheck(kind: DocumentKind): Promise<string[]> {
  const answer = await checkPathsAction(kind);
  if (!answer.ok) throw new Error(answer.message);
  return answer.paths;
}

/**
 * The editor of the design, or of the header, menu and footer. Before a
 * change is published it is measured on every page it reaches, which the
 * server lists at that moment (`websiteCheckPaths`).
 */
export function useDocumentEditor<T>(kind: DocumentKind, initial: DraftStart<T>, report: (notice: string) => void): DocumentEditor<T> {
  return useDraftEditor(
    initial,
    {
      save: (content, basedOn, force) => saveDraftAction(kind, content, basedOn, force),
      publish: (basedOn) => publishAction(kind, basedOn),
      discard: () => discardAction(kind),
      restore: (versionId) => restoreVersionAction(kind, versionId),
      check: {
        busy: "Checking the website at the width of a phone…",
        subject: WEBSITE_SUBJECT[kind],
        run: async () => checkWebsiteOnPhones(kind, await pagesToCheck(kind)),
      },
    },
    report,
  );
}

/**
 * The state of one of the website's editors: the content being edited, the
 * draft on the server, and the four things that can be done with it. Changes
 * are saved as the draft by themselves, one save at a time, each naming the
 * revision it was based on so that a change made somewhere else is noticed
 * and never silently overwritten.
 *
 * After a publish, a discard or a restore the page is rendered again by the
 * server, and the editor is given a `key` that changes with the revision, so
 * it starts again from what is stored. What went well is therefore told to
 * `report`, which belongs to something that stays: see `EditorFrame`. It is
 * told together with that new rendering, and the editor stays busy until
 * then: a change made in between would be thrown away with the old editor.
 * While it is busy nothing changes the content, not even the page editor's
 * undo keys, which work on the whole document: what is published is what was
 * checked, and the server publishes only the revision that was.
 */
export function useDraftEditor<T>(initial: DraftStart<T>, actions: DraftActions<T>, report: (notice: string) => void): DocumentEditor<T> {
  const router = useRouter();
  const [value, setValue] = useState(initial.content);
  const [status, setStatus] = useState<SaveStatus>("clean");
  const [problem, setProblem] = useState("");
  const [hasDraft, setHasDraft] = useState(initial.hasDraft);
  const [savedAt, setSavedAt] = useState(initial.draftAt);
  const [conflict, setConflict] = useState<DocumentEditor<T>["conflict"]>(null);
  const [busy, setBusy] = useState(false);
  // True from a publish, a discard or a restore that went through until the page the server renders again is shown.
  const [refreshing, startRefresh] = useTransition();
  const [saves, setSaves] = useState(0);

  // What the handlers need without waiting for a render: the newest content, what the server has, and the save in flight.
  const latest = useRef(initial.content);
  const stored = useRef(JSON.stringify(initial.content));
  const revision = useRef(initial.revision);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the publish's check found wrong that was there before the change: said with "Published".
  const already = useRef<string[]>([]);
  // Set when a publish found the draft changed somewhere else and the editor shows it instead: that notice stays.
  const shownTheirs = useRef(false);
  const running = useRef<Promise<boolean> | null>(null);

  /**
   * Save the newest content as the draft. `force` saves it over a draft
   * changed somewhere else. `ask` asks the server even when nothing changed
   * here, so that a draft changed somewhere else is noticed (before a
   * publish, which would otherwise check that one).
   */
  const save = async (force: boolean, ask = false): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // One save at a time: wait for the one in flight, then send whatever is newest.
    while (running.current) await running.current;
    const json = JSON.stringify(latest.current);
    if (json === stored.current && !force && !ask) {
      setStatus((current) => (current === "waiting" ? "saved" : current));
      return true;
    }
    const run = (async () => {
      setStatus("saving");
      try {
        const result = await actions.save(latest.current, revision.current, force);
        if (result.ok) {
          // A save that changed nothing (asked only to know the draft is still this one) leaves the preview as it is.
          if (result.revision !== revision.current) setSaves((count) => count + 1);
          revision.current = result.revision;
          stored.current = json;
          setHasDraft(result.hasDraft);
          setSavedAt(result.savedAt);
          setConflict(null);
          setProblem("");
          // More may have been typed while this was on its way: that is saved by the timer it set.
          setStatus(JSON.stringify(latest.current) === json ? "saved" : "waiting");
          return true;
        }
        if (result.reason === "conflict") {
          // Asked only to know the draft is still this one, with nothing changed here: nothing of this window's can be
          // lost, so the draft as it is stored now is shown, and nothing is offered to be saved over it.
          if (ask && json === stored.current) {
            const who = `${result.by ? ` by ${result.by}` : ""}${result.at ? ` at ${clock.format(new Date(result.at))}` : ""}`;
            shownTheirs.current = true;
            startRefresh(() => {
              report(
                result.waiting
                  ? `Not published: this was changed somewhere else${who} since you opened it. It is shown here now: look at it, then publish.`
                  : "This was published or discarded somewhere else since you opened it. It is shown here as it is now.",
              );
              router.refresh();
            });
            return false;
          }
          setConflict({ by: result.by, at: result.at });
          setStatus("conflict");
          return false;
        }
        setProblem(result.message);
        setStatus("error");
        return false;
      } catch {
        setProblem("The draft could not be saved. Check your connection; it is tried again at your next change.");
        setStatus("error");
        return false;
      }
    })();
    running.current = run;
    try {
      return await run;
    } finally {
      if (running.current === run) running.current = null;
    }
  };

  // From Publish, Discard or a version brought back until the editor starts again: nothing may change the content.
  const locked = busy || refreshing;

  const change = (next: T) => {
    // Whatever reaches the editor while it is busy is not taken: it would be published unchecked, or thrown away unsaid.
    if (locked) return;
    // An editor that reports its content without anything having changed (the page editor does, when it opens) changes nothing.
    if (JSON.stringify(next) === JSON.stringify(latest.current)) return;
    latest.current = next;
    setValue(next);
    report("");
    if (status !== "conflict") setStatus("waiting");
    if (timer.current) clearTimeout(timer.current);
    // While a conflict is open nothing is saved by itself: the person decides first.
    if (status !== "conflict") timer.current = setTimeout(() => void save(false), AUTOSAVE_MS);
  };

  // Leaving with a change that has not been saved yet: the browser asks first.
  useEffect(() => {
    if (status !== "waiting" && status !== "saving" && status !== "error" && status !== "conflict") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // The page editor's undo and redo keys work on the whole document and in its canvas, an inert form or not: while the
  // editor is busy they are not passed on.
  useEffect(() => {
    if (!locked) return;
    // Puck's own keys, on the whole document: undo and redo, and Delete and Backspace, which delete the chosen block. And,
    // in a place that takes typing, any key that types. Enter and Space on a link or a button still work.
    const swallow = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      const target = event.target instanceof Element ? event.target : null;
      const typing = !!target && ((target as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const blocked = command
        ? event.code === "KeyZ" || event.code === "KeyY"
        : event.key === "Delete" || event.key === "Backspace" || (typing && !MOVES.test(event.key));
      if (blocked) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const windows: Window[] = [window];
    for (const frame of Array.from(document.querySelectorAll("iframe"))) {
      try {
        if (frame.contentWindow) {
          frame.contentWindow.addEventListener("keydown", swallow, { capture: true });
          windows.push(frame.contentWindow);
        }
      } catch {
        // A frame of another site: the editor's keys are not there.
      }
    }
    window.addEventListener("keydown", swallow, { capture: true });
    return () => {
      for (const view of windows) {
        try {
          view.removeEventListener("keydown", swallow, { capture: true });
        } catch {
          // Gone with its frame.
        }
      }
    };
  }, [locked]);

  /**
   * The page as the server draws it now. A notice it was opened with ("Page
   * made.") is over once something is done with it: it is drawn without it.
   */
  const drawAgain = () => {
    const url = new URL(window.location.href);
    const said = url.searchParams.has("notice") || url.searchParams.has("error");
    url.searchParams.delete("notice");
    url.searchParams.delete("error");
    if (said) router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
    else router.refresh();
  };

  /**
   * Run one of the three big actions: save first, then act, then let the
   * server render the page again. `doing` is what the editor says meanwhile;
   * `done` is said with the page rendered again, when the editor has started
   * again from what is stored.
   */
  const act = async (run: () => Promise<Outcome>, doing: string, done: string | (() => string), saveFirst: boolean) => {
    setBusy(true);
    setProblem("");
    report(doing);
    try {
      // Nothing may be saved behind the action's back: a draft just discarded would come back.
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      while (running.current) await running.current;
      // Asked of the server even when nothing changed here: a draft changed somewhere else is said as such (the conflict),
      // and is not checked and refused in this editor's name.
      if (saveFirst && !(await save(false, true))) {
        if (!shownTheirs.current) report("");
        return;
      }
      const result = await run();
      if (!result.ok) {
        report("");
        return setProblem(result.message);
      }
      // One transition: the notice, and the page as the server renders it now. Until it is shown the editor stays busy.
      const said = typeof done === "string" ? done : done();
      startRefresh(() => {
        report(said);
        drawAgain();
      });
    } catch {
      report("");
      setProblem("That did not go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return {
    value,
    change,
    status,
    problem,
    hasDraft,
    savedAt,
    conflict,
    busy: locked,
    mayPublish: initial.may.publish,
    saves,
    // Nothing is saved, or loaded again, while the editor is busy: the publish, discard or restore would be undone.
    saveNow: () => (locked ? Promise.resolve(false) : save(false)),
    overwrite: () => (locked ? Promise.resolve(false) : save(true)),
    reload: () => {
      if (!locked) router.refresh();
    },
    publish: () =>
      act(
        async () => {
          already.current = [];
          if (actions.check) {
            report(actions.check.busy);
            let found: { problems: string[]; already?: string[] };
            try {
              found = await actions.check.run();
            } catch (error) {
              return {
                ok: false,
                message: `Not published: ${error instanceof Error ? error.message : "the change could not be checked."} Look at it with Preview, then publish again.`,
              };
            }
            if (found.problems.length > 0) {
              return {
                ok: false,
                message: `Not published: on a phone, ${actions.check.subject} would be hard to use. ${found.problems.join(" ")} Change it so it fits, then publish again.`,
              };
            }
            already.current = found.already ?? [];
            report("Publishing…");
          }
          // What was saved and checked, and nothing else: the server refuses a draft that changed since.
          return actions.publish(revision.current);
        },
        "Publishing…",
        () =>
          already.current.length === 0
            ? "Published. Visitors see it now."
            : `Published. Visitors see it now. These pages did not fit a phone before this change, and still do not: ${already.current.join(" ")} Change them so they fit.`,
        true,
      ),
    discard: () => act(actions.discard, "Discarding the changes…", "The changes were discarded.", false),
    restore: (versionId) =>
      act(() => actions.restore(versionId), "Bringing that version back…", "That version is now the draft. Look at it, then publish it or discard it.", false),
  };
}
