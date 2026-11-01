// @test-kind contract: Paqvilo's own Lense X-ray inspector UI (lense/xray-ui.mjs) against an invented loopback portal
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { SITE } from '../test/fixture.mjs';
import { inspectionFixture, addNativeInspectionFixture } from '../test/source-inspection-fixture.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { createSimulator } from '../mirage/server.mjs';

// X-ray paints in animation frames; after two more frames every paint scheduled before the call has run.
const painted = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const waitField = async (page, qualified, status = 'exact') => {
  await page.waitForFunction(
    ({ qualified, status }) => {
      const evidence = document.getElementById('paqvilo-xray').__px.selection()?.evidence;
      const rows =
        status === 'exact' ? [evidence?.owner.component] : (evidence?.candidates ?? []).map((row) => row.component);
      return (
        evidence?.owner.status === status &&
        rows.some((row) => row && row.entity + '.' + (row.field ?? row.name) === qualified)
      );
    },
    { qualified, status },
  );
};
// Waits for the X-ray card title. A timeout alone does not say why the card shows something else, so the failure carries
// the selected element, its identity and evidence states, and the card's visibility at that moment.
const titled = async (page, title) => {
  try {
    await page.locator('#paqvilo-xray').locator('.title').getByText(title, { exact: true }).waitFor();
  } catch (error) {
    const state = await page
      .evaluate(() => {
        const host = document.getElementById('paqvilo-xray'),
          ui = host.shadowRoot ?? host,
          identity = host.__px.selection(),
          node = host.__px.selectedNode();
        return {
          selected: node?.outerHTML.slice(0, 120) ?? null,
          title: identity?.title,
          kind: identity?.kind,
          owner: identity?.evidence?.owner?.status,
          source: identity?.evidence?.source?.status,
          refs: (identity?.evidence?.source?.refs ?? []).map((ref) => `${ref.name ?? ref.id}:${ref.status}`),
          cardHidden: ui.querySelector('.card')?.hidden,
          cardTitle: ui.querySelector('.card .title')?.textContent ?? null,
          details: ui.querySelector('[data-action=details]')?.getAttribute('aria-pressed'),
          scope: host.__px.getSelectionScope(node ?? undefined),
        };
      })
      .catch((reason) => ({ unavailable: String(reason?.message ?? reason) }));
    throw new Error(`${error.message}\nX-ray state: ${JSON.stringify(state)}`, { cause: error });
  }
};
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true, args: ['--disable-background-networking'] }));
});
after(() => browser?.close());

const body = `<header id="portal-header"><a class="wordmark" href="/">◈ &nbsp; Fieldwork</a><nav><a href="#overview">Overview</a><a href="#work">Work items</a><a href="#team">Team</a></nav><span class="avatar">JD</span></header>
<main id="workspace"><div class="intro"><div><p class="kicker">WORKSPACE / OPERATIONS</p><h1>A little clarity.<br>A lot of possibility.</h1><p class="description">Keep your team’s work moving, from the first idea to the final detail.</p></div><button id="open-dialog">＋ New work item</button></div>
<section class="stats" id="overview"><article><p>Active work items</p><strong>24</strong><span>↗ 12% this month</span></article><article><p>Ready for review</p><strong>08</strong><span>Across 3 teams</span></article><article><p>Team capacity</p><strong>86<small>%</small></strong><span>Room for something great</span></article></section>
<div class="columns"><section class="editor" id="work"><div class="section-title"><div><p class="kicker">DETAILS THAT MATTER</p><h2>Shape your next move</h2></div><span class="tag">Draft</span></div><form data-entityname="fx_widget" data-formid="widget-edit"><label for="fx_title">Work item title</label><input id="fx_title" name="fx_title" value="Quarterly planning workshop" placeholder="Give your idea a name"><div class="formrow"><div><label for="category">Category</label><select id="category"><option>Operations</option></select></div><div><label for="priority">Priority</label><select id="priority"><option>Normal</option></select></div></div><label for="notes">A few useful notes</label><textarea id="notes" placeholder="What would make this a success?"></textarea><div class="formfoot"><span>Only your team can see this draft</span><button id="save" type="button">Save changes ↗</button></div></form></section><aside class="updates"><p class="kicker">THE BIGGER PICTURE</p><h2>Making progress,<br>together.</h2><div class="chart"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><p class="description">Small steps add up. Your team has completed 18 items this week.</p><a href="#team" id="insights">Explore insights ↗</a></aside></div>
<section class="overflow" id="overflow"><div class="wide"><button id="clipped">Overflow control</button></div></section><div id="shadow-control"></div><iframe id="embedded" src="/frame" title="Embedded fixture"></iframe></main>
<dialog id="dialog"><div class="dialog-header"><span class="kicker">WORK ITEM / QUICK EDIT</span><h2>A focused view.</h2><p class="description">Nested contexts keep their own source identity.</p></div><form data-entityname="fx_child" data-viewid="child-view"><label for="fx_name">Related item name</label><input id="fx_name" name="fx_name" placeholder="Name your next step"><button id="nested-open" type="button">Open related record ↗</button></form><button id="dialog-close" type="button">Close</button><div class="nested" role="dialog" aria-label="Related record" hidden><p class="kicker">RELATED RECORD</p><h2>The finer detail.</h2><form data-entityname="fx_widget" data-formid="widget-edit"><label for="nested-title">Title</label><input id="nested-title" name="fx_title" placeholder="A related detail"></form></div></dialog>`;
const css = `*{box-sizing:border-box}body{margin:0;background:#f3f4f7;color:#26313c;font:14px/1.5 'Segoe UI',sans-serif;transform:translateZ(0)}header{height:84px;display:flex;align-items:center;padding:0 64px;gap:80px;background:#fff;border-bottom:1px solid #dfe3e9;position:sticky;top:0;z-index:20}a{color:inherit;text-decoration:none}nav{display:flex;gap:32px;color:#6c7484}.wordmark{font-size:23px;font-weight:650;letter-spacing:-1px}.avatar{margin-left:auto;border-radius:50%;padding:10px;background:#ece9f6;color:#6b6283}main{max-width:1240px;margin:auto;padding:46px 40px}.intro{display:flex;align-items:center;justify-content:space-between;margin-bottom:36px}.kicker{font-size:10px;letter-spacing:2px;color:#7b8190;font-weight:600;margin:0 0 14px}h1{font-size:44px;line-height:1.1;letter-spacing:-1.8px;font-weight:600;margin:0 0 18px}.description{color:#788191;line-height:1.7}button{border:0;border-radius:7px;background:#303e51;color:white;padding:13px 20px;cursor:pointer;font:600 12px 'Segoe UI',sans-serif}button:hover{background:#51667b}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:28px}.stats article{padding:23px 27px;border:1px solid #e0e4ec;background:white;border-radius:12px}.stats p{color:#788191;margin:0}.stats strong{font-size:38px;display:block;font-weight:500;margin:8px 0}.stats small{font-size:23px}.stats span{font-size:11px;color:#7a8793}.columns{display:grid;grid-template-columns:1.65fr 1fr;gap:24px}.editor{background:#fff;border:1px solid #e0e4ec;border-radius:12px;padding:28px}.section-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}h2{font-size:22px;font-weight:550;letter-spacing:-.5px;margin:0 0 14px}.section-title h2{margin:0}.section-title .kicker{margin-bottom:7px}.tag{border-radius:20px;padding:5px 12px;background:#f3efe4;color:#8e8057;font-size:11px}label{display:block;font-size:11px;font-weight:600;color:#667181;margin:15px 0 7px}input,select,textarea{width:100%;border:1px solid #dce1e9;border-radius:6px;background:#fcfcfd;padding:11px;font:13px 'Segoe UI',sans-serif;color:#495569}textarea{height:78px;resize:vertical}.formrow{display:grid;grid-template-columns:1fr 1fr;gap:16px}.formfoot{display:flex;align-items:center;justify-content:space-between;margin-top:18px}.formfoot span{font-size:10px;color:#9198a4}.updates{background:#e4e9f1;border-radius:12px;padding:30px;overflow:hidden;position:relative}.updates h2{font-size:28px;margin-top:20px}.updates a{font-size:12px}.chart{height:100px;display:flex;align-items:end;gap:9px;margin:30px 0}.chart i{flex:1;height:30%;border-radius:4px 4px 0 0;background:#b6c4d8}.chart i:nth-child(2n){height:48%}.chart i:nth-child(3n){height:75%;background:#7d95b5}.chart i:last-child{height:100%;background:#4e6a8e}.overflow{overflow:auto;width:270px;height:65px;margin-top:25px}.wide{width:700px;padding-left:190px}iframe{width:250px;height:60px;border:1px solid #dce1e9;margin-top:20px}dialog{border:1px solid #bccbdb;border-radius:18px;padding:36px;width:620px;overflow:visible;color:#26313c;box-shadow:0 40px 100px #0004}dialog::backdrop{background:#16253877;backdrop-filter:blur(3px)}dialog button{margin-top:20px}.nested{position:absolute;right:-90px;top:140px;width:380px;background:#fff;border:1px solid #bbc9d8;border-radius:16px;box-shadow:0 20px 80px #172d4b55;padding:30px;z-index:200}.nested[hidden]{display:none}@media(max-width:700px){main{padding:24px}.columns{grid-template-columns:1fr}header{padding:0 24px}nav{display:none}.intro{display:block}.stats{gap:8px}.stats article{padding:10px}h1{font-size:34px}.formfoot{gap:10px}.nested{right:0;width:300px}}`;

test(
  'X-ray inspects fields and sources without activating portal controls across clipping, dialogs, frames and rebuilds',
  { timeout: 90_000 },
  async (t) => {
    const fx = inspectionFixture();
    addNativeInspectionFixture(fx);
    const sidebar = body.match(/<aside class="updates">[\s\S]*?<\/aside>/)[0];
    fs.writeFileSync(
      path.join(fx.portal, 'web-pages/home/Home.webpage.copy.html'),
      body.replace(sidebar, '{% include "Partial" %}'),
    );
    fs.writeFileSync(path.join(fx.portal, 'web-templates/Partial.webtemplate.source.html'), sidebar);
    fs.writeFileSync(path.join(fx.portal, 'web-files/widget.css'), css);
    const previousSidebar = sidebar.replace('<h2>', '<h3>').replace('</h2>', '</h3>');
    const partialFile = path.join(fx.portal, 'web-templates/Partial.webtemplate.source.html');
    fs.writeFileSync(partialFile, previousSidebar);
    const hooks = path.join(fx.work, 'empty-hooks');
    fs.mkdirSync(hooks);
    // Repository variables of a calling Git process and signing in the user's configuration stay out.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const git = (...args) =>
      execFileSync('git', ['-C', fx.portal, '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe', env });
    git('init', '--quiet');
    git('add', '.');
    git(
      '-c',
      'user.name=Invented fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      `core.hooksPath=${hooks}`,
      'commit',
      '--quiet',
      '-m',
      'Invented baseline',
    );
    fs.writeFileSync(partialFile, sidebar);
    const server = http.createServer((req, res) => {
      if (req.url === '/widget.css') return res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }).end(css);
      if (req.url === '/frame')
        return res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end('<button onclick="parent.frameClicks++">Embedded action</button>');
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><html><head><title>Fieldwork · invented X-ray fixture</title><link rel="stylesheet" href="/widget.css"></head><body>${body.replace(sidebar, previousSidebar)}<script>window.actions=0;window.frameClicks=0;for(const type of ['pointerdown','mousedown','click','dblclick'])document.getElementById('save').addEventListener(type,()=>window.actions++);document.getElementById('open-dialog').onclick=()=>document.getElementById('dialog').showModal();document.getElementById('dialog-close').onclick=()=>document.getElementById('dialog').close();document.getElementById('nested-open').onclick=()=>document.querySelector('.nested').hidden=false;document.getElementById('shadow-control').attachShadow({mode:'open'}).innerHTML='<button id="shadow-button">Shadow component</button>';</script></body></html>`,
        );
    });
    let context, panel, detach;
    ownedFixture(t).add(async () => {
      await panel?.dispose();
    });
    ownedFixture(t).add(async () => {
      await detach?.();
    });
    ownedFixture(t).add(async () => {
      await context?.close();
    });
    ownedFixture(t).add(async () => {
      server.closeAllConnections();
    });
    ownedFixture(t).add(async () => {
      await new Promise((resolve) => server.close(resolve));
    });
    ownedFixture(t).remove(async () => {
      fx.cleanup();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    context = await browser.newContext({ viewport: { width: 1440, height: 1060 }, serviceWorkers: 'block' });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.fallback() : route.abort(),
    );
    const session = new OverlaySession({
      sourceDir: fx.portal,
      origin,
      site: structuredClone(SITE),
      sourceMaps: false,
      siteName: 'Fieldwork fixture',
      envName: 'loopback',
      stateDir: fx.work,
      browser: {},
      mirageConfig: { project: fx.project },
    });
    // The tab exists before attachment, so its first document is already intercepted instead of reloaded as a late tab.
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    detach = await attachSession(context, session);
    const opened = [];
    let arrived = () => {};
    panel = enablePanel(context, session, {
      open: async (...args) => {
        opened.push(args);
        arrived();
        return null;
      },
    });
    await page.goto(origin);
    const scope = page.locator('#paqvilo-panel'),
      xray = page.locator('#paqvilo-xray');
    const point = async (selector) => {
      const r = await page.locator(selector).boundingBox();
      assert.ok(r);
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    };
    const pick = async (selector) => {
      const p = await point(selector);
      await page.mouse.click(p.x, p.y);
    };
    // Source opening is asynchronous; nextOpen(click) resolves at the editor call the click causes.
    let seenOpens = 0;
    const nextOpen = async (click) => {
      const next = new Promise((resolve) => (arrived = resolve));
      await click();
      await next;
      assert.equal(opened.length, seenOpens + 1, 'exactly one source open');
      seenOpens = opened.length;
      return opened.at(-1);
    };
    const evidence = async (name) => {
      if (!process.env.PAQVILO_EVIDENCE_DIR) return;
      fs.mkdirSync(process.env.PAQVILO_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PAQVILO_EVIDENCE_DIR, name + '.png') });
    };
    await scope.locator('.pill').click();
    await scope.getByRole('button', { name: 'Toggle Lense X-ray' }).click();
    await xray.getByRole('toolbar').waitFor();
    await pick('#fx_title');
    await waitField(page, 'fx_widget.fx_title');
    assert.equal(await xray.locator('[data-inspection-evidence]').getAttribute('data-owner-status'), 'exact');
    assert.equal(await page.evaluate(() => window.actions), 0);
    await evidence('01-field-sources');
    const fieldSource = xray
      .locator('[data-evidence-source]')
      .filter({ hasText: 'Entity.xml' })
      .getByRole('button', { name: 'Open source', exact: true });
    assert.match((await nextOpen(() => fieldSource.click()))?.[1] ?? '', /Entities[\\/]fx_widget[\\/]Entity.xml$/);
    await pick('#save');
    assert.equal(await page.evaluate(() => window.actions), 0);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.actions), 0);
    await xray.getByRole('button', { name: 'Details', exact: true }).click();
    await pick('.updates h2');
    await titled(page, 'Partial');
    await xray.getByText('web-templates/Partial.webtemplate.source.html', { exact: false }).first().waitFor();
    const template = await nextOpen(() =>
      xray
        .locator('[data-evidence-source]')
        .filter({ hasText: 'Partial.webtemplate.source.html' })
        .getByRole('button', { name: 'Open source', exact: true })
        .click(),
    );
    assert.match(template?.[1] ?? '', /Partial.webtemplate.source.html$/);
    assert.equal(template?.[2], 1);
    await evidence('02-template-source');
    await page.evaluate(() => {
      const heading = document.querySelector('.updates h2'),
        wrapper = document.createElement('div');
      heading.before(wrapper);
      wrapper.append(heading);
    });
    await xray.locator('[data-disclosure=static-candidates] > summary').click();
    await xray.getByRole('button', { name: 'Select matching ancestor' }).first().click();
    assert.match(await xray.locator('.element-label').textContent(), /^aside\.updates/);
    await page.evaluate(() => {
      const node = document.querySelector('.updates');
      node.style.position = 'relative';
      document.querySelector('.columns').prepend(node);
    });
    await pick('.updates h2');
    await titled(page, 'Partial');
    await xray.getByRole('button', { name: 'Details', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.keyboard.down('Control');
    await page.locator('#open-dialog').click();
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.getElementById('paqvilo-xray').parentElement.id === 'dialog');
    await pick('#fx_name');
    await waitField(page, 'fx_child.fx_name');
    await xray.getByText('Related children', { exact: true }).first().waitFor({ state: 'attached' });
    await page.keyboard.down('Control');
    await page.locator('#nested-open').click();
    await page.keyboard.up('Control');
    await pick('#nested-title');
    await waitField(page, 'fx_widget.fx_title');
    await evidence('03-nested-modal');
    await xray.locator('.ancestry summary').click();
    await xray.getByText('Element & ancestry', { exact: true }).waitFor();
    await xray.getByRole('button', { name: '↑ Parent', exact: true }).click();
    assert.match(await xray.locator('.element-label').textContent(), /^form/);
    await page.keyboard.press('Escape');
    await page.keyboard.down('Control');
    await page.locator('#dialog-close').click();
    await page.keyboard.up('Control');
    await page.locator('#embedded').scrollIntoViewIfNeeded();
    const embeddedButton = await page.frameLocator('#embedded').locator('button').boundingBox();
    await page.mouse.click(embeddedButton.x + embeddedButton.width / 2, embeddedButton.y + embeddedButton.height / 2);
    assert.equal(await page.evaluate(() => window.frameClicks), 0);
    assert.equal(await xray.locator('.element-label').textContent(), 'button');
    await page.locator('#clipped').scrollIntoViewIfNeeded();
    await pick('#clipped');
    await painted(page);
    const clip = await page.locator('#overflow').boundingBox(),
      rect = await xray.locator('.selected').boundingBox();
    assert.ok(rect.x >= clip.x && rect.x + rect.width <= clip.x + clip.width + 1);
    await page.locator('#shadow-control').scrollIntoViewIfNeeded();
    await pick('#shadow-button');
    assert.match(await xray.locator('.element-label').textContent(), /shadow-button/);
    await page.evaluate(() => {
      document.querySelector('#shadow-control').shadowRoot.querySelector('button').remove();
    });
    // The selection is released when X-ray notices the removed node.
    await page.waitForFunction(() => !document.getElementById('paqvilo-xray').shadowRoot.querySelector('.title'));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize({ width: 540, height: 900 });
    await xray.getByRole('button', { name: 'Details', exact: true }).click();
    await page.locator('#fx_title').scrollIntoViewIfNeeded();
    await pick('#fx_title');
    await evidence('04-narrow-viewport');
    await xray.locator('.card').waitFor({ state: 'visible' });
    const cr = await xray.locator('.card').boundingBox();
    assert.ok(cr && cr.x >= 0 && cr.y >= 0 && cr.x + cr.width <= 540 && cr.y + cr.height <= 900);
    await xray.getByRole('button', { name: 'Turn off X-ray' }).click();
    await page.locator('#save').click();
    assert.ok((await page.evaluate(() => window.actions)) > 0);
    await page.keyboard.press('Alt+Shift+L');
    await scope.locator('.wrap.hidden').waitFor({ state: 'attached' });
    await page.keyboard.press('Alt+Shift+X');
    await xray.getByRole('toolbar').waitFor();
    await panel.draw(page);
    await xray.getByRole('toolbar').waitFor();
    await panel.dispose();
    assert.equal(await page.locator('#paqvilo-xray').count(), 0);
    assert.deepEqual(errors, []);
  },
);

test('X-ray keeps nested table contexts, scaled clipping, dialog order and popovers isolated', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://127.0.0.1:11886/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>body{margin:50px;font:16px sans-serif}.scaled{transform:scale(.7);transform-origin:top left;width:320px;height:110px;overflow:hidden;border:4px solid #777}.scaled button{margin-left:200px;width:300px;height:60px}dialog{padding:40px;width:500px}input{display:block;margin:15px;padding:12px}#later{position:fixed;top:150px;left:180px}#popover{position:fixed;inset:0;width:100vw;height:100vh;background:#fff8}</style><div id="EntityFormControl_outer" data-entityname="fx_outer" data-formid="outer"><div data-viewid="inner-view"><input id="inner" name="fx_shared"></div></div><input id="ambiguous" name="fx_shared"><button id="fx_shared">An ID alone is not a field binding</button><div class="scaled"><button id="scaled">Scaled and clipped</button></div><dialog id="later"><input id="later-field" name="fx_shared"></dialog><dialog id="initial"><input id="initial-field" name="fx_shared"><div id="popover" popover="manual">A later top-layer surface</div></dialog>`,
    }),
  );
  await page.goto('http://127.0.0.1:11886/');
  await page.evaluate(() => document.getElementById('initial').showModal());
  const data = { origin: 'http://127.0.0.1:11886', token: 'invented-xray-test' },
    report = {
      pageSources: [],
      forms: [{ id: 'outer', entity: 'fx_outer', name: 'Outer form' }],
      views: [{ id: 'inner-view', entity: 'fx_inner', name: 'Inner view' }],
      columns: [
        { entity: 'fx_outer', name: 'fx_shared' },
        { entity: 'fx_inner', name: 'fx_shared' },
      ],
    };
  await page.evaluate(xrayUi, data);
  await page.evaluate(
    ({ data, report }) => {
      document.getElementById('paqvilo-xray').__px.update(data, report);
      document.getElementById('paqvilo-xray').__px.toggle(true);
    },
    { data, report },
  );
  const xray = page.locator('#paqvilo-xray');
  assert.equal(await xray.evaluate((node) => node.parentElement.id), 'initial');
  await page.evaluate(() => document.getElementById('later').showModal());
  await page.waitForFunction(() => document.getElementById('paqvilo-xray').parentElement.id === 'later');
  await xray.getByRole('button', { name: 'Details', exact: true }).click();
  await page.evaluate(() => document.getElementById('later').close());
  await page.waitForFunction(() => document.getElementById('paqvilo-xray').parentElement.id === 'initial');
  // X-ray lifts itself above a new top-layer surface from the popover's toggle event.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const popover = document.getElementById('popover');
        popover.addEventListener('toggle', resolve, { once: true });
        popover.showPopover();
      }),
  );
  // A subsequently opened native popover must remain below the inspector controls.
  await xray.getByRole('button', { name: 'Details', exact: true }).click();
  await xray.getByRole('button', { name: 'Details', exact: true }).click();
  await page.evaluate(() => {
    document.getElementById('popover').hidePopover();
    document.getElementById('initial').close();
  });
  await page.waitForFunction(() => document.getElementById('paqvilo-xray').parentElement === document.body);
  const pick = async (selector) => {
    const r = await page.locator(selector).boundingBox();
    await page.mouse.click(r.x + Math.min(r.width / 2, 30), r.y + r.height / 2);
  };
  await pick('#inner');
  await waitField(page, 'fx_inner.fx_shared');
  assert.equal(await xray.getByText('Outer form', { exact: true }).count(), 0);
  await xray
    .locator('[data-evidence-role=enclosing]')
    .getByText('Inner view', { exact: true })
    .first()
    .waitFor({ state: 'attached' });
  await pick('#ambiguous');
  assert.equal(await xray.locator('[data-inspection-evidence]').getAttribute('data-owner-status'), 'candidate');
  await page.evaluate(() => document.getElementById('ambiguous').setAttribute('data-entityname', 'fx_outer'));
  await waitField(page, 'fx_outer.fx_shared', 'candidate');
  await pick('#fx_shared');
  assert.equal(await xray.locator('[data-inspection-evidence]').getAttribute('data-owner-status'), 'unavailable');
  await pick('#scaled');
  await painted(page);
  const clipped = await xray.locator('.selected').boundingBox(),
    container = await page.locator('.scaled').boundingBox();
  assert.ok(clipped.width < 100);
  assert.ok(clipped.x + clipped.width <= container.x + container.width);
  await xray.getByRole('combobox', { name: 'Highlight layer' }).selectOption('none');
  await painted(page);
  assert.equal(await xray.locator('.marks .mark:not(.selected):not(.hover)').count(), 0);
  // Replacing the page body tears down the old listeners instead of intercepting a new document.
  await page.evaluate(() => {
    document.body.innerHTML = '<button id="fresh" onclick="window.freshClicked=true">New page tree</button>';
  });
  // The removed host disposes itself from the mutation callback, before this evaluation returns.
  await page.locator('#fresh').click();
  assert.equal(await page.evaluate(() => window.freshClicked), true);
  assert.deepEqual(errors, []);
});

test('X-ray identifies the basic form, FormXml and column from a native Mirage-rendered form', async (t) => {
  const fx = inspectionFixture();
  let app, context, panel, detach;
  ownedFixture(t).add(async () => {
    await panel?.dispose();
  });
  ownedFixture(t).add(async () => {
    await detach?.();
  });
  ownedFixture(t).add(async () => {
    await context?.close();
  });
  ownedFixture(t).add(async () => {
    await app?.close();
  });
  ownedFixture(t).remove(async () => {
    fx.cleanup();
  });
  fs.writeFileSync(
    path.join(fx.portal, 'web-templates/Main.webtemplate.source.html'),
    "<main>{% entityform name: 'Edit widget' %}</main>",
  );
  const formFile = path.join(fx.portal, 'basic-forms/Widget.basicform.yml');
  fs.writeFileSync(formFile, fs.readFileSync(formFile, 'utf8').replace('100000001', '100000000'));
  app = await createSimulator({
    sourceDir: fx.portal,
    solutionRoots: [fx.solution],
    stateFile: path.join(fx.work, 'state.json'),
    watch: false,
    initial: {
      version: 1,
      tables: { fx_widget: [] },
      mappings: { fx_widget: { entitySet: 'fx_widgets', idColumn: 'fx_widgetid' } },
      permissions: [],
      settings: { permissionMode: 'permissive' },
      simulator: { mode: 'local', pageMode: 'local', identity: null, endpoints: [], live: {} },
    },
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === app.url ? route.fallback() : route.abort(),
  );
  const session = new OverlaySession({
    sourceDir: fx.portal,
    origin: app.url,
    site: structuredClone(SITE),
    sourceMaps: false,
    siteName: 'Native form fixture',
    envName: 'loopback',
    stateDir: fx.work,
    browser: {},
    mirage: true,
    mirageSourceRoots: [fx.portal, fx.solution],
    mirageConfig: { project: fx.project },
  });
  const page = await context.newPage();
  detach = await attachSession(context, session);
  panel = enablePanel(context, session, { open: async () => null });
  await page.goto(app.url);
  const field = page.locator('#fx_title');
  await field.waitFor();
  await page.locator('#paqvilo-xray').waitFor({ state: 'attached' });
  await page.keyboard.press('Alt+Shift+X');
  await page.locator('#paqvilo-xray').getByRole('toolbar').waitFor();
  const r = await field.boundingBox();
  await page.mouse.click(r.x + Math.min(25, r.width / 2), r.y + r.height / 2);
  const xray = page.locator('#paqvilo-xray');
  await waitField(page, 'fx_widget.fx_title');
  await xray.getByText('Edit widget', { exact: true }).first().waitFor({ state: 'attached' });
  await xray.getByText('Widget form', { exact: true }).first().waitFor({ state: 'attached' });
  assert.equal(await xray.getByText('Styles', { exact: true }).count(), 0);
  assert.equal(await xray.locator('.title').innerText(), 'Title');
});
