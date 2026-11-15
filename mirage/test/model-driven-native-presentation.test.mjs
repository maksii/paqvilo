// @test-kind observation: two native UCI draft captures on 2026-11-08 produced the 50 rows of fixtures/model-driven-presentation-expected.json, SHA256 da569c053dd3237e6dad9fc38a0d428df16eb581b1b47d0576ee02db6d7de325, from the probe with SHA256 d1d101c72488f3b03c7a83f0448e4b6f20450bc1b485e26a9199e2ed93d37992 (presentation-plan.json SHA256 093da88d2528d33989e5306a7692df6e9ddf136e733050572671099ed6255b66, not committed); see fixtures/frontend-parity-evidence.md. The tab, section and field inputs are typed in fixtures/model-driven-presentation.mjs, so no replay case records them.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { captureModelDrivenPresentationContract } from '../testing/model-driven-presentation.mjs';
import { presentationFixture } from './fixtures/model-driven-presentation.mjs';

const bytes = fs.readFileSync(new URL('./fixtures/model-driven-presentation-expected.json', import.meta.url));

const expected = JSON.parse(bytes);
let actual;
before(async () => {
  assert.equal(
    createHash('sha256').update(captureModelDrivenPresentationContract.toString()).digest('hex'),
    'd1d101c72488f3b03c7a83f0448e4b6f20450bc1b485e26a9199e2ed93d37992',
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'da569c053dd3237e6dad9fc38a0d428df16eb581b1b47d0576ee02db6d7de325',
  );
  const fixture = presentationFixture();
  actual = await captureModelDrivenPresentationContract(fixture.input, fixture.runtime.formContext);
  fixture.runtime.destroy();
});

for (const row of expected)
  test(`native presentation contract: ${row.id}`, () =>
    assert.deepEqual(
      actual.find((item) => item.id === row.id),
      row,
    ));

// @test-kind contract: client label state must not rewrite the imported layout metadata.
test('client layout labels leave their source metadata unchanged', () => {
  const fixture = presentationFixture();
  try {
    const tab = fixture.runtime.formContext.ui.tabs.get(0),
      section = tab.sections.get(0);
    tab.setLabel('Client tab');
    section.setLabel('Client section');
    assert.equal(tab.getLabel(), 'Client tab');
    assert.equal(section.getLabel(), 'Client section');
    assert.equal(fixture.tab.label, 'Native components');
    assert.equal(fixture.section.label, 'Fixture section');
  } finally {
    fixture.runtime.destroy();
  }
});
