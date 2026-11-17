/**
 * Reading an upload's body with a limit. `request.formData()` reads a body
 * whole, whatever its size, and a client that sends no length (a chunked
 * body) passes any check of the `Content-Length` header: this reads it a part
 * at a time and stops as soon as it is over the limit, before it is parsed.
 */
export type LimitedForm = { ok: true; form: FormData } | { ok: false; problem: "too_large" | "broken" };

export async function readFormData(request: Request, maxBytes: number): Promise<LimitedForm> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, problem: "too_large" };
  if (!request.body) return { ok: false, problem: "broken" };
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, problem: "too_large" };
      }
      parts.push(value);
    }
  } catch {
    return { ok: false, problem: "broken" };
  }
  try {
    const body = new Blob(parts as BlobPart[]);
    const form = await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    return { ok: true, form };
  } catch {
    return { ok: false, problem: "broken" };
  }
}
