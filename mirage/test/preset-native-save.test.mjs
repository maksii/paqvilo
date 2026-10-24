import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { nativeFormControlIds } from '../lib/native-postback.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const STAFF = '77777777-7777-4777-8777-777777777795';
const CURRENCY = '77777777-7777-4777-8777-777777777796';
const STEP = '77777777-7777-4777-8777-777777777797';
const ITEM = '77777777-7777-4777-8777-777777777798';
const BASE = '77777777-7777-4777-8777-777777777799';
const TYPE = '77777777-7777-4777-8777-777777777790';

async function fixture(t, create = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-native-save-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'portal'), solution = path.join(root, 'solution');
  const files = {
    'portal/website.yml': 'adx_websiteid: invented-site\nadx_name: Invented secured native save',
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': '{% entityform name: "Sample" %}',
    'portal/Sample.basicform.yml': `adx_entityformid: sample\nadx_name: Sample\nadx_mode: ${create ? 100000000 : 100000001}\nadx_recordidquerystringparametername: id\nadx_successmessage: Saved authored message\nadx_hideformonsuccess: false${create ? '\nadx_onsuccess: 756150001\nadx_redirecturl: /done/\nadx_redirecturlappendentityidquerystring: true\nadx_redirecturlquerystringname: row' : ''}`,
    'solution/PluginAssemblies/Rules.dll.data.xml': `<PluginAssembly PluginAssemblyId="77777777-7777-4777-8777-777777777789" FullName="Invented, Version=1.0.0.0"><PluginTypes><PluginType PluginTypeId="${TYPE}" Name="Invented.Rules"/></PluginTypes></PluginAssembly>`,
    'solution/SdkMessageProcessingSteps/modify.xml': `<SdkMessageProcessingStep SdkMessageProcessingStepId="{${STEP}}" Name="Invented mutation"><SdkMessageName>Update</SdkMessageName><PluginTypeId>${TYPE}</PluginTypeId><PluginTypeName>Invented.Rules</PluginTypeName><PrimaryEntity>exa_sample</PrimaryEntity><Stage>20</Stage><Mode>0</Mode><Rank>10</Rank><SupportedDeployment>0</SupportedDeployment></SdkMessageProcessingStep>`,
  };
  for (const [name, body] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), body); }
  const data = {
    mappings: { exa_sample: { entitySet: 'exa_samples', idColumn: 'exa_sampleid', nameColumn: 'exa_title',
      fields: { exa_title: { dataverseType: 'nvarchar' }, exa_secret: { dataverseType: 'memo', isSecured: true }, exa_price: { dataverseType: 'money', precision: 2 }, transactioncurrencyid: { dataverseType: 'lookup' } },
      relationships: { TransactionCurrencyId: { entity: 'transactioncurrency', from: 'transactioncurrencyid', to: 'transactioncurrencyid', many: false } } } },
    tables: { exa_sample: [{ exa_sampleid: ITEM, exa_title: 'Original', exa_secret: 'Initial secret', exa_price: 100, transactioncurrencyid: CURRENCY }],
      systemuser: [{ systemuserid: STAFF, fullname: 'Ordinary fixture staff', isdisabled: false }],
      transactioncurrency: [{ transactioncurrencyid: BASE, isocurrencycode: 'XBS', currencyname: 'Invented base', exchangerate: 1, currencyprecision: 2 }, { transactioncurrencyid: CURRENCY, isocurrencycode: 'XTS', currencyname: 'Invented currency', exchangerate: 1.25, currencyprecision: 2 }] },
    settings: { permissionMode: 'permissive' },
  };
  const pack = { id: 'invented-preset', name: 'Invented preset', description: 'Native secured-field and currency regression', matches: () => true,
    presets: () => ({ replacement: { name: 'Replace staff', ...structuredClone(data) } }),
    pluginSteps: { [STEP]: ({ target }) => target.exa_secret === 'mutate-me' ? { target: { exa_secret: 'mutated by plugin' } } : {} },
  };
  const fields = [{ name: 'exa_title', type: 'text', required: true }, { name: 'exa_secret', type: 'textarea' }, { name: 'exa_price', dataverseType: 'money' }, { name: 'transactioncurrencyid', type: 'lookup', targets: ['transactioncurrency'] }];
  const sim = await createSimulator({ sourceDir: source, stateFile: path.join(root, 'state.json'), solutionRoots: [solution], watch: false, port: 0, packs: [pack],
    initial: { simulator: { mode: 'local', pageMode: 'local', live: {}, componentSchemas: { sample: { entity: 'exa_sample', fields } } } } });
  ownedFixture(t).add(() => sim.close());
  await sim.applyPreset('replacement');
  const controls = nativeFormControlIds('entityform', 'sample'), route = '/?id=' + ITEM;
  const post = () => fetch(sim.url + route, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([
    ['__EVENTTARGET', controls.buttons + (create ? 'InsertButton' : 'UpdateButton')], ['__EVENTARGUMENT', ''], ['__RequestVerificationToken', sim.csrf],
    [controls.names + 'exa_title', 'Saved sample'], [controls.names + 'exa_secret', 'mutate-me'], [controls.names + 'exa_price', '100'],
    [controls.names + 'transactioncurrencyid', CURRENCY], [controls.names + 'transactioncurrencyid_entityname', 'transactioncurrency'],
  ]) });
  return { sim, post, route };
}

test('native secured-field and PascalCase currency save survives a staff-replacing preset and persists plugin changes', async t => {
  const { sim, post, route } = await fixture(t);
  const response = await post(), html = await response.text();
  const diagnostics = (await (await fetch(sim.url + '/_sim/api/diagnostics')).json()).diagnostics;
  assert.equal(response.status, 200, JSON.stringify(diagnostics.filter(entry => entry.path === '/').map(({ code, message }) => ({ code, message }))));
  assert.ok(html.includes('Saved authored message'), JSON.stringify(diagnostics.filter(entry => entry.path === '/').map(({ code, message }) => ({ code, message }))));
  const row = sim.store.tableRows('exa_sample').find(row => row.exa_sampleid === ITEM);
  assert.equal(row.exa_secret, 'mutated by plugin');
  assert.equal(row.exa_price_base, 80);
  assert.equal(row.transactioncurrencyid, CURRENCY);
  assert.ok((await (await fetch(sim.url + route)).text()).includes('mutated by plugin'));
  // The preserved internal principal grants no field-security privilege to ordinary staff.
  const staff = sim.store.tableRows('systemuser').find(row => row.systemuserid === STAFF);
  await assert.rejects(sim.store.transact(() => sim.store.recordPipeline.updateInternal({ user: staff, identity: { admin: true } }, 'exa_sample', ITEM, { exa_secret: 'forbidden' }, { authorized: true })), { code: 'AccessDenied', status: 403 });
  assert.equal(sim.store.tableRows('exa_sample').find(row => row.exa_sampleid === ITEM).exa_secret, 'mutated by plugin');
});

test('native insert confirms the saved secured row before following its source-configured redirect', async t => {
  const { sim, post } = await fixture(t, true);
  const before = new Set(sim.store.tableRows('exa_sample').map(row => row.exa_sampleid));
  const response = await post();
  const diagnostics = (await (await fetch(sim.url + '/_sim/api/diagnostics')).json()).diagnostics;
  assert.equal(response.status, 302, JSON.stringify(diagnostics.filter(entry => entry.path === '/').map(({ code, message }) => ({ code, message }))));
  const row = sim.store.tableRows('exa_sample').find(row => !before.has(row.exa_sampleid));
  assert.ok(row, 'an inline HTTP200 error is not a successful insert');
  assert.equal(row.exa_secret, 'mutate-me');
  assert.equal(row.exa_price_base, 80);
  assert.equal(response.headers.get('location'), '/done/?row=' + row.exa_sampleid);
});
