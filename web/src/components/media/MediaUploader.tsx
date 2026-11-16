"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type DragEvent } from "react";
import { useStarted } from "../use-started";
import { PICTURE_TYPES, uploadPicture } from "./upload";

interface Sent {
  name: string;
  state: "waiting" | "sending" | "added" | "refused";
  message: string;
}

/**
 * The way pictures get into the media library: chosen from the device, or
 * dropped onto the box. They are sent one at a time, each with its own line
 * that says how it went, and the page is loaded again when all are done.
 * `onDone` is told the ids of the pictures that were added.
 */
export function MediaUploader({ onDone, compact }: { onDone?: (ids: string[]) => void; compact?: boolean }) {
  const router = useRouter();
  const input = useId();
  const [sent, setSent] = useState<Sent[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  // Until the page has started, a chosen file would be lost: the button waits.
  const ready = useStarted() && !busy;

  const send = async (files: File[]) => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    const lines: Sent[] = files.map((file) => ({ name: file.name, state: "waiting", message: "" }));
    setSent(lines);
    const added: string[] = [];
    for (const [index, file] of files.entries()) {
      lines[index] = { ...lines[index], state: "sending" };
      setSent([...lines]);
      const answer = await uploadPicture(file);
      lines[index] = answer.ok ? { ...lines[index], state: "added" } : { ...lines[index], state: "refused", message: answer.message };
      if (answer.ok) added.push(answer.id);
      setSent([...lines]);
    }
    setBusy(false);
    if (added.length > 0) {
      onDone?.(added);
      router.refresh();
    }
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    void send(Array.from(event.dataTransfer.files));
  };

  return (
    <div
      className={`media-upload${over ? " over" : ""}${compact ? " compact" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <label htmlFor={input} className="btn btn-dark btn-small" aria-disabled={!ready}>
        {busy ? "Sending…" : "Add pictures"}
      </label>
      <input
        id={input}
        className="visually-hidden"
        type="file"
        accept={PICTURE_TYPES}
        multiple
        disabled={!ready}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = ""; // the same file can be chosen again
          void send(files);
        }}
      />
      {!compact && (
        <p className="editor-hint">
          Or drop them here. JPEG, PNG, WebP or AVIF, up to 15 MB each. A picture is turned the right way up, made no
          larger than a screen can use, and saved without what the camera wrote into it (where and when it was taken).
        </p>
      )}
      {sent.length > 0 && (
        <ul className="media-sent" aria-live="polite">
          {sent.map((line, index) => (
            <li key={`${index}-${line.name}`} className={line.state}>
              <span>{line.name}</span>
              <span>
                {line.state === "waiting" && "Waiting"}
                {line.state === "sending" && "Sending…"}
                {line.state === "added" && "Added"}
                {line.state === "refused" && `Not added. ${line.message}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
