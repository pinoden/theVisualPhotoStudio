"use client";

import Image from "next/image";
import { useRef, useState, useTransition } from "react";
import { choosablePicturesAction, type ChoosablePicture } from "@/app/admin/website/media/actions";
import { MediaUploader } from "./MediaUploader";

/**
 * A button that opens the media library to choose from: one picture, or
 * several with `multiple`. New pictures can be added without leaving it.
 * `onChoose` gets the chosen pictures, in the order they were chosen.
 */
export function PictureChooser({
  label,
  multiple,
  onChoose,
  className = "btn btn-outline btn-small",
  disabled,
}: {
  label: string;
  multiple?: boolean;
  onChoose: (pictures: ChoosablePicture[]) => void;
  className?: string;
  disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  /** Null while the library is being fetched. */
  const [pictures, setPictures] = useState<ChoosablePicture[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [problem, setProblem] = useState("");
  const [, startLoading] = useTransition();

  const load = (term: string) =>
    startLoading(async () => {
      setProblem("");
      const list = await choosablePicturesAction(term).catch(() => null);
      if (list === null) setProblem("The library could not be opened. Please sign in again.");
      setPictures(list ?? []);
    });

  const open = () => {
    setChosen([]);
    setSearch("");
    setPictures(null);
    dialog.current?.showModal();
    load("");
  };

  const toggle = (id: string) =>
    setChosen((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : multiple ? [...current, id] : [id]));

  const use = () => {
    const picked = chosen.map((id) => pictures?.find((picture) => picture.id === id)).filter((picture): picture is ChoosablePicture => picture !== undefined);
    dialog.current?.close();
    if (picked.length > 0) onChoose(picked);
  };

  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={open}>
        {label}
      </button>
      <dialog ref={dialog} className="picture-chooser" aria-label="Choose from the media library">
        <div className="picture-chooser-head">
          <h3>{multiple ? "Choose pictures" : "Choose a picture"}</h3>
          <button type="button" className="btn btn-outline btn-small" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
        <form
          className="picture-chooser-search"
          onSubmit={(event) => {
            event.preventDefault();
            setPictures(null);
            load(search);
          }}
        >
          <input
            className="form-control"
            type="search"
            aria-label="Search the library"
            placeholder="Search by name or description"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button type="submit" className="btn btn-outline btn-small">
            Search
          </button>
          <MediaUploader
            compact
            onDone={(ids) => {
              // What was just added is what the person came for: it is chosen, and the list shows it.
              setChosen((current) => (multiple ? [...current, ...ids] : ids.slice(-1)));
              setSearch("");
              load("");
            }}
          />
        </form>
        {problem && (
          <div className="flash flash-error" role="alert">
            {problem}
          </div>
        )}
        {pictures === null ? (
          <p className="editor-hint">Opening the library…</p>
        ) : pictures.length === 0 ? (
          <p className="editor-hint">{search ? "No picture matches that." : "The library is empty. Add pictures with the button above."}</p>
        ) : (
          <ul className="picture-chooser-grid">
            {pictures.map((picture) => {
              const order = chosen.indexOf(picture.id);
              return (
                <li key={picture.id}>
                  <button type="button" aria-pressed={order !== -1} onClick={() => toggle(picture.id)}>
                    <Image src={picture.url} width={picture.width} height={picture.height} alt={picture.alt || picture.filename} sizes="160px" />
                    <span>{picture.alt || picture.filename}</span>
                    {order !== -1 && multiple && <em aria-hidden="true">{order + 1}</em>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="picture-chooser-foot">
          <button type="button" className="btn btn-dark btn-small" disabled={chosen.length === 0} onClick={use}>
            {chosen.length <= 1 ? "Use this picture" : `Use these ${chosen.length} pictures`}
          </button>
        </div>
      </dialog>
    </>
  );
}

/**
 * For a page the server renders: a chooser whose choice is sent straight to
 * a server action, as the form field `mediaIds` (ids with commas between),
 * together with the fixed `fields`. The action redirects, as a form's would.
 */
export function ChoosePictures({
  label,
  action,
  fields,
  multiple = true,
}: {
  label: string;
  action: (formData: FormData) => Promise<void>;
  fields: Record<string, string>;
  multiple?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <PictureChooser
      label={pending ? "Adding…" : label}
      multiple={multiple}
      disabled={pending}
      onChoose={(pictures) =>
        startTransition(async () => {
          const data = new FormData();
          for (const [name, value] of Object.entries(fields)) data.set(name, value);
          data.set("mediaIds", pictures.map((picture) => picture.id).join(","));
          await action(data);
        })
      }
    />
  );
}
