import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('a bridge missing the requested tool is closed before baseline setup rejects', {timeout: 8000}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline setup fixture '));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const marker = path.join(directory, 'closed.txt'), server = path.join(directory, 'server.mjs');
  await fs.writeFile(server, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    const timer=setTimeout(()=>{fs.writeFileSync(process.argv[2],'watchdog');process.exit(0)},2000);
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const message=JSON.parse(line);if(message.id===undefined)return;
      const result=message.method==='initialize'?{protocolVersion:'2024-11-05'}:{tools:[]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
    }).on('close',()=>{clearTimeout(timer);fs.writeFileSync(process.argv[2],'closed');process.exit(0)});
  `);
  const matrix = path.join(directory, 'matrix.json');
  await fs.writeFile(matrix, JSON.stringify({version: 1, origin: 'https://fixture.invalid', live: {command: process.execPath, args: [server, marker]}, scenarios: [{id: 'fixture/read', steps: [{goto: '/'}]}]}));
  const script = fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, 'capture', '--matrix', matrix, '--out', path.join(directory, 'out'), '--side', 'live'], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', resolve);});
  assert.equal(code, 1);
  assert.match(output, /browser bridge offers no/);
  assert.equal(await fs.readFile(marker, 'utf8'), 'closed', 'the owned child must not survive failed setup until its watchdog');
});
