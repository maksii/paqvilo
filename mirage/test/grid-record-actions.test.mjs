// @test-kind unproven: local model of the legacy grid record actions (Adxstudio ViewConfiguration special message actions, LinkActionType codes, EntityActionController routes /_services/action-*); no hosted capture of these list actions
import test from 'node:test';
import assert from 'node:assert/strict';
import { signInHeaders } from '../testing/session.mjs';
import { CASES, G, startCaseList } from './support/case-list-fixture.mjs';

const { SITE, CONTACT, OPEN, OTHER, DEAL, TASK } = CASES;

async function fixture(t) {
  const app = await startCaseList(t);
  const agent = signInHeaders(app, CONTACT, { roles: ['Agent'] });
  const reader = signInHeaders(app, CONTACT, { roles: ['Reader'] });
  const html = await (await fetch(app.url, { headers: agent })).text();
  const encoded = /data-view-layouts="([^"]+)"/.exec(html)?.[1];
  const [layout] = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const post = (route, body, session = agent) =>
    fetch(`${app.url}/_services/${route}/${SITE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf, ...session },
      body: JSON.stringify(body),
    });
  const row = (table, id) => app.store.tableRows(table).find((item) => Object.values(item)[0] === id);
  return { app, html, layout, post, row, reader };
}

test('a list renders the table-specific record actions and runs them through the legacy action services', async (t) => {
  const { app, html, layout, post, row } = await fixture(t);
  assert.deepEqual(
    layout.Configuration.ItemActionLinks.map((link) => [link.Type, link.Label, link.URL?.Path]),
    [
      [
        14,
        "<span class='fa fa-check-circle fa-fw' aria-hidden='true'></span> Resolve Case",
        `/_services/action-resolve-case/${SITE}`,
      ],
      [
        16,
        "<span class='fa fa-times fa-fw' aria-hidden='true'></span> Cancel Case",
        `/_services/action-cancel-case/${SITE}`,
      ],
    ],
  );
  assert.match(html, /class="modal fade modal-resolvecase"/, 'the grid renders its resolve dialog');
  const reference = (id) => ({ entityReference: { LogicalName: 'incident', Id: id } });
  const refused = await post('action-resolve-case', { ...reference(OPEN), resolutionSubject: 'Fixed' });
  assert.equal(refused.status, 403);
  assert.equal(app.store.tableRows('incidentresolution').length, 0);
  const resolved = await post('action-resolve-case', {
    ...reference(OPEN),
    resolutionSubject: 'Fixed',
    resolutionDescription: 'Replaced the part',
  });
  assert.equal(resolved.status, 204, await resolved.text());
  assert.deepEqual([row('incident', OPEN).statecode, row('incident', OPEN).statuscode], [1, 5]);
  assert.equal(app.store.tableRows('incidentresolution')[0].subject, 'Fixed');
  const canceled = await post('action-cancel-case', reference(OTHER));
  assert.equal(canceled.status, 204, await canceled.text());
  assert.deepEqual([row('incident', OTHER).statecode, row('incident', OTHER).statuscode], [2, 6]);
  assert.deepEqual(
    [row('task', TASK).statecode, row('task', TASK).statuscode],
    [2, 6],
    'its open activity is canceled',
  );
  // A message action runs the same Dataverse message as the form action.
  const quoted = await post('action-generate-quote', { entityReference: { LogicalName: 'opportunity', Id: DEAL } });
  assert.equal(quoted.status, 204, await quoted.text());
  const [quote] = app.store.tableRows('quote');
  assert.equal(String(quote?.opportunityid?.id ?? quote?.opportunityid).toLowerCase(), DEAL);
});

// @test-kind security: a record action service needs Write on the record (as the legacy EntityActionController checks) and its own table, and a refusal writes nothing
test('record action services refuse a reader, another table and an unknown record', async (t) => {
  const { app, post, row, reader } = await fixture(t);
  assert.equal(
    (await post('action-cancel-case', { entityReference: { LogicalName: 'incident', Id: OPEN } }, reader)).status,
    403,
  );
  assert.equal(
    (await post('action-cancel-case', { entityReference: { LogicalName: 'opportunity', Id: DEAL } })).status,
    400,
  );
  assert.equal(
    (await post('action-cancel-case', { entityReference: { LogicalName: 'incident', Id: G(99) } })).status,
    404,
  );
  assert.equal(
    (await post('action-cancel-case', { entityReference: { LogicalName: 'incident', Id: OPEN } }, {})).status,
    403,
  );
  assert.deepEqual([row('incident', OPEN).statecode, row('task', TASK).statecode], [0, 0]);
  assert.equal(app.store.tableRows('incidentresolution').length, 0);
});

// @test-kind security: a record action service refuses a record in a state its message does not accept (the legacy grid shows the link only then), before the close activity or any other write
test('record action services refuse a case in the wrong state and write nothing', async (t) => {
  const { app, post, row } = await fixture(t);
  const reference = (id) => ({ entityReference: { LogicalName: 'incident', Id: id } });
  const resolution = { resolutionSubject: 'Fixed', resolutionDescription: 'Replaced the part' };
  const refused = async (route, body) => {
    const response = await post(route, body);
    assert.equal(response.status, 400, route);
    assert.equal((await response.json()).InnerError?.Code, 'InvalidStateTransition');
  };
  await refused('action-reopen-case', reference(OPEN));
  assert.equal((await post('action-resolve-case', { ...reference(OPEN), ...resolution })).status, 204);
  await refused('action-resolve-case', { ...reference(OPEN), ...resolution });
  await refused('action-close-case', reference(OPEN));
  await refused('action-cancel-case', reference(OPEN));
  assert.equal(app.store.tableRows('incidentresolution').length, 1);
  assert.deepEqual([row('incident', OPEN).statecode, row('incident', OPEN).statuscode], [1, 5]);
  assert.equal((await post('action-reopen-case', reference(OPEN))).status, 204);
  assert.deepEqual([row('incident', OPEN).statecode, row('incident', OPEN).statuscode], [0, 1]);
  assert.equal(row('task', TASK).statecode, 0);
});
