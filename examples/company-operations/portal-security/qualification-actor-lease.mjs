import fs from 'node:fs/promises';
import { savePrivateJson } from '../portal-harness/private-journal.mjs';

const guid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const fields = 'contactid,firstname,lastname,statecode,statuscode,_parentcustomerid_value';
const stableIdentity = (row) =>
  JSON.stringify([row.contactid, row.lastname, row.statecode, row.statuscode, row._parentcustomerid_value ?? null]);

/** Self Write uses only a safe scalar on the actual authenticated Contact.
 * Account, credentials, identity bindings and roles are separate leases. */
export async function planQualificationActorWrite(client, { actorContactId, operationId, journalFile } = {}) {
  if (![actorContactId, operationId].every((value) => guid.test(value ?? '')))
    throw new Error('Self Write requires actual actor and operation GUIDs.');
  const endpoint = `contacts(${actorContactId})`,
    before = await client.get(`${endpoint}?$select=${fields}`);
  if (before.contactid !== actorContactId || !before['@odata.etag'])
    throw new Error('Self Write actor/version readback failed.');
  const desired = 'CO-OP:' + operationId;
  const journal = {
    kind: 'native-contact-self-scalar-lease',
    actorContactId,
    operationId,
    before,
    desired,
    status: 'prepared',
  };
  await savePrivateJson(journalFile, journal, { exclusive: true });
  return {
    method: 'PATCH',
    url: '/_api/' + endpoint,
    body: { firstname: desired },
    ifMatch: before['@odata.etag'],
    target: { table: 'contact', id: actorContactId },
    expectedMessage: 'Update',
    operationId,
    actorScalarLeaseFile: journalFile,
  };
}

export async function restoreQualificationActorWrite(client, { journalFile } = {}) {
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  if (journal.kind !== 'native-contact-self-scalar-lease' || !guid.test(journal.actorContactId))
    throw new Error('Self scalar recovery journal drift.');
  const endpoint = `contacts(${journal.actorContactId})`,
    current = await client.get(`${endpoint}?$select=${fields}`);
  if (
    stableIdentity(current) !== stableIdentity(journal.before) ||
    (current.firstname !== journal.before.firstname && current.firstname !== journal.desired)
  )
    throw new Error('Foreign Contact scalar/Account/identity drift; Self Write recovery refused.');
  if (current.firstname !== journal.before.firstname) {
    if (!current['@odata.etag']) throw new Error('Self scalar recovery needs its current version.');
    journal.status = 'restore-pending';
    await savePrivateJson(journalFile, journal);
    await client.request(endpoint, {
      method: 'PATCH',
      body: { firstname: journal.before.firstname ?? null },
      ifMatch: current['@odata.etag'],
    });
  }
  const after = await client.get(`${endpoint}?$select=${fields}`);
  if (
    stableIdentity(after) !== stableIdentity(journal.before) ||
    (after.firstname ?? null) !== (journal.before.firstname ?? null)
  )
    throw new Error('Self scalar restoration readback failed.');
  journal.status = 'restored';
  journal.after = after;
  await savePrivateJson(journalFile, journal);
  return { verified: true, actorContactId: journal.actorContactId, restoredFields: ['firstname'] };
}
