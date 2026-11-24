"use client";

import { useRef, useState, type MouseEvent, type ReactNode } from "react";

export type ConflictCheck = (formData: FormData) => Promise<{ conflicts: { key: string; text: string }[] }>;

/**
 * An owner's submit button for booking, moving or changing a booking (question 79 in ProjectLibrary.md). Pressed, it asks
 * the server what the chosen time passes over: nothing, and the form is sent; something (the opening hours, another
 * booking, blocked time, the photographer's day), and a pop-up lists it, with "OK" to save it all the same and "Cancel"
 * to choose again. The keys of what was read go with the form, and the server saves only if nothing else has come in the
 * way since. Without its script, the form is sent with none read, and the server refuses a time with anything in its way.
 */
export function OverrideSubmit({ check, children, className }: { check: ConflictCheck; children: ReactNode; className: string }) {
  const field = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [conflicts, setConflicts] = useState<{ key: string; text: string }[]>([]);
  const [busy, setBusy] = useState(false);

  // Sent with `requestSubmit`, which makes no click: the form's action takes it as it takes any submission.
  const go = (keys: string[]) => {
    field.current!.value = keys.join(" ");
    button.current!.form!.requestSubmit();
  };

  async function onClick(event: MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form) return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    setBusy(true);
    try {
      const answer = await check(new FormData(form));
      if (answer.conflicts.length === 0) return go([]);
      setConflicts(answer.conflicts);
      dialog.current?.showModal();
    } catch {
      // The check could not be made: the form goes as it is, and the server says what stands in the way.
      go([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input ref={field} type="hidden" name="overrideConfirmed" defaultValue="" />
      <button ref={button} type="submit" className={className} onClick={onClick} disabled={busy} aria-busy={busy || undefined}>
        {children}
      </button>
      <dialog ref={dialog} className="override-dialog" aria-labelledby="override-title">
        <h3 id="override-title">This time passes over</h3>
        <ul>
          {conflicts.map((conflict) => (
            <li key={conflict.key}>{conflict.text}</li>
          ))}
        </ul>
        <p>Press OK to save it all the same. What it passes over stays as it is.</p>
        <div className="override-dialog-buttons">
          <button type="button" className="btn btn-outline btn-small" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-dark btn-small"
            autoFocus
            onClick={() => {
              dialog.current?.close();
              go(conflicts.map((conflict) => conflict.key));
            }}
          >
            OK
          </button>
        </div>
      </dialog>
    </>
  );
}
