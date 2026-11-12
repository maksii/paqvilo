// @test-kind contract: the owned loopback bridge of a live capture closes cleanly and leaves no evidence or grace timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { spawnLiveCapture } from './support/baseline-bridge-child.mjs';

// hang guard only: the child closes its bridge and exits by itself; this timer kills a child that never exits.
const EXIT_DEADLINE_MS = 170_000;

test('a complete loopback bridge capture closes without leftover evidence or child grace timers', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'baseline positive fixture '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'closed.txt'),
    server = path.join(directory, 'server.mjs');
  await fs.writeFile(
    server,
    `
    import fs from 'node:fs';
    import readline from 'node:readline';
    const timer=setTimeout(()=>{fs.writeFileSync(process.argv[2],'watchdog');process.exit(0)},300000);
    readline.createInterface({input:process.stdin}).on('line',async line=>{
      const message=JSON.parse(line);if(message.id===undefined)return;
      let result;
      if(message.method==='initialize')result={protocolVersion:'2024-11-05'};
      else if(message.method==='tools/list')result={tools:[{name:'browser_run_code_unsafe'}]};
      else {
        const code=message.params.arguments.code;
        const tail=code.slice(code.lastIndexOf('const posted = await fetch('));
        const url=JSON.parse(/fetch\\(("[^"]+")/.exec(tail)[1]);
        if(!/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/capture$/.test(url))throw Error('Expected loopback evidence receiver');
        const token=/"x-baseline-token": "([a-f0-9]+)"/.exec(tail)[1],run=/"x-baseline-run": "([a-f0-9]+)"/.exec(tail)[1];
        const captured={summary:{id:'fixture/read',status:'captured',problems:[],finishedAt:new Date().toISOString()},raw:{requests:[],console:[],pageErrors:[],elements:[],dom:'<p>Fixture</p>',finalUrl:'https://fixture.invalid/'}};
        const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-baseline-token':token,'x-baseline-run':run},body:JSON.stringify(captured)});
        result={content:[{type:'text',text:JSON.stringify({...captured.summary,posted:response.status})}]};
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
    }).on('close',()=>{clearTimeout(timer);fs.writeFileSync(process.argv[2],'closed');process.exit(0)});
  `,
  );
  const child = await spawnLiveCapture(t.signal, directory, server, marker);
  let output = '',
    timedOut = false;
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, EXIT_DEADLINE_MS);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  clearTimeout(deadline);
  assert.equal(await fs.readFile(marker, 'utf8'), 'closed');
  assert.equal(timedOut, false, 'the child exited by itself before the hang guard');
  assert.equal(exit, 0, output);
  const receipt = JSON.parse(await fs.readFile(path.join(directory, 'out', 'run-live.json'), 'utf8'));
  assert.equal(receipt.totals.captured, 1);
  assert.equal(receipt.totals.error, 0);
});
