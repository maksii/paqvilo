// Ruling 6 (RC4a): the /_sim permission view counts the records the session's visitor reads. On an enhanced-authorization
// site that is the visitor's mapped Dataverse user; before a portal request has mapped the visitor, /_sim evaluates the
// mapping it would get and writes nothing (it never provisions). Invented site, tables and data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';

const MEMBER = '77777777-7777-4777-8777-777777777701';
test('enhanced site: /_sim counts the signed-in visitor through its mapping, before and after a portal request, without provisioning', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-visible-counts-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), 'adx_websiteid: 77777777-7777-4777-8777-777777777777\nadx_name: Invented\nadx_enhancedauthorization: 3');
  await fs.writeFile(path.join(dir, 'webrole.yml'), `- adx_webroleid: ${MEMBER}\n  adx_name: Member`);
  await fs.writeFile(path.join(dir, 'sitesetting.yml'), ['enabled: true', 'fields: x_name'].map((pair, index) =>
    `- adx_sitesettingid: 77777777-7777-4777-8777-77777777780${index}\n  adx_name: Webapi/x_item/${pair.split(': ')[0]}\n  adx_value: ${pair.split(': ')[1]}`).join('\n'));
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' }, x_item: { entitySet: 'x_items', idColumn: 'x_itemid', fields: { x_name: { dataverseType: 'nvarchar' } } } },
    tables: { contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }], x_item: [{ x_itemid: 'i1', x_name: 'a' }, { x_itemid: 'i2', x_name: 'b' }] },
    permissions: [{ id: 'items', name: 'Items', entity: 'x_item', roles: ['Member'], operations: ['read'], scope: 'global' }],
    simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', live: { allowWrites: false }, endpoints: [], contactRoles: [{ contactId: 'alex', roleId: MEMBER }] },
  };
  const sim = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), port: 0, watch: false, initial });
  t.after(() => sim.close());
  const alex = signInHeaders(sim, 'alex');
  const counts = async (headers) => (await (await fetch(sim.url + '/_sim/api/state', { headers })).json()).status.permissionModel.visibleCounts.x_item;
  const users = () => sim.store.tableRows('systemuser').length;
  const before = users();
  assert.equal(await counts(alex), 2, 'the unmapped visitor is counted through the mapping it would get');
  assert.equal(users(), before, '/_sim provisions no mapped user');
  assert.equal((await fetch(sim.url + '/_api/x_items?$select=x_name', { headers: alex })).status, 200);
  assert.ok(users() > before, 'a portal request maps the visitor');
  assert.equal(await counts(alex), 2, 'the mapped visitor reads the same rows');
  assert.equal(await counts({}), 0, 'an anonymous session holds no grant');
});
