// @test-kind contract: Paqvilo's Logical names action adds copyable badges without moving any form element; checked on invented loopback form markup.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { validateModelDrivenAction } from '../lense/model-driven-actions.mjs';
import { runModelDrivenAction } from '../lense/model-driven-action-runner.mjs';

// Three invented layouts: a two-column grid field (label | control), a flex field whose label sits in a fixed-width
// cell, and padded block labels in a 180px column, as the local Mirage form renders them, whose display names nearly
// fill the column ("Remaining (calculated)") or whose logical names are longer than the display name. The page also
// styles every button, as an app may, and like Mirage it serves a Content-Security-Policy that refuses inline styles
// and scripts. Every field element is measured before and after the action.
const files = {
  '/form.css': [
    'text/css',
    `.grid{display:grid;grid-template-columns:180px 400px;gap:4px;margin:8px 0}.grid label{position:relative}
.flex{display:flex;gap:8px;margin:8px 0}.flex>.cap{width:160px}.flex label{display:block;overflow:hidden;white-space:nowrap}
.column{display:grid;grid-template-columns:180px 400px;margin:16px 0}.column label{display:block;position:relative;padding:6px 12px 0 0;line-height:20px;font:14px/20px sans-serif}
.column input{height:32px;box-sizing:border-box}
input{height:24px}button{display:flex;justify-content:center;min-height:32px;box-sizing:border-box;padding:6px 12px}`,
  ],
  '/form.js': [
    'text/javascript',
    `const names=['x_name','x_regionid','x_city','x_remaining','x_internalcode','x_portalcontactid'];
const collection=items=>({get:()=>items,forEach:callback=>items.forEach(callback)});
window.Xrm={Utility:{getGlobalContext:()=>({getClientUrl:()=>location.origin,userSettings:{userId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}})},
Page:{data:{entity:{getEntityName:()=> 'x_item',getId:()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',attributes:collection(names.map(name=>({getName:()=>name})))}},ui:{controls:collection([]),tabs:collection([])}}};
const host=document.createElement('div');host.id='paqvilo-model-inspector';document.body.append(host);
host.__paqModelActions={token:'invented-session',results:[],receive(requestId,result){this.results.push({requestId,result})}};`,
  ],
  '/main.aspx': [
    'text/html',
    `<!doctype html><title>Invented form</title><link rel="stylesheet" href="/form.css">
<div class="grid" data-id="x_name"><label for="a">Name<span>*</span></label><input id="a"></div>
<div class="grid" data-id="x_regionid"><label for="b">Region</label><input id="b"></div>
<div class="flex" data-id="x_city"><div class="cap"><label for="c">City</label></div><div><input id="c"></div></div>
<div class="column" data-id="x_remaining"><label for="d">Remaining (calculated)</label><input id="d" value="9,572.00"></div>
<div class="column" data-id="x_internalcode"><label for="e">Internal code (secured)</label><input id="e" value="***7090"></div>
<div class="column" data-id="x_portalcontactid"><label for="f">Portal contact</label><input id="f" value="Invented contact"></div>
<script src="/form.js"></script>`,
  ],
};

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions());
});
after(() => browser?.close());

test('Logical names badges take the place of the label text, never cover the control value, move nothing and clear completely', async (t) => {
  const server = http.createServer((request, response) => {
    const [type, body] = files[new URL(request.url, 'http://fixture.invalid').pathname] ?? ['text/plain', ''];
    response.writeHead(200, { 'content-type': type, 'content-security-policy': "default-src 'self'" }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`,
    context = await browser.newContext({ viewport: { width: 900, height: 600 } });
  ownedFixture(t).add(async () => {
    await context.close();
  });
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await context.newPage();
  await page.goto(origin + '/main.aspx?pagetype=entityrecord&etn=x_item');
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.querySelector('.column label')).paddingTop),
    '6px',
    'the form stylesheet applies under the policy',
  );
  const run = async (action, requestId) => {
    const ack = await page.evaluate(runModelDrivenAction, {
      origin,
      token: 'invented-session',
      ...validateModelDrivenAction(action),
      requestId,
    });
    assert.deepEqual(ack, { accepted: true, requestId });
    await page.waitForFunction(
      (id) =>
        document.getElementById('paqvilo-model-inspector').__paqModelActions.results.some((r) => r.requestId === id),
      requestId,
    );
  };
  const layout = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-id] *:not([data-paq-model-logical-name])')].map((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return [node.tagName, x, y, width, height];
      }),
    );
  // Every field's markup: a badge or an inline style left behind by the action shows here.
  const markup = () => page.evaluate(() => [...document.querySelectorAll('[data-id]')].map((node) => node.outerHTML));
  const before = await layout(),
    markupBefore = await markup();
  await run('form:show-logical-names', 'show');
  const badges = await page.evaluate(() =>
    [...document.querySelectorAll('[data-paq-model-logical-name]')].map((badge) => {
      const label = badge.closest('label'),
        field = label.closest('[data-id]'),
        control = field.querySelector('input').getBoundingClientRect(),
        own = badge.getBoundingClientRect(),
        caption = label.getBoundingClientRect(),
        style = getComputedStyle(label),
        // The label's text, without the badge.
        text = document.createRange();
      text.setStartAfter(badge);
      text.setEndAfter(label.lastChild);
      const words = text.getBoundingClientRect();
      return {
        name: badge.textContent,
        title: badge.title,
        // The badge starts where the label's content starts and covers the label text.
        atLabelStart:
          Math.abs(own.left - (caption.left + parseFloat(style.paddingLeft))) < 1 &&
          Math.abs(own.top - (caption.top + parseFloat(style.paddingTop))) < 1,
        coversText:
          own.left <= words.left && own.right >= Math.min(words.right, caption.right - parseFloat(style.paddingRight)),
        // It never overlaps the control box that shows the value.
        clearOfControl:
          own.right <= control.left ||
          own.left >= control.right ||
          own.bottom <= control.top ||
          own.top >= control.bottom,
        // The name starts at the badge's left edge, where a label's text starts.
        leftAligned: (() => {
          const name = document.createRange();
          name.selectNodeContents(badge);
          return name.getBoundingClientRect().left - own.left < 8;
        })(),
        // It stays inside the label's own box.
        withinLabel: own.right <= caption.right + 0.5 && own.bottom <= caption.bottom + 0.5,
      };
    }),
  );
  assert.deepEqual(
    badges.map((badge) => badge.name),
    ['x_name', 'x_regionid', 'x_city', 'x_remaining', 'x_internalcode', 'x_portalcontactid'],
  );
  for (const badge of badges) {
    assert.ok(
      badge.atLabelStart && badge.coversText && badge.clearOfControl && badge.withinLabel && badge.leftAligned,
      JSON.stringify(badge),
    );
  }
  assert.match(
    badges[3].title,
    /^Remaining \(calculated\) · click to copy x_remaining$/,
    'the display name is the tooltip',
  );
  assert.equal(badges[0].title, 'Name · click to copy x_name', 'the required marker is not part of the display name');
  assert.deepEqual(await layout(), before, 'no label, control or cell moved or resized');
  await run('form:clear-logical-names', 'clear');
  assert.equal(await page.locator('[data-paq-model-logical-name]').count(), 0);
  assert.deepEqual(await markup(), markupBefore, 'every field is back to its markup: no badge, no inline style');
  assert.deepEqual(await layout(), before);
});
