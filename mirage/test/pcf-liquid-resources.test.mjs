// @test-kind observation: the Liquid tag host's Resources[] entries and the /_pcfwebresource/<id> answers per resource kind, live captures paqvilo-developer pcf-parity summary-F section 6 (runs fa and fb, res-liquid-ny and res-field-ny, paqvilo3 2026-11-26) replayed on an invented control and portal
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { createHash } from 'node:crypto';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const P = 'inv_Invented.Resources';
const RESX = (text) =>
  `<?xml version="1.0" encoding="utf-8"?><root><data name="Caption" xml:space="preserve"><value>${text}</value></data></root>`;
const MANIFEST = `<manifest><control namespace="Invented" constructor="Resources" version="1.0.0" control-type="standard"><property name="textValue" of-type="SingleLine.Text" usage="input"/><resources><code path="bundle.js" order="1"/><css path="css/probe.css" order="1"/><img path="img/probe.png"/><img path="img/probe.svg"/><html path="html/probe.html"/><resx path="strings/Resources.1033.resx" version="1.0.0"/><resx path="strings/Resources.1058.resx" version="1.0.0"/></resources></control></manifest>`;

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
}

// Mirage's local /_pcfwebresource address of a control resource (code-components.mjs): images and HTML pages have no
// Resources[] entry that names it.
const resourceAddress = (url) => {
  const hex = createHash('sha256').update(`paqvilo-pcf:${url}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const decode = (text) =>
  text.replace(
    /&(quot|amp|lt|gt|#39|#32);/g,
    (_, name) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'", '#32': ' ' })[name],
  );

/** The Liquid host page of the invented control with `manifest` and `files`; answers the runtime and the page. */
async function resourcesPage(t, manifest, files) {
  const dir = await fs.realpath(await makeTemporaryDirectory(path.join(os.tmpdir(), 'pcf-resources-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const solution = path.join(dir, 'solution'),
    portal = path.join(dir, 'portal');
  await writeFiles(path.join(solution, 'Controls', P), {
    'ControlManifest.xml': manifest,
    'ControlManifest.xml.data.xml': `<CustomControl><Name>${P}</Name></CustomControl>`,
    'bundle.js': `window.ComponentFramework.registerControl('Invented.Resources', class { init() {} updateView() {} destroy() {} });`,
    ...files,
  });
  await writeFiles(portal, {
    'website.yml': 'adx_websiteid: invented\nadx_name: Invented\n',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\n',
    'web-pages/Home.webpage.copy.html': `{% codecomponent name:${P} textValue:'resources' %}`,
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\n',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main\n',
    'Main.webtemplate.source.html': "<html><body>{% include 'Page Copy' %}</body></html>",
  });
  const runtime = await createSimulator({ sourceDir: portal, solutionRoots: [solution], watch: false, port: 0 });
  t.after(() => runtime.close());
  const html = await fetch(runtime.url).then((response) => response.text());
  return { runtime, html, config: JSON.parse(decode(/data-pcf-control="([^"]*)"/.exec(html)[1])) };
}

test('the host lists one Type 2 placeholder per RESX file and no image or HTML entry; only the bundle and the style sheet are served', async (t) => {
  const { runtime, html, config } = await resourcesPage(t, MANIFEST, {
    'css/probe.css': '.invented-resources{}',
    'img/probe.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'img/probe.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'html/probe.html': '<p>invented</p>',
    'strings/Resources.1033.resx': RESX('Caption'),
    'strings/Resources.1058.resx': RESX('Pidpys'),
  });
  // Two RESX files: two null Type 2 placeholders first, the RESX entries (Type 2), the code (Type 0) and the CSS (Type 1).
  assert.deepEqual(
    config.Resources.map((resource) => [resource.Type, resource.Path === null ? null : 'id', resource.LoadingOrder]),
    [
      [2, null, 0],
      [2, null, 0],
      [3, 'id', 1],
      [2, 'id', 3],
      [2, 'id', 3],
      [0, 'id', 4],
      [1, 'id', 4],
    ],
  );
  const [bundle] = config.Resources.filter((resource) => resource.Type === 0);
  const [style] = config.Resources.filter((resource) => resource.Type === 1);
  const resx = config.Resources.filter((resource) => resource.Type === 2 && resource.Path !== null);
  const answer = async (id) => {
    const response = await fetch(`${runtime.url}/_pcfwebresource/${id}`);
    return [response.status, (await response.text()).length > 0];
  };
  assert.deepEqual(await answer(bundle.Path), [200, true]);
  assert.deepEqual(await answer(style.Path), [200, true]);
  // A RESX, image or HTML resource answers 403 with an empty body (the images and the HTML page have no Resources[]
  // entry; their address is the one Mirage gives every served resource of the control).
  for (const entry of resx) assert.deepEqual(await answer(entry.Path), [403, false]);
  const spec = JSON.parse(/__paqviloPcf\.mount\((.*), document\.currentScript/.exec(html)[1]);
  const others = spec.resources.filter((resource) => ['img', 'html'].includes(resource.kind));
  assert.deepEqual(others.map((resource) => resource.kind).sort(), ['html', 'img', 'img']);
  for (const resource of others) assert.deepEqual(await answer(resourceAddress(resource.url)), [403, false]);
});

// Regression: a control without RESX files got one placeholder.
// @test-kind observation: controls without RESX files have no null Type 2 entry, live captures paqvilo-developer pcf-parity raw r2 lq-dependency-ny, lq-two-datasets-ny and lq-required-missing-ny and raw d1 subgrid-denied-ny (VirtualProbe, ReactProbe, MultiSelectProbe), 2026-11-26, alongside summary-F section 6 (one placeholder per RESX file)
test('a control without RESX files lists no Type 2 placeholder', async (t) => {
  const { config } = await resourcesPage(
    t,
    `<manifest><control namespace="Invented" constructor="Resources" version="1.0.0" control-type="standard"><property name="textValue" of-type="SingleLine.Text" usage="input"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>`,
    {},
  );
  assert.deepEqual(
    config.Resources.map((resource) => [resource.Type, resource.Path === null ? null : 'id']),
    [
      [3, 'id'],
      [0, 'id'],
    ],
  );
});
