import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_DRIVEN_ACTIONS, modelDrivenAction, validateModelDrivenAction, modelDrivenDiagnosticUrl } from '../lense/model-driven-actions.mjs';

test('native action catalogue covers the complete reference vocabulary and separates draft, discard and autosave semantics', () => {
  assert.equal(new Set(MODEL_DRIVEN_ACTIONS.map(action => action.id)).size, MODEL_DRIVEN_ACTIONS.length);
  assert.equal(MODEL_DRIVEN_ACTIONS.filter(action => action.id.startsWith('form:')).length, 16);
  assert.equal(MODEL_DRIVEN_ACTIONS.filter(action => action.id.startsWith('navigation:')).length, 14);
  assert.equal(MODEL_DRIVEN_ACTIONS.filter(action => action.id.startsWith('debugging:')).length, 8);
  assert.equal(modelDrivenAction('form:clone-record').effect, 'draft');
  assert.equal(modelDrivenAction('form:refresh-autosave-off').effect, 'discard');
  assert.equal(modelDrivenAction('form:toggle-autosave').effect, 'client-form');
  assert.equal(modelDrivenAction('admin:check-system-health'), undefined, 'a type-only upstream feature is not advertised as implemented');
  for (const action of MODEL_DRIVEN_ACTIONS) assert.deepEqual(Object.keys(action), ['id', 'label', 'group', 'description', 'effect', 'requirements', 'inputs']);
});

test('action parameters reject arbitrary expressions and inherited shapes while preserving Boolean false', () => {
  assert.deepEqual(validateModelDrivenAction('navigation:open-record-by-id', { entity: 'X_Person', id: '{AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA}' }), { action: 'navigation:open-record-by-id', params: { entity: 'x_person', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
  assert.deepEqual(validateModelDrivenAction('form:toggle-autosave', { enabled: false }).params, { enabled: false });
  assert.deepEqual(validateModelDrivenAction('form:toggle-autosave').params, { enabled: true });
  for (const params of [{ entity: "x_person')/Other" }, { entity: 'x_person', expression: 'window.alert(1)' }, Object.create({ entity: 'x_person' }), []]) assert.throws(() => validateModelDrivenAction('navigation:new-record', params));
  assert.throws(() => validateModelDrivenAction('navigation:open-record-by-id', { entity: 'x_person', id: 'not-a-guid' }));
  assert.throws(() => validateModelDrivenAction('custom:execute', { code: 'anything' }));
});

test('diagnostic toggles preserve source routes and unrelated duplicate flags, then reset all owned options', () => {
  const source = 'https://example.invalid/main.aspx?appid=invented&etn=x_person&id=record&flags=Keep%3Dtrue&flags=Other%3Dyes#tab';
  let changed = source;
  for (const action of MODEL_DRIVEN_ACTIONS.filter(action => action.id.startsWith('debugging:') && !action.id.endsWith('clear-flags'))) changed = modelDrivenDiagnosticUrl(changed, action.id);
  const url = new URL(changed); assert.equal(url.searchParams.get('etn'), 'x_person'); assert.equal(url.hash, '#tab');
  assert.deepEqual(url.searchParams.getAll('flags').slice(0, 2), ['Keep=true', 'Other=yes']);
  assert.equal(modelDrivenDiagnosticUrl(changed, 'debugging:forms-monitor'), changed, 'repeated toggles do not duplicate native flags');
  const reset = new URL(modelDrivenDiagnosticUrl(changed, 'debugging:clear-flags'));
  assert.deepEqual(reset.searchParams.getAll('flags'), ['Keep=true', 'Other=yes']);
  for (const parameter of ['monitor', 'ribbondebug', 'perf']) assert.equal(reset.searchParams.has(parameter), false);
  assert.equal(reset.searchParams.get('id'), 'record'); assert.equal(reset.hash, '#tab');
});
