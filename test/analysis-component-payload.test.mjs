// @test-kind contract+security: missing enhanced payloads remain incomplete without syntax advice or disclosed setting values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDirSync } from './fixture.mjs';
import { analyzeProject } from '../lense/analysis/index.mjs';

test('enhanced component diagnostics distinguish XML syntax from absent and invalid record payloads', (t) => {
  const root = tempDirSync('paq-component-payload-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'powerpagecomponent.xml');
  const envelope = (content, type = 9) =>
    `<powerpagecomponent powerpagecomponentid="11111111-1111-4111-8111-111111111111"><name>Authentication/Invented/ClientSecret</name><powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>0</statecode>${content}</powerpagecomponent>`;
  for (const content of [
    '',
    '<content/>',
    '<content></content>',
    '<content><![CDATA[]]></content>',
    '<content><![CDATA[[]]]></content>',
    '<content><![CDATA[null]]></content>',
    '<content><![CDATA["bad-secret-value"]]></content>',
  ]) {
    fs.writeFileSync(file, envelope(content));
    const report = analyzeProject(root);
    assert.equal(report.complete, false);
    assert.equal(report.ready, false);
    assert.ok(!report.findings.some((finding) => finding.ruleId === 'PAQ-SOURCE-001'));
    assert.ok(report.findings.some((finding) => finding.ruleId === 'PAQ-SOURCE-002'));
    assert.doesNotMatch(JSON.stringify(report), /bad-secret-value|Correct source syntax|ClientSecret/);
  }
  fs.writeFileSync(file, envelope('<content><![CDATA[{bad-secret-value]]></content>'));
  const invalid = analyzeProject(root);
  assert.ok(invalid.findings.some((finding) => finding.ruleId === 'PAQ-SOURCE-001'));
  assert.doesNotMatch(JSON.stringify(invalid), /bad-secret-value/);
  for (const payload of [{}, { value: '' }, { value: null }]) {
    fs.writeFileSync(file, envelope(`<content><![CDATA[${JSON.stringify(payload)}]]></content>`));
    assert.equal(analyzeProject(root).complete, true);
  }
  fs.writeFileSync(file, envelope('<content><![CDATA[{}]]></content>', 999));
  assert.ok(analyzeProject(root).coverage.skipped.some((item) => item.reason === 'unsupported-component-type'));
  fs.writeFileSync(file, envelope('').replace('</powerpagecomponent>', '</wrong>'));
  assert.ok(analyzeProject(root).findings.some((finding) => finding.ruleId === 'PAQ-SOURCE-001'));
});
