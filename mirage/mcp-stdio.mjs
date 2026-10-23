// Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0): enough to call tools of a
// browser bridge such as @playwright/mcp running in extension mode against the user's own
// signed-in browser profile. No SDK dependency; the token stays in the child's environment.
import {spawn} from 'node:child_process';
import readline from 'node:readline';

export function startMcpServer({command, args = [], env = process.env, cwd, onStderr = () => {}}) {
  const child = spawn(command, args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false});
  const pending = new Map();
  let nextId = 0, failure = null, closePromise;
  const stop = error => {
    failure ??= error;
    for (const {reject, timer} of pending.values()) { clearTimeout(timer); reject(failure); }
    pending.clear();
  };
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  child.once('error', () => { stop(new Error('MCP process failed to start.')); resolveExit(); });
  child.once('exit', (code, signal) => {
    stop(new Error(`MCP process exited (${signal ?? code ?? 'unknown'}).`));
    resolveExit();
  });
  child.stdin.on('error', () => stop(new Error('MCP process input closed.')));
  const lines = readline.createInterface({input: child.stdout});
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) {
      const {resolve, reject, timer} = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(Object.assign(new Error(message.error.message ?? 'MCP error'), {code: message.error.code}));
      else resolve(message.result);
    }
  });
  child.stderr.on('data', chunk => onStderr(String(chunk)));
  const request = (method, params = {}, timeout = 60000) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out after ${timeout} ms`));
    }, timeout);
    pending.set(id, {resolve, reject, timer});
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
  });
  const notify = (method, params = {}) => {
    if (failure) throw failure;
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', method, params}) + '\n');
  };
  return {
    async initialize() {
      const result = await request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'paqvilo-baseline', version: '1'}}, 60000);
      notify('notifications/initialized');
      return result;
    },
    async callTool(name, args = {}, timeout = 300000) {
      const result = await request('tools/call', {name, arguments: args}, timeout);
      const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (result.isError) throw new Error(text.slice(0, 2000) || `${name} failed`);
      return text;
    },
    async listTools() { return (await request('tools/list', {}, 60000)).tools ?? []; },
    close() {
      return closePromise ??= (async () => {
        stop(new Error('MCP client closed.'));
        try { child.stdin.end(); } catch { /* already closed */ }
        let timer;
        try {
          const exited = await Promise.race([exit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
          if (!exited) child.kill();
        } finally { clearTimeout(timer); }
      })();
    },
  };
}
