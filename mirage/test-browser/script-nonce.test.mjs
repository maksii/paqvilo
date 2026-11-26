// @test-kind security: under a nonce Content-Security-Policy the browser runs the scripts and handlers the exported source, the platform and the local runtime wrote, and blocks the script and handler markup a record printed
// The invented portal is mirage/test/fixtures/script-nonce-portal.mjs; its first authored script records every CSP
// violation (securitypolicyviolation; 'report-sample' in the enforced policy gives the blocked script's first characters).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createSimulator } from '../server.mjs';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { parse } from 'parse5';
import { applyScriptNonces } from '../lib/render-provenance.mjs';
import { startNoncePortal, nonceFragmentOf, NONCE_MODAL_PATH } from '../test/fixtures/script-nonce-portal.mjs';

let browser, portal;
before(async () => {
  portal = await startNoncePortal({ reportOnly: "script-src 'self' 'nonce'" });
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(async () => {
  await browser?.close();
  await portal?.close();
});

const headerNonce = (response, name = 'content-security-policy') =>
  /'nonce-([^']+)'/.exec(response.headers()[name] ?? '')?.[1] ?? null;
const DATA_SAMPLES = ["window.injected = 'ran'", "window.dataHandler = 'ran'"];

test('authored, platform and runtime scripts run; data-written scripts and handlers are blocked', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const response = await page.goto(portal.sim.url + '/');
  const nonce = headerNonce(response);
  assert.ok(nonce, 'the page response carries the substituted nonce');
  assert.equal(headerNonce(response, 'content-security-policy-report-only'), nonce);
  // Readiness: the record's script is refused while parsing, its handler when its image fails; both are reported.
  await page.waitForFunction(
    (samples) =>
      samples.every((sample) =>
        window.violations?.some(
          (violation) => violation.disposition === 'enforce' && violation.sample.startsWith(sample),
        ),
      ),
    DATA_SAMPLES,
  );
  const state = await page.evaluate(() => ({
    authored: window.authored,
    snippet: window.snippet,
    pageScript: window.pageScript,
    interpolated: window.interpolated,
    injected: window.injected ?? null,
    dataHandler: window.dataHandler ?? null,
    runtime: window.__portalSimulation?.local === true,
    pagesApi: typeof window.Microsoft?.PowerPages?.onPagesClientApiReady,
    runtimeNonce: document.querySelector('script[data-paqvilo-mirage-runtime]')?.nonce,
    enforced: window.violations.filter((v) => v.disposition === 'enforce').map((v) => v.sample),
    reported: window.violations.filter((v) => v.disposition === 'report').length,
  }));
  assert.deepEqual(state, {
    authored: 'ran',
    snippet: 'ran',
    pageScript: 'ran',
    interpolated: '77777777-7777-4777-8777-777777777760',
    injected: null,
    dataHandler: null,
    runtime: true,
    pagesApi: 'function',
    runtimeNonce: nonce,
    // Only the record's markup is refused: every platform bundle, compatibility adapter and runtime script ran.
    enforced: ["window.injected = 'ran';", "window.dataHandler = 'ran'"],
    // The report-only policy (the same nonce and handler hashes) reports the same two refusals.
    reported: 2,
  });
  // The authored inline handler runs: its hash is in the enforced policy.
  await page.click('#authored-handler');
  await page.waitForFunction(() => window.clicked === 'ran');
  assert.equal(await page.evaluate(() => window.violations.length), 4);
});

test('a script injected at runtime without the nonce is blocked, and each navigation has its own nonce', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const first = headerNonce(await page.goto(portal.sim.url + '/'));
  await page.waitForFunction(() => window.authored === 'ran');
  const outcome = await page.evaluate(
    () =>
      new Promise((resolve) => {
        document.addEventListener('securitypolicyviolation', (event) => {
          if (event.disposition === 'enforce') resolve({ ran: window.lateInline === 'ran', sample: event.sample });
        });
        const script = document.createElement('script');
        script.textContent = "window.lateInline = 'ran';";
        document.body.append(script);
      }),
  );
  assert.deepEqual(outcome, { ran: false, sample: "window.lateInline = 'ran';" });
  const second = headerNonce(await page.reload());
  await page.waitForFunction(() => window.authored === 'ran');
  assert.ok(first && second && first !== second, 'every response has its own nonce');
  assert.equal(await page.evaluate(() => document.querySelector('script[data-paqvilo-mirage-runtime]').nonce), second);
});

test('a code component under the nonce policy mounts through the local PCF host without a refused script', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-nonce-pcf-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const id = 'd0000000-0000-4000-8000-000000000001';
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Invented nonce PCF',
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': `<html><body>{% codecomponent name:${id} value:'Initial' %}<script>window.authored = 'ran';</script></body></html>`,
    'portal/sitesetting.yml': `- adx_sitesettingid: s0\n  adx_name: HTTP/Content-Security-Policy\n  adx_value: "script-src 'self' 'nonce'"`,
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedNoncePcf</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Controls/tst_Invented.Editor/ControlManifest.xml':
      '<manifest><control namespace="Invented" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources><code path="bundle.js"/></resources></control></manifest>',
    'solution/Controls/tst_Invented.Editor/ControlManifest.xml.data.xml':
      '<CustomControl><Name>tst_Invented.Editor</Name></CustomControl>',
    'solution/Controls/tst_Invented.Editor/bundle.js': `window.ComponentFramework.registerControl('Invented.Editor',class{init(context,notify,state,container){this.input=document.createElement('input');this.input.value=context.parameters.value.raw;container.appendChild(this.input);}updateView(){}getOutputs(){return{value:this.input.value};}destroy(){}});`,
  };
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    stateFile: path.join(root, 'state.json'),
    port: 0,
    watch: false,
    observed: {
      codeComponents: { [id]: 'tst_Invented.Editor' },
      evidence: 'Invented fixture manifest and literal tag',
    },
  });
  t.after(() => app.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage(),
    refused = [];
  page.on('console', (message) => {
    if (/Content Security Policy/.test(message.text())) refused.push(message.text());
  });
  const response = await page.goto(app.url + '/');
  assert.ok(headerNonce(response));
  await page.locator('[data-pcf-ready=true]').waitFor();
  assert.equal(await page.locator('input').inputValue(), 'Initial');
  assert.equal(await page.evaluate(() => window.authored), 'ran');
  assert.deepEqual(refused, []);
});

// The documented default policy of new sites (Learn "Manage your site's Content Security Policy"), verbatim.
const DEFAULT_POLICY =
  "script-src 'self' content.powerapps.com content.powerapps.us content.appsplatform.us content.powerapps.cn 'nonce'; style-src 'unsafe-inline' https:;";

test('a modal form document under the documented default policy runs its scripts and loads its stylesheets', async (t) => {
  const defaults = await startNoncePortal({ policy: DEFAULT_POLICY });
  t.after(() => defaults.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage(),
    refused = [];
  page.on('console', (message) => {
    if (/Content Security Policy/.test(message.text())) refused.push(message.text().slice(0, 200));
  });
  const response = await page.goto(defaults.sim.url + NONCE_MODAL_PATH);
  assert.equal(response.status(), 200);
  const policy = response.headers()['content-security-policy'];
  assert.ok(headerNonce(response), policy);
  // https: does not match the http loopback origin: the local response adds 'self' to that directive only.
  assert.match(policy, /style-src 'unsafe-inline' https: 'self';/);
  // The exported Head/Bottom snippet, the WebForms form, the platform bundles and the local runtime all ran.
  await page.waitForFunction(() => window.headBottom === 'ran' && window.__portalSimulation?.local === true);
  const state = await page.evaluate(() => ({
    form: Boolean(document.querySelector('form#content_form')),
    postBack: typeof window.__doPostBack,
    jquery: typeof window.jQuery,
    stylesheets: [...document.styleSheets].filter((sheet) => sheet.href).length,
  }));
  assert.deepEqual(
    { ...state, stylesheets: state.stylesheets > 0 },
    {
      form: true,
      postBack: 'function',
      jquery: 'function',
      stylesheets: true,
    },
  );
  assert.deepEqual(refused, []);
});

// Record names that a security review used to get a script past the nonce policy: a start tag that ends in an open
// attribute value, `<head>` in a value on a page without its own head, and an SVG context around an authored script
// that interpolates the record with | escape.
const BYPASS_CASES = [
  {
    label: 'open attribute value',
    options: { name: "<script x=>window.injected = 'open-value'</script>" },
    refused: "window.injected = 'open-value'",
  },
  {
    label: '<head> in a value of a page without its own head',
    options: {
      name: '<div title="<head><script>window.injected = \'head\'</script>"></div>',
      headerAndFooter: false,
    },
    refused: null,
  },
  {
    label: 'SVG context around an interpolating script',
    options: { name: "</div><svg>\"&quot;;window.injected = 'svg';//", interpolated: '{{ c.x_name | escape }}' },
    refused: 'window.interpolated',
  },
  {
    label: 'select content from a record around an interpolating script',
    options: {
      name: "</div><select><svg>\";window.injected = 'select';//",
      interpolated: '{{ c.x_name | escape }}',
    },
    refused: 'window.interpolated',
  },
  {
    label: 'a record <body> whose onload the parser merges onto the page body',
    options: { name: '<body onload="window.injected = \'body\'">' },
    refused: "window.injected = 'body'",
  },
  {
    label: 'a record <html> whose onclick the parser merges onto the page html element',
    options: { name: '<html onclick="window.injected = \'html\'">' },
    act: (page) => page.click('#authored-handler'),
    refused: "window.injected = 'html'",
  },
];

for (const { label, options, act, refused } of BYPASS_CASES)
  test(`record markup stays without the nonce under the enforced policy: ${label}`, async (t) => {
    const bypass = await startNoncePortal(options);
    t.after(() => bypass.close());
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    const response = await page.goto(bypass.sim.url + '/');
    assert.ok(headerNonce(response));
    // A handler on the html element runs when a click reaches it.
    if (act) {
      await page.waitForFunction(() => window.authored === 'ran');
      await act(page);
    }
    // Readiness: the refused script is reported while parsing (a handler when its event fires), or the record's code
    // ran, which the assertion below reports; the runtime and the authored script have run by load.
    if (refused)
      await page.waitForFunction(
        (sample) =>
          window.injected !== undefined ||
          window.violations?.some(
            (violation) => violation.disposition === 'enforce' && violation.sample.startsWith(sample),
          ),
        refused,
      );
    await page.waitForFunction(() => window.authored === 'ran' && window.__portalSimulation?.local === true);
    assert.deepEqual(
      await page.evaluate(() => ({
        injected: window.injected ?? null,
        runtimeNonce:
          document.querySelector('script[data-paqvilo-mirage-runtime]')?.nonce ===
          document.querySelector('script[nonce]')?.nonce,
        markers: /data-paqvilo-nonce-(?:pending|injected)-/.test(document.documentElement.outerHTML),
      })),
      { injected: null, runtimeNonce: true, markers: false },
    );
  });

// Opener contexts a record can print before an authored script (the elements whose parsing differs most between
// parsers: select content, tables, foreign content and its integration points, raw text, templates), alone and after a
// prefix that a page or a record may leave open.
const OPENERS = [
  ...['', '<select>', '<select><option>', '<select><optgroup>', '<svg>', '<math>', '<math><annotation-xml>'],
  ...['<math><annotation-xml encoding="text/html">', '<svg><foreignObject>', '<svg><desc>', '<svg><title>'],
  ...['<math><mi>', '<math><mtext>', '<table>', '<table><tr>', '<table><tr><td>', '<table><caption>'],
  ...['<table><colgroup>', '<template>', '<noscript>', '<textarea>', '<title>', '<xmp>', '<iframe>', '<style>'],
  ...['<noembed>', '<noframes>', '<plaintext>', '<button>', '<a>', '<form>', '<p>', '<ruby>', '<nobr>', '<li>'],
  ...['<dl><dt>', '<h1>', '<pre>', '<object>', '<marquee>', '<head>', '<body>', '<html>', '<datalist>'],
  ...['<fieldset>', '<legend>', '<details>', '<summary>', '<dialog>', '<menu>', '<font>', '<hr>', '<img>'],
  ...['<input>', '<keygen>', '<image>', '<optgroup>', '<option>', '<rt>', '<selectedcontent>', '<svg><a>'],
  ...['<svg><g>', '<svg><text>', '<math><mglyph>', '<math><malignmark>', '<math><ms>', '<svg><![CDATA['],
  ...['<![CDATA[', '<!--', '<?', '</', '<select><svg>', '<select><math>', '<select><table>', '<select><button>'],
  ...['<select><input>', '<select><div>', '<select><datalist>', '<select><hr>', '<select><textarea>'],
];
const PREFIXES = ['', '<select>', '<select><option>', '<table>', '<table><tr><td>', '<table><select>', '<datalist>'];
const CONTEXTS = [...new Set(PREFIXES.flatMap((prefix) => OPENERS.map((opener) => prefix + opener)))];
const FRAME_NONCE = 'ZGlmZmVyZW50aWFsLW5vbmNl';
const srcdoc = (html) => html.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

/**
 * The document of one context, decided by applyScriptNonces: a source script that must run, the record's opener, and
 * an authored script (#T) that interpolates a value printed with | escape. Wherever the browser decodes character
 * references in #T, the value ends its string literal and sets zqxinj.
 */
function contextDocument(context) {
  const { fragment, index } = nonceFragmentOf([
    '<!doctype html><body><script>window.control = 1;</script>',
    { data: context },
    '<script id="T">window.x = "',
    { data: '&quot;;window.zqxinj = 1;//' },
    '";</script>',
  ]);
  return applyScriptNonces({ fragment, index, nonce: FRAME_NONCE, pending: 'data-paqvilo-nonce-pending-frame' }).html;
}

/** The namespace parse5 gives #T in `html` (null when it is no element there), template contents included. */
function parse5Namespace(html) {
  const pending = [parse(html)];
  while (pending.length) {
    const node = pending.pop();
    if (node.tagName === 'script' && node.attrs.some((attr) => attr.name === 'id' && attr.value === 'T'))
      return node.namespaceURI.split('/').pop();
    pending.push(...(node.childNodes ?? []), ...(node.content ? [node.content] : []));
  }
  return null;
}

test('an authored script after any record opener runs only where Chromium and parse5 agree it is HTML script text', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  // Each context is a srcdoc frame: it inherits the enforced policy of the page that holds it.
  const batches = [];
  for (let at = 0; at < CONTEXTS.length; at += 100) batches.push(CONTEXTS.slice(at, at + 100));
  const outcomes = [];
  for (const [number, batch] of batches.entries()) {
    const documents = batch.map(contextDocument);
    const url = `http://paqvilo-differential.test/${number}`;
    await page.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        headers: { 'content-security-policy': `script-src 'nonce-${FRAME_NONCE}'` },
        body: `<!doctype html><body>${documents.map((html) => `<iframe srcdoc="${srcdoc(html)}"></iframe>`).join('')}`,
      }),
    );
    await page.goto(url, { waitUntil: 'load' });
    const frames = await page.evaluate(() =>
      [...document.querySelectorAll('iframe')].map((frame) => {
        const win = frame.contentWindow;
        const find = (root) => {
          for (const element of root.querySelectorAll('*')) {
            if (element.localName === 'script' && element.id === 'T') return element;
            const inner = element.content && find(element.content);
            if (inner) return inner;
          }
          return null;
        };
        const target = find(frame.contentDocument);
        return {
          control: win.control ?? null,
          zqxinj: win.zqxinj ?? null,
          namespace: target ? target.namespaceURI.split('/').pop() : null,
          nonce: Boolean(target?.nonce),
        };
      }),
    );
    batch.forEach((opener, at) => outcomes.push({ opener, parse5: parse5Namespace(documents[at]), ...frames[at] }));
  }
  assert.equal(outcomes.length, CONTEXTS.length);
  for (const outcome of outcomes) {
    const label = JSON.stringify(outcome);
    // The source script before the opener ran with the nonce: the frame enforces the policy and the nonce is valid.
    assert.equal(outcome.control, 1, label);
    // The record never runs code, whichever namespace the browser gives the authored script.
    assert.equal(outcome.zqxinj, null, label);
    // An authored script that Chromium parses as foreign content (where its references decode) has no nonce, whatever
    // namespace parse5 gave it.
    if (outcome.namespace && outcome.namespace !== 'xhtml') assert.equal(outcome.nonce, false, label);
  }
  // The comparison covers both parsers' foreign content and the contexts where they disagree (select content).
  assert.ok(outcomes.some((outcome) => outcome.namespace === 'svg' && outcome.parse5 === 'svg'));
  assert.ok(outcomes.some((outcome) => outcome.opener === '' && outcome.nonce && outcome.namespace === 'xhtml'));
});
