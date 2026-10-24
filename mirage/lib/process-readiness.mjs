/** Observe one owned child's complete readiness JSON and release all observation resources. */
export function observeProcessReadiness(child, { timeoutMs, label = 'serve' }) {
  let output = '',
    errors = '',
    timer,
    done = false;
  const dispose = () => {
    clearTimeout(timer);
    child.stdout.removeListener('data', stdout);
    child.stderr.removeListener('data', stderr);
    child.removeListener('exit', exited);
    child.removeListener('error', failed);
  };
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const finish = (error, value) => {
    if (done) return;
    done = true;
    dispose();
    if (error) reject(error);
    else resolve(value);
  };
  const stdout = (chunk) => {
    output += chunk;
    try {
      finish(null, JSON.parse(output));
    } catch {
      /* Partial JSON waits for the next chunk. */
    }
  };
  const stderr = (chunk) => {
    errors += chunk;
  };
  const exited = (code) =>
    finish(new Error(`${label} exited with ${code} before it was ready: ${(errors || output).trim().slice(-2000)}`));
  const failed = (error) => finish(error);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', stdout);
  child.stderr.on('data', stderr);
  child.once('exit', exited);
  child.once('error', failed);
  timer = setTimeout(() => finish(new Error(`${label} did not report its portals within ${timeoutMs} ms`)), timeoutMs);
  return { promise, dispose };
}
