// The canvas host language is the staff user's UI language (usersettings uilanguageid, else the organization's base
// language), so Language() and Value/Decimal/Float without a tag follow it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { createCanvasApp } from '../lib/canvas-runtime.mjs';
import { fixtureApp, organization } from './canvas-runtime-fixture.mjs';

const formula = 'Set(fxLanguage, Language()); Set(fxValue, Value("1.234,5")); Set(fxFloat, Float("2,5"))';

async function run(t, setup) {
  const org = await organization(t);
  setup(org);
  const instance = createCanvasApp({
    app: await fixtureApp(),
    evaluator: createPowerFxEvaluator(),
    principal: org.admin,
    api: org.api,
    caller: org.caller,
  });
  await instance.start();
  const { errors, snapshot } = await instance.act({ action: 'run', formula });
  assert.deepEqual(errors, []);
  return snapshot.variables;
}

test('a de-DE staff user (usersettings uilanguageid 1031) reads numbers and Language() in de-DE', async (t) => {
  const variables = await run(t, (org) => {
    (org.store.state.tables.usersettings ??= []).push({
      usersettingsid: org.admin.principalId,
      systemuserid: org.admin.principalId,
      uilanguageid: 1031,
    });
  });
  assert.equal(variables.fxLanguage, 'de-DE');
  assert.equal(variables.fxValue, 1234.5);
  assert.equal(variables.fxFloat, 2.5);
});

test('without a usersettings row the organization base language applies', async (t) => {
  const variables = await run(t, (org) => {
    const organizationRow = org.store.state.tables.organization?.[0];
    assert.ok(organizationRow, 'the organization row is seeded');
    organizationRow.languagecode = 1031;
  });
  assert.equal(variables.fxLanguage, 'de-DE');
  assert.equal(variables.fxValue, 1234.5);
});
