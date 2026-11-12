// Reads a local runtime's state endpoint. A refusal names the HTTP status and, when the body is the runtime's JSON error,
// its error code. The body text and the headers are never copied into the message.
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

async function errorCodeOf(response) {
  try {
    const code = (await response.json())?.error?.code;
    return typeof code === 'string' && ERROR_CODE.test(code) ? code : null;
  } catch {
    // A body that is not JSON carries no code; the status alone is reported.
    return null;
  }
}

async function stateUnavailable(response) {
  const code = await errorCodeOf(response);
  const detail = code ? `HTTP ${response.status} ${code}` : `HTTP ${response.status}`;
  return new Error(`Local runtime state is unavailable (${detail}).`);
}

/** fetch() for a local state endpoint. Pass the same init as fetch(); a non-OK response throws a status-only error. */
export async function fetchLocalState(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    // The network error under a fetch TypeError (refused connection, refused redirect) is the cause, else the fetch error.
    // eslint-disable-next-line preserve-caught-error -- the cause is the network error that fetch wraps, and callers read it.
    throw new Error(`Local runtime state request to ${new URL(url).origin} failed.`, { cause: error.cause ?? error });
  }
  if (!response.ok) throw await stateUnavailable(response);
  return response;
}
