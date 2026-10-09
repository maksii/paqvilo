import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { PortalModel, sourceText } from '../lense/portal-model.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { editSource } from '../lense/source-edit.mjs';
import { createFixture, SITE } from './fixture.mjs';

const site = { ...SITE, markup: { ...SITE.markup, kinds: [...SITE.markup.kinds, 'metadata-markup'] } };

test('known YAML rendered fields are discoverable and literal changes preserve metadata diagnostics', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const files = [
    ['weblink-sets/footer/Footer.en-US.weblinkset.yml', { adx_name: 'Footer', adx_copy: '<p>Old footer</p>', adx_weblinksetid: 'footer-id' }, 'adx_copy'],
    ['polls/poll/Poll.poll.yml', { adx_pollid: 'poll-id', adx_question: '<p>Old question</p>' }, 'adx_question'],
    ['basic-forms/contact/Contact.basicform.yml', { adx_entityformid: 'form-id', adx_instructions: '<p>Old instructions</p>' }, 'adx_instructions'],
    ['weblink-sets/menu/Menu.weblinkset.weblink.yml', [{ adx_weblinkid: 'link-id', adx_description: '<p>Old link description</p>', adx_name: '<b>Old label</b>' }], 'adx_description'],
  ];
  for (const [rel, content] of files) fx.write(rel, YAML.stringify(content));
  fx.commit();
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  let model = await PortalModel.create(fx.dir);
  for (const [rel, , field] of files) {
    const source = model.inlineSources.find((entry) => entry.file === fx.file(rel) && entry.field === field);
    assert.ok(source, `${rel}#${field}`);
    assert.equal(source.format, 'yaml');
    editSource(source, (text) => text.replace('Old', 'New'));
  }
  model = new PortalModel(fx.dir);
  assert.deepEqual(model.deploymentChanges(baseline, baseline.changedFiles()), []);
  const r = new HtmlRewriter({ model, site, baseline });
  const result = r.rewrite('<html><body><p>Old footer</p><p>Old question</p><p>Old instructions</p><p>Old link description</p></body></html>', '/');
  assert.equal(result.applied.length, 4);
  assert.ok(result.html.includes('<p>New footer</p>'));
  const footerFile = files[0][0];
  fx.write(footerFile, fx.read(footerFile).replace('footer-id', 'different-footer'));
  assert.ok(new PortalModel(fx.dir).deploymentChanges(baseline, baseline.changedFiles()).some((change) => change.rel === footerFile));
});

test('localized YAML description Value edits are previewable but LCID and record moves are deployment changes', (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const rel = 'basic-forms/contact/Contact.basicform.basicformmetadata.yml';
  const value = '<button onclick="window.clicked = 1">English button</button>';
  const records = [
    { adx_entityformmetadataid: 'meta1', adx_entityform: 'contact-id', adx_description: JSON.stringify([{ LCID: 1033, Value: value }, { LCID: 1045, Value: '<p>Polski</p>' }]) },
    { adx_entityformmetadataid: 'meta2', adx_description: '<p>Different field</p>' },
  ];
  fx.write(rel, YAML.stringify(records));
  fx.commit();
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  const source = new PortalModel(fx.dir).inlineSources.find((entry) => entry.file === fx.file(rel) && entry.lcid === 1033);
  assert.deepEqual(source.fieldPath, [0, 'adx_description']);
  assert.deepEqual(source.jsonPath, [0, 'Value']);
  assert.equal(sourceText(source), value);
  editSource(source, (text) => text.replace('= 1', '= 2'));
  const model = new PortalModel(fx.dir);
  assert.deepEqual(model.deploymentChanges(baseline, baseline.changedFiles()), []);
  const result = new HtmlRewriter({ model, site, baseline }).rewrite(`<html><body>${value}</body></html>`, '/');
  assert.ok(result.html.includes('window.clicked = 2'));
  const after = YAML.parse(fx.read(rel));
  assert.equal(JSON.parse(after[0].adx_description)[1].Value, '<p>Polski</p>');
  const localized = JSON.parse(after[0].adx_description);
  localized[0].LCID = 1031;
  after[0].adx_description = JSON.stringify(localized);
  fx.write(rel, YAML.stringify(after));
  assert.equal(sourceText(source), null, 'LCID replacement cannot reuse an indexed source');
  assert.ok(new PortalModel(fx.dir).deploymentChanges(baseline, baseline.changedFiles()).some((change) => change.rel === rel));
  fx.write(rel, YAML.stringify(records.toReversed()));
  assert.equal(sourceText(source), null, 'record order replacement cannot reuse an indexed source');
  assert.ok(new PortalModel(fx.dir).deploymentChanges(baseline, baseline.changedFiles()).some((change) => change.rel === rel));
});

test('basic and advanced form metadata labels and validation messages expose localized literal leaves', (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const localized = (text) => JSON.stringify([{ LCID: 1033, Value: `<p>${text}</p>` }]);
  fx.write('web-pages/about/About.webpage.yml', fx.read('web-pages/about/About.webpage.yml') + 'adx_webform: wizard-form\n');
  const stepRel = 'advanced-forms/wizard/advanced-form-steps/details/Details.advancedformstep.yml';
  fx.write(stepRel, 'adx_webformstepid: step1\nadx_webform: wizard-form\n');
  for (const [rel, recordIdField, id] of [
    ['basic-forms/contact/Contact.basicform.basicformmetadata.yml', 'adx_entityformmetadataid', 'basic-meta'],
    ['advanced-forms/wizard/Wizard.advancedformmetadata.yml', 'adx_webformmetadataid', 'advanced-meta'],
  ]) {
    fx.write(rel, YAML.stringify([{ [recordIdField]: id, ...(id === 'advanced-meta' ? { adx_webformstep: 'step1' } : {}), adx_description: localized('Hint'), adx_label: localized('Label'), adx_validationregularexpressionerrormessage: localized('Validation') }]));
  }
  fx.commit();
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  const sources = new PortalModel(fx.dir).inlineSources.filter((source) => source.kind === 'metadata-markup');
  assert.equal(sources.length, 6);
  assert.deepEqual(sources.find((source) => source.recordId === 'advanced-meta').usedOn, ['/about-us']);
  for (const source of sources) editSource(source, (text) => text.replace('</p>', ' updated</p>'));
  assert.deepEqual(new PortalModel(fx.dir).deploymentChanges(baseline, baseline.changedFiles()), []);
  const result = new HtmlRewriter({ model: new PortalModel(fx.dir), site, baseline }).rewrite('<html><body><p>Hint</p><p>Label</p><p>Validation</p></body></html>', '/');
  assert.ok(result.html.includes('Hint updated'));
  fx.write(stepRel, fx.read(stepRel) + 'statecode: 1\n');
  assert.equal(new PortalModel(fx.dir).inlineSources.filter((source) => source.kind === 'metadata-markup').length, 3, 'inactive step metadata is excluded');
});

test('form metadata of an inactive parent is excluded', (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  fx.write('basic-forms/contact/Contact.basicform.yml', 'adx_entityformid: inactive-form\nstatecode: 1\n');
  fx.write('basic-forms/contact/Contact.basicform.basicformmetadata.yml', YAML.stringify([{ adx_entityformmetadataid: 'm1', adx_entityform: 'inactive-form', adx_description: '<p>Hidden hint</p>' }]));
  const model = new PortalModel(fx.dir);
  assert.equal(model.inlineSources.some((source) => source.kind === 'metadata-markup'), false);
  assert.ok(model.inactiveSources.some((source) => source.rel.endsWith('basicformmetadata.yml')));
});
