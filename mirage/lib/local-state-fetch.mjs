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

/**
 * The one line every reference tool prints when its --local origin does not answer (a refused connection, or nothing
 * within `timeout` ms when the request timed out) instead of fetch's "fetch failed". The network error under a fetch
 * TypeError is the cause, else the fetch error.
 */
export function localUnreachable(origin, error, timeout) {
  const limit = timeout ? timeout + ' ms' : 'the time limit';
  const within = error?.name === 'TimeoutError' ? ' within ' + limit : '';
  const verb = within ? 'answered' : 'answers';
  return new Error(
    `Nothing ${verb} at the --local origin ${new URL(origin).origin}${within}; start Mirage there or pass the origin it prints.`,
    { cause: error.cause ?? error },
  );
}

/** fetch() for a local state endpoint. Pass the same init as fetch(); a non-OK response throws a status-only error. */
export async function fetchLocalState(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw localUnreachable(url, error);
  }
  if (!response.ok) throw await stateUnavailable(response);
  return response;
}
