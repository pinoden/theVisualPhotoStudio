"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useStarted } from "../use-started";

type State = { kind: "idle" } | { kind: "sending"; name: string; percent: number } | { kind: "done"; name: string } | { kind: "refused"; name: string; message: string };

/** The video files the site takes (src/server/videos.ts, `VIDEO_TYPES`). */
const ACCEPT = "video/mp4,video/quicktime,video/webm";

/**
 * A video into the media library (question 77 in ProjectLibrary.md), in three steps: the site gives an upload address,
 * the browser sends the file there itself (on the host, straight to Neon's storage, so a large file arrives whole), and
 * the site checks it. One at a time, with how much of it has gone.
 */
export function VideoUploader() {
  const router = useRouter();
  const input = useId();
  const [state, setState] = useState<State>({ kind: "idle" });
  const ready = useStarted() && state.kind !== "sending";

  async function send(file: File) {
    setState({ kind: "sending", name: file.name, percent: 0 });
    const refuse = (message: string) => setState({ kind: "refused", name: file.name, message });
    try {
      const started = await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
      });
      const start = (await started.json().catch(() => ({}))) as { ok?: boolean; id?: string; message?: string; upload?: { url: string; method: "PUT"; headers: Record<string, string> } };
      if (!start.ok || !start.id || !start.upload) return refuse(start.message ?? "The video could not be sent. Please try again.");
      const upload = start.upload;
      // XMLHttpRequest, for the progress a fetch does not give.
      const sentWhole = await new Promise<boolean>((resolve) => {
        const request = new XMLHttpRequest();
        request.open(upload.method, upload.url);
        for (const [name, value] of Object.entries(upload.headers)) request.setRequestHeader(name, value);
        request.upload.onprogress = (event) => {
          if (event.lengthComputable) setState({ kind: "sending", name: file.name, percent: Math.round((event.loaded / event.total) * 100) });
        };
        request.onload = () => resolve(request.status >= 200 && request.status < 300);
        request.onerror = () => resolve(false);
        request.send(file);
      });
      if (!sentWhole) return refuse("The video did not arrive whole. Please try again.");
      const finished = await fetch(`/api/videos/${start.id}/finish`, { method: "POST" });
      const finish = (await finished.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!finish.ok) return refuse(finish.message ?? "The video did not arrive whole. Please try again.");
      setState({ kind: "done", name: file.name });
      router.refresh();
    } catch {
      refuse("The video could not be sent. Please check your connection and try again.");
    }
  }

  return (
    <div className="video-uploader">
      <label className="form-label" htmlFor={input}>
        Add a video
      </label>
      <input
        id={input}
        type="file"
        accept={ACCEPT}
        className="form-control"
        disabled={!ready}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void send(file);
        }}
      />
      <p className="form-hint" style={{ fontSize: ".8rem", margin: ".35rem 0 0" }}>
        An MP4, MOV or WebM file. Then say what it shows below, and put its address in a page&rsquo;s Video block.
      </p>
      <div role="status" aria-live="polite">
        {state.kind === "sending" && (
          <p>
            Sending {state.name}: <progress max={100} value={state.percent} aria-label={`Sending ${state.name}`} /> {state.percent}%
          </p>
        )}
        {state.kind === "done" && <p className="flash flash-success">{state.name} was added. Say what it shows below.</p>}
        {state.kind === "refused" && (
          <p className="flash flash-error">
            {state.name}: {state.message}
          </p>
        )}
      </div>
    </div>
  );
}
