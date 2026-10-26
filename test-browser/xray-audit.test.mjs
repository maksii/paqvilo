import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';

const column = (entity, name) => ({ entity, name, label: name, ref: `@solution/${entity}.xml`, resolved: true });
const base = {
  page: { name: 'Audit page' },
  pageSources: [],
  forms: [
    {
      id: 'form-a',
      name: 'Form A',
      entity: 'audit_a',
      ref: 'forms/a.yml',
      formXml: { id: 'system-a', name: 'System form A', ref: '@solution/form-a.xml' },
    },
  ],
  views: [
    { id: 'view-a', name: 'View A', entity: 'audit_a', ref: '@solution/view-a.xml' },
    { id: 'view-b', name: 'View B', entity: 'audit_b', ref: '@solution/view-b.xml' },
  ],
  components: [{ kind: 'list', recordId: 'list-a', name: 'List A', entity: 'audit_a', ref: 'lists/a.yml' }],
  columns: [
    column('audit_a', 'audit_first'),
    column('audit_a', 'audit_second'),
    column('audit_a', 'audit_shared'),
    column('audit_b', 'audit_shared'),
  ],
  elementSources: [],
};
const style =
  '<style>body{margin:0;font:14px Arial} .case{margin:130px 40px;width:650px} input,select,textarea,button{padding:8px;margin:5px}label{display:block;padding:8px} .box{height:140px;width:300px;overflow:auto} .tall{height:600px} dialog{padding:30px;width:650px}</style>';

// Each case uses its own browser context, so cases run concurrently in one browser.
test('X-ray case-by-case adversarial browser audit', { timeout: 180_000, concurrency: 4 }, async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const results = [];
  t.after(() => {
    if (process.env.XRAY_AUDIT_REPORT) {
      const file = path.resolve(process.env.XRAY_AUDIT_REPORT);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            executedAt: new Date().toISOString(),
            scope: 'Synthetic local browser fixtures; no live portal',
            cases: results,
          },
          null,
          2,
        ),
      );
    }
  });
  const cases = [];
  const scenario = (id, title, html, run, report = base) => {
    cases.push(
      t.test(`${id} ${title}`, async () => {
        const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
        context.setDefaultTimeout(2500);
        await context.route('**/*', (route) => route.abort());
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const row = { id, title, fixture: 'synthetic DOM + explicit exported report', status: 'running' };
        results.push(row);
        try {
          await page.route('http://127.0.0.1:11887/**', (route) =>
            route.fulfill({ contentType: 'text/html', body: style + `<div class="case">${html}</div>` }),
          );
          await page.goto('http://127.0.0.1:11887/');
          const data = { origin: 'http://127.0.0.1:11887', token: 'invented-audit-session' };
          await page.evaluate(xrayUi, data);
          await page.evaluate(
            ({ data, report }) => {
              const api = document.getElementById('paqvilo-xray').__px;
              api.update(data, report);
              api.toggle(true);
            },
            { data, report },
          );
          const xray = page.locator('#paqvilo-xray');
          const pick = async (selector) => {
            const rect = await page.locator(selector).boundingBox();
            assert.ok(rect, `${selector} has a visible box`);
            await page.mouse.click(rect.x + Math.min(20, rect.width / 2), rect.y + rect.height / 2);
          };
          const field = async (name) => {
            await page.waitForFunction((name) => {
              const evidence = document.getElementById('paqvilo-xray').__px.selection()?.evidence;
              return [evidence?.owner.component, ...(evidence?.candidates ?? []).map((item) => item.component)].some(
                (item) => item && item.entity + '.' + (item.field ?? item.name) === name,
              );
            }, name);
          };
          // X-ray paints selections and scans in animation frames; after two more frames every paint scheduled before
          // the call (including a rescheduled warm-up paint) has run.
          const painted = () =>
            page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          // The X-ray wheel handler scrolls synchronously; once a window listener has seen the wheel, it has scrolled.
          const wheeled = async (x, y) => {
            await page.evaluate(() => {
              window.auditWheelCount = 0;
              window.addEventListener('wheel', () => window.auditWheelCount++, true);
            });
            await page.mouse.move(x, y);
            await page.mouse.wheel(0, 100);
            await page.waitForFunction(() => window.auditWheelCount === 1);
          };
          await run({ page, xray, pick, field, painted, wheeled });
          assert.deepEqual(errors, [], 'no browser errors');
          row.status = 'passed';
          if (process.env.XRAY_AUDIT_REPORT && ['I13', 'D07', 'G07'].includes(id)) {
            const file = path.join(path.dirname(path.resolve(process.env.XRAY_AUDIT_REPORT)), id + '.png');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            await page.screenshot({ path: file });
            row.screenshot = file;
          }
        } catch (error) {
          row.status = 'failed';
          row.error = String(error.message).slice(0, 1500);
          throw error;
        } finally {
          await context.close();
        }
      }),
    );
  };
  scenario(
    'I01',
    'Explicit form, FormXml, table and column',
    '<form data-formid="form-a"><input id="audit_first"></form>',
    async ({ xray, pick, field }) => {
      await pick('#audit_first');
      await field('audit_a.audit_first');
      await xray.getByText('Form A', { exact: true }).first().waitFor({ state: 'attached' });
      await xray.getByText('System form A', { exact: true }).first().waitFor({ state: 'attached' });
    },
  );
  scenario(
    'I02',
    'Label child resolves its associated column',
    '<div data-entityname="audit_a"><label for="audit_first"><span id="caption">Title</span></label><input id="audit_first"></div>',
    async ({ pick, field }) => {
      await pick('#caption');
      await field('audit_a.audit_first');
    },
  );
  scenario(
    'I03',
    'Implicit label resolves its column',
    '<div data-entityname="audit_a"><label><span id="caption">Title</span><input id="audit_first"></label></div>',
    async ({ pick, field }) => {
      await pick('#caption');
      await field('audit_a.audit_first');
    },
  );
  scenario(
    'I04',
    'Field annotation on wrapper survives a generated input ID',
    '<div data-entityname="audit_a"><div data-fieldname="audit_first"><input id="generated"></div></div>',
    async ({ pick, field }) => {
      await pick('#generated');
      await field('audit_a.audit_first');
    },
  );
  scenario(
    'I05',
    'Compatible nested metadata retains form identity',
    '<form data-formid="form-a"><div data-entityname="audit_a"><input id="audit_first"></div></form>',
    async ({ pick, field, xray }) => {
      await pick('#audit_first');
      await field('audit_a.audit_first');
      await xray.getByText('Form A', { exact: true }).first().waitFor({ state: 'attached' });
    },
  );
  scenario(
    'I06',
    'Nested view overrides enclosing native form table',
    '<div id="EntityFormControl_forma" data-formid="form-a"><div data-viewid="view-b"><input id="audit_shared"></div></div>',
    async ({ pick, field, xray }) => {
      await pick('#audit_shared');
      await field('audit_b.audit_shared');
      assert.equal(await xray.getByText('Form A', { exact: true }).count(), 0);
    },
  );
  scenario(
    'I07',
    'Compatible table annotations retain enclosing view/list',
    '<section data-entityname="audit_a" data-viewid="view-a" data-listid="list-a"><div data-entityname="audit_a"><input id="audit_first"></div></section>',
    async ({ pick, field, xray }) => {
      await pick('#audit_first');
      await field('audit_a.audit_first');
      await xray.getByText('View A', { exact: true }).first().waitFor({ state: 'attached' });
      await xray.getByText('List A', { exact: true }).first().waitFor({ state: 'attached' });
    },
  );
  scenario(
    'I08',
    'Dialog without metadata does not mask a native form ID',
    '<dialog open><div id="EntityFormControl_forma_EntityFormView"><input id="audit_first"></div></dialog>',
    async ({ pick, xray }) => {
      await pick('#audit_first');
      await xray.getByText('Form A', { exact: true }).first().waitFor({ state: 'attached' });
    },
  );
  scenario(
    'I09',
    'Deep wrappers retain form/table context',
    `<form data-formid="form-a">${'<div>'.repeat(40)}<input id="audit_shared">${'</div>'.repeat(40)}</form>`,
    async ({ pick, field }) => {
      await pick('#audit_shared');
      await field('audit_a.audit_shared');
    },
  );
  scenario('I10', 'Ambiguous column remains ambiguous', '<input id="audit_shared">', async ({ pick, xray }) => {
    await pick('#audit_shared');
    assert.equal(await xray.locator('[data-inspection-evidence]').getAttribute('data-owner-status'), 'candidate');
    assert.equal(await xray.locator('[data-evidence-role=alternatives] .ie-row').count(), 2);
  });
  scenario(
    'I11',
    'Unrelated button ID is not a Dataverse column',
    '<button id="audit_first">Action</button>',
    async ({ pick, xray }) => {
      await pick('#audit_first');
      assert.equal(await xray.locator('.binding').count(), 0);
    },
  );
  scenario(
    'I12',
    'Conflicting explicit table and view are not presented as a certain column',
    '<div data-entityname="audit_a" data-viewid="view-b"><input id="audit_shared"></div>',
    async ({ pick, xray }) => {
      await pick('#audit_shared');
      assert.equal(await xray.locator('[data-inspection-evidence]').getAttribute('data-owner-status'), 'conflicting');
      assert.equal(await xray.locator('.binding strong').filter({ hasText: 'audit_a.audit_shared' }).count(), 0);
    },
  );
  scenario(
    'D01',
    'Selected field name updates in place',
    '<div data-entityname="audit_a"><input id="field" name="audit_first"></div>',
    async ({ pick, field, page }) => {
      await pick('#field');
      await field('audit_a.audit_first');
      await page.locator('#field').evaluate((node) => (node.name = 'audit_second'));
      await field('audit_a.audit_second');
    },
  );
  scenario(
    'D02',
    'Selected label for updates in place',
    '<div data-entityname="audit_a"><label id="caption" for="audit_first">Label</label><input id="audit_first"><input id="audit_second"></div>',
    async ({ pick, field, page }) => {
      await pick('#caption');
      await field('audit_a.audit_first');
      await page.locator('#caption').evaluate((node) => (node.htmlFor = 'audit_second'));
      await field('audit_a.audit_second');
    },
  );
  scenario(
    'D03',
    'Selected grid cell data-th updates in place',
    '<div data-entityname="audit_a"><span id="cell" data-th="audit_first">Cell</span></div>',
    async ({ pick, field, page }) => {
      await pick('#cell');
      await field('audit_a.audit_first');
      await page.locator('#cell').evaluate((node) => node.setAttribute('data-th', 'audit_second'));
      await field('audit_a.audit_second');
    },
  );
  scenario(
    'D04',
    'Open-shadow column metadata updates in place',
    '<div id="component"></div>',
    async ({ page, pick, field }) => {
      await page.locator('#component').evaluate((node) => {
        node.attachShadow({ mode: 'open' }).innerHTML =
          '<div data-entityname="audit_a"><input id="shadow-field" data-attribute="audit_first"></div>';
      });
      await pick('#shadow-field');
      await field('audit_a.audit_first');
      await page.locator('#shadow-field').evaluate((node) => node.setAttribute('data-attribute', 'audit_second'));
      await field('audit_a.audit_second');
    },
  );
  scenario(
    'D05',
    'Moving a selected field changes table context',
    '<div id="one" data-entityname="audit_a"><input id="audit_shared"></div><div id="two" data-entityname="audit_b"></div>',
    async ({ page, pick, field }) => {
      await pick('#audit_shared');
      await field('audit_a.audit_shared');
      await page.evaluate(() => document.getElementById('two').append(document.getElementById('audit_shared')));
      await field('audit_b.audit_shared');
    },
  );
  scenario(
    'D06',
    'Replacing selected element does not select another node with same ID',
    '<input id="audit_first">',
    async ({ page, pick, xray }) => {
      await pick('#audit_first');
      await page.locator('#audit_first').evaluate((node) => node.replaceWith(node.cloneNode()));
      await page.waitForFunction(() => document.getElementById('paqvilo-xray').__px.selection() === null);
      assert.equal(await xray.locator('.binding').count(), 0);
    },
  );
  scenario(
    'G01',
    'Viewport-fixed child escapes an untransformed overflow ancestor',
    '<div style="height:80px;width:80px;overflow:hidden"><button id="fixed" style="position:fixed;left:350px;top:300px">Fixed</button></div>',
    async ({ page, pick, xray, painted }) => {
      await pick('#fixed');
      await painted();
      const a = await page.locator('#fixed').boundingBox(),
        b = await xray.locator('.selected').boundingBox();
      assert.ok(b, 'visible fixed element has an outline');
      assert.ok(Math.abs(a.x - b.x) < 2 && Math.abs(a.width - b.width) < 2);
    },
  );
  scenario(
    'G02',
    'Scaled overflow clipping matches the visible client area',
    '<div id="clip" style="width:300px;height:100px;overflow:hidden;transform:scale(.7);transform-origin:top left"><button id="wide" style="margin-left:200px;width:300px">Wide</button></div>',
    async ({ page, xray, painted }) => {
      const r = await page.locator('#clip').boundingBox();
      await page.mouse.click(r.x + 155, r.y + 15);
      await painted();
      const b = await xray.locator('.selected').boundingBox();
      assert.ok(b && b.x + b.width <= r.x + r.width + 1);
    },
  );
  scenario(
    'G03',
    'Nested wheel scrolling chains when the inner scroller reaches its edge',
    '<div id="outer" class="box"><div style="height:100px"></div><div id="inner" class="box" style="height:80px"><div class="tall">Inner content</div></div><div class="tall"></div></div>',
    async ({ page, wheeled }) => {
      await page.evaluate(() => {
        document.getElementById('outer').scrollTop = 80;
        const inner = document.getElementById('inner');
        inner.scrollTop = inner.scrollHeight;
      });
      const r = await page.locator('#inner').boundingBox();
      await page.evaluate(() => {
        window.auditWheels = [];
        window.addEventListener(
          'wheel',
          (e) =>
            window.auditWheels.push({
              target: e.composedPath()[0].className,
              x: e.clientX,
              y: e.clientY,
              delta: e.deltaY,
            }),
          true,
        );
      });
      await wheeled(r.x + 20, r.y + 20);
      assert.ok(
        (await page.locator('#outer').evaluate((node) => node.scrollTop)) > 80,
        JSON.stringify(
          await page.evaluate(() => ({
            events: window.auditWheels,
            scroll: document.getElementById('outer').scrollTop,
            html: document.elementsFromPoint(60, 170).map((n) => n.id || n.className),
          })),
        ),
      );
    },
  );
  scenario(
    'G04',
    'Overscroll containment prevents parent chaining',
    '<div id="outer" class="box"><div style="height:100px"></div><div id="inner" class="box" style="height:80px;overscroll-behavior:contain"><div class="tall">Inner content</div></div><div class="tall"></div></div>',
    async ({ page, wheeled }) => {
      await page.evaluate(() => {
        document.getElementById('outer').scrollTop = 80;
        const inner = document.getElementById('inner');
        inner.scrollTop = inner.scrollHeight;
      });
      const r = await page.locator('#inner').boundingBox();
      await wheeled(r.x + 20, r.y + 20);
      assert.equal(await page.locator('#outer').evaluate((node) => node.scrollTop), 80);
    },
  );
  scenario(
    'G05',
    'Line-mode wheel uses line distances',
    '<div id="scroll" class="box" style="line-height:20px"><div class="tall">Content</div></div>',
    async ({ page, xray }) => {
      const r = await page.locator('#scroll').boundingBox();
      await xray.locator('.shield').evaluate(
        (node, p) =>
          node.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: p.x + 20,
              clientY: p.y + 20,
              deltaY: 3,
              deltaMode: 1,
            }),
          ),
        r,
      );
      assert.ok((await page.locator('#scroll').evaluate((node) => node.scrollTop)) >= 40);
    },
  );
  scenario('G06', 'Ctrl-wheel preserves browser zoom default', '<p>Zoom fixture</p>', async ({ xray }) => {
    const prevented = await xray.locator('.shield').evaluate((node) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 100 });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(prevented, false);
  });
  scenario(
    'L01',
    'Removing an active modal preserves the inspector',
    '<button id="outside">Outside</button><dialog id="modal"><input id="audit_first"></dialog>',
    async ({ page, xray, pick }) => {
      await page.locator('#modal').evaluate((node) => node.showModal());
      await page.waitForFunction(() => document.getElementById('paqvilo-xray')?.parentElement.id === 'modal');
      await pick('#audit_first');
      await xray.evaluate((node) => (window.auditRetainedHost = node));
      await page.locator('#modal').evaluate((node) => node.remove());
      await xray.getByRole('toolbar').waitFor();
      assert.equal(await xray.evaluate((node) => node.parentElement === document.body), true);
      assert.equal(await xray.evaluate((node) => node === window.auditRetainedHost), true);
      assert.equal(await xray.evaluate((node) => node.__px.selection()), null);
      await xray.evaluate((node) => node.__px.dispose());
      await page.locator('body').evaluate((node) => node.append(document.createElement('div')));
      assert.equal(
        await page.locator('#paqvilo-xray').count(),
        0,
        'explicit disposal never resurrects on later mutations',
      );
    },
  );
  scenario(
    'L02',
    'Disposal releases interception and removes all overlay UI',
    '<button id="action" onclick="window.auditClicks=(window.auditClicks||0)+1">Action</button>',
    async ({ page, pick, xray }) => {
      await pick('#action');
      assert.equal(await page.evaluate(() => window.auditClicks ?? 0), 0);
      await xray.evaluate((node) => node.__px.dispose());
      await page.locator('#action').click();
      assert.equal(await page.evaluate(() => window.auditClicks), 1);
      assert.equal(await page.locator('#paqvilo-xray').count(), 0);
    },
  );
  scenario(
    'L03',
    'Ctrl reset on blur restores inspect mode',
    '<button id="action">Action</button>',
    async ({ page, xray }) => {
      await page.keyboard.down('Control');
      assert.equal(await xray.locator('.shield').isVisible(), false);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      assert.equal(await xray.locator('.shield').isVisible(), true);
      await page.keyboard.up('Control');
    },
  );
  scenario(
    'L04',
    'Keyboard parent selection works after using inspector controls',
    '<form data-formid="form-a"><input id="audit_first"></form>',
    async ({ page, pick, xray }) => {
      await pick('#audit_first');
      await xray.getByRole('button', { name: 'Reveal', exact: true }).click();
      await page.keyboard.press('ArrowUp');
      assert.match(await xray.locator('.element-label').textContent(), /^form/);
    },
  );
  scenario(
    'L05',
    'Tab stays inside inspector during inspection',
    '<input id="audit_first">',
    async ({ page, xray }) => {
      for (let i = 0; i < 16; i++) await page.keyboard.press('Tab');
      assert.equal(
        await xray.evaluate((node) => node.shadowRoot.activeElement?.getRootNode() === node.shadowRoot),
        true,
      );
    },
  );
  scenario(
    'S01',
    'Same selector in two templates remains two candidates',
    '<aside class="shared"><span id="text">Content</span></aside>',
    async ({ pick, xray }) => {
      await pick('#text');
      await xray.getByText('Template A', { exact: true }).last().first().waitFor({ state: 'attached' });
      await xray.getByText('Template B', { exact: true }).last().first().waitFor({ state: 'attached' });
      assert.equal(await xray.locator('[data-inspection-evidence]').getAttribute('data-source-status'), 'candidate');
    },
    {
      ...base,
      elementSources: [
        { selector: 'aside.shared', kind: 'template', name: 'Template A', ref: 'templates/a.html' },
        { selector: 'aside.shared', kind: 'template', name: 'Template B', ref: 'templates/b.html' },
      ],
    },
  );
  scenario(
    'S02',
    'Missing export produces an explicit unknown instead of a guessed file',
    '<p id="unknown">Unknown</p>',
    async ({ pick, xray }) => {
      await pick('#unknown');
      assert.equal(await xray.locator('[data-inspection-evidence]').getAttribute('data-owner-status'), 'unavailable');
      assert.equal(await xray.locator('[data-inspection-evidence]').getAttribute('data-source-status'), 'unavailable');
      assert.equal(await xray.locator('.source').count(), 0);
    },
  );
  scenario(
    'S03',
    'Input values are absent from inspector content',
    '<div data-entityname="audit_a"><input id="audit_first" value="VALUE_MUST_NOT_APPEAR"><textarea id="notes">TEXT_MUST_NOT_APPEAR</textarea></div>',
    async ({ pick, xray }) => {
      await pick('#audit_first');
      assert.doesNotMatch(await xray.textContent(), /VALUE_MUST_NOT_APPEAR|TEXT_MUST_NOT_APPEAR/);
    },
  );
  scenario(
    'S04',
    'Unproven static candidate browsing preserves file without claiming an exact line',
    '<p id="source">Content</p>',
    async ({ page, pick, xray }) => {
      await page.evaluate(() =>
        document.addEventListener('paqvilo-xray', (event) => {
          if (event.detail.action === 'open') window.auditOpened = event.detail;
        }),
      );
      await pick('#source');
      await xray.locator('[data-disclosure=static-candidates] > summary').click();
      await xray.getByRole('button', { name: 'Browse file ↗' }).click();
      assert.deepEqual(await page.evaluate(() => ({ ref: window.auditOpened.ref, line: window.auditOpened.line })), {
        ref: 'templates/example.html',
        line: undefined,
      });
    },
    {
      ...base,
      elementSources: [
        { selector: '#source', kind: 'template', name: 'Example', ref: 'templates/example.html', line: 42 },
      ],
    },
  );
  scenario(
    'I13',
    'Shared system form identifies both candidate basic forms',
    '<div data-formid="system-a" data-entityname="audit_a"><input id="audit_first"></div>',
    async ({ pick, xray, painted }) => {
      await pick('#audit_first');
      await xray.getByText('Form A', { exact: true }).first().waitFor({ state: 'attached' });
      await xray.getByText('Form A alternate', { exact: true }).first().waitFor({ state: 'attached' });
      assert.notEqual(await xray.locator('[data-inspection-evidence]').getAttribute('data-owner-status'), 'exact');
      // A later paint may re-render the card; its rows must not change.
      await painted();
      assert.equal(await xray.locator('[data-evidence-role=enclosing] .ie-row').count(), 2);
      assert.equal(await xray.getByText('System form A', { exact: true }).count(), 1);
    },
    {
      ...base,
      forms: [
        ...base.forms,
        { ...base.forms[0], id: 'form-alternate', name: 'Form A alternate', ref: 'forms/alternate.yml' },
      ],
    },
  );
  scenario(
    'I14',
    'Explicit form table conflict remains unresolved',
    '<form data-formid="form-a" data-entityname="audit_b"><input id="audit_shared"></form>',
    async ({ pick, xray }) => {
      await pick('#audit_shared');
      assert.equal(await xray.locator('[data-inspection-evidence]').getAttribute('data-owner-status'), 'conflicting');
      assert.equal(await xray.locator('.binding').count(), 0);
    },
  );
  scenario(
    'I15',
    'Nearest native form wins within the same table',
    '<div id="EntityFormControl_forma"><div id="EntityFormControl_forminner"><input id="audit_first"></div></div>',
    async ({ pick, xray }) => {
      await pick('#audit_first');
      await xray.getByText('Inner form', { exact: true }).first().waitFor({ state: 'attached' });
      assert.equal(await xray.getByText('Form A', { exact: true }).count(), 0);
    },
    {
      ...base,
      forms: [...base.forms, { ...base.forms[0], id: 'form-inner', name: 'Inner form', ref: 'forms/inner.yml' }],
    },
  );
  scenario(
    'I16',
    'List identity does not match a different component kind',
    '<div data-listid="list-a"><input id="audit_first"></div>',
    async ({ pick, xray }) => {
      await pick('#audit_first');
      await xray.getByText('List A', { exact: true }).first().waitFor({ state: 'attached' });
      assert.equal(await xray.getByText('Unrelated basic form', { exact: true }).count(), 0);
    },
    {
      ...base,
      components: [
        ...base.components,
        {
          kind: 'basic-form',
          recordId: 'list-a',
          name: 'Unrelated basic form',
          entity: 'audit_b',
          ref: 'forms/unrelated.yml',
        },
      ],
    },
  );
  scenario(
    'I17',
    'Multistep form identity retains its FormXml and column',
    '<div data-formid="advanced-a"><input id="audit_first"></div>',
    async ({ pick, xray, field }) => {
      await pick('#audit_first');
      await field('audit_a.audit_first');
      await xray.getByText('Multistep A', { exact: true }).first().waitFor({ state: 'attached' });
      await xray.getByText('System form A', { exact: true }).first().waitFor({ state: 'attached' });
      await xray.locator('[data-disclosure=declared-form-definitions] > summary').click();
      assert.match(await xray.locator('.content').innerText(), /Multistep form/);
    },
    {
      ...base,
      forms: [
        { ...base.forms[0], id: 'advanced-a', kind: 'advanced-form', name: 'Multistep A', ref: 'advanced-forms/a.yml' },
      ],
    },
  );
  scenario(
    'I18',
    'Code component schema resolves its exported source',
    '<div data-pcf-schema="audit.Control"><button id="control">Control</button></div>',
    async ({ pick, xray }) => {
      await pick('#control');
      await xray
        .locator('[data-evidence-role=alternatives]')
        .getByText('audit.Control', { exact: true })
        .waitFor({ state: 'attached' });
      assert.notEqual(await xray.locator('[data-inspection-evidence]').getAttribute('data-owner-status'), 'exact');
      await xray.getByText('controls/a.yml', { exact: false }).first().waitFor({ state: 'attached' });
    },
    {
      ...base,
      codeComponents: [
        { schemaName: 'audit.Control', entity: 'audit_a', name: 'Custom control', ref: 'controls/a.yml' },
      ],
    },
  );
  scenario(
    'D07',
    'Slotted field inherits shadow metadata and updates after slot reassignment',
    '<div id="component"><input id="audit_shared" slot="a"></div>',
    async ({ page, pick, field }) => {
      await page.locator('#component').evaluate((node) => {
        node.attachShadow({ mode: 'open' }).innerHTML =
          '<section data-entityname="audit_a"><slot name="a"></slot></section><section data-entityname="audit_b"><slot name="b"></slot></section>';
      });
      await pick('#audit_shared');
      await field('audit_a.audit_shared');
      await page.locator('#audit_shared').evaluate((node) => (node.slot = 'b'));
      await field('audit_b.audit_shared');
    },
  );
  scenario(
    'D08',
    'New open root is discovered without a document child mutation',
    '<div id="component"></div>',
    async ({ page, xray }) => {
      await page.locator('#component').evaluate((node) => {
        node.attachShadow({ mode: 'open' }).innerHTML = '<input id="shadow-field" style="width:180px;height:40px">';
      });
      await page.waitForFunction(
        () => document.getElementById('paqvilo-xray').shadowRoot.querySelectorAll('.mark').length > 0,
      );
      assert.ok((await xray.locator('.mark').count()) > 0);
    },
  );
  scenario(
    'G07',
    'Transformed containing block clips a fixed descendant',
    '<div id="clip" style="position:relative;transform:translateZ(0);height:80px;width:180px;overflow:hidden"><button id="fixed" style="position:fixed;left:120px;top:10px;width:180px">Fixed clipped</button></div>',
    async ({ page, xray, painted }) => {
      const r = await page.locator('#clip').boundingBox();
      await page.mouse.click(r.x + 140, r.y + 25);
      await painted();
      const b = await xray.locator('.selected').boundingBox();
      assert.ok(b && b.x + b.width <= r.x + r.width + 1);
    },
  );
  scenario(
    'G08',
    'Absolutely positioned child escapes overflow before its containing block',
    '<div style="width:80px;height:80px;overflow:hidden"><button id="absolute" style="position:absolute;left:350px;top:300px">Absolute</button></div>',
    async ({ page, pick, xray, painted }) => {
      await pick('#absolute');
      await painted();
      const a = await page.locator('#absolute').boundingBox(),
        b = await xray.locator('.selected').boundingBox();
      assert.ok(b && Math.abs(a.width - b.width) < 2);
    },
  );
  scenario(
    'G09',
    'Visible descendant of visibility-hidden ancestor still has an outline',
    '<div style="visibility:hidden"><button id="visible" style="visibility:visible">Visible child</button></div>',
    async ({ pick, xray, painted }) => {
      await pick('#visible');
      await painted();
      assert.ok(await xray.locator('.selected').boundingBox());
    },
  );
  scenario(
    'G10',
    'RTL horizontal wheel moves in both negative and positive directions',
    '<div id="scroll" class="box" style="direction:rtl;overflow-x:auto"><div style="width:900px;height:40px">Wide</div></div>',
    async ({ page, xray }) => {
      const r = await page.locator('#scroll').boundingBox();
      const wheel = (delta) =>
        xray.locator('.shield').evaluate(
          (node, p) =>
            node.dispatchEvent(
              new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                clientX: p.r.x + 20,
                clientY: p.r.y + 20,
                deltaX: p.delta,
              }),
            ),
          { r, delta },
        );
      await wheel(-100);
      assert.equal(await page.locator('#scroll').evaluate((node) => node.scrollLeft), -100);
      await wheel(40);
      assert.equal(await page.locator('#scroll').evaluate((node) => node.scrollLeft), -60);
    },
  );
  scenario(
    'G11',
    'Diagonal wheel routes horizontal and vertical axes independently',
    '<div id="outer" class="box"><div id="inner" style="width:200px;height:80px;overflow:auto;overscroll-behavior-x:contain"><div style="height:40px;width:900px">Wide</div></div><div class="tall"></div></div>',
    async ({ page, xray }) => {
      const r = await page.locator('#inner').boundingBox();
      await xray.locator('.shield').evaluate(
        (node, r) =>
          node.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: r.x + 20,
              clientY: r.y + 20,
              deltaX: 80,
              deltaY: 90,
            }),
          ),
        r,
      );
      assert.equal(await page.locator('#inner').evaluate((node) => node.scrollLeft), 80);
      assert.equal(await page.locator('#outer').evaluate((node) => node.scrollTop), 90);
    },
  );
  scenario(
    'L06',
    'Overlap keyboard cycling includes the open shadow stack',
    '<div id="component"></div>',
    async ({ page, pick, xray }) => {
      await page.locator('#component').evaluate((node) => {
        node.attachShadow({ mode: 'open' }).innerHTML =
          '<section id="shadow-region"><button id="shadow-button">Shadow</button></section>';
      });
      await pick('#shadow-button');
      assert.match(await xray.locator('.element-label').textContent(), /shadow-button/);
      await page.keyboard.press(']');
      assert.match(await xray.locator('.element-label').textContent(), /shadow-region/);
    },
  );
  scenario(
    'L07',
    'Interact mode allows an intentionally activated portal action',
    '<button id="action" onclick="window.auditClicks=(window.auditClicks||0)+1">Action</button>',
    async ({ page, xray }) => {
      await xray.getByRole('button', { name: 'Inspect', exact: true }).click();
      await page.locator('#action').click();
      assert.equal(await page.evaluate(() => window.auditClicks), 1);
      await xray.getByRole('button', { name: 'Interact', exact: true }).click();
    },
  );
  scenario(
    'S05',
    'Failed refresh clears previous source identities',
    '<input id="audit_first">',
    async ({ pick, xray, field }) => {
      await pick('#audit_first');
      await field('audit_a.audit_first');
      await xray.evaluate((node) =>
        node.__px.update(
          {
            origin: 'http://127.0.0.1:11887',
            token: 'invented-audit-session',
            inspectionError: 'Local export unavailable',
          },
          null,
        ),
      );
      await xray.getByText('Details: Local export unavailable', { exact: true }).first().waitFor({ state: 'attached' });
      assert.equal(await xray.locator('.binding').count(), 0);
      assert.equal(await xray.locator('.source').count(), 0);
    },
  );
  scenario(
    'S06',
    'Inactive source inspection clears an older report',
    '<input id="audit_first">',
    async ({ pick, xray, field }) => {
      await pick('#audit_first');
      await field('audit_a.audit_first');
      await xray.evaluate(
        (node, report) =>
          node.__px.update(
            {
              origin: 'http://127.0.0.1:11887',
              token: 'invented-audit-session',
              inspection: { active: false, error: 'Inspection disabled' },
            },
            report,
          ),
        base,
      );
      await xray.getByText('Details: Inspection disabled', { exact: true }).first().waitFor({ state: 'attached' });
      assert.equal(await xray.locator('.binding').count(), 0);
    },
  );
  scenario(
    'S07',
    'Page CSS and JavaScript expose dependency files with bounded claims',
    '<p id="unknown">Content</p>',
    async ({ pick, xray }) => {
      await pick('#unknown');
      await xray.locator('.page-context summary').click();
      await xray.getByText('assets/site.css', { exact: true }).first().waitFor({ state: 'attached' });
      await xray.getByText('assets/site.js', { exact: true }).first().waitFor({ state: 'attached' });
      assert.match(
        await xray.locator('.content').innerText(),
        /neither execution nor selected-element ownership is implied/,
      );
    },
    {
      ...base,
      assets: [
        { name: 'Site CSS', url: '/site.css', ref: 'assets/site.css' },
        { name: 'Site script', url: '/site.js', ref: 'assets/site.js' },
      ],
    },
  );
  scenario(
    'D09',
    'Large DOM selection retains source identity in a late shadow root',
    '<div id="padding"></div><div id="component"></div>',
    async ({ page, pick, field, xray }) => {
      await page.locator('#padding').evaluate((node) => (node.innerHTML = '<i></i>'.repeat(9000)));
      await page.locator('#component').evaluate((node) => {
        node.attachShadow({ mode: 'open' }).innerHTML =
          '<div data-entityname="audit_a"><input id="late-field" data-field="audit_first"></div>';
      });
      await pick('#late-field');
      await field('audit_a.audit_first');
      const geometry = await xray.evaluate((host) => ({
        outline: host.shadowRoot.querySelector('.selected')?.getBoundingClientRect().toJSON(),
        target: document.getElementById('component').shadowRoot.querySelector('input').getBoundingClientRect().toJSON(),
      }));
      assert.ok(geometry.outline);
      for (const key of ['x', 'y', 'width', 'height'])
        assert.ok(Math.abs(geometry.target[key] - geometry.outline[key]) <= 2, key);
    },
  );
  scenario(
    'I19',
    'A unique column name without table context is only a candidate',
    '<input id="audit_first">',
    async ({ pick, xray }) => {
      await pick('#audit_first');
      assert.equal(await xray.locator('[data-inspection-evidence]').getAttribute('data-owner-status'), 'candidate');
      assert.equal(await xray.locator('[data-evidence-role=alternatives] .ie-row').count(), 1);
    },
  );
  await Promise.all(cases);
});
