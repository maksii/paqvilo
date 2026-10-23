import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const candidate = fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url));

async function fakeBridge() {
  const fs = await import('node:fs');
  const readline = await import('node:readline');
  const marker = process.argv[2], mode = process.argv[3];
  let cleared = false;
  const timer = setTimeout(() => process.exit(99), 5000);
  const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', async line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: '2024-11-05' } });
    if (message.method === 'tools/list') return send({ id: message.id, result: { tools: [{ name: 'browser_run_code_unsafe' }] } });
    const code = message.params.arguments.code;
    const options = JSON.parse(/const result = await run\(page, (\{[^\n]*\})\);/.exec(code)[1]);
    const id = options.scenario.id;
    if (id === 'clear-cache' && mode !== 'success') return send({ id: message.id, error: { code: -32000, message: 'Invented cache bridge failure' } });
    if (id === 'clear-cache') cleared = true;
    const status = id.startsWith('persona-') && !cleared ? 'failed' : 'captured';
    const captured = { summary: { id, status, problems: status === 'failed' ? ['Invented persona not yet settled'] : [], finishedAt: new Date().toISOString() }, raw: { requests: [], console: [], pageErrors: [], elements: [], dom: '<p>Invented fixture</p>', finalUrl: 'https://fixture.invalid/' } };
    const tail = code.slice(code.lastIndexOf('const posted = await fetch('));
    const endpoint = JSON.parse(/fetch\(("[^"]+")/.exec(tail)[1]);
    if (!/^http:\/\/127\.0\.0\.1:\d+\/capture$/.test(endpoint)) throw Error('Expected owned loopback receiver');
    const token = /"x-baseline-token": "([a-f0-9]+)"/.exec(tail)[1];
    const run = /"x-baseline-run": "([a-f0-9]+)"/.exec(tail)[1];
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-baseline-token': token, 'x-baseline-run': run }, body: JSON.stringify(captured) });
    send({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ ...captured.summary, posted: response.status }) }] } });
  }).on('close', () => { clearTimeout(timer); fs.writeFileSync(marker, 'closed'); process.exit(0); });
}
async function run(script, mode) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline admin cleanup '));
  try {
    const marker = path.join(directory, 'bridge-closed.txt');
    const hookMarker = path.join(directory, 'hook-events.txt');
    const server = path.join(directory, 'server.mjs');
    const hook = path.join(directory, 'hook.mjs');
    await fs.writeFile(server, `(${fakeBridge.toString()})();`);
    await fs.writeFile(hook, `import fs from 'node:fs';fs.appendFileSync(process.argv[2],process.argv[3]+'\\n');if(process.argv[4]==='add-error'&&process.argv[3]==='add')process.exit(7);if(process.argv[4]==='cleanup-error'&&process.argv[3]==='remove')process.exit(9);`);
    const hookCommand = action => `"${process.execPath}" "${hook}" "${hookMarker}" ${action} ${mode}`;
    const matrix = path.join(directory, 'matrix.json');
    await fs.writeFile(matrix, JSON.stringify({ version: 1, origin: 'https://fixture.invalid', live: { command: process.execPath, args: [server,marker,mode], clearCache: { attempts: 1, delay: 0, steps: [{ goto: '/clear' }] } }, hooks: { liveAdminAdd: hookCommand('add'), liveAdminRemove: hookCommand('remove') }, personas: { editor: { verify: { attempts: 1, delay: 0, steps: [{ goto: '/probe' }] } } }, scenarios: [{ id: 'fixture/read', persona: 'editor', steps: [{ goto: '/' }] }] }));
    const child = spawn(process.execPath, [script, 'capture', '--matrix', matrix, '--out', path.join(directory, 'out'), '--side', 'live'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '', timedOut = false;
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 7000);
    let code;
    try { code = await new Promise((resolve,reject) => { child.once('exit', resolve); child.once('error', reject); }); }
    finally { clearTimeout(timer); }
    assert.equal(timedOut, false, output);
    assert.equal(await fs.readFile(marker,'utf8'), 'closed', 'owned bridge closed');
    const events = (await fs.readFile(hookMarker,'utf8')).trim().split('\n');
    return { code, events, output };
  } finally {
    assert.ok(directory.startsWith(os.tmpdir()+path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('baseline removes temporary admin after bridge cache failure', { timeout: 10000 }, async () => {
  const result = await run(candidate, 'clear-error');
  assert.equal(result.code, 2);
  assert.deepEqual(result.events, ['add','remove']);
  assert.match(result.output, /Invented cache bridge failure/);
});
test('baseline does not blindly remove membership after a failed add hook', { timeout: 10000 }, async () => {
  const result = await run(candidate, 'add-error');
  assert.equal(result.code, 2);
  assert.deepEqual(result.events, ['add']);
  assert.match(result.output, /Hook failed \(7\)/);
});
test('baseline retains primary cache error and explicit cleanup-hook failure', { timeout: 10000 }, async () => {
  const result = await run(candidate, 'cleanup-error');
  assert.equal(result.code, 2);
  assert.deepEqual(result.events, ['add','remove']);
  assert.match(result.output, /Invented cache bridge failure/);
  assert.match(result.output, /admin role cleanup also failed/);
  assert.match(result.output, /Hook failed \(9\)/);
});
test('baseline successful cache cycle removes admin before capture and closes owned bridge', { timeout: 10000 }, async () => {
  const result = await run(candidate, 'success');
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.events, ['add','remove']);
});
