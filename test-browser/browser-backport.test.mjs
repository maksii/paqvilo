import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  makeTemporaryDirectory,
  ownedFixture,
  removeFixtureDirectory,
  assertTemporaryDirectory,
} from '../mirage/testing/owned-fixture.mjs';
import { DEFAULT_DISABLED_FEATURES, BACKPORTED_DISABLED_FEATURES } from '../test/browser-backport.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const bootstrap = new URL('../test/browser-bootstrap.mjs', import.meta.url).href;
const require = createRequire(import.meta.url);

test(
  'effective CDP arguments retain browser defaults and real HTTP across package copies and persistent launches',
  { timeout: 180000 },
  async (t) => {
    const directory = await makeTemporaryDirectory(path.join(root, '.paqvilo/browser-backport-'));
    ownedFixture(t).remove(async () =>
      removeFixtureDirectory(
        await assertTemporaryDirectory(directory, { parent: path.join(root, '.paqvilo'), directChild: true }),
      ),
    );
    const third = path.join(directory, 'example/node_modules/playwright-core');
    await fs.cp(path.dirname(require.resolve('playwright-core/package.json')), third, { recursive: true });
    const script = path.join(directory, 'probe.mjs');
    await fs.writeFile(
      script,
      `
    import fs from 'node:fs/promises'; import http from 'node:http'; import path from 'node:path';
    import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url';
    const [mode,copy,profile]=process.argv.slice(2);
    const request=createRequire(path.join(copy,'package.json'));
    // CJS and ESM exports must share the same lazily patched client instance.
    const cjs=request('playwright-core'); const esm=await import(pathToFileURL(request.resolve('playwright-core').replace(/index\\.js$/,'index.mjs')).href);
    if(cjs.chromium!==esm.chromium)throw new Error('different CJS/ESM client');
    let hits=0; const server=http.createServer((req,res)=>{hits++;res.setHeader('content-type','text/html');res.end('<h1>Invented real HTTP</h1>')});
    await new Promise(r=>server.listen(0,'127.0.0.1',r)); let browser,context,browserServer;
    try{
      const channel=process.env.PAQVILO_BROWSER||(process.platform==='win32'?'msedge':undefined);
      const options={headless:true,channel:channel==='chromium'?undefined:channel,args:['--enable-automation','--paqvilo-invented-retained'],ignoreDefaultArgs:['--mute-audio']};
      if(mode==='persistent'){context=await esm.chromium.launchPersistentContext(profile,options);browser=context.browser();}
      else if(mode==='server'){browserServer=await esm.chromium.launchServer(options);browser=await esm.chromium.connect(browserServer.wsEndpoint());context=await browser.newContext();}
      else{browser=await esm.chromium.launch(options);context=await browser.newContext();}
      const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/');
      if(await page.locator('h1').textContent()!=='Invented real HTTP')throw new Error('HTTP content lost');
      const session=await browser.newBrowserCDPSession();const {arguments:args}=await session.send('Browser.getBrowserCommandLine');await session.detach();
      console.log(JSON.stringify({args,hits}));
    }finally{
      const failures=[];
      for(const close of [()=>context?.close(),()=>browser?.close(),()=>browserServer?.close(),()=>{server.closeAllConnections();return new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}]){
        try{await close()}catch(error){failures.push(error)}
      }
      if(failures.length)throw new AggregateError(failures,'Browser probe cleanup failed');
    }
  `,
    );
    const env = { ...process.env };
    delete env.NODE_OPTIONS; // Baseline must bypass inherited test activation too.
    const copies = [root, path.join(root, 'mirage'), path.join(directory, 'example')];
    const run = async (mode, copy, activated) => {
      const result = await execute(
        process.execPath,
        [
          ...(activated ? ['--import', typeof activated === 'string' ? activated : bootstrap] : []),
          script,
          mode,
          copy,
          path.join(directory, `profile-${Math.random().toString(36).slice(2)}`),
        ],
        {
          cwd: root,
          env: typeof activated === 'string' ? { ...env, PAQVILO_TEST_LOOPBACK_PROXY: 'http://127.0.0.1:1' } : env,
          signal: t.signal,
          windowsHide: true,
        },
      );
      return JSON.parse(result.stdout.trim());
    };
    for (const mode of ['launch', 'persistent', 'server']) {
      const before = await run(mode, root, false);
      assert.ok(before.hits >= 1);
      assert.equal(before.args.includes(DEFAULT_DISABLED_FEATURES), true);
      assert.equal(before.args.includes('--mute-audio'), false);
      for (const copy of copies) {
        const after = await run(mode, copy, true);
        assert.ok(after.hits >= 1);
        assert.equal(after.args.filter((arg) => arg.startsWith('--disable-features=')).length, 1);
        assert.equal(
          after.args.includes(process.platform === 'win32' ? BACKPORTED_DISABLED_FEATURES : DEFAULT_DISABLED_FEATURES),
          true,
        );
        const normalize = (args) =>
          args.filter((arg) => !arg.startsWith('--user-data-dir=') && !arg.startsWith('--disable-features='));
        assert.deepEqual(normalize(after.args), normalize(before.args));
      }
    }
    const sanitized = await run(
      'persistent',
      root,
      new URL('./helpers/browser-loopback-preload.mjs', import.meta.url).href,
    );
    assert.ok(sanitized.hits >= 1, 'sanitized CLI fixture retains real loopback HTTP');
    assert.equal(
      sanitized.args.includes(process.platform === 'win32' ? BACKPORTED_DISABLED_FEATURES : DEFAULT_DISABLED_FEATURES),
      true,
    );
    assert.equal(sanitized.args.includes('--proxy-server=http://127.0.0.1:1'), true);
    assert.equal(sanitized.args.includes('--proxy-bypass-list=127.0.0.1;localhost'), true);
    assert.equal(sanitized.args.includes('--paqvilo-invented-retained'), true);
  },
);
