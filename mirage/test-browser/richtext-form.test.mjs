import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function fixture(t, { compatibility = false, mode = 100000000, readOnly = false } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'rte-browser-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Test',
    'web-pages/home/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template',
    'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_name: Main\nadx_webtemplateid: main',
    'web-templates/main/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/main/Main.webtemplate.source.html': '{% entityform name: "Narrative" %}',
    'basic-forms/Narrative.basicform.yml': `adx_entityformid: narrative-form\nadx_name: Narrative\nadx_entityname: example\nadx_mode: ${mode}`,
    // Native custom JavaScript precedes the form markup, so it observes after ready.
    'basic-forms/Narrative.basicform.custom_javascript.js': `document.addEventListener('DOMContentLoaded',()=>{window.richChanges=[];$('#narrative').on('change',function(){const html=JSON.parse(this.value);window.richChanges.push({html,text:$('<div>').html(html).text()});}).each(function(){new MutationObserver(changes=>{const value=changes[0].target.value;window.observedHTML=JSON.parse(value);const doc=new DOMParser().parseFromString(window.observedHTML,'text/html');window.observedText=doc.body.textContent;}).observe(this,{attributes:true});});});`,
  };
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  }
  const initial = {
    tables: {
      example: mode === 100000001 ? [{ exampleid: '11111111-1111-4111-8111-111111111111', narrative: '' }] : [],
    },
    mappings: { example: { entitySet: 'examples', idColumn: 'exampleid' } },
    permissions: [],
    settings: { permissionMode: 'permissive' },
    simulator: {
      identity: { id: 'editor' },
      componentSchemas: {
        'narrative-form': {
          entity: 'example',
          fields: [
            {
              name: 'narrative',
              type: 'textarea',
              readOnly,
              richText: {
                name: 'MscrmControls.RichTextEditor.RichTextEditorControl',
              },
            },
          ],
        },
      },
    },
  };
  const stateFile = path.join(root, 'state.json');
  await fs.writeFile(stateFile, JSON.stringify(initial));
  const app = await createSimulator({
    sourceDir: root,
    stateFile,
    watch: false,
    richTextCompatibility: compatibility,
  });
  ownedFixture(t).add(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { app, page, errors };
}

test('rich text editor changes preserve native JSON binding, authored observers and stored HTML through native form submit', async (t) => {
  const { app, page, errors } = await fixture(t);
  await page.route('**/webresources/msdyn_/RichTextEditorControl/**', (route) => {
    if (route.request().url().endsWith('.json'))
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ defaultSupportedProps: { height: 185 } }),
      });
    return route.fulfill({
      contentType: 'application/javascript',
      body: `window.CKEDITOR={replace(id,config){const node=document.getElementById(id),editable=document.createElement('div');editable.contentEditable=!config.readOnly;editable.className='cke_editable';editable.setAttribute('role','textbox');editable.setAttribute('aria-label','Narrative editor');editable.innerHTML=node.value;node.after(editable);node.hidden=true;const handlers={};editable.addEventListener('input',()=>handlers.change?.());setTimeout(()=>handlers.instanceReady?.(),0);return{getData:()=>editable.innerHTML,on:(event,fn)=>handlers[event]=fn};}};`,
    });
  });
  await page.goto(app.url);
  await page.locator('[data-sim-richtext-editor][data-mounted=ready]').waitFor();
  await page.getByRole('textbox', { name: 'Narrative editor' }).fill('Meaningful scope change');
  const expected = '<div><strong>Meaningful scope change</strong></div>';
  await page.getByRole('textbox', { name: 'Narrative editor' }).evaluate((editor, html) => {
    editor.innerHTML = html;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }, expected);
  assert.equal(await page.locator('#narrative').inputValue(), JSON.stringify(expected));
  await page.waitForFunction(() => window.observedText === 'Meaningful scope change');
  // OOB inline postback still runs when authored validation scripts trigger a
  // disabled submit control programmatically; a disabled physical click cannot.
  await page.locator('#InsertButton').evaluate((button) => {
    button.disabled = true;
    button.click();
  });
  assert.equal(app.store.snapshot().tables.example.length, 0);
  // The native form posts the page back; the response is the re-rendered page.
  const saved = page.waitForResponse(
    (response) => response.request().isNavigationRequest() && response.request().method() === 'POST',
  );
  await page
    .locator('#InsertButton')
    .evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  assert.equal((await saved).status(), 200);
  assert.equal(app.store.snapshot().tables.example[0].narrative, expected);
  assert.deepEqual(errors, []);
});

test('compatibility HTML survives repeated edit/postback/reopen cycles with authored jQuery observers and bounded events', async (t) => {
  const { app, page, errors } = await fixture(t, { compatibility: true, mode: 100000001 });
  const url = app.url + '/?id=11111111-1111-4111-8111-111111111111';
  const ready = async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.locator('[data-sim-richtext-editor][data-mounted=ready]').waitFor();
  };
  await ready();
  assert.equal(await page.locator('#narrative').inputValue(), '""');
  for (const html of [
    '<p title="quoted">Formatted <strong>HTML</strong> &amp; more</p>',
    'Plain &amp; quoted "text"',
    '<table><tbody><tr><td>Table "content"</td></tr></tbody></table>',
    '<pre>  Code &amp; text\nsecond line</pre>',
    '',
  ]) {
    const expected = !html || /^<(?:p|table|pre)\b/.test(html) ? html : '<p>' + html + '</p>';
    await page
      .frameLocator('iframe.cke_wysiwyg_frame')
      .locator('body')
      .evaluate((body, html) => {
        body.innerHTML = html;
        body.dispatchEvent(new Event('input', { bubbles: true }));
      }, html);
    assert.equal(await page.locator('#narrative').inputValue(), JSON.stringify(expected));
    const events = await page.evaluate(() => {
      const editor = window.CKEDITOR.instances.narrative_editor;
      const before = window.richChanges.length;
      editor.updateElement();
      editor.updateElement();
      return { before, after: window.richChanges.length, last: window.richChanges.at(-1) };
    });
    assert.equal(events.before, 1);
    assert.equal(events.after, events.before, 'unchanged sync does not repeat authored change handlers');
    assert.equal(events.last.html, expected);
    const posted = page.waitForResponse(
      (response) => response.request().isNavigationRequest() && response.request().method() === 'POST',
    );
    await page.locator('#UpdateButton').click();
    assert.equal((await posted).status(), 200);
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
    assert.equal(app.store.snapshot().tables.example[0].narrative, expected);
    await ready();
    assert.equal(await page.locator('#narrative').inputValue(), JSON.stringify(expected));
    assert.equal(
      await page.evaluate(() => window.CKEDITOR.instances.narrative_editor.getData()),
      expected,
      'reopening preserves paragraph structure',
    );
    assert.deepEqual(await page.evaluate(() => window.richChanges), [], 'loading is not a user change');
  }
  assert.deepEqual(errors, []);
});

test('compatibility markup retains formatting while excluding executable elements, handlers and URLs', async (t) => {
  const { app, page } = await fixture(t, { compatibility: true, mode: 100000001 });
  const unsafe =
    '<p title="quoted" style="color: red">Formatted <strong>HTML</strong></p>' +
    '<table><tbody><tr><td>Cell</td></tr></tbody></table><pre>  Code &amp; text</pre>' +
    '<img src="/invented-missing.png" onerror="parent.richTextExecuted=true">' +
    '<a href="javascript:parent.richTextExecuted=true">Unsafe link</a>' +
    '<script>parent.richTextExecuted=true</script><iframe srcdoc="<script>parent.richTextExecuted=true</script>"></iframe>';
  app.store.state.tables.example[0].narrative = unsafe;
  await page.goto(app.url + '/?id=11111111-1111-4111-8111-111111111111', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-sim-richtext-editor][data-mounted=ready]').waitFor();
  for (const replace of [false, true]) {
    const result = await page.evaluate(
      ({ replace, unsafe }) => {
        const editor = window.CKEDITOR.instances.narrative_editor;
        if (replace) editor.setData(unsafe);
        editor.updateElement();
        const body = editor.editable();
        return {
          executed: window.richTextExecuted === true,
          unsafe: body.querySelectorAll('script,iframe,[onerror],[href^="javascript:"]').length,
          title: body.querySelector('p').title,
          color: body.querySelector('p').style.color,
          strong: body.querySelector('strong').textContent,
          cell: body.querySelector('td').textContent,
          pre: body.querySelector('pre').textContent,
          stored: JSON.parse(document.getElementById('narrative').value),
        };
      },
      { replace, unsafe },
    );
    assert.equal(result.executed, false);
    assert.equal(result.unsafe, 0);
    assert.equal(result.title, 'quoted');
    assert.equal(result.color, 'red');
    assert.equal(result.strong, 'HTML');
    assert.equal(result.cell, 'Cell');
    assert.equal(result.pre, '  Code & text');
    assert.doesNotMatch(result.stored, /<script|<iframe|onerror|javascript:/i);
  }
});

test('read-only compatibility editors retain empty values without editable bodies or enabled formatting', async (t) => {
  const { app, page, errors } = await fixture(t, { compatibility: true, readOnly: true });
  await page.goto(app.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.locator('[data-sim-richtext-editor][data-mounted=ready]').waitFor();
  assert.equal(
    await page.frameLocator('iframe.cke_wysiwyg_frame').locator('body').getAttribute('contenteditable'),
    'false',
  );
  assert.equal(await page.locator('.sim-richtext-toolbar button:enabled').count(), 0);
  assert.equal(await page.locator('#narrative').inputValue(), '""');
  assert.deepEqual(errors, []);
});

test('compatibility editor readiness waits for its srcdoc document when an earlier blank load wins the race', async (t) => {
  const { app, page, errors } = await fixture(t, { compatibility: true });
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc');
    Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
      ...descriptor,
      set(html) {
        if (this.classList.contains('cke_wysiwyg_frame') && !window.delayedEditor) {
          const frame = this;
          window.delayedEditor = { frame, blankLoaded: false, release: () => descriptor.set.call(frame, html) };
          frame.addEventListener('load', () => {
            if (frame.contentDocument?.URL === 'about:blank') window.delayedEditor.blankLoaded = true;
          });
        } else descriptor.set.call(this, html);
      },
    });
  });
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.delayedEditor.frame.src = 'about:blank';
  });
  await page.waitForFunction(() => window.delayedEditor?.blankLoaded, null, { timeout: 5000 });
  assert.equal(await page.locator('[data-sim-richtext-editor]').getAttribute('data-mounted'), 'loading');
  await page.evaluate(() => window.delayedEditor.release());
  await page.locator('[data-sim-richtext-editor][data-mounted=ready]').waitFor();
  assert.equal(
    await page.frameLocator('iframe.cke_wysiwyg_frame').locator('body').getAttribute('contenteditable'),
    'true',
  );
  assert.deepEqual(errors, []);
});

test('native adapter change feedback does not create an attribute-mutation loop for unchanged HTML', async (t) => {
  const { app, page, errors } = await fixture(t);
  await page.route('**/webresources/msdyn_/RichTextEditorControl/**', (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith('.json') ? 'application/json' : 'application/javascript',
      body: route.request().url().endsWith('.json')
        ? '{}'
        : `window.CKEDITOR={instances:{},replace(id){let value=document.getElementById(id).value;const events={};const editor={on(name,fn){events[name]=fn;},fire(name){events[name]?.();},getData(){return value;},setData(next){value=next;this.fire('change');}};this.instances[id]=editor;queueMicrotask(()=>editor.fire('instanceReady'));return editor;}};`,
    }),
  );
  await page.goto(app.url);
  await page.locator('[data-sim-richtext-editor][data-mounted=ready]').waitFor();
  const result = await page.evaluate(async () => {
    const input = document.getElementById('narrative'),
      editor = window.CKEDITOR.instances.narrative_editor;
    let mutations = 0,
      changes = 0;
    input.addEventListener('change', () => changes++);
    const observer = new MutationObserver(() => {
      if (++mutations < 4) editor.fire('change');
    });
    observer.observe(input, { attributes: true, attributeFilter: ['value'] });
    editor.setData('<p title="quoted">Content &amp; more</p>');
    await new Promise(requestAnimationFrame);
    observer.disconnect();
    return { mutations, changes, value: JSON.parse(input.value) };
  });
  assert.deepEqual(result, { mutations: 1, changes: 1, value: '<p title="quoted">Content &amp; more</p>' });
  assert.deepEqual(errors, []);
});
