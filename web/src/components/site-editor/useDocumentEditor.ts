"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { discardAction, publishAction, restoreVersionAction, saveDraftAction, type DocumentKind } from "@/app/admin/website/actions";
import { checkWebsiteOnPhones } from "./phone-check";

/** How long after the last change the draft is saved by itself. */
const AUTOSAVE_MS = 900;

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
  /** True while publishing, discarding or restoring. */
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
  | { ok: false; reason: "conflict"; message: string; by: string | null; at: string | null }
  | { ok: false; reason: "forbidden" | "missing"; message: string };

/** What an editor asks of the server. Each answers with a result and never redirects. */
export interface DraftActions<T> {
  save(content: T, basedOn: number, force: boolean): Promise<SaveOutcome>;
  publish(): Promise<Outcome>;
  discard(): Promise<Outcome>;
  restore(versionId: string): Promise<Outcome>;
  /**
   * Run after the draft is saved and before it is published: what would be
   * wrong with it on the website, in sentences. Nothing is published while
   * anything is. The phone checks of phone-check.ts.
   */
  check?: {
    /** What the editor says while the check runs. */
    busy: string;
    /** What would be hard to use on a phone: "this page", "the website with this design". */
    subject: string;
    run(): Promise<string[]>;
  };
}

/** What a change of the design, or of the header, menu and footer, would break: it reaches every page. */
const WEBSITE_SUBJECT: Record<DocumentKind, string> = {
  design: "the website with this design",
  frame: "the website with this header, menu and footer",
};

/** The editor of the design, or of the header, menu and footer. */
export function useDocumentEditor<T>(kind: DocumentKind, initial: DraftStart<T>, report: (notice: string) => void): DocumentEditor<T> {
  return useDraftEditor(
    initial,
    {
      save: (content, basedOn, force) => saveDraftAction(kind, content, basedOn, force),
      publish: () => publishAction(kind),
      discard: () => discardAction(kind),
      restore: (versionId) => restoreVersionAction(kind, versionId),
      check: { busy: "Checking the website at the width of a phone…", subject: WEBSITE_SUBJECT[kind], run: checkWebsiteOnPhones },
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
 * `report`, which belongs to something that stays: see `EditorFrame`.
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
  const [saves, setSaves] = useState(0);

  // What the handlers need without waiting for a render: the newest content, what the server has, and the save in flight.
  const latest = useRef(initial.content);
  const stored = useRef(JSON.stringify(initial.content));
  const revision = useRef(initial.revision);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef<Promise<boolean> | null>(null);

  const save = async (force: boolean): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // One save at a time: wait for the one in flight, then send whatever is newest.
    while (running.current) await running.current;
    const json = JSON.stringify(latest.current);
    if (json === stored.current && !force) {
      setStatus((current) => (current === "waiting" ? "saved" : current));
      return true;
    }
    const run = (async () => {
      setStatus("saving");
      try {
        const result = await actions.save(latest.current, revision.current, force);
        if (result.ok) {
          revision.current = result.revision;
          stored.current = json;
          setHasDraft(result.hasDraft);
          setSavedAt(result.savedAt);
          setConflict(null);
          setProblem("");
          setSaves((count) => count + 1);
          // More may have been typed while this was on its way: that is saved by the timer it set.
          setStatus(JSON.stringify(latest.current) === json ? "saved" : "waiting");
          return true;
        }
        if (result.reason === "conflict") {
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

  const change = (next: T) => {
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

  /** Run one of the three big actions: save first, then act, then let the server render the page again. */
  const act = async (run: () => Promise<Outcome>, done: string, saveFirst: boolean) => {
    setBusy(true);
    setProblem("");
    report("");
    try {
      // Nothing may be saved behind the action's back: a draft just discarded would come back.
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      while (running.current) await running.current;
      if (saveFirst && !(await save(false))) return;
      const result = await run();
      if (!result.ok) return setProblem(result.message);
      report(done);
      router.refresh();
    } catch {
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
    busy,
    mayPublish: initial.may.publish,
    saves,
    saveNow: () => save(false),
    overwrite: () => save(true),
    reload: () => router.refresh(),
    publish: () =>
      act(
        async () => {
          if (actions.check) {
            report(actions.check.busy);
            let problems: string[];
            try {
              problems = await actions.check.run();
            } catch (error) {
              report("");
              return { ok: false, message: `Not published: ${error instanceof Error ? error.message : "the change could not be checked."} Try again.` };
            }
            report("");
            if (problems.length > 0) {
              return {
                ok: false,
                message: `Not published: on a phone, ${actions.check.subject} would be hard to use. ${problems.join(" ")} Change it so it fits, then publish again.`,
              };
            }
          }
          return actions.publish();
        },
        "Published. Visitors see it now.",
        true,
      ),
    discard: () => act(actions.discard, "The changes were discarded.", false),
    restore: (versionId) => act(() => actions.restore(versionId), "That version is now the draft. Look at it, then publish it or discard it.", false),
  };
}
