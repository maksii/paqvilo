import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { signInContext } from '../mirage/testing.mjs';
import { ownedFixture, removeFixtureDirectory } from '../mirage/testing/owned-fixture.mjs';
import { canvasLocalIdentity } from '../mirage/test/canvas-player-fixture.mjs';

test(
  'Canvas runs trusted manifest-bound PCF, synchronizes outputs/events and preserves lifecycle across snapshots',
  { timeout: 60000 },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pcf-')));
    const cleanup = ownedFixture(t);
    cleanup.remove(() => removeFixtureDirectory(root));
    const write = async (name, value) => {
      const file = path.join(root, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, value);
    };
    await write(
      'portal/website.yml',
      'adx_websiteid: 77777777-7777-4777-8777-777777777777\nadx_name: Invented\nadx_enhancedauthorization: 1\n',
    );
    await write('portal/Home.webpage.yml', 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n');
    await write(
      'solution/Other/Solution.xml',
      '<ImportExportXml><SolutionManifest><UniqueName>InventedCanvasPcf</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    );
    await write(
      'solution/Controls/tst_Invented.Editor/ControlManifest.xml.data.xml',
      '<CustomControl><Name>tst_Invented.Editor</Name></CustomControl>',
    );
    await write(
      'solution/Controls/tst_Invented.Editor/ControlManifest.xml',
      '<manifest><control namespace="Invented" constructor="Editor" control-type="standard"><property name="Value" usage="bound" of-type="SingleLine.Text"/><event name="Saved"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>',
    );
    await write(
      'solution/Controls/tst_Invented.Editor/bundle.js',
      `window.ComponentFramework.registerControl('Invented.Editor',class {
    init(context,notify,state,element){this.context=context;this.notify=notify;this.value='';window.pcfInit=(window.pcfInit||0)+1;window.pcfHasWebApi=!!context.webAPI;this.button=document.createElement('button');this.button.textContent='PCF change';this.button.onclick=()=>{this.value='changed';notify();};element.append(this.button);this.event=document.createElement('button');this.event.textContent='PCF event';this.event.onclick=()=>this.context.events.Saved();element.append(this.event);}
    updateView(context){this.context=context;this.value=context.parameters.Value.raw;}
    getOutputs(){return {Value:this.value};}
    destroy(){window.pcfDestroy=(window.pcfDestroy||0)+1;}
  });`,
    );
    await write('apps/invented/Src/App.pa.yaml', 'App:\n  Properties:\n    OnStart: =Set(events, 0)\n');
    await write(
      'apps/invented/Src/Home.pa.yaml',
      `Screens:
  Home:
    Children:
      - Editor:
          Control: CodeComponent
          ComponentName: tst_Invented.Editor
          Properties:
            Value: ="initial"
            Saved: =Set(events, events + 1)
            OnChange: =Set(output, Self.Value)
            Width: =250
            Height: =80
      - Result:
          Control: Label@2.5.1
          Properties:
            Text: =Editor.Value & ":" & events
            Y: =100
            Width: =250
      - Next:
          Control: Classic/Button@2.2.0
          Properties:
            Text: ="Away"
            OnSelect: =Navigate(Other)
            Y: =160
  Other:
    Children: []
`,
    );
    const sim = await createSimulator({
      sourceDir: path.join(root, 'portal'),
      stateFile: path.join(root, 'state.json'),
      solutionRoots: [path.join(root, 'solution')],
      projectRoot: root,
      port: 0,
      watch: false,
      canvas: { sources: ['apps/invented'], codeComponents: true },
      initial: canvasLocalIdentity(),
    });
    cleanup.add(() => sim.close());
    const preflight = await sim.preflight();
    assert.equal(preflight.requirements.find((entry) => entry.id === 'canvas:app/invented')?.status, 'satisfied');
    assert.equal(preflight.requirements.find((entry) => entry.id === 'canvas:rendering')?.status, 'satisfied');
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    cleanup.add(() => browser.close());
    const context = await browser.newContext();
    await signInContext(context, sim, 'alex');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const response = await page.goto(sim.url + '/_apps/canvas/invented');
    assert.match(response.headers()['content-security-policy'], /style-src 'self' 'unsafe-inline'/);
    assert.doesNotMatch(response.headers()['content-security-policy'], /unsafe-eval/);
    await page.getByTestId('canvas-start').click();
    await page.getByText('PCF change', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-control="Result"]')?.textContent === 'changed:0');
    await page.getByText('PCF event', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-control="Result"]')?.textContent === 'changed:1');
    assert.equal(await page.evaluate(() => window.pcfInit), 1);
    assert.equal(await page.evaluate(() => window.pcfHasWebApi), false);
    const state = await (await context.request.get(sim.url + '/_apps/api/canvas/invented')).json();
    assert.equal(state.variables.output, 'changed');
    await page.locator('[data-control="Next"]').click();
    await page.waitForFunction(() => window.pcfDestroy === 1);
    assert.deepEqual(errors, []);
  },
);
