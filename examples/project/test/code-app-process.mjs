import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function startCodeApp(
  t,
  env,
  { ipc = false, script = new URL('../code-app/server.mjs', import.meta.url) } = {},
) {
  const file = script instanceof URL ? fileURLToPath(script) : script;
  await access(file);
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
  });
  const closed = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  const [output] = await Promise.race([
    once(child.stdout, 'data', { signal: t.signal }),
    closed.then(([code]) => {
      throw new Error(`Code app server exited before startup (${code}).`);
    }),
  ]);
  const port = Number(String(output).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  if (!port) throw new Error('Code app server did not report its bound port.');
  return { child, port };
}
