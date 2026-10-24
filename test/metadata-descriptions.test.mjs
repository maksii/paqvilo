import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { PortalModel, sourceText } from '../lense/portal-model.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { editSource } from '../lense/source-edit.mjs';
import { auditResources } from '../lense/resource-audit.mjs';
import { createFixture, SITE, HOME_ID } from './fixture.mjs';

const site = { ...SITE, markup: { ...SITE.markup, kinds: [...SITE.markup.kinds, 'metadata-markup'] } };
const localized = (text) =>
  JSON.stringify([
    { LCID: 1033, Value: `<p>${text}</p>`, Other: 42 },
    { LCID: 1045, Value: '<p>Other language</p>' },
  ]);

for (const short of [false, true]) {
  const format = short ? 'short-key' : 'classic';
  test(`${format} optional shortcut root files are quiet when absent and diagnostic when invalid`, async (t) => {
    const fx = createFixture();
    t.after(() => fx.cleanup());
    if (short) fx.write('website.yml', 'id: site\nname: Site\n');
    const existingWarnings = [
      'web-files/orphan.png.webfile.yml: parent page not found in web-pages/, cannot build the URL',
    ];
    assert.deepEqual(new PortalModel(fx.dir).warnings, existingWarnings);
    assert.deepEqual((await PortalModel.create(fx.dir)).warnings, existingWarnings);
    fx.write('shortcut.yml', '- malformed: [\n');
    assert.ok((await PortalModel.create(fx.dir)).warnings.some((warning) => warning.startsWith('shortcut.yml:')));
    // A present directory is not an absent optional file: its unsafe source remains diagnostic.
    fs.renameSync(fx.file('shortcut.yml'), fx.file('malformed-shortcut.txt'));
    fs.mkdirSync(fx.file('shortcut.yml'));
    assert.ok(new PortalModel(fx.dir).warnings.some((warning) => warning.startsWith('shortcut.yml:')));
  });

  test(`${format} shortcut descriptions and attachment summaries preserve record and language identity`, async (t) => {
    const fx = createFixture();
    t.after(() => fx.cleanup());
    const key = (name) => (short ? name : `adx_${name}`);
    const idKey = (name) => (short ? 'id' : `adx_${name}id`);
    if (short) fx.write('website.yml', 'id: site\nname: Site\n');
    const shortcutFile = 'shortcut.yml';
    const records = [
      {
        [idKey('shortcut')]: 'shortcut-one',
        [key('description')]: localized('Old shortcut'),
        [key('externalurl')]: 'https://example.test/path',
      },
      { [idKey('shortcut')]: 'shortcut-two', [key('description')]: '<p>Sibling description</p>' },
      { [idKey('shortcut')]: 'shortcut-inactive', [key('description')]: '<p>Inactive shortcut</p>', statecode: 1 },
    ];
    fx.write(shortcutFile, YAML.stringify(records));
    const nestedFile = 'shortcuts/nested/Nested.shortcut.yml';
    fx.write(
      nestedFile,
      YAML.stringify({
        [idKey('shortcut')]: 'nested-shortcut',
        [key('description')]: '<p>Nested before</p>',
        [key('externalurl')]: 'https://example.test/nested',
      }),
    );
    const summaryFile = 'web-files/manual/Manual.webfile.yml';
    const summaryRecord = {
      [idKey('webfile')]: 'file-one',
      [key('name')]: 'Manual',
      [key('parentpageid')]: HOME_ID,
      [key('partialurl')]: 'manual.txt',
      [key('summary')]: localized('Old summary'),
      filename: 'manual.txt',
    };
    fx.write(summaryFile, YAML.stringify(summaryRecord));
    fx.write('web-files/manual/manual.txt', 'unchanged attachment bytes');
    fx.commit();
    const baseline = new GitBaseline(fx.dir, 'HEAD');
    let model = await PortalModel.create(fx.dir);
    const sources = model.inlineSources.filter((source) =>
      [fx.file(shortcutFile), fx.file(summaryFile), fx.file(nestedFile)].includes(source.file),
    );
    assert.equal(sources.length, 6);
    assert.equal(
      sources.some((source) => sourceText(source) === '<p>Inactive shortcut</p>'),
      false,
    );
    const selected = sources.filter((source) => source.lcid === 1033);
    const shortcut = selected.find((source) => source.file === fx.file(shortcutFile));
    const summary = selected.find((source) => source.file === fx.file(summaryFile));
    assert.equal(selected.length, 2);
    assert.equal(shortcut.recordId, 'shortcut-one');
    assert.equal(summary.recordId, 'file-one');
    for (const source of selected) {
      assert.equal(
        auditResources(model, site).resources.find((resource) => resource.id === source.rel).status,
        'mapped',
      );
      editSource(source, (text) => text.replace('Old', 'New'));
    }
    const nested = sources.find((source) => source.file === fx.file(nestedFile));
    assert.equal(nested.recordId, 'nested-shortcut');
    assert.equal(auditResources(model, site).resources.find((resource) => resource.id === nested.rel).status, 'mapped');
    editSource(nested, (text) => text.replace('before', 'after'));
    model = await PortalModel.create(fx.dir);
    assert.deepEqual(model.deploymentChanges(baseline, baseline.changedFiles()), []);
    const rendered = new HtmlRewriter({ model, site, baseline }).rewrite(
      '<html><body><p>Old shortcut</p><p>Old summary</p><p>Nested before</p></body></html>',
      '/',
    );
    assert.equal(rendered.applied.length, 3);
    assert.match(rendered.html, /New shortcut/);
    assert.match(rendered.html, /New summary/);
    assert.match(rendered.html, /Nested after/);
    assert.equal(fx.read('web-files/manual/manual.txt'), 'unchanged attachment bytes');
    const after = YAML.parse(fx.read(summaryFile));
    assert.deepEqual({ ...after, [key('summary')]: summaryRecord[key('summary')] }, summaryRecord);
    after[idKey('webfile')] = 'foreign-file';
    fx.write(summaryFile, YAML.stringify(after));
    assert.equal(sourceText(summary), null);
    assert.throws(() => editSource(summary, (text) => text + 'x'), /stale record identity/);
    assert.ok(
      new PortalModel(fx.dir)
        .deploymentChanges(baseline, baseline.changedFiles())
        .some((change) => change.rel === summaryFile),
    );
    const changed = YAML.parse(fx.read(shortcutFile));
    const languages = JSON.parse(changed[0][key('description')]);
    languages[0].LCID = 1031;
    changed[0][key('description')] = JSON.stringify(languages);
    fx.write(shortcutFile, YAML.stringify(changed));
    assert.equal(sourceText(shortcut), null);
    assert.ok(
      new PortalModel(fx.dir)
        .deploymentChanges(baseline, baseline.changedFiles())
        .some((change) => change.rel === shortcutFile),
    );
    fx.write(shortcutFile, YAML.stringify(records.toReversed()));
    assert.equal(sourceText(shortcut), null);
  });
}

test('enhanced shortcut descriptions and file summaries keep attachment and structural metadata independent', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  fs.renameSync(fx.file('web-pages'), fx.file('classic-pages'));
  fs.renameSync(fx.file('web-files'), fx.file('classic-files'));
  const put = (id, type, content, attachment = false) => {
    const json = JSON.stringify(content).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    fx.write(
      `powerpagecomponents/${id}/powerpagecomponent.xml`,
      [
        `<powerpagecomponent powerpagecomponentid="${id}">`,
        `<name>${id}</name>`,
        `<content>${json}</content>`,
        `<powerpagecomponenttype>${type}</powerpagecomponenttype>`,
        attachment ? '<filecontent mimetype="text/plain">manual.txt</filecontent>' : '',
        '</powerpagecomponent>',
      ].join('\n'),
    );
  };
  put('home', 2, { isroot: true, partialurl: '/' });
  put('shortcut', 32, { description: localized('Old shortcut'), externalurl: 'https://example.test/' });
  put('file', 3, { summary: '<p>Old summary</p>', parentpageid: 'home', partialurl: 'manual.txt' }, true);
  fx.write('powerpagecomponents/file/filecontent/manual.txt', 'attachment unchanged');
  fx.commit();
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  let model = await PortalModel.create(fx.dir);
  const sources = model.inlineSources.filter((source) => source.kind === 'metadata-markup');
  assert.equal(sources.length, 3);
  for (const source of sources.filter((source) => source.lcid !== 1045))
    editSource(source, (text) => text.replace('Old', 'New'));
  model = new PortalModel(fx.dir);
  assert.deepEqual(model.deploymentChanges(baseline, baseline.changedFiles()), []);
  const rendered = new HtmlRewriter({ model, site, baseline }).rewrite(
    '<html><body><p>Old shortcut</p><p>Old summary</p></body></html>',
    '/',
  );
  assert.equal(rendered.applied.length, 2);
  assert.equal(model.findWebFile('/manual.txt').file, fx.file('powerpagecomponents/file/filecontent/manual.txt'));
  assert.equal(fx.read('powerpagecomponents/file/filecontent/manual.txt'), 'attachment unchanged');
  const shortcut = sources.find((source) => source.lcid === 1033);
  const shortcutFile = 'powerpagecomponents/shortcut/powerpagecomponent.xml';
  fx.write(shortcutFile, fx.read(shortcutFile).replace('1033', '1031'));
  assert.equal(sourceText(shortcut), null);
  assert.ok(
    new PortalModel(fx.dir)
      .deploymentChanges(baseline, baseline.changedFiles())
      .some((change) => change.rel.includes('/shortcut/')),
  );
  const summaryFile = 'powerpagecomponents/file/powerpagecomponent.xml';
  fx.write(summaryFile, fx.read(summaryFile).replace('manual.txt', 'different.txt'));
  assert.ok(
    new PortalModel(fx.dir)
      .deploymentChanges(baseline, baseline.changedFiles())
      .some((change) => change.rel.includes('/file/')),
  );
});
