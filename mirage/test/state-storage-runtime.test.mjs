import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSimulator } from '../server.mjs';
import { readStateFile } from '../lib/state-storage.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

test('HTTP writes journal, report save timing, share queued sessions and reopen after restart', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'mirage-journal-http-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(join(root, 'website.yml'), 'adx_websiteid: site\nadx_name: Synthetic storage\n');
  await fs.writeFile(join(root, 'sitesetting.yml'), '- adx_name: Webapi/item/enabled\n  adx_value: true\n- adx_name: Webapi/item/fields\n  adx_value: name\n');
  const file = join(root, 'state.json'), options = { sourceDir: root, stateFile: file, persistence: { journalThresholdBytes: 0 }, watch: false };
  let app = await createSimulator({ ...options, initial: { settings: { permissionMode: 'permissive' }, mappings: { item: { idColumn: 'itemid', entitySet: 'items', fields: { name: { type: 'string' } } } }, tables: { item: [{ itemid: id(1), name: 'before' }, { itemid: id(2), name: 'before' }] } } });
  ownedFixture(t).add(() => app.close());
  const csrf = (await (await fetch(app.url + '/__sim/api/state?summary=1')).json()).csrf;
  const patch = async (record, name) => {
    const response = await fetch(`${app.url}/_api/items(${id(record)})`, { method: 'PATCH', headers: { __RequestVerificationToken: csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    assert.equal(response.status, 204, await response.text());
  };
  await Promise.all([patch(1, 'session-one'), patch(2, 'session-two')]);
  const audit = await (await fetch(app.url + '/__sim/api/audit?method=PATCH')).json();
  assert.equal(audit.items.length, 2);
  for (const entry of audit.items) { assert.equal(typeof entry.saveMs, 'number'); assert.ok(entry.saveMs >= 0); assert.equal(entry.saveMode, 'journal'); }
  assert.equal((await readStateFile(file)).tables.item[1].name, 'session-two');
  await app.close(); app = await createSimulator(options);
  assert.equal(app.store.state.tables.item[0].name, 'session-one');
  assert.equal(app.store.state.tables.item[1].name, 'session-two');
});
