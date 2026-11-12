// Supervise only explicitly configured local Code App development servers for one Mirage dev session.
import { spawn } from 'node:child_process';
import { stopCodeAppDevServer } from './code-app-dev-stop.mjs';
import { codeAppLocalUrl, pinnedLocalFetch } from '../mirage/lib/code-apps-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function appUrl(app) {
  const url = codeAppLocalUrl(app.localAppUrl);
  if (!url) throw new Error(`Code app ${app.name} requires a loopback http(s) localAppUrl without credentials.`);
  return url;
}
// Every loopback spelling (localhost, 127.x.x.x, ::1, *.localhost) names one listener, so the key ignores the spelling.
function listenerKey(url) {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//loopback:${port}`;
}
// Only servers Paqvilo starts are refused on a shared listener; user-run apps may point at one server.
function refuseSharedListeners(apps) {
  const seen = new Map();
  for (const app of apps) {
    if (!app.devServer || !app.localAppUrl) continue;
    const url = appUrl(app),
      key = listenerKey(url),
      first = seen.get(key);
    if (first)
      throw new Error(
        `Code apps ${first.name} and ${app.name} share the dev server ${url.origin}; give each app its own port.`,
      );
    seen.set(key, app);
  }
}
// A probe without an answer is not ready. Only the hang guard, a child failure or cancellation ends the wait.
async function ready(url, probe, signal) {
  try {
    const response = await pinnedLocalFetch(url.href, { method: 'GET', signal }, probe);
    return response.ok;
  } catch {
    return false;
  }
}
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
const pathDirectories = () => (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
const pathExtensions = () => (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
// The file a command resolves to. A name with a path is resolved as given; a bare name is tried with each PATHEXT entry, in
// order, in each PATH directory, and the first regular file wins.
function resolvedFile(name, cwd) {
  const pathGiven = /[\\/]/.test(name);
  const extensions = pathGiven || path.extname(name) ? [''] : pathExtensions();
  const bases = pathGiven ? [path.resolve(cwd, name)] : pathDirectories().map((dir) => path.join(dir, name));
  return bases.flatMap((base) => extensions.map((extension) => base + extension)).find(isFile) ?? null;
}
function commandOf(app) {
  const command = app.devServer.command;
  if (command[0] === 'npm' && process.platform === 'win32') {
    const cli = process.env.npm_execpath;
    if (!cli || !fs.existsSync(cli))
      throw new Error('For npm on Windows, run through npm or configure an explicit Node and npm CLI path.');
    return [process.execPath, cli, ...command.slice(1)];
  }
  return command;
}

// cmd.exe metacharacters: each is escaped with a caret.
const CMD_METACHARACTERS = /[()[\]%!^"`<>&|;, *?]/g;
const cmdEscape = (text) => text.replace(CMD_METACHARACTERS, '^$&');
// Doubles every run of backslashes that precedes a quote, escapes that quote, and doubles a run at the end of the text,
// so the batch shim's own argument parsing sees the original characters. One pass; no backtracking.
function doubleBackslashRuns(text) {
  let result = '';
  let run = 0;
  for (const character of text) {
    if (character === '\\') {
      run++;
      continue;
    }
    result += character === '"' ? '\\'.repeat(run * 2) + String.raw`\"` : '\\'.repeat(run) + character;
    run = 0;
  }
  return result + '\\'.repeat(run * 2);
}
// One argument for a batch shim. It is quoted for the command line and escaped twice, because cmd.exe parses the line and then
// the shim parses its arguments again.
function shimArgument(value) {
  const quoted = `"${doubleBackslashRuns(String(value))}"`;
  return cmdEscape(cmdEscape(quoted));
}
// cmd.exe ends its command line at a line feed or carriage return and treats NUL as the end of the string, so such a
// value would silently drop the rest of the command. The message names the 1-based command element (the executable is 1).
const SHIM_CONTROL_CHARACTERS = /[\r\n\0]/;
const SHIM_CONTROL_NAMES = new Map([
  ['\r', 'carriage return'],
  ['\n', 'line feed'],
  ['\0', 'NUL'],
]);
function assertShimLineSafe(values) {
  values.forEach((value, index) => {
    const found = SHIM_CONTROL_CHARACTERS.exec(String(value));
    if (found)
      throw new Error(
        `Command argument ${index + 1} contains a ${SHIM_CONTROL_NAMES.get(found[0])}; cmd.exe would end the command line there and drop the rest. Remove it from the command.`,
      );
  });
}
// Runs a batch shim through the command interpreter with /d /s /c; the line is passed verbatim, so no argument is re-split.
function shimInvocation(file, args) {
  assertShimLineSafe([file, ...args]);
  const line = [cmdEscape(file), ...args.map(shimArgument)].join(' ');
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`] };
}
// On Windows every command runs under the wrapper, which keeps its process tree addressable. A .cmd or .bat file is
// sent to the wrapper as an already-escaped interpreter line with verbatim arguments; other commands use ordinary
// quoting. The command travels in the IPC message, so no argument is re-split on the way to the wrapper.
export function launchOf(command, cwd) {
  if (process.platform !== 'win32') return { file: command[0], args: command.slice(1), wrapped: false, message: null };
  const wrapper = {
    file: process.execPath,
    args: [fileURLToPath(new URL('./code-app-dev-wrapper.mjs', import.meta.url))],
    wrapped: true,
  };
  const file = resolvedFile(command[0], cwd);
  if (file && /\.(?:cmd|bat)$/i.test(file)) {
    const shim = shimInvocation(file, command.slice(1));
    return { ...wrapper, message: { command: [shim.file, ...shim.args], verbatim: true } };
  }
  return { ...wrapper, message: { command, verbatim: false } };
}
function cwdOf(app) {
  const base = fs.realpathSync(app.dir);
  const cwd = fs.realpathSync(path.resolve(base, app.devServer.cwd ?? '.'));
  const relative = path.relative(base, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`Code app ${app.name} dev server cwd must stay inside its app directory.`);
  return cwd;
}
const TAIL_LINES = 5;
const TAIL_CHARS = 1000;
// The last lines a child printed, kept for its exit report; bounded by count and size.
function outputTail() {
  const lines = [];
  return {
    add(line) {
      lines.push(line.trimEnd());
      if (lines.length > TAIL_LINES) lines.shift();
    },
    text() {
      return lines.join('\n').slice(-TAIL_CHARS);
    },
  };
}
// The exit report names the command, the status and the last output lines received before the exit.
function exitedError(app, status, tail) {
  const last = tail.text();
  return new Error(
    `Code app ${app.name} dev server exited (${status}). Command: ${app.devServer.command.join(' ')}.` +
      (last ? `\nLast output:\n${last}` : ''),
  );
}

function logOutput(app, stream, output, tail) {
  let buffer = '';
  let remaining = 8192;
  const emit = (line) => {
    for (const value of Object.values(app.devServer.env ?? {})) if (value) line = line.replaceAll(value, '[redacted]');
    tail.add(line);
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

function watchStartupChild(app, child, wrapped, isClosing, onFailure, tail) {
  let failure;
  if (wrapped)
    child.on('message', (message) => {
      if (message?.type === 'error') failure = new Error(`Code app ${app.name} could not start: ${message.message}`);
      else if (message?.type === 'exit') failure = exitedError(app, message.signal ?? message.code, tail);
      if (failure && !isClosing()) onFailure(failure);
    });
  child.once('error', (error) => {
    failure = new Error(`Code app ${app.name} could not start: ${error.message}`);
    if (!isClosing()) onFailure(failure);
  });
  child.once('exit', (code, bySignal) => {
    failure ??= exitedError(app, bySignal ?? code, tail);
    if (!isClosing()) onFailure(failure);
  });
  return () => failure;
}

function startConfiguredChild(app, command, cwd, { mirageUrl, output, onFailure, isClosing, owned }) {
  const launch = launchOf(command, cwd);
  const child = spawn(launch.file, launch.args, {
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
    stdio: launch.wrapped ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  owned.push({ child, closed });
  if (launch.wrapped) child.send({ ...launch.message, cwd });
  const tail = outputTail();
  logOutput(app, child.stdout, output, tail);
  logOutput(app, child.stderr, output, tail);
  const getFailure = watchStartupChild(app, child, launch.wrapped, isClosing, onFailure, tail);
  return { getFailure };
}

function throwIfStartupFailed(getFailure) {
  const failure = getFailure();
  if (failure) throw failure;
}

function throwIfStartupAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

/** The error a caller receives when startup stops: the first child failure, else a cancellation with its own code. */
export const CODE_APP_STARTUP_CANCELLED = 'CODE_APP_STARTUP_CANCELLED';
function startupError(error, signal, failure) {
  if (failure) return failure;
  if (!signal?.aborted) return error;
  return Object.assign(new Error('Code App dev server startup was cancelled.'), {
    code: CODE_APP_STARTUP_CANCELLED,
    cause: signal.reason,
  });
}

// The start-up hang guard; a configured devServer.timeoutMs overrides it. It stops only a wait for a server that never
// answers: readiness, a child failure and cancellation end the wait first, so elapsed time alone never fails a start.
const CODE_APP_START_HANG_GUARD_MS = 120_000;
const READINESS_POLL_MS = 100;

const scheduleTimer = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};
const pausePoll = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const probeSignal = (...signals) => AbortSignal.any(signals.filter(Boolean));

// One app's hang guard. Its abort signal ends pending probes; `expired` records that the guard ended the wait.
function startWatch(app, schedule) {
  const ms = app.devServer.timeoutMs ?? CODE_APP_START_HANG_GUARD_MS;
  const watch = { ms, expired: false, abort: new AbortController() };
  watch.cancel = schedule(() => {
    watch.expired = true;
    watch.abort.abort();
  }, ms);
  return watch;
}

function throwIfGuardExpired(watch, app, url) {
  if (watch.expired)
    throw new Error(
      `Code app ${app.name} dev server was not ready at ${url.origin} after waiting ${watch.ms}ms. ` +
        'This is the start-up hang guard (devServer.timeoutMs), which stops a server that never answers.',
    );
}

async function startOwnedApp(app, url, state, watch) {
  const cwd = cwdOf(app);
  const command = commandOf(app);
  const { getFailure } = startConfiguredChild(app, command, cwd, {
    mirageUrl: state.mirageUrl,
    output: state.output,
    onFailure: (failure) => {
      watch.abort.abort();
      state.reportFailure(failure);
    },
    isClosing: state.isClosing,
    owned: state.owned,
  });
  const probing = probeSignal(state.signal, watch.abort.signal);
  while (!(await ready(url, state.probe, probing))) {
    throwIfStartupFailed(getFailure);
    throwIfStartupAborted(state.signal);
    throwIfGuardExpired(watch, app, url);
    await state.sleep(READINESS_POLL_MS);
  }
  throwIfStartupFailed(getFailure);
  state.output(`[code app ${app.name}] ready at ${url.origin}\n`);
}

async function startApp(app, state) {
  const url = appUrl(app);
  throwIfStartupAborted(state.signal);
  const watch = startWatch(app, state.schedule);
  try {
    const reused = await ready(url, state.probe, probeSignal(state.signal, watch.abort.signal));
    throwIfStartupAborted(state.signal);
    throwIfGuardExpired(watch, app, url);
    if (reused) state.output(`[code app ${app.name}] using existing ${url.origin}\n`);
    else await startOwnedApp(app, url, state, watch);
  } finally {
    watch.cancel();
  }
}

/** Start declared dev servers; reused listeners are never owned or stopped. */
export async function startCodeAppDevServers(
  apps,
  {
    signal,
    mirageUrl,
    onFailure = () => {},
    output = (text) => process.stdout.write(text),
    lookup,
    connect,
    sleep = pausePoll,
    schedule = scheduleTimer,
  } = {},
) {
  refuseSharedListeners(apps);
  const owned = [];
  let closing = false;
  let firstFailure = null;
  const reportFailure = (failure) => {
    firstFailure ??= failure;
    onFailure(failure);
  };
  const close = async () => {
    closing = true;
    const results = await Promise.allSettled(owned.map(({ child, closed }) => stopCodeAppDevServer(child, closed)));
    const errors = results.filter((item) => item.status === 'rejected').map((item) => item.reason);
    if (errors.length) throw new AggregateError(errors, 'Could not stop Code App dev servers.');
  };
  const state = {
    signal,
    mirageUrl,
    output,
    probe: { lookup, connect },
    sleep,
    schedule,
    owned,
    reportFailure,
    isClosing: () => closing,
  };
  try {
    for (const app of apps) if (app.devServer) await startApp(app, state);
    return { close, owned: owned.length };
  } catch (error) {
    const reason = startupError(error, signal, firstFailure);
    await close();
    throw reason;
  }
}
