"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useStarted } from "../use-started";
import { PICTURE_TYPES, uploadPicture } from "./upload";

/**
 * Put a new file in a picture's place. Everything that shows the picture
 * shows the new file from then on, and its description stays.
 */
export function ReplacePicture({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const input = useId();
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [problem, setProblem] = useState("");
  // Until the page has started, a chosen file would be lost: the button waits.
  const ready = useStarted() && state !== "sending";

  const replace = async (file: File | undefined) => {
    if (!file) return;
    setState("sending");
    setProblem("");
    const answer = await uploadPicture(file, id);
    if (!answer.ok) {
      setProblem(answer.message);
      setState("idle");
      return;
    }
    setState("done");
    router.refresh();
  };

  return (
    <div className="media-replace">
      <label htmlFor={input} className="btn btn-outline btn-small" aria-disabled={!ready}>
        {state === "sending" ? "Sending…" : "Replace the file"}
      </label>
      <input
        id={input}
        className="visually-hidden"
        type="file"
        accept={PICTURE_TYPES}
        aria-label={`Replace the file of ${name}`}
        disabled={!ready}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void replace(file);
        }}
      />
      {state === "done" && (
        <span className="editor-hint" role="status">
          {" "}
          Replaced: it shows the new file everywhere.
        </span>
      )}
      {problem && (
        <div className="editor-problem" role="alert">
          {problem}
        </div>
      )}
    </div>
  );
}
