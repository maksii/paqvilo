// Terminal interrupts reach the wrapper and its child together on Windows, so the wrapper must not kill the child.
// On POSIX the terminal also signals the child's process group, so a SIGINT is only kept alive, never forwarded.
const WINDOWS_KEEP_ALIVE_SIGNALS = ['SIGINT', 'SIGBREAK'];
const POSIX_KEEP_ALIVE_SIGNALS = ['SIGINT'];
const POSIX_FORWARDED_SIGNALS = ['SIGTERM'];

function keepAliveListeners(signals) {
  // The child receives the same console interrupt, runs its own cleanup and exits; the wrapper exits with its code.
  const ignoreSignal = () => {};
  return signals.map((signal) => [signal, ignoreSignal]);
}

function forwardingListeners(child) {
  return POSIX_FORWARDED_SIGNALS.map((signal) => [signal, () => child.kill(signal)]);
}

function terminationListeners(child, platform) {
  if (platform === 'win32') return keepAliveListeners(WINDOWS_KEEP_ALIVE_SIGNALS);
  return [...keepAliveListeners(POSIX_KEEP_ALIVE_SIGNALS), ...forwardingListeners(child)];
}

export function forwardTerminationSignals(child, { platform = process.platform, source = process } = {}) {
  const listeners = terminationListeners(child, platform);
  for (const [signal, listener] of listeners) source.on(signal, listener);
  return () => {
    for (const [signal, listener] of listeners) source.off(signal, listener);
  };
}

/** The exit status of a process that ended with `code`, or else by `signal` (130 for SIGINT, 143 for SIGTERM). */
export function exitStatus(code, signal) {
  if (code != null) return code;
  if (signal === 'SIGINT') return 130;
  return signal === 'SIGTERM' ? 143 : 1;
}

const UNHANDLED_TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM'];

/** Marks a listener that stands in for the default action of a signal: it does not count as an owner of the stop. */
export const TERMINATION_FALLBACK = Symbol.for('paqvilo.terminationFallback');

/** The listeners of `signal` on `source` that own its stop, that is all of them except the fallbacks. */
export const stopOwners = (source, signal) => source.listeners(signal).filter((l) => !l[TERMINATION_FALLBACK]).length;

/**
 * Ends a lense command that nothing else handles with the exit status of the signal that ended it. Windows reports a
 * console interrupt by its own exit code, so nothing is registered there. Returns a function that removes the listeners.
 */
export function exitOnUnhandledTermination({
  platform = process.platform,
  source = process,
  exit = (code) => process.exit(code),
} = {}) {
  if (platform === 'win32') return () => {};
  const listeners = UNHANDLED_TERMINATION_SIGNALS.map((signal) => {
    const listener = () => {
      if (stopOwners(source, signal) === 0) exit(exitStatus(null, signal));
    };
    listener[TERMINATION_FALLBACK] = true;
    return [signal, listener];
  });
  for (const [signal, listener] of listeners) source.on(signal, listener);
  return () => {
    for (const [signal, listener] of listeners) source.off(signal, listener);
  };
}

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'];
const FORCED_EXIT_SIGNAL_COUNT = 3;
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

/**
 * Counts shutdown signals: `onFirst(signal)` runs for the first, the second is absorbed, the third forces the exit.
 */
export function shutdownSignalCounter({
  onFirst,
  write = (line) => console.error(line),
  exit = (code) => process.exit(code),
}) {
  let signals = 0;
  return (signal) => {
    signals += 1;
    if (signals === 1) onFirst(signal);
    else if (signals === FORCED_EXIT_SIGNAL_COUNT) {
      write('Forced exit: cleanup did not finish.');
      exit(SIGNAL_EXIT_CODES[signal]);
    }
  };
}

/**
 * Keeps SIGINT/SIGTERM from ending the process while shutdown work runs. The first signal prints a notice and aborts
 * the signal given to `work`, so waits that honour it end early; the second is absorbed, and the third ends the
 * process with the exit code of that signal. The signals are read from `source`, which defaults to the process.
 */
export async function guardShutdownSignals(
  work,
  write = (line) => console.error(line),
  { exit = (code) => process.exit(code), source = process } = {},
) {
  const interrupted = new AbortController();
  const absorb = shutdownSignalCounter({
    onFirst: () => {
      write('stopping…');
      interrupted.abort(new Error('stop interrupted'));
    },
    write,
    exit,
  });
  const listeners = SHUTDOWN_SIGNALS.map((signal) => [signal, () => absorb(signal)]);
  for (const [signal, listener] of listeners) source.on(signal, listener);
  try {
    return await work(interrupted.signal);
  } finally {
    for (const [signal, listener] of listeners) source.off(signal, listener);
  }
}
