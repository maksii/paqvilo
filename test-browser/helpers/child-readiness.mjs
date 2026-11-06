/** Await an observed CLI readiness line under the caller's existing test deadline. */
export function waitForChildOutput(child, { signal, pattern, readOutput, label }) {
  if (!signal) throw new TypeError('Child readiness requires the owning test signal.');
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.stdout.off('data', check);
      child.stderr.off('data', check);
      child.off('close', exited);
      child.off('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const finish = (error) => {
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const check = () => {
      pattern.lastIndex = 0;
      if (pattern.test(readOutput())) finish();
    };
    const exited = (code, termination) =>
      finish(new Error(`${label}: owned CLI exited ${code ?? termination}: ${readOutput()}`));
    const failed = (cause) => finish(new Error(`${label}: owned CLI failed: ${readOutput()}`, { cause }));
    const aborted = () => finish(signal.reason ?? new Error(`${label}: owning test cancelled.`));
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('close', exited);
    child.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) return aborted();
    if (child.exitCode != null || child.signalCode != null) return exited(child.exitCode, child.signalCode);
    check();
  });
}
