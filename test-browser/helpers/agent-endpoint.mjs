// Whether a stopped agent API still serves its own session. A refused connection is not the
// only correct outcome: on a busy host another process may reuse the released loopback port,
// but it cannot answer this session's bearer token. A listener that accepts and never answers
// still fails the check: the test's operation guard cancels its supplied signal.
// Cancellation must propagate instead of claiming that the listener is stopped.
export async function servesAgentSession({ endpoint, token }, { signal } = {}) {
  let response;
  try {
    response = await fetch(endpoint + '/v1/session', {
      redirect: 'manual',
      signal,
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    signal?.throwIfAborted();
    return false;
  }
  await response.body?.cancel();
  return response.status === 200;
}
