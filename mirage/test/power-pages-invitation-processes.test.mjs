// @test-kind observation: the Power Pages invitation processes as hosted session F4 AUTH-05d captured them in two agreeing runs (invitation-prepare-{a,b}-single and invitation-send-{a,b}-single, survey-1795733745275.json for the workflow definitions, in the hosted-f4 evidence folder): UpdateInvitationCode gives a new invitation a 172-character code in real time; Send Invitation runs as a background job owned by the caller and created by SYSTEM, writes one email regarding the invitation from the caller to the invited contact with an empty subject and its tracking token and the redemption link, and sets the invitation Sent. The link uses the local origin instead of the hosted http://localhost:7500. Schema and names are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { workflowExtension } from '../lib/dataverse-workflows.mjs';
import { settleCommittedWork } from '../lib/committed-work.mjs';
import { startAdminApi } from './support/web-api.mjs';

const CONTACT = '7a000000-0000-4000-8000-000000000001';
// The solution's ids of the two invitation processes, as the hosted survey read them (survey-1795733745275.json).
const INVITATION_PROCESSES = Object.freeze({
  updateInvitationCode: '6cf2fe48-d865-4ced-8546-0a78600efefc',
  sendInvitation: '15c03c8d-754f-4386-a62c-cf7e91337ebd',
});
const ORIGIN = 'http://127.0.0.1:65001';

function schema() {
  const state = emptyState();
  const text = { dataverseType: 'nvarchar' };
  const int = { dataverseType: 'int' };
  state.mappings.adx_invitation = {
    logicalName: 'adx_invitation',
    entitySet: 'adx_invitations',
    idColumn: 'adx_invitationid',
    nameColumn: 'adx_name',
    userConfigured: true,
    fields: {
      adx_name: text,
      adx_invitationcode: text,
      adx_type: int,
      adx_invitecontact: { dataverseType: 'lookup', targets: ['contact'] },
      statecode: int,
      statuscode: int,
    },
    relationships: {},
  };
  state.tables.adx_invitation = [];
  state.tables.contact = [
    { contactid: CONTACT, fullname: 'Invented Invitee', emailaddress1: 'invitee@example.test', statecode: 0 },
  ];
  return state;
}

async function fixture(t, extra = {}) {
  const store = await new DataStore({ state: schema() }).init();
  const { request } = await startAdminApi(t, store, {
    extensions: [...EXTENSIONS, workflowExtension({ facts: [], portalOrigin: () => ORIGIN, ...extra })],
  });
  return { store, request };
}

test('UpdateInvitationCode and Send Invitation run as built-in platform processes', async (t) => {
  const { store, request } = await fixture(t);
  const definitions = store
    .tableRows('workflow')
    .filter((row) => Number(row.type) === 1)
    .map((row) => [row.workflowid, row.name, row.mode, Boolean(row.ondemand), Boolean(row.triggeroncreate)]);
  assert.deepEqual(definitions.sort(), [
    [INVITATION_PROCESSES.sendInvitation, 'Send Invitation', 0, true, false],
    [INVITATION_PROCESSES.updateInvitationCode, 'UpdateInvitationCode', 1, false, true],
  ]);
  const created = await request(
    'POST',
    '/adx_invitations',
    {
      adx_name: 'Invented invitation',
      adx_type: 756150000,
      'adx_invitecontact@odata.bind': `/contacts(${CONTACT})`,
    },
    { prefer: 'return=representation' },
  );
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.adx_invitationid;
  const invitation = () => store.tableRows('adx_invitation').find((row) => row.adx_invitationid === id);
  const code = invitation().adx_invitationcode;
  assert.deepEqual([code.length, Buffer.from(code, 'base64').length], [172, 128], 'a 172-character code of 128 bytes');
  const provided = await request(
    'POST',
    '/adx_invitations',
    { adx_name: 'Invented code', adx_invitationcode: 'INVENTED-CODE' },
    { prefer: 'return=representation' },
  );
  assert.equal(provided.json.adx_invitationcode, 'INVENTED-CODE', 'a given code is kept');

  const caller = (await request('GET', '/WhoAmI')).json.UserId;
  const started = await request(
    'POST',
    `/workflows(${INVITATION_PROCESSES.sendInvitation})/Microsoft.Dynamics.CRM.ExecuteWorkflow`,
    {
      EntityId: id,
    },
  );
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const job = store.tableRows('asyncoperation').find((row) => row.asyncoperationid === started.json.asyncoperationid);
  const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid;
  assert.deepEqual([job.name, job.ownerid?.id, job.createdby?.id], ['Send Invitation', caller, system]);
  await settleCommittedWork(store, []);
  const done = store.tableRows('asyncoperation').find((row) => row.asyncoperationid === job.asyncoperationid);
  assert.equal(done.statuscode, 30, 'the job succeeds');
  assert.equal(invitation().statuscode, 756150000, 'the invitation is Sent');
  const emails = store.tableRows('email').filter((row) => row.regardingobjectid?.id === id);
  assert.equal(emails.length, 1);
  const [email] = emails;
  assert.match(email.subject, /^ CRM:\d{7}$/);
  assert.equal(email.subject, ' ' + email.trackingtoken);
  assert.equal(email.regardingobjectid.logical_name, 'adx_invitation');
  assert.equal(email.ownerid?.id, caller);
  const link = `${ORIGIN}/register/?returnurl=/&invitation=${encodeURIComponent(invitation().adx_invitationcode)}`;
  assert.ok(email.description.includes(`href="${link.replaceAll('&', '&amp;')}"`), email.description);
  assert.match(email.description, /You have been invited to our portal\./);
  const parties = store
    .tableRows('activityparty')
    .filter((row) => row.activityid?.id === email.activityid)
    .map((row) => [row.participationtypemask, row.partyid?.id])
    .sort();
  assert.deepEqual(parties, [
    [1, caller],
    [2, CONTACT],
  ]);
});

test('a pack handler for the Send Invitation id replaces the built-in process', async (t) => {
  const ran = [];
  const handlers = new Map([[INVITATION_PROCESSES.sendInvitation, async () => (ran.push('pack'), { message: null })]]);
  const { store, request } = await fixture(t, { handlers });
  const created = await request(
    'POST',
    '/adx_invitations',
    { adx_name: 'Invented', adx_invitationcode: 'X1' },
    {
      prefer: 'return=representation',
    },
  );
  await request('POST', `/workflows(${INVITATION_PROCESSES.sendInvitation})/Microsoft.Dynamics.CRM.ExecuteWorkflow`, {
    EntityId: created.json.adx_invitationid,
  });
  await settleCommittedWork(store, []);
  assert.deepEqual(ran, ['pack']);
  assert.equal(store.tableRows('email').length, 0);
});
