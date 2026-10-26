import { EventEmitter, once } from 'node:events';

/**
 * Collects a child's stdout and stderr and waits for printed lines as they arrive, instead of
 * polling the accumulated text. A wait fails at once when the child exits without the line.
 */
export function childOutput(child, { limit = Infinity } = {}) {
  const printed = new EventEmitter();
  let text = '';
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk) => {
      text = (text + chunk).slice(-limit);
      printed.emit('data');
    });
  // 'close' follows the final stdout and stderr chunks, unlike 'exit'.
  const exited = new Promise((resolve) => child.once('close', () => resolve()));
  return {
    get text() {
      return text;
    },
    /** Resolves with the first match of `pattern`; `timeoutMs` bounds the whole wait. */
    async waitFor(pattern, { timeoutMs = 60_000, label = String(pattern) } = {}) {
      const signal = AbortSignal.timeout(timeoutMs);
      for (;;) {
        const match = pattern.exec(text);
        if (match) return match;
        const next = await Promise.race([
          once(printed, 'data', { signal }).then(
            () => 'data',
            () => 'timeout',
          ),
          exited.then(() => 'exited'),
        ]);
        if (next === 'data') continue;
        const late = pattern.exec(text);
        if (late) return late;
        // Long opaque runs are redacted so a failure report never repeats a printed credential.
        throw new Error(
          `${label}: child ${next === 'exited' ? 'exited' : `printed nothing matching within ${timeoutMs} ms`}:\n${text.replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]')}`,
        );
      }
    },
  };
}
