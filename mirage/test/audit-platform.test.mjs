import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMirageContext } from '../api.mjs';
import { profileFixture } from './fixtures/deployment-profiles.mjs';
import { debugMarkup, exportFieldFile } from '../lib/source-debug.mjs';

test('context import reuse ends at bootstrap: Solution data is reimported on reload', async (t) => {
  const fixture = await profileFixture(t);
  const entityFile = path.join(fixture.solutionRoots[0], 'Entities/sample_item/Entity.xml');
  await fs.mkdir(path.dirname(entityFile), { recursive: true });
  const xml = (set) =>
    `<Entity><Name>sample_item</Name><EntityInfo><entity Name="sample_item"><attributes><attribute><LogicalName>sample_itemid</LogicalName><Type>primarykey</Type></attribute></attributes><EntitySetName>${set}</EntitySetName></entity></EntityInfo></Entity>`;
  await fs.writeFile(entityFile, xml('sample_before'));
  const config = path.join(fixture.root, 'catalogue.yml');
  await fs.writeFile(
    config,
    'sourceRoot: .\nsites:\n  sample:\n    source: portal\n    environments:\n      local: http://127.0.0.1:8787\n    mirage:\n      solutionRoots: [solution]\n',
  );
  const context = await createMirageContext({ config, site: 'sample' });
  const app = await context.createSimulator({ watch: false });
  fixture.onCleanup(() => app.close());
  assert.equal(app.store.snapshot().mappings.sample_item.entitySet, 'sample_before');
  await fs.writeFile(entityFile, xml('sample_after'));
  await app.reload();
  assert.equal(app.store.snapshot().mappings.sample_item.entitySet, 'sample_after');
});

test('a context runtime honours a legacy deployment-profile override instead of its cached portal', async (t) => {
  const fixture = await profileFixture(t);
  await fs.mkdir(path.join(fixture.sourceDir, 'deployment-profiles'));
  await fs.copyFile(
    path.join(fixture.root, 'profiles/dev.yml'),
    path.join(fixture.sourceDir, 'deployment-profiles/dev.deployment.yml'),
  );
  const config = path.join(fixture.root, 'catalogue.yml');
  await fs.writeFile(
    config,
    'sourceRoot: .\nsites:\n  sample:\n    source: portal\n    environments:\n      local: http://127.0.0.1:8787\n',
  );
  const context = await createMirageContext({ config, site: 'sample' });
  const app = await context.createSimulator({ watch: false, deploymentProfile: 'dev' });
  fixture.onCleanup(() => app.close());
  assert.match(await (await fetch(app.url)).text(), /<h1>Development<\/h1>/);
});

test('inline script maps recognise uppercase tags and map YAML literal fields to actual export lines and columns', async (t) => {
  const fixture = await profileFixture(t),
    file = path.join(fixture.sourceDir, 'Embedded.webtemplate.yml');
  const markup = '<SCRIPT>window.first=1;\nwindow.second=2;</SCRIPT>\n';
  const source = 'adx_name: Embedded\nadx_source: |\n  <SCRIPT>window.first=1;\n  window.second=2;</SCRIPT>\n';
  await fs.writeFile(file, source);
  const result = debugMarkup(markup, exportFieldFile({ _file: file, adx_source: markup }, 'source.html'));
  const map = JSON.parse(
    Buffer.from(/sourceMappingURL=data:application\/json;charset=utf-8;base64,([\w+/=]+)/.exec(result)[1], 'base64'),
  );
  assert.deepEqual(map.sourcesContent, [source]);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const decode = (segment) => {
    const values = [];
    let value = 0,
      shift = 0;
    for (const char of segment) {
      const digit = alphabet.indexOf(char);
      value |= (digit & 31) << shift;
      if (digit & 32) {
        shift += 5;
        continue;
      }
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = shift = 0;
    }
    return values;
  };
  const segments = map.mappings.split(';').map(decode);
  assert.deepEqual(segments[0], [0, 0, 2, 10]);
  assert.deepEqual(segments[1], [0, 0, 1, -8]);
});

test('source maps follow profile literal fields and avoid false line maps for encoded fields', async (t) => {
  const fixture = await profileFixture(t),
    file = path.join(fixture.sourceDir, 'Embedded.webtemplate.yml'),
    profile = path.join(fixture.root, 'profile.yml');
  const markup = '<script>window.profile=1;</script>\n';
  await fs.writeFile(file, 'adx_source: "<script>window.exported=1;</script>"\n');
  await fs.writeFile(
    profile,
    'adx_webtemplate:\n- adx_webtemplateid: embedded\n  adx_source: |\n    <script>window.profile=1;</script>\n',
  );
  const mapped = debugMarkup(
    markup,
    exportFieldFile({ _file: file, _profileSourceFiles: { source: profile }, adx_source: markup }, 'source.html'),
  );
  const map = JSON.parse(
    Buffer.from(/sourceMappingURL=data:application\/json;charset=utf-8;base64,([\w+/=]+)/.exec(mapped)[1], 'base64'),
  );
  assert.equal(map.sources[0], pathToFileURL(profile).href);
  const encoded = debugMarkup(
    '<script>window.exported=1;</script>',
    exportFieldFile({ _file: file, adx_source: '<script>window.exported=1;</script>' }, 'source.html'),
  );
  assert.match(encoded, /sourceURL=/);
  assert.doesNotMatch(encoded, /sourceMappingURL=/);
});
