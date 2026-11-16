// Only an ordered, finite sequence of completed work can refresh this guard.
export function observeBenchmarkProgress(
  child,
  { phases, samples = 1, guardMs, timers = { setTimeout, clearTimeout } },
) {
  const expected = phases.flatMap((phase) =>
    Array.from({ length: samples }, (_, sample) =>
      ['started', 'complete'].map((status) => ({
        type: 'benchmark-progress',
        phase,
        sample: sample + 1,
        samples,
        status,
      })),
    ).flat(),
  );
  let stdout = '',
    stderr = '',
    remainder = '',
    index = 0,
    timer,
    generation = 0,
    done = false;
  const completed = Promise.withResolvers();
  const dispose = () => {
    timers.clearTimeout(timer);
    child.stdout.removeListener('data', output);
    child.stderr.removeListener('data', diagnostic);
    child.removeListener('error', failed);
    child.removeListener('close', closed);
  };
  const finish = (error, result) => {
    if (done) return;
    done = true;
    dispose();
    if (error) {
      child.kill();
      completed.reject(error);
    } else completed.resolve(result);
  };
  const arm = () => {
    timers.clearTimeout(timer);
    const current = ++generation;
    timer = timers.setTimeout(() => {
      if (current !== generation || done) return;
      const waiting = expected[index];
      finish(
        new Error(
          `Benchmark stopped progressing while waiting for ${waiting ? `${waiting.phase} sample ${waiting.sample} ${waiting.status}` : 'process exit'} (${guardMs} ms guard).`,
        ),
      );
    }, guardMs);
  };
  const failed = (error) => finish(error);
  const output = (chunk) => {
    stdout += chunk;
    if (stdout.length > 1024 * 1024) finish(new Error('Benchmark stdout exceeded its capture limit.'));
  };
  const progress = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event?.type !== 'benchmark-progress') return;
    if (JSON.stringify(event) !== JSON.stringify(expected[index])) {
      finish(new Error('Benchmark reported unexpected, repeated or out-of-order progress.'));
      return;
    }
    index++;
    arm();
  };
  const diagnostic = (chunk) => {
    stderr += chunk;
    if (stderr.length > 1024 * 1024) {
      finish(new Error('Benchmark stderr exceeded its capture limit.'));
      return;
    }
    const lines = (remainder + chunk).split('\n');
    remainder = lines.pop();
    for (const line of lines) {
      if (done) break;
      progress(line);
    }
  };
  const closed = (status, signal) => {
    if (remainder) progress(remainder);
    if (done) return;
    if (status !== 0) finish(new Error(`Benchmark exited ${status}/${signal}: ${stderr}`));
    else if (index !== expected.length) finish(new Error('Benchmark exited without completing every expected phase.'));
    else finish(null, { status, stdout, stderr, progress: index });
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', output);
  child.stderr.on('data', diagnostic);
  child.once('error', failed);
  child.once('close', closed);
  arm();
  return completed.promise;
}
