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
 * Keeps SIGINT/SIGTERM from ending the process while shutdown work runs. The first signal prints a notice,
 * the second is absorbed, and the third ends the process with the exit code of that signal.
 * The signals are read from `source`, which defaults to the process.
 */
export async function guardShutdownSignals(
  work,
  write = (line) => console.error(line),
  { exit = (code) => process.exit(code), source = process } = {},
) {
  const absorb = shutdownSignalCounter({ onFirst: () => write('stopping…'), write, exit });
  const listeners = SHUTDOWN_SIGNALS.map((signal) => [signal, () => absorb(signal)]);
  for (const [signal, listener] of listeners) source.on(signal, listener);
  try {
    return await work();
  } finally {
    for (const [signal, listener] of listeners) source.off(signal, listener);
  }
}
