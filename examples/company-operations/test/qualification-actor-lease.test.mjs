import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planQualificationActorWrite, restoreQualificationActorWrite } from '../portal-security/qualification-actor-lease.mjs';

test('Self scalar lease targets actual actor, restores conditional versions, and rejects foreign identity drift', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'self-contact-lease-')), journalFile = path.join(folder, 'journal.json');
  const actor = '00000000-0000-0000-0000-000000000001', operation = '00000000-0000-0000-0000-000000000002';
  let row = { contactid: actor, firstname: 'Before', lastname: 'Unchanged', statecode: 0, statuscode: 1, '@odata.etag': 'W/"1"' };
  const writes = [], client = { get: async () => structuredClone(row), request: async (endpoint, options) => { writes.push({ endpoint, options }); row = { ...row, ...options.body }; } };
  try {
    const request = await planQualificationActorWrite(client, { actorContactId: actor, operationId: operation, journalFile });
    assert.equal(writes.length, 0); assert.equal(request.ifMatch, 'W/"1"'); assert.equal(request.target.id, actor);
    row.firstname = request.body.firstname; row['@odata.etag'] = 'W/"2"';
    assert.equal((await restoreQualificationActorWrite(client, { journalFile })).verified, true);
    assert.equal(row.firstname, 'Before'); assert.equal(writes[0].options.ifMatch, 'W/"2"');
    row.lastname = 'Foreign edit';
    await assert.rejects(restoreQualificationActorWrite(client, { journalFile }), /identity drift/); assert.equal(writes.length, 1);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
