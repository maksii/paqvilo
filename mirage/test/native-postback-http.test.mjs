import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { nativeFormControlIds } from '../lib/native-postback.mjs';

async function fixture(t, { transport = 'postback', redirect = false, readOnly = false, wizard = false, lookup = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-postback-http-'));
  const files = {
    'website.yml': 'adx_websiteid: fixture-site\nadx_name: Invented native transport',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<!doctype html><html><body><form id="liquid_form">{% entityform name: "First" %}{% entityform name: "Second" %}</form></body></html>',
    'First.basicform.yml': `adx_entityformid: first\nadx_name: First\nadx_mode: ${readOnly ? 100000002 : 100000001}\nadx_recordidquerystringparametername: firstrow`,
    'Second.basicform.yml': `adx_entityformid: second\nadx_name: Second\nadx_mode: 100000001\nadx_recordidquerystringparametername: secondrow\nadx_successmessage: Saved source message\nadx_hideformonsuccess: false${redirect ? '\nadx_onsuccess: 756150001\nadx_redirecturl: /done/?source=owned\nadx_redirecturlappendentityidquerystring: true\nadx_redirecturlquerystringname: row' : ''}`,
  };
  if (wizard) {
    files['Main.webtemplate.source.html'] = '<!doctype html><html><body><form id="liquid_form">{% webform name: "Wizard" %}</form></body></html>';
    files['Wizard.advancedform.yml'] = 'adx_webformid: wizard\nadx_name: Wizard';
  }
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  const fields = [{ name: 'title', type: 'text', label: 'Title', required: true }, { name: 'description', type: 'textarea' }, { name: 'count', dataverseType: 'int', minimum: 0, maximum: 10 }];
  if (lookup) fields.push({ name: 'customerid', type: 'lookup' });
  const app = await createSimulator({ sourceDir: root, watch: false, initial: {
    mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid', fields: { title: { dataverseType: 'nvarchar' }, description: { dataverseType: 'memo' }, count: { dataverseType: 'int', minValue: 0, maxValue: 10 } }, ...(lookup ? { relationships: { customer_account: { entity: 'account', from: 'customerid', to: 'accountid', many: false }, customer_contact: { entity: 'contact', from: 'customerid', to: 'contactid', many: false } } } : {}) }, account: { entitySet: 'accounts', idColumn: 'accountid' }, contact: { entitySet: 'contacts', idColumn: 'contactid' } },
    tables: { sample: [{ sampleid: 'first-row', title: 'First' }, { sampleid: 'second-row', title: 'Second' }], account: [{ accountid: 'owned-account' }], contact: [{ contactid: 'owned-contact' }] },
    settings: { permissionMode: 'permissive' },
    simulator: { mode: 'local', pageMode: 'local', identity: { roles: [] }, live: {}, endpoints: [], observed: { nativeFormTransport: transport, evidence: 'Invented loopback transport contract' }, componentSchemas: { first: { entity: 'sample', fields }, second: { entity: 'sample', fields }, wizard: { initialStepId: 'create', steps: [{ stepId: 'create', nextStepId: 'edit', entity: 'sample', mode: 100000000, fields: [{ name: 'title', required: true }] }, { stepId: 'edit', entity: 'sample', mode: 100000001, fields: [{ name: 'title', required: true }] }] } } },
  } });
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const route = '/?firstrow=first-row&secondrow=second-row';
  const controls = nativeFormControlIds('entityform', 'second');
  const post = (values = {}, extra = [], target = controls.buttons + 'UpdateButton') => fetch(app.url + route, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['__EVENTTARGET', target], ['__EVENTARGUMENT', ''], ['__RequestVerificationToken', app.state().csrf], ...Object.entries(values).map(([key, value]) => [controls.names + key, value]), ...extra]) });
  return { app, post, route, controls };
}

test('URLencoded postback saves only the exact selected form and returns source-configured inline HTML', async t => {
  const { app, post } = await fixture(t);
  const first = nativeFormControlIds('entityform', 'first');
  const response = await post({ title: '<b>Owned</b>', description: 'A\r\nB', count: '3' }, [[first.names + 'title', 'Forged first'], ['recordId', 'first-row']]);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  assert.match(html, /id="MessageLabel">Saved source message/);
  assert.match(html, /value="&lt;b&gt;Owned&lt;\/b&gt;"/);
  assert.deepEqual(app.store.snapshot().tables.sample.map(row => [row.sampleid, row.title]), [['first-row', 'First'], ['second-row', '<b>Owned</b>']]);
  assert.equal(app.store.snapshot().tables.sample[1].description, 'A\nB');
  assert.equal(app.store.snapshot().tables.sample[1].count, 3);
});

test('source redirect retains the exact service target and appended record key', async t => {
  const { post } = await fixture(t, { redirect: true });
  const response = await post({ title: 'Redirected' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/done/?source=owned&row=second-row');
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
});

test('lookup postbacks use only the declared target, preserve omission and clear an explicit empty control', async t => {
  const { app, post, controls } = await fixture(t, { lookup: true });
  const row = () => app.store.snapshot().tables.sample.find(item => item.sampleid === 'second-row');
  assert.equal((await post({ title: 'Account linked', customerid: 'owned-account' }, [[controls.names + 'customerid_entityname', 'account']])).status, 200);
  assert.equal(row().customerid.id, 'owned-account');
  assert.equal(row().customerid.logical_name, 'account');
  assert.equal((await post({ title: 'Lookup omitted' })).status, 200);
  assert.equal(row().customerid.id, 'owned-account');
  assert.equal((await post({ title: 'Contact linked', customerid: 'owned-contact' }, [[controls.names + 'customerid_entityname', 'contact']])).status, 200);
  assert.equal(row().customerid.logical_name, 'contact');
  assert.equal((await post({ title: 'Lookup cleared', customerid: '' })).status, 200);
  assert.equal(row().customerid, null);
});

test('unknown, ambiguous and repeated lookup targets cannot mutate the selected row', async t => {
  const { app, post, controls } = await fixture(t, { lookup: true });
  const before = app.store.snapshot().tables.sample;
  for (const targets of [[], ['unknown'], ['account', 'contact']]) {
    const response = await post({ title: 'Must not save', customerid: 'owned-account' }, targets.map(value => [controls.names + 'customerid_entityname', value]));
    assert.equal(response.status, 400);
    assert.deepEqual(app.store.snapshot().tables.sample, before);
  }
});

test('native field validation renders HTML200 with posted escaped values and no saved change', async t => {
  const { app, post } = await fixture(t);
  const response = await post({ title: '', description: '<script>unexecuted</script>', count: 'bad' });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Title is a required field/);
  assert.match(html, /must be a valid integer/);
  assert.match(html, /id="count"[^>]*value="bad"/);
  assert.match(html, /&lt;script&gt;unexecuted&lt;\/script&gt;/);
  assert.equal(app.store.snapshot().tables.sample[1].title, 'Second');
});

test('advanced URLencoded submission follows its own visitor session and previous-step action', async t => {
  const { app } = await fixture(t, { wizard: true });
  const ids = nativeFormControlIds('webform', 'wizard');
  const response = await fetch(app.url + '/', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['__EVENTTARGET', ids.buttons + 'NextButton'], ['__RequestVerificationToken', app.state().csrf], [ids.names + 'title', 'Visitor created'], ['stepId', 'forged'], ['sessionid', 'forged']]) });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /stepid=edit/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const next = await fetch(app.url + response.headers.get('location'), { headers: { cookie } });
  const html = await next.text();
  assert.match(html, /value="Visitor created"/);
  const previous = await fetch(app.url + response.headers.get('location'), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams([['__EVENTTARGET', ids.buttons + 'PreviousButton'], ['__RequestVerificationToken', app.state().csrf], [ids.names + 'title', 'Ignored previous']]) });
  assert.equal(previous.status, 302);
  assert.match(previous.headers.get('location'), /stepid=create/);
  assert.equal(app.store.snapshot().tables.sample.filter(row => row.title === 'Visitor created').length, 1);
  assert.equal(app.store.snapshot().tables.sample.some(row => row.title === 'Ignored previous'), false);
});

test('CSRF, duplicate scalar, unknown targets and read-only controls retain failure status and never save', async t => {
  const { app, post, controls } = await fixture(t, { readOnly: true });
  const noToken = await fetch(app.url + '/?secondrow=second-row', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '__EVENTTARGET=forged' });
  assert.equal(noToken.status, 403);
  assert.equal((await post({ title: 'Unknown' }, [], 'unknown')).status, 400);
  assert.equal((await post({ title: 'Duplicated' }, [[controls.names + 'title', 'second']])).status, 400);
  assert.equal((await post({}, [], nativeFormControlIds('entityform', 'first').buttons + 'UpdateButton')).status, 400);
  assert.deepEqual(app.store.snapshot().tables.sample.map(row => row.title), ['First', 'Second']);
});

test('default JSON route and JSON profile remain unchanged', async t => {
  const { app, post, route } = await fixture(t, { transport: 'json' });
  assert.equal((await post({ title: 'Unaccepted transport' })).status, 405);
  const response = await fetch(app.url + '/__sim/forms/entityform/second/submit', { method: 'POST', headers: { 'content-type': 'application/json', __RequestVerificationToken: app.state().csrf }, body: JSON.stringify({ recordId: 'second-row', values: { title: 'JSON saved' }, pageUrl: route }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).outcome.message, 'Saved source message');
});
