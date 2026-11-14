// The gesture trace of a single-page browser client (docs/design/tracing.md): the page's calls join the page trace, and
// the calls after a trusted pointer or key gesture join an activity of their own, linked to the page's root span.
// canvas-player.mjs serves this file's text in front of the player with the `export` removed (the player is a classic
// script); the other clients import it.
// ponytail: calls fired together before the first answer become sibling roots of one trace, and timer-driven calls join
// the latest gesture's activity; give each call its own span id if that ever needs telling apart.
export function createGestureTrace() {
  let gesture = false;
  let interaction = null;
  if (typeof window !== 'undefined')
    for (const type of ['pointerdown', 'keydown'])
      window.addEventListener(
        type,
        (event) => {
          if (event.isTrusted) gesture = true;
        },
        true,
      );
  // The page's own headers: each one that has a value (page = { traceId, spanId }, the root of the page load).
  const pageHeaders = (page) => ({
    ...(page.traceId ? { 'X-Trace-Id': page.traceId } : {}),
    ...(page.spanId ? { 'X-Sim-Parent-Trace': page.spanId } : {}),
  });
  return {
    // The headers of the next call. A gesture starts a new activity when the page has a root span to link it to.
    headersFor(page) {
      if (gesture) {
        gesture = false;
        if (page.spanId) interaction = { traceId: crypto.randomUUID(), spanId: null };
      }
      if (!interaction) return pageHeaders(page);
      return interaction.spanId
        ? { 'X-Trace-Id': interaction.traceId, 'X-Sim-Parent-Trace': interaction.spanId }
        : { 'X-Trace-Id': interaction.traceId, 'X-Sim-Parent-Request': page.spanId };
    },
    // The first answer of the activity names its span, which parents the activity's later calls.
    noteAnswer(response) {
      if (interaction && !interaction.spanId && response.headers.get('x-trace-id') === interaction.traceId)
        interaction.spanId = response.headers.get('x-sim-span-id');
    },
    // Back to the page's headers, as after a configure().
    reset() {
      gesture = false;
      interaction = null;
    },
  };
}
