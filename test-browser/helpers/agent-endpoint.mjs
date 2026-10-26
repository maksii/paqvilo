// Whether a stopped agent API still serves its own session. A refused connection is not the
// only correct outcome: on a busy host another process may reuse the released loopback port,
// but it cannot answer this session's bearer token. A listener that accepts and never answers
// still fails the check through its bounded timeout.
export async function servesAgentSession({ endpoint, token }, { timeoutMs = 5000 } = {}) {
  let response;
  try {
    response = await fetch(endpoint + '/v1/session', {
      redirect: 'manual',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw error;
    return false;
  }
  await response.body?.cancel();
  return response.status === 200;
}
