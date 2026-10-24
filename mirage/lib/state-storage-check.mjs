// Deliberately separate from the seconds-long unit suite. This exercises a
// real >512 MiB self-contained state file and requires about 2 GiB free RAM.
// node --expose-gc --max-old-space-size=4096 mirage/test-volume/state-storage.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { constants } from 'node:buffer';
import { DataStore } from './data.mjs';
import { hashStateFile } from './state-stream.mjs';

export async function verifyStateStorage() {
  const root = await fs.mkdtemp(join(tmpdir(), 'mirage-volume-'));
  let stateHandle;
  try {
    const rows = 600000,
      payload = 'x'.repeat(1024),
      file = join(root, 'state.json');
    let store = new DataStore({
      file,
      state: {
        settings: { permissionMode: 'permissive' },
        mappings: { item: { idColumn: 'itemid', entitySet: 'items' } },
        tables: {
          item: Array.from({ length: rows }, (_, i) => ({
            itemid: `row-${i}`,
            parentid: `row-${Math.floor(i / 40)}`,
            payload,
          })),
        },
      },
    });
    const started = performance.now();
    await store.init();
    // Keep the same descriptor through the checks and deliberate external edit.
    stateHandle = await fs.open(file, 'a+');
    const bytes = (await stateHandle.stat()).size;
    assert.ok(bytes > constants.MAX_STRING_LENGTH, `${bytes} must exceed the engine string limit`);
    assert.equal(await hashStateFile(file), store.persistedDigest);
    const savedDigest = store.persistedDigest,
      savedMs = performance.now() - started;
    store = null;
    global.gc?.();
    const loading = performance.now();
    store = await new DataStore({ file }).init();
    assert.equal(store.persistedDigest, savedDigest);
    assert.equal(store.state.tables.item.length, rows);
    for (let i = 0; i < rows; i++) {
      const row = store.state.tables.item[i];
      assert.equal(row.itemid, `row-${i}`);
      assert.equal(row.payload, payload);
      assert.equal(row.parentid, `row-${Math.floor(i / 40)}`);
    }
    const loadMs = performance.now() - loading;
    const patching = performance.now();
    for (let i = 0; i < 20; i++) await store.update('items', `row-${rows - 1 - i}`, { name: `patch-${i}` });
    const patchMs = performance.now() - patching;
    assert.ok(patchMs < 5000, `20 PATCHes took ${patchMs.toFixed(0)}ms`);
    const digest = store.persistedDigest;
    store = null;
    global.gc?.();
    store = await new DataStore({ file }).init();
    assert.equal(store.persistedDigest, digest);
    for (let i = 0; i < 20; i++) assert.equal(store.state.tables.item[rows - 1 - i].name, `patch-${i}`);
    await stateHandle.appendFile(' ');
    await stateHandle.close();
    stateHandle = null;
    await assert.rejects(store.update('items', 'row-0', { name: 'conflict' }), { code: 'StateConflict' });
    assert.equal(store.state.tables.item[0].name, undefined);
    store = null;
    global.gc?.();
    const { createSimulator } = await import('../server.mjs');
    const sourceDir = join(root, 'portal');
    await fs.mkdir(sourceDir);
    await fs.writeFile(join(sourceDir, 'website.yml'), 'adx_websiteid: site\nadx_name: Synthetic volume\n');
    await fs.writeFile(
      join(sourceDir, 'sitesetting.yml'),
      '- adx_name: Webapi/item/enabled\n  adx_value: true\n- adx_name: Webapi/item/fields\n  adx_value: name\n',
    );
    const guid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    const solution = join(root, 'solution');
    await fs.mkdir(join(solution, 'Other'), { recursive: true });
    await fs.mkdir(join(solution, 'PluginAssemblies'), { recursive: true });
    await fs.mkdir(join(solution, 'SdkMessageProcessingSteps'), { recursive: true });
    await fs.writeFile(
      join(solution, 'Other', 'Solution.xml'),
      '<ImportExportXml><SolutionManifest><UniqueName>InventedStorage</UniqueName></SolutionManifest></ImportExportXml>',
    );
    await fs.writeFile(
      join(solution, 'PluginAssemblies', 'storage.xml'),
      `<PluginAssembly PluginAssemblyId="${guid(2)}"><Name>Invented.Storage</Name><PluginTypes><PluginType PluginTypeId="${guid(3)}"><TypeName>Invented.Storage.Update</TypeName></PluginType></PluginTypes></PluginAssembly>`,
    );
    await fs.writeFile(
      join(solution, 'SdkMessageProcessingSteps', 'update.xml'),
      `<SdkMessageProcessingStep SdkMessageProcessingStepId="${guid(1)}"><Name>Storage update placeholder</Name><PluginTypeId>${guid(3)}</PluginTypeId><SdkMessageName>Update</SdkMessageName><PrimaryEntity>item</PrimaryEntity><Stage>20</Stage><Rank>1</Rank><Mode>0</Mode><SupportedDeployment>0</SupportedDeployment><StateCode>0</StateCode></SdkMessageProcessingStep>`,
    );
    await fs.writeFile(
      join(sourceDir, 'Edit.basicform.yml'),
      'adx_entityformid: edit\nadx_name: Edit item\nadx_entityname: item\nadx_mode: 100000001\n',
    );
    let app = await createSimulator({
      sourceDir,
      solutionRoots: [solution],
      stateFile: join(root, 'http-state.json'),
      watch: false,
      initial: {
        settings: { permissionMode: 'permissive' },
        mappings: { item: { idColumn: 'itemid', entitySet: 'items', fields: { name: { type: 'string' } } } },
        simulator: { componentSchemas: { edit: { entity: 'item', fields: [{ name: 'name' }] } } },
        tables: { item: Array.from({ length: 300000 }, (_, i) => ({ itemid: guid(i), payload: 'v'.repeat(128) })) },
      },
    });
    let httpPatchMs, formSaveMs;
    try {
      const csrf = (await (await fetch(app.url + '/__sim/api/state?summary=1')).json()).csrf;
      const patch = async (n) => {
        const response = await fetch(`${app.url}/_api/items(${guid(n)})`, {
          method: 'PATCH',
          headers: { __RequestVerificationToken: csrf, 'content-type': 'application/json' },
          body: JSON.stringify({ name: `http-${n}` }),
        });
        assert.equal(response.status, 204, await response.text());
      };
      const httpStarted = performance.now();
      for (let n = 0; n < 20; n++) await patch(299999 - n);
      httpPatchMs = performance.now() - httpStarted;
      assert.ok(httpPatchMs < 5000, `20 HTTP PATCHes took ${httpPatchMs.toFixed(0)}ms`);
      await Promise.all([patch(21), patch(22)]);
      const formStarted = performance.now();
      const form = await fetch(app.url + '/__sim/forms/entityform/edit/submit', {
        method: 'POST',
        headers: { __RequestVerificationToken: csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ recordId: guid(23), values: { name: 'form-save' } }),
      });
      assert.ok(form.ok, await form.text());
      formSaveMs = performance.now() - formStarted;
      assert.ok(formSaveMs < 5000, `Form save took ${formSaveMs.toFixed(0)}ms`);
      assert.equal(app.store.lastSave.mode, 'journal');
      const audit = await (await fetch(app.url + '/__sim/api/audit?method=PATCH')).json();
      assert.ok(audit.items.every((entry) => entry.saveMode === 'journal' && entry.saveMs >= 0));
      assert.ok(
        app
          .state()
          .diagnostics.some((entry) => entry.code === 'PLUGIN_STEP_PLACEHOLDER' && entry.operation === 'update'),
      );
    } finally {
      await app.close();
      app = null;
      global.gc?.();
    }
    const persisted = await new DataStore({ file: join(root, 'http-state.json') }).init();
    for (let n = 0; n < 20; n++) assert.equal(persisted.state.tables.item[299999 - n].name, `http-${299999 - n}`);
    assert.equal(persisted.state.tables.item[21].name, 'http-21');
    assert.equal(persisted.state.tables.item[22].name, 'http-22');
    assert.equal(persisted.state.tables.item[23].name, 'form-save');
    return {
      formSaveMs: Math.round(formSaveMs),
      formJournalVerified: true,
      rows,
      bytes,
      saveMs: Math.round(savedMs),
      loadMs: Math.round(loadMs),
      twentyPatchMs: Math.round(patchMs),
      httpRows: 300000,
      twentyHttpPatchMs: Math.round(httpPatchMs),
      digestVerified: true,
      externalConflictVerified: true,
      concurrentClientsVerified: true,
      placeholderJournalVerified: true,
    };
  } finally {
    await stateHandle?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
