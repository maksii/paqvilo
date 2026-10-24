import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const inventory = JSON.parse(await fs.readFile(new URL('../baseline/plugins.json', import.meta.url), 'utf8'));
const source = await fs.readFile(new URL('../components/DataversePlugins/BaselineRules.cs', import.meta.url), 'utf8');

test('baseline plugin inventory lists the failing, mutation and registration-state steps with unique ids', () => {
  const fail = inventory.steps.filter((s) => s.kind === 'fail' && s.message !== 'Retrieve');
  const mutate = inventory.steps.filter((s) => s.kind === 'mutate');
  assert.equal(fail.length, 9);
  assert.equal(mutate.length, 2);
  const keys = new Set(fail.map((s) => `${s.message}/${s.stage}`));
  for (const message of ['Create', 'Update', 'Delete'])
    for (const stage of [10, 20, 40]) assert.ok(keys.has(`${message}/${stage}`));
  for (const s of fail) {
    const stage = { 10: 'prevalidation', 20: 'preoperation', 40: 'postoperation' }[s.stage];
    assert.equal(s.sentinel, `plugin-fail-${s.message.toLowerCase()}-${stage}`);
    assert.equal(s.error, `Baseline plugin rejected ${s.message.toLowerCase()} at ${stage}`);
    assert.equal(s.rank, 10);
    assert.equal(s.filteringAttributes, s.message === 'Update' ? 'pqvd_text' : null);
    const image =
      s.message === 'Delete'
        ? ['baseline', 'PreImage', 'pqvd_text']
        : s.message === 'Update' && s.stage === 40
          ? ['baselinepost', 'PostImage', 'pqvd_text']
          : null;
    assert.deepEqual(s.image && [s.image.name, s.image.type, s.image.attributes], image);
  }
  for (const s of mutate) {
    assert.deepEqual([s.stage, s.rank], [20, 20]);
    assert.equal(s.filteringAttributes, s.message === 'Update' ? 'pqvd_ticker,pqvd_textarea' : null);
  }
  const one = (kind, message) => {
    const found = inventory.steps.filter((s) => s.kind === kind && s.message === message);
    assert.equal(found.length, 1, `${kind} ${message}`);
    return found[0];
  };
  const retrieve = one('fail', 'Retrieve');
  assert.deepEqual(
    [retrieve.stage, retrieve.mode, retrieve.sentinel, retrieve.error],
    [40, 0, 'plugin-fail-retrieve-postoperation', 'Baseline plugin rejected retrieve at postoperation'],
  );
  const hide = one('hide', 'RetrieveMultiple');
  assert.deepEqual([hide.stage, hide.mode, hide.sentinel], [40, 0, 'plugin-hide-retrievemultiple']);
  const impersonated = one('impersonated-noop', 'Update');
  assert.deepEqual(
    [impersonated.stage, impersonated.rank, impersonated.mode, impersonated.runAs, impersonated.configuration],
    [40, 30, 0, 'application-user', 'noop'],
  );
  const async = one('async-noop', 'Create');
  assert.deepEqual([async.stage, async.mode, async.asyncAutoDelete, async.configuration], [40, 1, true, 'noop']);
  const disabled = one('disabled', 'Delete');
  assert.deepEqual([disabled.stage, disabled.rank, disabled.disabled, disabled.configuration], [10, 20, true, 'noop']);
  assert.equal(inventory.steps.length, 16);
  const ids = [
    inventory.assemblyId,
    inventory.typeId,
    ...inventory.steps.flatMap((s) => [s.id, s.image?.id].filter(Boolean)),
  ];
  assert.equal(new Set(ids).size, ids.length);
});

test('BaselineRules source carries the sentinel and error format', () => {
  assert.match(source, /"plugin-fail-" \+ message \+ "-" \+ stage/);
  assert.match(source, /"Baseline plugin rejected " \+ message \+ " at " \+ stage/);
  assert.match(source, /PreEntityImages\.Contains\("baseline"\)/);
  assert.match(source, /"mutated by plugin"/);
  assert.match(source, /OutputParameters\["BusinessEntity"\]/);
  assert.match(source, /"plugin-hide-retrievemultiple"/);
  assert.match(source, /configuration == "noop"/);
});
