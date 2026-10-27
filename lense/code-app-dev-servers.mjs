// Supervise only explicitly configured local Code App development servers for one Mirage dev session.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
function appUrl(app) {
  let url;
  try {
    url = new URL(app.localAppUrl);
  } catch {
    throw new Error(`Code app ${app.name} needs a loopback localAppUrl before starting its dev server.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !loopback.has(url.hostname) || url.username || url.password)
    throw new Error(`Code app ${app.name} requires a loopback localAppUrl without credentials.`);
  return url;
}
async function ready(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
    const ok = response.ok;
    await response.body?.cancel();
    return ok;
  } catch {
    return false;
  }
}
function commandOf(command) {
  if (command[0] === 'npm' && process.platform === 'win32') {
    const cli = process.env.npm_execpath;
    if (!cli || !fs.existsSync(cli))
      throw new Error('For npm on Windows, run through npm or configure an explicit Node and npm CLI path.');
    return [process.execPath, cli, ...command.slice(1)];
  }
  return command;
}
function cwdOf(app) {
  const base = fs.realpathSync(app.dir);
  const cwd = fs.realpathSync(path.resolve(base, app.devServer.cwd ?? '.'));
  const relative = path.relative(base, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`Code app ${app.name} dev server cwd must stay inside its app directory.`);
  return cwd;
}
function logOutput(app, stream, output) {
  let buffer = '';
  let remaining = 8192;
  const emit = (line) => {
    for (const value of Object.values(app.devServer.env ?? {})) if (value) line = line.replaceAll(value, '[redacted]');
    output(`[code app ${app.name}] ${line}`);
  };
  stream.on('data', (chunk) => {
    if (!remaining) return;
    const text = String(chunk);
    const take = Math.min(text.length, remaining);
    remaining -= take;
    buffer += text.slice(0, take);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      emit(buffer.slice(0, newline + 1));
      buffer = buffer.slice(newline + 1);
    }
    if (!remaining) {
      buffer = '';
      output(`[code app ${app.name}] further output omitted\n`);
    }
  });
  stream.on('end', () => {
    if (buffer) emit(buffer);
  });
}
async function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32' && (child.exitCode !== null || child.signalCode !== null)) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve) => {
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  if (child.exitCode === null && child.signalCode === null)
    await Promise.race([exited, delay(5000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null)
    throw new Error(`Code app dev server pid ${child.pid} did not stop.`);
}

/** Start declared dev servers; reused listeners are never owned or stopped. */
export async function startCodeAppDevServers(
  apps,
  { signal, mirageUrl, onFailure = () => {}, output = (text) => process.stdout.write(text) } = {},
) {
  const owned = [];
  let closing = false;
  const close = async () => {
    closing = true;
    const results = await Promise.allSettled(owned.map(terminate));
    const errors = results.filter((item) => item.status === 'rejected').map((item) => item.reason);
    if (errors.length) throw new AggregateError(errors, 'Could not stop Code App dev servers.');
  };
  try {
    for (const app of apps) {
      if (!app.devServer) continue;
      const url = appUrl(app);
      if (signal?.aborted) throw signal.reason;
      if (await ready(url)) {
        output(`[code app ${app.name}] using existing ${url.origin}\n`);
        continue;
      }
      const command = commandOf(app.devServer.command);
      const cwd = cwdOf(app);
      const wrapped = process.platform === 'win32';
      const child = spawn(
        wrapped ? process.execPath : command[0],
        wrapped ? [fileURLToPath(new URL('./code-app-dev-wrapper.mjs', import.meta.url))] : command.slice(1),
        {
          cwd,
          env: {
            ...process.env,
            ...app.devServer.env,
            ...(mirageUrl ? { PAQVILO_MIRAGE_URL: mirageUrl } : {}),
            PAQVILO_CODE_APP: app.name,
          },
          shell: false,
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: wrapped ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
        },
      );
      if (wrapped) child.send({ command, cwd });
      owned.push(child);
      logOutput(app, child.stdout, output);
      logOutput(app, child.stderr, output);
      let failure;
      if (wrapped)
        child.on('message', (message) => {
          if (message?.type === 'error')
            failure = new Error(`Code app ${app.name} could not start: ${message.message}`);
          else if (message?.type === 'exit')
            failure = new Error(`Code app ${app.name} dev server exited (${message.signal ?? message.code}).`);
          if (failure && !closing) onFailure(failure);
        });
      child.once('error', (error) => {
        failure = new Error(`Code app ${app.name} could not start: ${error.message}`);
        if (!closing) onFailure(failure);
      });
      child.once('exit', (code, bySignal) => {
        failure ??= new Error(`Code app ${app.name} dev server exited (${bySignal ?? code}).`);
        if (!closing) onFailure(failure);
      });
      const deadline = Date.now() + (app.devServer.timeoutMs ?? 30000);
      while (!(await ready(url))) {
        if (failure) throw failure;
        if (signal?.aborted) throw signal.reason;
        if (Date.now() >= deadline)
          throw new Error(
            `Code app ${app.name} dev server was not ready at ${url.origin} within ${app.devServer.timeoutMs ?? 30000}ms.`,
          );
        await delay(100, undefined, { signal });
      }
      if (failure) throw failure;
      output(`[code app ${app.name}] ready at ${url.origin}\n`);
    }
    return { close, owned: owned.length };
  } catch (error) {
    await close();
    throw error;
  }
}
