/** Collect unchanged request bytes. Decoding and protocol error policy belong to the caller. */
export async function readRawBody(request, { maximum, tooLarge }) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
