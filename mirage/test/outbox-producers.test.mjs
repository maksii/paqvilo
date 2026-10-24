// SendEmail and BackgroundSendEmail capture outgoing email in the outbox (outbox.mjs) through the full Web API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { createOutbox } from '../lib/outbox.mjs';

const APP_ID = '77777777-7777-4777-8777-777777777711';
const SECRET_VAR = 'PAQVILO_OUTBOX_PRODUCERS_SECRET';
const API = '/api/data/v9.2/';

async function fixture(t, { withOutbox = true } = {}) {
  process.env[SECRET_VAR] = 'outbox-producers-secret';
  t.after(() => {
    delete process.env[SECRET_VAR];
  });
  const store = await new DataStore({ state: emptyState() }).init();
  const outbox = withOutbox ? createOutbox({ store }) : null;
  // The host composes api.providers (organization-host.mjs); this extension stands in for it when the option is not supported.
  const providers = {
    name: 'x-test-providers',
    install(api) {
      if (outbox && !api.providers?.outbox) api.providers = { ...(api.providers ?? {}), outbox };
    },
  };
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      {
        appId: APP_ID,
        displayName: 'Invented app',
        secretEnvironmentVariable: SECRET_VAR,
        roles: ['System Administrator'],
      },
    ],
  });
  const api = await startDataverseApi({
    store,
    settings,
    log: () => {},
    providers: { outbox },
    extensions: [providers, ...EXTENSIONS],
  });
  t.after(() => api.close());
  const token = (
    await (
      await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: APP_ID,
          client_secret: process.env[SECRET_VAR],
          scope: `${api.origin}/.default`,
        }),
      })
    ).json()
  ).access_token;
  const act = async (path, body) => {
    const response = await fetch(`${api.origin}${API}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, headers: response.headers };
  };
  const email = async (fields) => {
    const response = await act('emails', fields);
    assert.equal(response.status, 204, response.text);
    return /\(([0-9a-f-]{36})\)/i.exec(response.headers.get('OData-EntityId'))[1];
  };
  return { store, outbox, act, email };
}

const emailRow = (store, id) => store.tableRows('email').find((row) => row.activityid === id);

test("SendEmail with IssueSend false captures a delivered entry with the email's fields", async (t) => {
  const { store, outbox, act, email } = await fixture(t);
  const id = await email({
    subject: 'Invented subject',
    description: '<p>Invented body</p>',
    sender: 'from@example.test',
    torecipients: 'a@example.test; b@example.test',
    cc: 'c@example.test',
  });
  const response = await act(`emails(${id})/Microsoft.Dynamics.CRM.SendEmail`, { IssueSend: false });
  assert.equal(response.status, 200, response.text);
  assert.equal(emailRow(store, id).statuscode, 3);
  const [entry] = outbox.list();
  assert.equal(outbox.list().length, 1);
  assert.equal(entry.channel, 'email');
  assert.equal(entry.state, 'delivered');
  assert.equal(entry.from, 'from@example.test');
  assert.deepEqual(entry.to, ['a@example.test', 'b@example.test']);
  assert.deepEqual(entry.cc, ['c@example.test']);
  assert.equal(entry.subject, 'Invented subject');
  assert.equal(entry.body, emailRow(store, id).description, 'the stored description');
  assert.deepEqual(entry.source, { kind: 'SendEmail', id });
});

test('SendEmail with IssueSend true queues the entry and BackgroundSendEmail marks it delivered', async (t) => {
  const { store, outbox, act, email } = await fixture(t);
  const id = await email({ subject: 'Queued one', torecipients: 'q@example.test' });
  assert.equal((await act(`emails(${id})/Microsoft.Dynamics.CRM.SendEmail`, { IssueSend: true })).status, 200);
  assert.equal(emailRow(store, id).statuscode, 6);
  assert.equal(outbox.list()[0].state, 'queued');
  const response = await act('BackgroundSendEmail', { Query: null });
  assert.equal(response.status, 200, response.text);
  const [entry] = outbox.list();
  assert.equal(entry.state, 'delivered');
  assert.ok(entry.deliveredOn);
  assert.equal(emailRow(store, id).statuscode, 6, 'the email row itself is unchanged');
});

test('attachments are referenced by name, size and type; the bytes stay out of the outbox', async (t) => {
  const { store, outbox, act, email } = await fixture(t);
  const id = await email({ subject: 'With attachment' });
  const bytes = Buffer.from('invented attachment bytes');
  await store.create(
    'activitymimeattachment',
    {
      objectid: { id, logical_name: 'email' },
      objecttypecode: 'email',
      attachmentnumber: 1,
      filename: 'x-note.txt',
      mimetype: 'text/plain',
      body: bytes.toString('base64'),
      filesize: bytes.length,
    },
    { admin: true },
  );
  assert.equal((await act(`emails(${id})/Microsoft.Dynamics.CRM.SendEmail`, { IssueSend: false })).status, 200);
  const [entry] = outbox.list();
  assert.deepEqual(entry.attachments, [
    { name: 'x-note.txt', contentType: 'text/plain', size: bytes.length, key: null },
  ]);
  assert.ok(!JSON.stringify(outbox.list()).includes(bytes.toString('base64')));
});

test('without an outbox SendEmail changes the statuscode only', async (t) => {
  const { store, act, email } = await fixture(t, { withOutbox: false });
  const id = await email({ subject: 'No outbox' });
  assert.equal((await act(`emails(${id})/Microsoft.Dynamics.CRM.SendEmail`, { IssueSend: false })).status, 200);
  assert.equal(emailRow(store, id).statuscode, 3);
  assert.equal(store.tableRows('paqvilo_outboxentry').length, 0);
  assert.equal((await act('BackgroundSendEmail', { Query: null })).status, 200);
});
