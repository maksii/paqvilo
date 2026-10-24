import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';

test('portal → model-driven staff selection → portal preserves styles, scripts and contact session', async (t) => {
  const fixture = await modelDrivenFixture(t),
    { sim, origin, sourceDir } = fixture;
  const contactId = '12345678-1234-4234-8234-123456789012';
  await sim.store.transact(() =>
    sim.store.state.tables.contact.push({ contactid: contactId, fullname: 'Invented Portal Visitor' }),
  );
  await fs.writeFile(
    path.join(sourceDir, 'web-templates/Main.webtemplate.source.html'),
    '<style>body{background:rgb(232,238,244);font-family:Georgia,serif}#portal-heading{color:rgb(10,20,30);font-size:29px}</style><h1 id="portal-heading">Portal</h1><p id="portal-persona">{{user.id}}</p>',
  );
  await sim.reload();
  const registration = await fetch(origin + '/_sim/api/dataverse/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf },
    body: JSON.stringify({
      fullname: 'Invented Organization Staff',
      domainname: 'staff@example.test',
      roles: ['System Administrator'],
    }),
  });
  assert.equal(registration.status, 201);
  const staff = await registration.json(),
    portalSession = sim.signIn(contactId, { roles: ['Readers'] });
  const cookieAt = portalSession.cookieHeader.indexOf('='),
    configured = structuredClone(sim.store.state.simulator.identity);
  const browser = await chromium.launch(browserLaunchOptions());
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1582, height: 1000 } });
  await context.addCookies([
    {
      name: portalSession.cookieHeader.slice(0, cookieAt),
      value: portalSession.cookieHeader.slice(cookieAt + 1),
      url: origin,
    },
  ]);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const inspect = () =>
    page.evaluate(() => {
      const heading = document.querySelector('#portal-heading'),
        css = getComputedStyle(heading),
        body = getComputedStyle(document.body);
      return {
        color: css.color,
        font: css.fontFamily,
        size: css.fontSize,
        background: body.backgroundColor,
        persona: document.querySelector('#portal-persona').textContent.trim(),
        xrm: typeof window.Xrm,
        appAssets: [...document.querySelectorAll('link[href],script[src]')]
          .map((node) => node.href ?? node.src)
          .filter((url) => url.includes('/_apps/assets/')),
      };
    });
  await page.goto(origin + '/');
  await page.locator('#portal-heading').waitFor();
  const before = await inspect();
  assert.equal(before.persona, contactId);
  assert.deepEqual(before.appAssets, []);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Staff profile', exact: true }).click();
  await page.getByLabel('Organization staff', { exact: true }).selectOption(staff.systemuserid);
  await page.getByRole('button', { name: 'Use identity', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('dialog')?.open);
  const selected = await (await context.request.get(origin + '/_sim/api/dataverse/session')).json();
  assert.equal(selected.current.id, staff.systemuserid);
  await page.goto(origin + '/');
  await page.locator('#portal-heading').waitFor();
  assert.deepEqual(await inspect(), before);
  assert.deepEqual(sim.store.state.simulator.identity, configured);
  assert.deepEqual(errors, []);
});
