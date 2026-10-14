// MCP stdio client regression: a tiny fake server in a temp dir, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startMcpServer } from "../mcp-stdio.mjs";

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

test("MCP stdio client round trips, surfaces errors, times out and closes the child", { timeout: 30_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paqvilo-mcp-stdio-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, "server.mjs");
  const marker = path.join(directory, "marker.txt");
  await fs.writeFile(script, SERVER);
  const stderr = [];
  const client = startMcpServer({ command: process.execPath, args: [script, marker], cwd: directory, onStderr: (text) => stderr.push(text) });
  try {
    const init = await client.initialize();
    assert.equal(init.serverInfo.name, "fake");
    assert.equal(init.client, "paqvilo-baseline");
    assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["echo", "fail"]);
    assert.equal(await client.callTool("echo", { a: 1 }), "a=1\ntwo");
    await assert.rejects(client.callTool("fail"), /tool broke/);
    await assert.rejects(client.callTool("slow", {}, 200), /tools\/call timed out after 200 ms/);
    assert.equal(await client.callTool("echo", { a: 2 }), "a=2\ntwo", "a late or missing reply does not desynchronise later calls");
  } finally {
    await client.close();
  }
  assert.equal(await fs.readFile(marker, "utf8"), "notified:notifications/initialized\nclosed\n");
  assert.deepEqual(stderr, []);
});
