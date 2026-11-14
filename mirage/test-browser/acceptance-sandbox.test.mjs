// @test-kind contract+security: acceptance observes valid sandboxed pages without weakening application-error gates or editor isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAcceptance } from '../acceptance.mjs';
import { createSimulator } from '../server.mjs';
import { sharedBrowser, loopbackServer } from './shared-browser.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

// The runner's action budget for these flows: never the limiting factor on a loaded host.
const ACTION_BUDGET_MS = 120_000;

const browser = sharedBrowser();
async function output(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-sandbox-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const clean = (flow) => {
  assert.equal(flow.passed, true, JSON.stringify(flow));
  assert.ok(flow.steps.every((step) => step.passed));
  assert.deepEqual(flow.consoleErrors, []);
  assert.deepEqual(flow.pageErrors, []);
  assert.deepEqual(flow.failedResponses, []);
};

test('valid script-disabled srcdoc acceptance matches an ordinary browser and still fails authored errors', async (t) => {
  const root = await output(t);
  const { origin } = await loopbackServer(t, (req, res) => {
    if (req.url.startsWith('/__sim/api/')) {
      res.setHeader('content-type', 'application/json');
      return res.end(
        JSON.stringify(
          req.url.startsWith('/__sim/api/state')
            ? {
                config: { mode: 'local', pageMode: 'local', endpoints: [] },
                status: { sourceFingerprint: 'invented', implementationFingerprint: 'invented' },
              }
            : { events: [] },
        ),
      );
    }
    if (req.url === '/failure') {
      res.writeHead(503);
      return res.end('Invented failure');
    }
    res.setHeader('content-type', 'text/html');
    const script =
      req.url === '/console'
        ? '<script>console.error("Authored console error")</script>'
        : req.url === '/exception'
          ? '<script>throw new Error("Authored exception")</script>'
          : req.url === '/request'
            ? '<img src="/failure">'
            : '';
    const frameScript = req.url === '/blocked' ? '<script>parent.executed=true</script>' : '';
    res.end(
      `<h1>Read-only observation fixture</h1><iframe id="editor" sandbox="allow-same-origin" srcdoc="<p>Invented value</p>${frameScript}"></iframe>${script}`,
    );
  });
  const page = await browser.page(t),
    errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.frameLocator('#editor').locator('body').innerText(), 'Invented value');
  assert.deepEqual(errors, []);
  const steps = (path) => [
    { action: 'navigate', path },
    { action: 'text', selector: 'h1', value: 'Read-only observation fixture' },
    { action: 'text', frame: '#editor', selector: 'body', value: 'Invented value' },
  ];
  const result = await runAcceptance({
    timeout: ACTION_BUDGET_MS,
    localUrl: origin,
    outputDir: root,
    flows: ['/', '/console', '/exception', '/request', '/blocked'].map((route) => ({
      name: route,
      steps: steps(route),
    })),
  });
  clean(result.flows[0]);
  for (const flow of result.flows.slice(1)) {
    assert.equal(flow.passed, false, flow.name);
    assert.ok(
      flow.steps.every((step) => step.passed),
      JSON.stringify(flow),
    );
  }
  assert.match(result.flows[1].error, /consoleErrors/);
  assert.match(result.flows[2].error, /pageErrors/);
  assert.ok(result.flows[3].failedResponses.some((row) => row.status === 503));
  assert.match(result.flows[4].consoleErrors.join('\n'), /Blocked script execution/);
});

test('acceptance edits, saves and reopens two real compatibility editors twice with JSON and HTML intact', async (t) => {
  const root = await output(t);
  const formatted = '<p title="quoted">Formatted <strong>HTML</strong> &amp; "text"</p>';
  const detailValues = ['First', 'Second'].map(
    (word) => `<p title="quoted">${word} <strong>HTML</strong> &amp; "text"</p>`,
  );
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Invented',
    'web-pages/home/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template',
    'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_name: Main\nadx_webtemplateid: main',
    'web-templates/main/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/main/Main.webtemplate.source.html': '{% entityform name: "Narrative" %}',
    'basic-forms/Narrative.basicform.yml':
      'adx_entityformid: form\nadx_name: Narrative\nadx_entityname: example\nadx_mode: 100000001',
    'basic-forms/Narrative.basicform.custom_javascript.js': `document.addEventListener('DOMContentLoaded',()=>{const button=document.createElement('button');button.id='format';button.type='button';button.textContent='Format';button.onclick=()=>{const editor=window.CKEDITOR.instances.details_editor;const first='<p title="quoted">First <strong>HTML</strong> &amp; "text"</p>';const second='<p title="quoted">Second <strong>HTML</strong> &amp; "text"</p>';editor.setData(editor.getData().includes('First') ? second : first);editor.updateElement();};document.body.append(button);});`,
    'web-files/favicon.ico.webfile.yml': 'adx_webfileid: icon\nadx_name: favicon.ico\nadx_partialurl: favicon.ico',
    'web-files/favicon.ico': '',
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, 'portal', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const id = '11111111-1111-4111-8111-111111111111';
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    port: 0,
    watch: false,
    richTextCompatibility: true,
    initial: {
      tables: { example: [{ exampleid: id, narrative: '', details: formatted }] },
      mappings: { example: { entitySet: 'examples', idColumn: 'exampleid' } },
      permissions: [],
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        endpoints: [],
        identity: { id: 'invented-editor' },
        componentSchemas: {
          form: {
            entity: 'example',
            fields: ['narrative', 'details'].map((name) => ({
              name,
              type: 'textarea',
              richText: { name: 'MscrmControls.RichTextEditor.RichTextEditorControl' },
            })),
          },
        },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const steps = [{ action: 'navigate', path: '/?id=' + id }];
  for (const [index, value] of ['First "quoted" edit', 'Second & final edit'].entries()) {
    steps.push(
      {
        action: 'value',
        selector: '#narrative',
        value: JSON.stringify(value.startsWith('First') ? '' : '<p>First "quoted" edit</p>'),
      },
      { action: 'value', selector: '#details', value: JSON.stringify(index === 0 ? formatted : detailValues[0]) },
      { action: 'richtext', field: 'narrative', mode: 'adapter', value },
      { action: 'click', selector: '#format' },
      {
        action: 'value',
        selector: '#narrative',
        value: JSON.stringify('<p>' + value.replaceAll('&', '&amp;') + '</p>'),
      },
      { action: 'value', selector: '#details', value: JSON.stringify(detailValues[index]) },
      { action: 'click', selector: '#UpdateButton' },
      { action: 'navigate', path: '/?id=' + id },
      { action: 'richtextText', field: 'narrative', mode: 'adapter', value },
      { action: 'value', selector: '#details', value: JSON.stringify(detailValues[index]) },
    );
  }
  const result = await runAcceptance({
    timeout: ACTION_BUDGET_MS,
    localUrl: app.url,
    outputDir: path.join(root, 'report'),
    flows: [{ name: 'Editor round trips', steps }],
  });
  clean(result.flows[0]);
  assert.equal(result.passed, true);
  assert.equal(app.store.snapshot().tables.example[0].narrative, '<p>Second &amp; final edit</p>');
  assert.equal(app.store.snapshot().tables.example[0].details, detailValues[1]);
});
