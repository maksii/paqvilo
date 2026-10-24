import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// /_setup/ and /_sim/ are two areas of one product with one shell, one stylesheet set and the same components.
const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const pages = { setup: ['lense/setup/index.html', '/_setup/', /<small>PROJECT SETUP<\/small>/], sim: ['mirage/admin/index.html', '/__sim/', /<small id="workspace-kind">SIMULATOR WORKSPACE<\/small>/] };

test('both areas serve the shared shell markup and cascade the shared sheets before their page sheet', async () => {
  for (const [name, [file, prefix, kind]] of Object.entries(pages)) {
    const html = await read(file);
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(match => match[1].replace(prefix, ''));
    assert.deepEqual(sheets.slice(0, 4), ['ui-kit.css', 'shell.css', 'dashboard.css', 'style.css'], name);
    for (const pattern of [/<aside class="sidebar"/, /<header class="topbar"/, /class="sidebar-bottom"/, /<footer>/, /class="skip-link"/, />AREAS</,
      />Project setup<\/a>/, />Simulator workspace</, /aria-current="page"/, kind,
      /<span class="brand-symbol"[^>]*>P<\/span\s*><span>(?:<span id="workspace-name">)?Paqvilo/]) assert.match(html, pattern, `${name}: ${pattern}`);
  }
});
