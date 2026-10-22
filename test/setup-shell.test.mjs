import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// D22: /_setup/ and /_sim/ are two areas of one product with one shell, one stylesheet set and the same components.
const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const pages = { setup: ['lense/setup/index.html', '/_setup/'], sim: ['mirage/admin/index.html', '/__sim/'] };

test('both pages link ui-kit.css, shell.css and dashboard.css in that order before their page sheet', async () => {
  for (const [name, [file, prefix]] of Object.entries(pages)) {
    const sheets = [...(await read(file)).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(match => match[1].replace(prefix, ''));
    assert.deepEqual(sheets.slice(0, 4), ['ui-kit.css', 'shell.css', 'dashboard.css', 'style.css'], name);
  }
});

test('both pages use the shared shell markup and the AREAS switch', async () => {
  for (const [name, [file]] of Object.entries(pages)) {
    const html = await read(file);
    for (const pattern of [/<aside class="sidebar"/, /<header class="topbar"/, /class="sidebar-bottom"/, /<footer>/, /class="skip-link"/, /class="brand-symbol"/, />AREAS</,
      />Project setup<\/a>/, />Simulator workspace</, /aria-current="page"/]) assert.match(html, pattern, `${name}: ${pattern}`);
    assert.match(html, /<span class="brand-symbol"[^>]*>P<\/span\s*><span>(?:<span id="workspace-name">)?Paqvilo/, `${name}: Paqvilo wordmark`);
  }
  assert.match(await read(pages.setup[0]), /<small>PROJECT SETUP<\/small>/);
  assert.match(await read(pages.sim[0]), /<small id="workspace-kind">SIMULATOR WORKSPACE<\/small>/);
});

test('page sheets define no tokens, fonts or base shell rules of their own', async () => {
  const setup = await read('lense/setup/style.css');
  for (const banned of [':root', 'font-family', 'aside{', 'aside {', 'header{', 'header {', 'button{', 'button {', '.card{', '.card {', '.badge{', '.badge {']) assert.ok(!setup.includes(banned), `lense/setup/style.css has ${banned}`);
  assert.ok(!(await read('mirage/admin/style.css')).includes(':root'), 'mirage/admin/style.css has :root');
  const shell = await read('mirage/admin/shell.css');
  for (const selector of [':root', '.sidebar', '.topbar', '.button,\n.ui-button', '.badge,\n.ui-badge', '.notice,\n.ui-notice', '.table-wrap,\n.ui-table-wrap']) assert.ok(shell.includes(selector), `shell.css lacks ${selector}`);
  const kit = await read('mirage/admin/ui-kit.css');
  for (const duplicate of [/^\.ui-button \{/m, /^\.ui-badge \{/m, /^\.ui-notice \{/m, /^\.ui-table th/m]) assert.doesNotMatch(kit, duplicate);
});
