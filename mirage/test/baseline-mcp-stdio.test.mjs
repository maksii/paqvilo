// @test-kind contract: the MCP stdio client implements the JSON-RPC behaviour of Paqvilo's baseline bridge
// MCP stdio client regression against a tiny fake server in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startMcpServer } from '../mcp-stdio.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SERVER = `
import readline from "node:readline";
import fs from "node:fs";
const marker = process.argv[2];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
process.stdout.write("not json noise\\n");
readline.createInterface({ input: process.stdin })
  .on("line", (line) => {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) { fs.appendFileSync(marker, "notified:" + method + "\\n"); return; }
    if (method === "initialize") send({ id, result: { protocolVersion: params.protocolVersion, serverInfo: { name: "fake" }, client: params.clientInfo.name } });
    else if (method === "tools/list") send({ id, result: { tools: [{ name: "echo" }, { name: "fail" }] } });
    else if (method === "tools/call" && params.name === "echo") send({ id, result: { content: [{ type: "text", text: "a=" + params.arguments.a }, { type: "image", data: "x" }, { type: "text", text: "two" }] } });
    else if (method === "tools/call" && params.name === "fail") send({ id, result: { isError: true, content: [{ type: "text", text: "tool broke" }] } });
    else if (method === "tools/call" && params.name === "slow") { /* never answers */ }
    else send({ id, error: { code: -32601, message: "no such method " + method } });
  })
  .on("close", () => { fs.appendFileSync(marker, "closed\\n"); process.exit(0); });
`;

// The server asks for a ping with the id of the pending tools/call, waits for the client's reply, then answers the call.
const PING_SERVER = `
import readline from "node:readline";
import fs from "node:fs";
const marker = process.argv[2];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let waiting = null;
readline.createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === undefined) {
      if (message.id === waiting) {
        fs.appendFileSync(marker, "reply:" + JSON.stringify(message) + "\\n");
        send({ id: waiting, result: { content: [{ type: "text", text: "after ping" }] } });
        waiting = null;
      }
      return;
    }
    if (message.method === "initialize") send({ id: message.id, result: {} });
    else if (message.method === "tools/call") {
      waiting = message.id;
      send({ id: message.id, method: "ping" });
    }
  })
  .on("close", () => process.exit(0));
`;

test('a server ping that reuses a pending call id is answered and does not resolve that call', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mcp-ping-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'server.mjs');
  const marker = path.join(directory, 'marker.txt');
  await fs.writeFile(script, PING_SERVER);
  const client = startMcpServer({ command: process.execPath, args: [script, marker], cwd: directory });
  try {
    await client.initialize();
    assert.equal(await client.callTool('echo', {}, 5000), 'after ping');
    assert.equal(await fs.readFile(marker, 'utf8'), 'reply:{"jsonrpc":"2.0","id":2,"result":{}}\n');
  } finally {
    await client.close();
  }
});

// The server writes lines that are valid JSON but not JSON-RPC objects before it answers the call.
const NON_OBJECT_SERVER = `
import readline from "node:readline";
const send = (text) => process.stdout.write(text + "\\n");
readline.createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    else if (message.method === "tools/call") {
      for (const noise of ["null", "42", '"x"', "[]"]) send(noise);
      send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "after noise" }] } }));
    }
  })
  .on("close", () => process.exit(0));
`;

test('non-object lines from the server are ignored and the pending call still resolves', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mcp-noise-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'server.mjs');
  await fs.writeFile(script, NON_OBJECT_SERVER);
  const client = startMcpServer({ command: process.execPath, args: [script], cwd: directory });
  try {
    await client.initialize();
    assert.equal(await client.callTool('echo', {}, 5000), 'after noise');
  } finally {
    await client.close();
  }
});

// An injected child whose output ends while it is still alive: the pending call settles with the child's exit.
test('a pending call settles when the server output ends while the child is alive', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.emit('exit', null, 'SIGTERM');
    return true;
  };
  const client = startMcpServer({ command: 'unused', spawnProcess: () => child });
  const pending = client.listTools();
  child.stdout.end();
  await assert.rejects(pending, /MCP process exited \(SIGTERM\)/);
  await client.close();
});

test('MCP stdio client round trips, surfaces errors, times out and closes the child', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mcp-stdio-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'server.mjs');
  const marker = path.join(directory, 'marker.txt');
  await fs.writeFile(script, SERVER);
  const stderr = [];
  const client = startMcpServer({
    command: process.execPath,
    args: [script, marker],
    cwd: directory,
    onStderr: (text) => stderr.push(text),
  });
  try {
    const init = await client.initialize();
    assert.equal(init.serverInfo.name, 'fake');
    assert.equal(init.client, 'paqvilo-baseline');
    assert.deepEqual(
      (await client.listTools()).map((tool) => tool.name),
      ['echo', 'fail'],
    );
    assert.equal(await client.callTool('echo', { a: 1 }), 'a=1\ntwo');
    await assert.rejects(client.callTool('fail'), /tool broke/);
    await assert.rejects(client.callTool('slow', {}, 200), /tools\/call timed out after 200 ms/);
    assert.equal(
      await client.callTool('echo', { a: 2 }),
      'a=2\ntwo',
      'a late or missing reply does not desynchronise later calls',
    );
  } finally {
    await client.close();
  }
  assert.equal(await fs.readFile(marker, 'utf8'), 'notified:notifications/initialized\nclosed\n');
  assert.deepEqual(stderr, []);
});

// The injected child records the kill calls and the stdin ends. `end` is recorded synchronously, so a test sees that
// close has reached its wait without yielding to the event loop. `kill` does not emit `exit`: the test decides when the
// child exits by emitting `exit` itself.
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.stdinEnds = 0;
  const end = child.stdin.end.bind(child.stdin);
  child.stdin.end = (...args) => {
    child.stdinEnds += 1;
    return end(...args);
  };
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

test('close waits for the child exit however long it takes below the hang guard', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeChild();
  const client = startMcpServer({ command: 'unused', spawnProcess: () => child });
  let closed = false;
  const closing = client.close().then(() => {
    closed = true;
  });
  assert.equal(child.stdinEnds, 1, 'close ends the child input and then waits for the child');
  t.mock.timers.tick(59_999);
  assert.deepEqual(child.kills, [], 'a live child is not killed before the hang guard expires');
  // only an event this test controls can settle it: one turn lets a version that does not wait run past its wait
  await new Promise((resolve) => setImmediate(resolve));
  // Only the child's exit can settle closing, so the flag stays unset until the emit below.
  assert.equal(closed, false, 'close is pending while the child is still running');
  child.emit('exit', 0, null);
  await closing;
  assert.equal(closed, true);
  assert.deepEqual(child.kills, [], 'an exit before the hang guard expires leaves the child unkilled');
});

test('a bridge that has not exited when the hang guard expires is asked to end, and close still waits for its exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeChild();
  const client = startMcpServer({ command: 'unused', spawnProcess: () => child });
  const order = [];
  const closing = client.close().then(() => {
    order.push('closed');
  });
  t.mock.timers.tick(60_000);
  assert.deepEqual(child.kills, [undefined], 'the hang guard asks the hung child to end with the default signal');
  // only an event this test controls can settle it: one turn lets a version that does not wait run past its wait
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], 'the request to end does not settle close');
  order.push('exit-emitted');
  child.emit('exit', null, 'SIGTERM');
  await closing;
  assert.deepEqual(order, ['exit-emitted', 'closed'], 'close settles only after the exit');
  t.mock.timers.tick(60_000);
  assert.deepEqual(child.kills, [undefined], 'the exit clears the second hang guard, so the child is not killed again');
});

test('a bridge that ignores the request to end is killed after the hang guard expires a second time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeChild();
  const client = startMcpServer({ command: 'unused', spawnProcess: () => child });
  const order = [];
  const closing = client.close().then(() => {
    order.push('closed');
  });
  t.mock.timers.tick(60_000);
  assert.deepEqual(child.kills, [undefined], 'the first hang guard period asks the child to end');
  t.mock.timers.tick(59_999);
  assert.deepEqual(child.kills, [undefined], 'the child is not killed before the second period expires');
  t.mock.timers.tick(1);
  assert.deepEqual(
    child.kills,
    [undefined, 'SIGKILL'],
    'the second period kills the child, which cannot ignore SIGKILL',
  );
  // only an event this test controls can settle it: one turn lets a version that does not wait run past its wait
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], 'the kill does not settle close');
  order.push('exit-emitted');
  child.emit('exit', null, 'SIGKILL');
  await closing;
  assert.deepEqual(order, ['exit-emitted', 'closed'], 'close settles only after the exit');
});

test('close resolves at once for a child that already exited', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeChild();
  const client = startMcpServer({ command: 'unused', spawnProcess: () => child });
  child.emit('exit', 0, null);
  await client.close();
  t.mock.timers.tick(60_000);
  assert.deepEqual(child.kills, [], 'no hang guard is left armed for a child that has exited');
});
