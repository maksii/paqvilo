import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalModel, sourceText, componentIdentity } from '../lense/portal-model.mjs';
import { editSource } from '../lense/source-edit.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { describeResources, resourceFilters } from '../lense/commands/resources.mjs';
import { createFixture, SITE } from './fixture.mjs';

const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const component = (id, type, content) => [
  `<powerpagecomponent powerpagecomponentid="${id}">`, '<name>Fixture record</name>',
  `<content>${escapeXml(JSON.stringify(content))}</content>`, `<powerpagecomponenttype>${type}</powerpagecomponenttype>`,
  '<statecode>0</statecode>', '</powerpagecomponent>',
].join('\n');

for (const definition of [
  { id: 'page', type: 2, field: 'customjavascript', content: { isroot: true, partialurl: '/', customjavascript: 'window.value = "Old";', summary: '<p>Sibling</p>' } },
  { id: 'form', type: 15, field: 'customjavascript', content: { customjavascript: 'window.value = "Old";', entityname: 'request' } },
  { id: 'metadata', type: 16, field: 'description', content: { description: '<p>Old</p>', label: 'Sibling label', entityform: 'form' } },
]) test(`enhanced ${definition.id} editors refuse a replacement record before transforming`, async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  fs.renameSync(fx.file('web-pages'), fx.file('classic-pages'));
  fs.renameSync(fx.file('web-files'), fx.file('classic-files'));
  const rel = `powerpagecomponents/${definition.id}/powerpagecomponent.xml`;
  const original = component(definition.id, definition.type, definition.content);
  fx.write(rel, original);
  fx.commit();
  const model = await PortalModel.create(fx.dir);
  const source = model.inlineSources.find((entry) => entry.field === definition.field && entry.componentId === definition.id);
  assert.ok(source, 'all enhanced inline and metadata descriptors carry the outer record identity');
  const cfg = { siteName: 'test', envName: 'local', origin: 'https://portal.invalid', sourceDir: fx.dir, configFile: path.join(fx.dir, 'catalogue.yml'), site: SITE };
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  const report = describeResources(cfg, model, baseline, baseline.changedFiles(), resourceFilters({ limit: 500 }));
  const serialized = JSON.parse(JSON.stringify(report.resources.find((entry) => entry.field === definition.field && entry.componentId === definition.id)));
  assert.equal(serialized.componentId, definition.id, 'discovery round trips identity through JSON');
  editSource(serialized, (text) => text.replace('Old', 'New'));
  assert.equal(sourceText(source), definition.content[definition.field].replace('Old', 'New'));
  const afterLegitimateEdit = fx.read(rel);
  assert.equal(afterLegitimateEdit.slice(0, afterLegitimateEdit.indexOf('<content>')), original.slice(0, original.indexOf('<content>')));
  assert.equal(afterLegitimateEdit.slice(afterLegitimateEdit.indexOf('</content>')), original.slice(original.indexOf('</content>')));
  const foreign = afterLegitimateEdit.replace(`powerpagecomponentid="${definition.id}"`, 'powerpagecomponentid="foreign"');
  fx.write(rel, foreign);
  assert.equal(sourceText(source), null, 'a stale reader cannot treat the replacement record as its original');
  for (const descriptor of [source, serialized]) {
    let transformed = false;
    assert.throws(() => editSource(descriptor, (text) => { transformed = true; return text + 'unsafe'; }), /stale record identity/);
    assert.equal(transformed, false);
    assert.equal(fx.read(rel), foreign, 'refused editing preserves every sibling XML byte');
  }
  assert.ok(new PortalModel(fx.dir).deploymentChanges(baseline, baseline.changedFiles()).some((entry) => entry.rel === rel));
});

test('outer component identity rejects missing, duplicate and nested records', () => {
  assert.equal(componentIdentity('<powerpagecomponent powerpagecomponentid="ABC"><content>{}</content></powerpagecomponent>'), 'abc');
  assert.equal(componentIdentity("<powerpagecomponent powerpagecomponentid = 'ABC'><content>{}</content></powerpagecomponent>"), 'abc');
  assert.equal(componentIdentity('<powerpagecomponent><content>{}</content></powerpagecomponent>'), null);
  assert.equal(componentIdentity('<powerpagecomponent powerpagecomponentid="one" powerpagecomponentid="two"/>'), null);
  assert.equal(componentIdentity('<powerpagecomponent powerpagecomponentid="one"><powerpagecomponent powerpagecomponentid="two"/></powerpagecomponent>'), null);
});


test('identity ignores record-like text in comments, CDATA and processing instructions while preserving quoted attributes', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  fs.renameSync(fx.file('web-pages'), fx.file('classic-pages'));
  fs.renameSync(fx.file('web-files'), fx.file('classic-files'));
  const content = { description: '<p>Old text</p><powerpagecomponent powerpagecomponentid="cdata-fake">literal content</powerpagecomponent>' };
  const before = [
    '<!-- <powerpagecomponent powerpagecomponentid="comment-fake"> -->',
    `<?fixture value="<powerpagecomponent powerpagecomponentid='pi-fake'>"?>`,
    `<powerpagecomponent data-note="quoted > and powerpagecomponentid='attribute-fake'" powerpagecomponentid="real">`,
    '<name>Real</name><powerpagecomponenttype>5</powerpagecomponenttype>',
    '<content><![CDATA[' + JSON.stringify(content) + ']]></content>',
    '<!-- <powerpagecomponent powerpagecomponentid="comment-after"> -->',
    '</powerpagecomponent>',
  ].join('\n');
  assert.equal(componentIdentity(before), 'real');
  const rel = 'powerpagecomponents/real/powerpagecomponent.xml';
  fx.write(rel, before);
  const source = (await PortalModel.create(fx.dir)).inlineSources.find((entry) => entry.field === 'description');
  assert.equal(source.componentId, 'real');
  assert.equal(sourceText(source), content.description);
  editSource(source, (text) => text.replace('Old', 'New'));
  assert.equal(sourceText(source), content.description.replace('Old', 'New'));
  assert.ok(fx.read(rel).startsWith(before.slice(0, before.indexOf('<content>'))));
  assert.ok(fx.read(rel).endsWith(before.slice(before.indexOf('</content>'))));
});


test('large malformed whitespace and incomplete XML tags are refused in a bounded worker', { timeout: 10000 }, async () => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ componentIdentity }) => {
      const text = '<powerpagecomponent' + ' \t'.repeat(500000) + 'invalid/>';
      parentPort.postMessage([componentIdentity(text), componentIdentity('<a '.repeat(500000))]);
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { module: new URL('../lense/portal-model.mjs', import.meta.url).href } });
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Component identity exceeded its worker deadline.')), 5000);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => { if (code) reject(new Error('Component identity worker exited early.')); });
    });
    assert.deepEqual(result, [null, null]);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});
