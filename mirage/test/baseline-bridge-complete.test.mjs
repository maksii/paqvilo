import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test(
  'a complete loopback bridge capture closes without leftover evidence or child grace timers',
  { timeout: 12000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline positive fixture '));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const marker = path.join(directory, 'closed.txt'),
      server = path.join(directory, 'server.mjs');
    await fs.writeFile(
      server,
      `
    import fs from 'node:fs';
    import readline from 'node:readline';
    const timer=setTimeout(()=>{fs.writeFileSync(process.argv[2],'watchdog');process.exit(0)},3000);
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
    const matrix = path.join(directory, 'matrix.json'),
      out = path.join(directory, 'out');
    await fs.writeFile(
      matrix,
      JSON.stringify({
        version: 1,
        origin: 'https://fixture.invalid',
        live: { command: process.execPath, args: [server, marker] },
        scenarios: [{ id: 'fixture/read', steps: [{ goto: '/' }] }],
      }),
    );
    const script = fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url));
    const child = spawn(process.execPath, [script, 'capture', '--matrix', matrix, '--out', out, '--side', 'live'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    }, 8000);
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    clearTimeout(deadline);
    assert.equal(await fs.readFile(marker, 'utf8'), 'closed');
    assert.equal(timedOut, false, 'completed evidence must not retain a 30-second fallback timer');
    assert.equal(exit, 0, output);
    const receipt = JSON.parse(await fs.readFile(path.join(out, 'run-live.json'), 'utf8'));
    assert.equal(receipt.totals.captured, 1);
    assert.equal(receipt.totals.error, 0);
  },
);
