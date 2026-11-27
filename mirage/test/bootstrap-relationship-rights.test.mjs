// @test-kind contract: export bootstrap keeps each explicit Append/Append To flag and grants no false or absent right
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState } from '../lib/bootstrap.mjs';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
const G = (n) => '77777777-7777-4777-8777-' + String(n).padStart(12, '0');
// native: the flags a lookup bind needs (Append To on the bound table, Append on the related table) on their tables
function portal(append, appendTo, { native = false } = {}) {
  const grant = (entity, flags) => ({
    kind: 'tablepermission',
    id: entity,
    adx_entitylogicalname: entity,
    adx_entityname: entity,
    adx_scope: 756150000,
    adx_entitypermission_webrole: [G(1)],
    adx_read: true,
    ...flags,
  });
  return {
    records: [
      { kind: 'webrole', id: G(1), name: 'Member' },
      grant('widget', { [native ? 'adx_appendto' : 'adx_append']: native ? appendTo : append, adx_create: true }),
      grant('label', { [native ? 'adx_append' : 'adx_appendto']: native ? append : appendTo }),
    ],
    templates: {},
    forms: [],
    lists: [],
    settings: {
      'Webapi/widget/enabled': 'true',
      'Webapi/widget/fields': 'widgetid,labelid',
      'Webapi/label/enabled': 'true',
      'Webapi/label/fields': 'labelid',
    },
  };
}
test('bootstrap preserves explicit relationship rights without granting false or absent rights', () => {
  for (const value of [true, 1, false, 0, undefined]) {
    const state = initialState(portal(value, value));
    assert.equal(state.permissions[0].operations.includes('append'), value === true || value === 1);
    assert.equal(state.permissions[1].operations.includes('appendTo'), value === true || value === 1);
    assert.equal(state.permissions[0].operations.includes('appendTo'), false);
    assert.equal(state.permissions[1].operations.includes('append'), false);
  }
});
// @test-kind observation: native captures 2026-11-23 through a site's /_api (paqvilo-developer feedback-251-252-parity q5/q6): a create with a lookup bind needs Append To on the table holding the lookup and Append on the related table; either missing is 403 90040106 and nothing is created
test('bootstrapped grants authorize real HTTP lookup creation and preserve each denial boundary', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-bootstrap-rights-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), 'adx_name: Invented\nadx_websiteid: invented\n');
  await fs.writeFile(
    path.join(dir, 'sitesetting.yml'),
    Object.entries(portal().settings)
      .map(([name, value]) => '- adx_name: ' + name + '\n  adx_value: "' + value + '"')
      .join('\n'),
  );
  for (const [append, appendTo, expected] of [
    [true, true, 204],
    [false, true, 403],
    [true, false, 403],
    [false, false, 403],
  ]) {
    await fs.writeFile(path.join(dir, 'webrole.yml'), JSON.stringify([{ adx_webroleid: G(1), adx_name: 'Member' }]));
    await fs.writeFile(
      path.join(dir, 'tablepermission.yml'),
      JSON.stringify(
        portal(append, appendTo, { native: true })
          .records.filter((r) => r.kind === 'tablepermission')
          .map((r) => ({ ...r, adx_entitypermissionid: r.id })),
      ),
    );
    const initial = initialState(portal(append, appendTo, { native: true }));
    initial.mappings.widget = {
      entitySet: 'widgets',
      idColumn: 'widgetid',
      relationships: { labelid: { entity: 'label', from: 'labelid', to: 'labelid', many: false } },
    };
    initial.mappings.label = { entitySet: 'labels', idColumn: 'labelid' };
    initial.tables.widget = [];
    initial.tables.label = [{ labelid: G(3) }];
    initial.mappings.contact = { entitySet: 'contacts', idColumn: 'contactid' };
    initial.tables.contact = [{ contactid: G(4), fullname: 'Invented member', statecode: 0 }];
    initial.settings.associationPermissions = 'enforce';
    initial.simulator.identityScope = 'configured';
    initial.simulator.identity = { contactId: G(4), roles: ['Member'] };
    const sim = await createSimulator({ sourceDir: dir, initial, watch: false, port: 0 });
    try {
      const cookie = sim.signIn(G(4), { roles: ['Member'] }).cookieHeader;
      const response = await fetch(sim.url + '/_api/widgets', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', __RequestVerificationToken: sim.csrf },
        body: JSON.stringify({ widgetid: G(2), 'labelid@odata.bind': '/labels(' + G(3) + ')' }),
      });
      assert.equal(response.status, expected, await response.text());
      assert.equal(sim.store.state.tables.widget.length, expected === 204 ? 1 : 0);
      if (expected === 204) {
        const row = sim.store.state.tables.widget[0];
        assert.equal(row.widgetid, G(2));
        assert.equal(row.labelid?.id ?? row.labelid, G(3));
      }
    } finally {
      await sim.close();
    }
  }
});
