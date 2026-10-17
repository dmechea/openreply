/**
 * The body of a request to an endpoint anyone may call, as text, or null when
 * it is larger than `limit` bytes. A body that declares its size is refused
 * before any of it is read; one that does not is read only up to the limit,
 * so an oversized body is never buffered whole.
 */
export async function readBodyText(request: Request, limit: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
