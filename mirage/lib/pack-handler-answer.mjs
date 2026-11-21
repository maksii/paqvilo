/** How long a request waits for a data pack's handler: the time a synchronous Power Automate request may take. */
const PACK_HANDLER_LIMIT_MS = 120_000;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

/**
 * The answer of a data pack's operation handler (`cloudFlows`, `serverLogics`) for one request. The handler is project
 * code the request would otherwise wait on without end: a handler that has not settled within the limit ends the
 * request with 504, and the request stops waiting for it. `call` is invoked once; what it throws is passed on.
 * `describe` says what a usable answer is; an answer `usable` refuses (a handler that returned nothing) is a 500
 * that names the handler, where the caller would otherwise fail on the missing value.
 */
export async function packHandlerAnswer(
  { kind, name, usable = (answer) => answer != null, describe },
  call,
  { limitMs = PACK_HANDLER_LIMIT_MS, clock = globalThis } = {},
) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = clock.setTimeout(
      () =>
        reject(
          fail(
            `The data pack's ${kind} handler for "${name}" did not answer within ${Math.round(limitMs / 1000)} s. A handler must return or throw; this request no longer waits for it.`,
            504,
            'PackHandlerTimeout',
          ),
        ),
      limitMs,
    );
    timer?.unref?.();
  });
  let answer;
  try {
    const pending = Promise.resolve().then(call);
    // The handler may still reject after its request stopped waiting: that rejection has no request left to report it.
    pending.catch(() => {});
    answer = await Promise.race([pending, expired]);
  } finally {
    clock.clearTimeout(timer);
  }
  if (!usable(answer)) {
    const got = answer === undefined ? 'nothing' : String(answer);
    throw fail(
      `The data pack's ${kind} handler for "${name}" returned ${got}; it must return ${describe}.`,
      500,
      'PackHandlerAnswerInvalid',
    );
  }
  return answer;
}
