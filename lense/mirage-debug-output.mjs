import fs from 'node:fs';
import { open } from 'node:fs/promises';

const instruction =
  /^Mirage plug-in debugger: attach to paqvilo-plugin-host\.exe PID [1-9]\d*(?: --label [\w.@-]{1,80})? \([_a-z][\w.+`]{0,249}\)\. Waiting before plug-in construction; local debug deadline is 30 minutes\.$/i;

/** Forward only the owned daemon's bounded debugger instruction, never its general log. */
export function mirageDebugOutput(log, output = (line) => process.stderr.write(line + '\n')) {
  let offset = fs.statSync(log).size;
  let pending = '';
  let discarding = false;
  let closed = false;
  let flight;
  let more = false;
  const consume = (text) => {
    const lines = (pending + text).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!discarding && instruction.test(line.replace(/\r$/, ''))) output(line.replace(/\r$/, ''));
      discarding = false;
    }
    if (pending.length > 4096) {
      pending = '';
      discarding = true;
    }
  };
  const read = async () => {
    more = false;
    const file = await open(log, 'r');
    try {
      const size = (await file.stat()).size;
      if (size < offset) {
        offset = 0;
        pending = '';
        discarding = false;
      }
      const bytes = Buffer.alloc(Math.min(65536, size - offset));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      offset += bytesRead;
      consume(bytes.subarray(0, bytesRead).toString('utf8'));
      more = offset < size;
    } finally {
      await file.close();
    }
  };
  const flush = () => {
    if (closed) return Promise.resolve();
    flight ??= read()
      .catch(() => {})
      .finally(() => {
        flight = null;
        if (more && !closed) void flush();
      });
    return flight;
  };
  const changed = () => void flush();
  fs.watchFile(log, { interval: 100, persistent: false }, changed);
  return {
    flush,
    async close() {
      closed = true;
      fs.unwatchFile(log, changed);
      await flight;
    },
  };
}
