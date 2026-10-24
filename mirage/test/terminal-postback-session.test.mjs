import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent } from '../lib/platform.mjs';
import { createWebFormSessions } from '../lib/form-service.mjs';

test('only the completed postback of the same owner, form, step and saved row can render terminal success', async () => {
  const sessions = createWebFormSessions(),
    session = sessions.create('survey', 'contact:owner');
  session.history = [
    { stepId: 'one', recordId: 'saved', entity: 'answer' },
    { stepId: 'two', recordId: 'saved', entity: 'answer' },
  ];
  session.current = 'two';
  session.active = false;
  session.completed = true;
  const portal = {
    website: { id: 'invented' },
    settings: {},
    forms: [],
    lists: [],
    pages: [],
    records: [],
    advancedForms: [{ id: 'survey', name: 'Survey', metadata: { adx_multiplerecordsperuserpermitted: true } }],
  };
  const schemas = {
    survey: {
      initialStepId: 'two',
      steps: [
        {
          stepId: 'two',
          type: 'load',
          entity: 'answer',
          mode: 100000001,
          metadata: { adx_entitysourcetype: 100000003, adx_entitysourcestep: 'one' },
          fields: [{ name: 'note', type: 'text' }],
        },
      ],
    },
  };
  const store = {
    resolveMapping: () => ({ entitySet: 'answers', idColumn: 'answerid' }),
    get: async () => ({ answerid: 'saved', note: 'Saved' }),
    query: async () => ({ value: [] }),
    allowed: () => true,
  };
  const postback = {
    kind: 'webform',
    formId: 'survey',
    sessionId: session.id,
    stepId: 'two',
    savedId: 'saved',
    outcome: { type: 'message', message: 'Owned terminal success', hideForm: true },
  };
  const render = (state = postback, owner = 'contact:owner') =>
    renderComponent(
      'webform',
      'Survey',
      {
        user: { contactId: owner.slice('contact:'.length) },
        request: { url: 'http://localhost/?stepid=two', params: { stepid: 'two' } },
      },
      {
        portal,
        store,
        schemas,
        renderLiquid: async (value) => value,
        webFormSessions: sessions,
        webFormOwner: () => owner,
        nativePostbackState: state,
      },
    );
  assert.match(await render(), /Owned terminal success/);
  for (const [state, owner] of [
    [null, 'contact:owner'],
    [postback, 'contact:foreign'],
    [{ ...postback, formId: 'another' }, 'contact:owner'],
    [{ ...postback, stepId: 'one', savedId: 'foreign' }, 'contact:owner'],
    [{ ...postback, savedId: 'foreign' }, 'contact:owner'],
  ]) {
    const html = await render(state, owner);
    assert.match(html, /source-invalid/);
    assert.doesNotMatch(html, /Owned terminal success/);
  }
  portal.advancedForms[0].metadata = {
    adx_multiplerecordsperuserpermitted: false,
    adx_editexistingrecordpermitted: false,
  };
  assert.match(await render(), /Owned terminal success/);
  const ordinaryReload = await render(null);
  assert.match(ordinaryReload, /already completed a submission/);
  assert.doesNotMatch(ordinaryReload, /Owned terminal success/);
  assert.equal(session.active, false);
  assert.equal(session.completed, true);
});

test('terminal PRG success-only GET trusts completed owner/form/final history without reading row fields', async () => {
  const sessions = createWebFormSessions(),
    session = sessions.create('survey', 'contact:owner');
  const original = [
    { stepId: 'one', recordId: 'saved', entity: 'answer' },
    { stepId: 'two', recordId: 'saved', entity: 'answer' },
  ];
  session.history = structuredClone(original);
  session.current = 'two';
  session.active = false;
  session.completed = true;
  const definition = { id: 'survey', name: 'Survey', metadata: { adx_multiplerecordsperuserpermitted: true } };
  const portal = {
    website: { id: 'invented' },
    settings: {},
    forms: [],
    lists: [],
    pages: [],
    records: [],
    advancedForms: [definition],
  };
  const schemas = {
    survey: {
      initialStepId: 'two',
      steps: [
        {
          stepId: 'two',
          type: 'load',
          entity: 'answer',
          mode: 100000001,
          fields: [{ name: 'note', type: 'text' }],
          metadata: {
            adx_entitysourcetype: 100000003,
            adx_entitysourcestep: 'one',
            adx_successmessage: 'Owned GET success',
            adx_hideformonsuccess: true,
          },
        },
      ],
    },
  };
  let readable = true;
  const store = {
    resolveMapping: () => ({ entitySet: 'answers', idColumn: 'answerid' }),
    get: async (_entity, id) => (readable && id === 'saved' ? { answerid: 'saved', note: 'Saved' } : null),
    query: async () => ({ value: [] }),
    allowed: () => true,
  };
  const render = (params = { stepid: 'two', msg: 'success' }, owner = 'contact:owner') =>
    renderComponent(
      'webform',
      'Survey',
      {
        user: { contactId: owner.slice(8) },
        request: { url: 'http://localhost/?' + new URLSearchParams(params), params },
      },
      {
        portal,
        store,
        schemas,
        renderLiquid: async (value) => value,
        webFormSessions: sessions,
        webFormOwner: () => owner,
      },
    );
  assert.match(await render(), /Owned GET success/);
  assert.match(await render(), /Owned GET success/, 'reload follows PRG without another save');
  for (const [params, owner] of [
    [{ stepid: 'two', msg: 'success' }, 'contact:foreign'],
    [{ stepid: 'one', msg: 'success' }, 'contact:owner'],
    [{ stepid: 'two', msg: 'success', sessionid: 'foreign' }, 'contact:owner'],
    [{ stepid: 'two' }, 'contact:owner'],
  ])
    assert.doesNotMatch(await render(params, owner), /Owned GET success/);
  for (const history of [
    [],
    [{ stepId: 'two', recordId: null, entity: 'answer' }],
    [{ stepId: 'two', recordId: 'saved', entity: 'contact' }],
  ]) {
    session.history = history;
    assert.doesNotMatch(await render(), /Owned GET success/);
  }
  session.history = structuredClone(original);
  readable = false;
  assert.match(await render(), /Owned GET success/);
  schemas.survey.steps[0].metadata.adx_hideformonsuccess = false;
  assert.doesNotMatch(await render(), /Owned GET success/);
  schemas.survey.steps[0].metadata.adx_hideformonsuccess = true;
  readable = true;
  session.completed = false;
  assert.doesNotMatch(await render(), /Owned GET success/);
  session.completed = true;
  definition.metadata.adx_startnewsessiononload = true;
  assert.doesNotMatch(await render(), /Owned GET success/);
  assert.match(await render({ stepid: 'two', msg: 'success', sessionid: session.id }), /Owned GET success/);
  assert.equal(session.active, false);
  assert.equal(session.completed, true);
});
