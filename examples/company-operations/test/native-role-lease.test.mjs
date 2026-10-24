import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beginRoleLease, setLeasedRoles, recoverRoleLease } from '../portal-harness/native-role-lease.mjs';
test('native role lease restores after unknown commit and preserves unrelated memberships', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'paqvilo-role-')),
    file = path.join(dir, 'lease.json'),
    roles = new Set(['one', 'foreign']);
  let stop = false;
  const client = {
    url: (query) => 'https://example.invalid/' + query,
    list: async (query) =>
      query.startsWith('powerpagecomponents?')
        ? ['one', 'two'].map((id) => ({ powerpagecomponentid: id, powerpagecomponenttype: 11, statecode: 0 }))
        : Array.from(roles, (id) => ({ powerpagecomponentid: id })),
    request: async (query, { method, body }) => {
      const id =
        method === 'DELETE'
          ? /contact\((.*?)\)/.exec(query)[1]
          : /powerpagecomponents\((.*?)\)/.exec(body['@odata.id'])[1];
      method === 'DELETE' ? roles.delete(id) : roles.add(id);
      if (stop) {
        stop = false;
        throw new Error('after commit');
      }
    },
  };
  try {
    await beginRoleLease(client, { siteId: 'site', contactId: 'actor', roleIds: ['one', 'two'], journalFile: file });
    await setLeasedRoles(client, file, ['one', 'two']);
    assert.deepEqual([...roles].sort(), ['foreign', 'one', 'two']);
    stop = true;
    await assert.rejects(setLeasedRoles(client, file, []), /after commit/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).entries.at(-1).status, 'pending');
    await recoverRoleLease(client, file);
    assert.deepEqual([...roles].sort(), ['foreign', 'one']);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).state, 'restored');
    roles.add('unexpected');
    await assert.rejects(setLeasedRoles(client, file, []), /outside the role lease/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
