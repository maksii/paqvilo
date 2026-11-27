// @test-kind contract: Lense overlays a pcf-scripts build output (pcf.sources) on a live code component declaration, invented control and fake browser; the naming rule is Paqvilo's documented pcf.sources contract
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OverlaySession } from '../lense/session.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { pcfSettings } from '../mirage/lib/pcf-sources.mjs';
import { createFixture, SITE, tempDirSync } from './fixture.mjs';
import { fakeBrowser, pausedAnswers as answers } from './fake-browser.mjs';

const ORIGIN = 'https://portal.example.com';
const SCHEMA = 'inv_Invented.Widget';
const BUNDLE = '0d0d0d0d-4444-4444-8444-000000000001';
const STYLE = '0d0d0d0d-4444-4444-8444-000000000002';

const declaration = JSON.stringify({
  Resources: [
    { Type: 0, Path: BUNDLE, LoadingOrder: 4, IsControlSpecific: true },
    { Type: 1, Path: STYLE, LoadingOrder: 4, IsControlSpecific: true },
  ],
  Name: SCHEMA,
})
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;');
const page = `<!doctype html><html><head><link href="/_pcfwebresource/${STYLE}" rel="stylesheet"></head><body><span id="c_Container"><script src="/_pcfwebresource/${BUNDLE}"></script><span id="PcfControlConfig_c" data-pcf-control="${declaration}"></span></span></body></html>`;

test('a pcf-scripts build output answers the live declaration of its control', async (t) => {
  const project = tempDirSync('paqvilo-pcf-build-');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const built = path.join(project, 'out', 'controls', 'Widget');
  fs.mkdirSync(path.join(built, 'css'), { recursive: true });
  fs.writeFileSync(
    path.join(built, 'ControlManifest.xml'),
    '<manifest><control namespace="Invented" constructor="Widget" control-type="standard"><resources><code path="bundle.js" order="1"/><css path="css/widget.css" order="1"/></resources></control></manifest>',
  );
  fs.writeFileSync(path.join(built, 'bundle.js'), 'window.widget = "built";\n');
  fs.writeFileSync(path.join(built, 'css', 'widget.css'), '.built { color: green; }\n');
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const session = new OverlaySession({
    origin: ORIGIN,
    sourceDir: fx.dir,
    sourceMaps: false,
    siteName: 'invented',
    mirageConfig: { solutionRoots: [], pcf: pcfSettings({ sources: [{ path: project, publisherPrefix: 'inv' }] }) },
    site: structuredClone(SITE),
  });
  const b = fakeBrowser({
    [ORIGIN + '/widget']: { headers: { 'content-type': 'text/html; charset=utf-8' }, body: page },
  });
  const tab = b.openTab(`${ORIGIN}/widget`);
  t.after(await interceptOrigin(b.context, ORIGIN, session.route));
  const pause = answers(tab);
  let n = 0;
  const load = async (address, type = 'Script') => {
    const id = `r${++n}`;
    await pause(id, ORIGIN + address, { type });
    return b.answers(id).at(-1);
  };
  await load('/widget', 'Document');
  const script = await load(`/_pcfwebresource/${BUNDLE}`);
  assert.equal(script.method, 'Fetch.fulfillRequest');
  assert.equal(Buffer.from(script.body, 'base64').toString(), 'window.widget = "built";\n');
  const style = await load(`/_pcfwebresource/${STYLE}`, 'Stylesheet');
  assert.equal(Buffer.from(style.body, 'base64').toString(), '.built { color: green; }\n');
  const real = fs.realpathSync.native(built);
  assert.deepEqual(
    session.pcfResourcesFor(tab.page).map((item) => [item.kind, item.path]),
    [
      ['code', 'bundle.js'],
      ['css', 'css/widget.css'],
    ],
  );
  assert.ok(session.watchPaths.includes(real), 'the build output folder is watched for rebuilds');
});
