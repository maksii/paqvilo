// Real DOM proof for offline YAML field overlays; all requests are fulfilled loopback fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { chromium } from 'playwright-core';
import { PortalModel } from '../lense/portal-model.mjs';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { editSource } from '../lense/source-edit.mjs';

test('real browser: discovered YAML footer and localized form markup apply after safe edits and refresh', { timeout: 45_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-metadata-browser-'));
  let browser;
  t.after(async () => {
    await browser?.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const versions = new Map();
  const write = (rel, text) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    versions.set(file, text);
    return file;
  };
  write('website.yml', 'adx_name: Synthetic metadata portal\n');
  const originalFooter = '<footer id="footer"><p>Original footer</p></footer>\n';
  const originalAction = '<button id="instruction" onclick="window.metadataClicks = (window.metadataClicks || 0) + 1">Original action</button>\n';
  const polish = { LCID: 1045, Value: '<p>Polish instructions</p>', Extra: { preserve: true } };
  const footerFile = write('weblink-sets/footer/Footer.weblinkset.yml', '# preserved footer comment\n' + YAML.stringify({ adx_weblinksetid: 'footer1', adx_name: 'Footer', adx_copy: originalFooter, unrelated: 'retain' }));
  const formFile = write('basic-forms/contact/Contact.basicform.basicformmetadata.yml', '# preserved records comment\n' + YAML.stringify([
    { adx_entityformmetadataid: 'm1', adx_entityform: 'form1', adx_description: JSON.stringify([{ LCID: 1033, Value: originalAction }, polish]), adx_type: 0 },
    { adx_entityformmetadataid: 'm2', adx_entityform: 'form1', adx_description: 'Unchanged sibling' },
  ]));
  const model = await PortalModel.create(dir);
  const footer = model.inlineSources.find((source) => source.file === footerFile && source.field === 'adx_copy');
  const form = model.inlineSources.find((source) => source.file === formFile && source.lcid === 1033);
  assert.ok(footer && form, 'descriptors must come from the real model');
  assert.equal(footer.kind, 'metadata-markup');
  assert.deepEqual(form.fieldPath, [0, 'adx_description']);
  assert.deepEqual(form.jsonPath, [0, 'Value']);
  const changed = new Set();
  const baseline = { show: (file) => versions.get(file) ?? null, changedFiles: () => changed };
  const site = { markup: { enabled: true, kinds: ['metadata-markup'] }, inline: { enabled: false }, scope: 'changed' };
  let rewriter = await HtmlRewriter.create({ model, site, baseline });
  const online = `<!doctype html><html lang="en-US"><head></head><body>${originalFooter}${originalAction}</body></html>`;
  let result;
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const origin = 'http://127.0.0.1:9';
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    result = rewriter.rewrite(online, url.pathname);
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: result.html });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/en-US/fixture/`);
  assert.equal(await page.locator('#footer').textContent(), 'Original footer');
  assert.deepEqual(result.applied, []);

  editSource(footer, (text) => text.replace('Original footer', 'Local footer'));
  editSource(form, (text) => text.replace('Original action', 'Local action').replace('+ 1', '+ 2'));
  changed.add(footerFile);
  changed.add(formFile);
  rewriter.refresh([footerFile, formFile]);
  await page.reload();
  assert.equal(await page.locator('#footer').textContent(), 'Local footer');
  assert.equal(await page.locator('#instruction').textContent(), 'Local action');
  await page.locator('#instruction').click();
  assert.equal(await page.evaluate(() => window.metadataClicks), 2);
  assert.deepEqual(result.applied.map((item) => item.rel).sort(), [footer.rel, form.rel].sort());
  assert.deepEqual(result.notes, []);
  assert.deepEqual(rewriter.unsupported, []);
  const records = YAML.parse(fs.readFileSync(formFile, 'utf8'));
  assert.deepEqual(JSON.parse(records[0].adx_description)[1], polish);
  assert.deepEqual(records[1], { adx_entityformmetadataid: 'm2', adx_entityform: 'form1', adx_description: 'Unchanged sibling' });
  assert.equal(YAML.parse(fs.readFileSync(footerFile, 'utf8')).unrelated, 'retain');
  assert.ok(fs.readFileSync(formFile, 'utf8').includes('# preserved records comment'));

  editSource(form, (text) => text.replace('Local action', 'Refreshed action').replace('+ 2', '+ 3'));
  rewriter.refresh([formFile]);
  await page.reload();
  assert.equal(await page.locator('#instruction').textContent(), 'Refreshed action');
  await page.locator('#instruction').click();
  assert.equal(await page.evaluate(() => window.metadataClicks), 3);

  const wrong = new Map(versions);
  wrong.set(footerFile, versions.get(footerFile).replace('Original footer', 'Different baseline footer'));
  wrong.set(formFile, versions.get(formFile).replace('Original action', 'Different baseline action'));
  const wrongIdentity = new Map(wrong);
  wrongIdentity.set(formFile, versions.get(formFile).replace('m1', 'different-record'));
  for (const show of [(file) => wrong.get(file) ?? null, (file) => wrongIdentity.get(file) ?? null, () => null]) {
    rewriter = await HtmlRewriter.create({ model, site, baseline: { show, changedFiles: () => changed } });
    await page.reload();
    assert.equal(await page.locator('#footer').textContent(), 'Original footer');
    assert.equal(await page.locator('#instruction').textContent(), 'Original action');
    await page.locator('#instruction').click();
    assert.equal(await page.evaluate(() => window.metadataClicks), 1);
    assert.deepEqual(result.applied, []);
  }
  assert.ok(rewriter.unsupported.some((item) => item.rel === form.rel && /does not exist online yet/.test(item.reason)));

  const shared = YAML.parse(versions.get(formFile));
  shared[0].adx_description = JSON.stringify([{ LCID: 1033, Value: originalAction }, { LCID: 1045, Value: originalAction }]);
  versions.set(formFile, YAML.stringify(shared));
  fs.writeFileSync(formFile, versions.get(formFile));
  editSource(form, (text) => text.replace('Original action', 'English-only action').replace('+ 1', '+ 9'));
  rewriter = await HtmlRewriter.create({ model, site, baseline });
  for (const language of ['en-US', 'pl-PL']) {
    await page.goto(`${origin}/${language}/fixture/`);
    assert.equal(await page.locator('#instruction').textContent(), 'Original action');
    await page.locator('#instruction').click();
    assert.equal(await page.evaluate(() => window.metadataClicks), 1);
    assert.ok(result.applied.every((item) => item.rel !== form.rel));
  }
  assert.ok(rewriter.unsupported.some((item) => item.rel === form.rel && /another localized Value/.test(item.reason)));
});
