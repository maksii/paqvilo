// Auto-generated steps over the WebForms postback: Next/Previous re-render another tab without a
// save, the earlier tabs' values travel in __VIEWSTATE and the last tab's Insert saves them all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { nativeFormControlIds } from '../lib/native-postback.mjs';

test('auto-generated steps post back tab by tab and save every tab on Insert', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-steps-http-'));
  const files = {
    'website.yml': 'adx_websiteid: fixture-site\nadx_name: Invented stepped form',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<!doctype html><html><body>{% entityform name: "Stepped" %}</body></html>',
    'Stepped.basicform.yml': 'adx_entityformid: stepped\nadx_name: Stepped\nadx_entityname: sample\nadx_mode: 100000000\nadx_autogeneratesteps: true\nadx_nextbuttontext: Next tab\nadx_successmessage: Saved all tabs\nadx_hideformonsuccess: false',
  };
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  const fields = [{ name: 'title', type: 'text', label: 'Title', required: true }, { name: 'description', type: 'textarea', label: 'Description' }];
  const tab = (name, field) => ({ name, label: name, showLabel: true, columns: [{ width: '100%', sections: [{ name, label: name, rows: [[{ name: field }]] }] }] });
  const app = await createSimulator({ sourceDir: root, watch: false, initial: {
    mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid', fields: { title: { dataverseType: 'nvarchar' }, description: { dataverseType: 'memo' } } } },
    tables: { sample: [] },
    settings: { permissionMode: 'permissive' },
    simulator: { mode: 'local', pageMode: 'local', identity: { roles: [] }, live: {}, endpoints: [], componentSchemas: { stepped: { entity: 'sample', fields, layout: [tab('first', 'title'), tab('second', 'description')] } } },
  } });
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const ids = nativeFormControlIds('entityform', 'stepped');
  const viewStateOf = (html) => /name="__VIEWSTATE" id="__VIEWSTATE" value="([^"]*)"/.exec(html)[1];
  const post = (entries) => fetch(app.url + '/', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['__RequestVerificationToken', app.csrf], ...entries]) });

  const first = await (await fetch(app.url + '/')).text();
  assert.match(first, /<h2 class="tab-title">first<\/h2>/);
  assert.equal(first.includes('tab-title">second'), false);
  assert.match(first, /<input type="submit" name="[^"]*\$NextButton" value="Next tab"/);
  assert.equal(first.includes('data-pp-viewstate'), false, 'the component state lives in __VIEWSTATE, not in the DOM');
  // Next: the browser posts the submit button's own name and an empty __EVENTTARGET.
  const next = await post([['__EVENTTARGET', ''], ['__EVENTARGUMENT', ''], ['__VIEWSTATE', viewStateOf(first)], [ids.names + 'title', 'Typed on the first tab'], [ids.names + 'NextButton', 'Next tab']]);
  assert.equal(next.status, 200);
  const second = await next.text();
  assert.match(second, /<h2 class="tab-title">second<\/h2>/);
  assert.equal(second.includes('tab-title">first'), false);
  assert.match(second, /id="PreviousButton"/);
  assert.match(second, /name="[^"]*\$InsertButton"/);
  assert.deepEqual(app.store.snapshot().tables.sample, [], 'Next saves nothing');
  // Previous returns to the first tab with its value; Next again keeps it.
  const back = await (await post([['__EVENTTARGET', ''], ['__VIEWSTATE', viewStateOf(second)], [ids.names + 'description', 'Typed on the second tab'], [ids.names + 'PreviousButton', 'Previous']])).text();
  assert.match(back, /<h2 class="tab-title">first<\/h2>/);
  assert.match(back, /value="Typed on the first tab"/);
  const again = await (await post([['__EVENTTARGET', ''], ['__VIEWSTATE', viewStateOf(back)], [ids.names + 'title', 'Edited on the first tab'], [ids.names + 'NextButton', 'Next tab']])).text();
  assert.match(again, /Typed on the second tab/);
  // Insert on the last tab saves both tabs' values.
  const saved = await post([['__EVENTTARGET', ids.buttons + 'InsertButton'], ['__VIEWSTATE', viewStateOf(again)], [ids.names + 'description', 'Final description']]);
  assert.equal(saved.status, 200);
  assert.match(await saved.text(), /Saved all tabs/);
  assert.deepEqual(app.store.snapshot().tables.sample.map(row => [row.title, row.description]), [['Edited on the first tab', 'Final description']]);
  // A forged view state of another form carries nothing.
  const forged = '/wE' + Buffer.from(JSON.stringify({ v: 1, form: 'other', autoStep: 1, values: { title: 'Forged' } })).toString('base64');
  const fresh = await (await post([['__EVENTTARGET', ''], ['__VIEWSTATE', forged], [ids.names + 'title', 'Own'], [ids.names + 'NextButton', 'Next tab']])).text();
  assert.match(fresh, /<h2 class="tab-title">second<\/h2>/);
  const insert = await post([['__EVENTTARGET', ids.buttons + 'InsertButton'], ['__VIEWSTATE', viewStateOf(fresh)], [ids.names + 'description', 'D']]);
  assert.equal(insert.status, 200);
  assert.equal(app.store.snapshot().tables.sample.at(-1).title, 'Own');
  // The page's __VIEWSTATE carries the anti-forgery key: a postback without a body token is
  // accepted with it (live postbacks post no __RequestVerificationToken) and refused without.
  const bare = (entries) => fetch(app.url + '/', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(entries) });
  const keyed = await bare([['__EVENTTARGET', ''], ['__VIEWSTATE', viewStateOf(first)], [ids.names + 'title', 'Keyed'], [ids.names + 'NextButton', 'Next tab']]);
  assert.equal(keyed.status, 200);
  assert.match(await keyed.text(), /<h2 class="tab-title">second<\/h2>/);
  const unkeyed = await bare([['__EVENTTARGET', ''], ['__VIEWSTATE', forged], [ids.names + 'title', 'Unkeyed'], [ids.names + 'NextButton', 'Next tab']]);
  assert.equal(unkeyed.status, 403);
});
