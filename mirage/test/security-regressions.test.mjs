import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseFragment } from 'parse5';
import { createFilters } from '../lib/liquid-filters.mjs';
import { parseXmlDocument } from '../lib/fetchxml-engine.mjs';
import { parseCookies } from '../lib/auth-session.mjs';
import { JQUERY_CORE_SCRIPT, BOOTSTRAP_CORE_SCRIPT } from '../lib/source-dependencies.mjs';
import { clientPortalObjectRuntime } from '../lib/portal-client-object.mjs';
import { DataStore } from '../lib/data.mjs';
import { csvCell } from '../lib/csv.mjs';
import { derivePersona, __testing, HOSTED_RESOURCES, loadSourceCorpus } from '../parity-suite.mjs';

test('HTML safe escape preserves formatting and removes malformed, encoded, and foreign-content executable markup', () => {
  const sanitize = createFilters().html_safe_escape;
  const payloads = [
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<img src=x onerror=alert(1)><a href="java&#x73;cript:alert(1)">link</a>',
    '<a href="java\nscript:alert(1)" onclick="alert(1)">link</a>',
    '<svg><a xlink:href="javascript:alert(1)">link</a><script>alert(1)</script></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="data:text/html,x">x</object>',
    '<script>alert(1)</script ><p>safe</p>',
    '<img/src=x/onerror=alert(1)>',
  ];
  const allowed = new Set(['http:', 'https:', 'ftp:', 'mailto:', 'tel:']);
  for (const payload of payloads) {
    const output = sanitize(payload);
    const visit = (node) => {
      assert.ok(!['script', 'style', 'svg', 'math', 'iframe', 'object', 'embed', 'base', 'meta'].includes(node.tagName), output);
      for (const attr of node.attrs ?? []) {
        assert.ok(!attr.name.startsWith('on') && !['srcdoc', 'xlink:href'].includes(attr.name), output);
        if (['href', 'src'].includes(attr.name)) assert.ok(allowed.has(new URL(attr.value, 'https://fixture.invalid').protocol), output);
      }
      for (const child of node.childNodes ?? []) visit(child);
    };
    visit(parseFragment(output));
    assert.equal(sanitize(output), output, 'sanitizing twice must be stable');
  }
  assert.equal(sanitize('<p class="note">Hello <b>world</b> &amp; <a href="/details" title="Read">details</a><img src="/photo.png" alt="Photo"></p>'),
    '<p class="note">Hello <b>world</b> &amp; <a href="/details" title="Read">details</a><img src="/photo.png" alt="Photo" /></p>');
  assert.equal(sanitize('<p style="color: red; font-weight: bold; text-align: center; background: url(javascript:alert(1)); font-size: expression(alert(1))">Styled</p>'),
    '<p style="color:red;font-weight:bold;text-align:center">Styled</p>');
});

test('FetchXML scanner keeps quoted brackets, namespaces, instructions and decoded attributes, and rejects truncated input', () => {
  const xml = '<?xml version="1.0"?><!-- comment --><fetch xmlns:x="urn:test"><entity name="account"><filter><condition attribute="name" value="a &gt; b"/><condition attribute="name" value=\'quoted "value"\'/></filter></entity></fetch>';
  const parsed = parseXmlDocument(xml, { root: 'fetch' });
  assert.equal(parsed.attrs['xmlns:x'], 'urn:test');
  assert.equal(parsed.children[0].children[0].children[0].attrs.value, 'a > b');
  assert.equal(parsed.children[0].children[0].children[1].attrs.value, 'quoted "value"');
  for (const source of ['<!--', '<?xml', '<fetch a="unterminated>', '<fetch><entity</fetch>', '<fetch a=noquotes/>', '<fetch>'])
    assert.throws(() => parseXmlDocument(source), /Malformed|Unterminated|complete/);
});

test('dependency filename scanners preserve short legacy version/hash/modifier combinations', () => {
  const legacy = [
    /(?:^|\/)jquery(?:[.-](?:\d[\w.]*|min|slim))*\.js(?:[?#]|$)/i,
    /(?:^|\/)bootstrap(?:\.bundle|\.min|[.-](?:v?\d[\w.]*|[a-f0-9]{6,}))*\.js(?:[?#]|$)/i,
  ];
  const pieces = ['.min', '.slim', '.bundle', '-min', '-bundle', '-3.6', '.v3', '-abcdef', '.3.min', '.ui', '-1x', '.'];
  for (const [index, [name, matcher]] of [['jquery', JQUERY_CORE_SCRIPT], ['bootstrap', BOOTSTRAP_CORE_SCRIPT]].entries())
    for (const a of ['', ...pieces]) for (const b of ['', ...pieces]) {
      const value = '/scripts/' + name + a + b + '.js?v=1';
      assert.equal(matcher.test(value), legacy[index].test(value), value);
    }
  assert.equal(JQUERY_CORE_SCRIPT.test('/page?next=/jquery.js'), false);
});

test('hosted-resource classification parses actual hosts rather than hostname text in paths or credentials', () => {
  const hosted = (value) => HOSTED_RESOURCES.some((pattern) => pattern.test(value));
  for (const value of ['https://app.powerbi.com/embed', '//sub.powerbi.com/embed', 'https://js.monitor.azure.com/scripts/b/ai.3.min.js', '/js/powerbi-client.min.js']) assert.equal(hosted(value), true, value);
  for (const value of ['https://evil.invalid//powerbi.com/embed', 'https://evilpowerbi.com/embed', 'https://app.powerbi.com.evil.invalid/embed', 'https://powerbi.com@evil.invalid/embed', 'https://evil.invalid//js.monitor.azure.com/ai.3.min.js']) assert.equal(hosted(value), false, value);
});

test('adversarial XML and dependency filenames complete within a bounded worker process', () => {
  const xmlModule = new URL('../lib/fetchxml-engine.mjs', import.meta.url).href;
  const dependencyModule = new URL('../lib/source-dependencies.mjs', import.meta.url).href;
  const script = `import {parseXmlDocument} from ${JSON.stringify(xmlModule)};
    import {JQUERY_CORE_SCRIPT,BOOTSTRAP_CORE_SCRIPT} from ${JSON.stringify(dependencyModule)};
    for(const source of ['<!--'.repeat(50000), '<?'.repeat(50000), '<'.repeat(200000), '<fetch '+ '-="a'.repeat(50000)+'>']) {
      let rejected=false;try{parseXmlDocument(source);}catch{rejected=true;}if(!rejected)throw Error('Malformed XML accepted');
    }
    for(const [matcher,prefix] of [[JQUERY_CORE_SCRIPT,'jquery'],[BOOTSTRAP_CORE_SCRIPT,'bootstrap']]) {
      if(matcher.test('/'+prefix+'-0'+'.0'.repeat(50000)+'!'))throw Error('Invalid filename accepted');
      if(matcher.test('/'+prefix+'.min'.repeat(50000)+'!'))throw Error('Invalid filename accepted');
    }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('cookie and selected-column names cannot change object prototypes', () => {
  const cookies = parseCookies('__proto__=bad; constructor=value; toString=text; a=first; a=second');
  assert.equal(Object.getPrototypeOf(cookies), Object.prototype);
  assert.equal(Object.hasOwn(cookies, '__proto__'), true);
  assert.equal(cookies.__proto__, 'bad');
  assert.equal(cookies.a, 'first');
  const row = JSON.parse('{"itemid":"one","name":"Safe","__proto__":{"polluted":true}}');
  const store = new DataStore({ state: { mappings: { item: { idColumn: 'itemid' } }, tables: { item: [row] }, settings: { permissionMode: 'permissive' } } });
  const result = store.query('item', { $select: '__proto__,name' }).value[0];
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.polluted, undefined);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.name, 'Safe');
});

test('native CSV exports neutralize spreadsheet formulas while preserving signed numbers and CSV quoting', () => {
  for (const text of ['=1+1', '+SUM(A1:A2)', '-cmd|payload', '@SUM(A1)', '\t=1+1', '  =1+1'])
    assert.ok(csvCell(text).startsWith("'"), text);
  assert.equal(csvCell(-12.5), '-12.5'); assert.equal(csvCell('-12.50'), '-12.50');
  assert.equal(csvCell('+12'), '+12'); assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('a"b'), '"a""b"'); assert.equal(csvCell('Name'), 'Name');
});

test('source-corpus entity decoding never promotes double-encoded markup into source-derived reveal matches', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-corpus-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'page.html'), '&amp;lt;Double encoded&amp;gt; &lt;Once encoded&gt;');
  const corpus = await loadSourceCorpus(root);
  assert.equal(corpus.has('<Double encoded>'), false);
  assert.equal(corpus.has('&lt;Double encoded&gt;'), true);
  assert.equal(corpus.has('<Once encoded>'), true);
});

test('browser code construction keeps hostile JSON values as data', async () => {
  const hostile = '\\";globalThis.injected=true;//</script>\u2028\u2029';
  const context = vm.createContext({});
  context.window = context;
  const script = clientPortalObjectRuntime({ username: hostile }, { websiteId: hostile, language: hostile });
  assert.ok(!script.includes('</script>'));
  vm.runInContext(script, context);
  assert.equal(context.injected, undefined);
  assert.equal(context.Microsoft.Dynamic365.Portal.User.userName, hostile);
  const live = { async page(_path, options) {
    let received;
    const sandbox = { document: { querySelector(selector) { received = selector; return { value: 'Reader' }; } } };
    const value = vm.runInNewContext(options.probeExpression, sandbox);
    assert.equal(sandbox.injected, undefined);
    assert.equal(received, hostile);
    return { probeValue: value };
  } };
  assert.deepEqual((await derivePersona({ live, roleNames: ['Reader'], probe: { selector: hostile }, delayMs: 0 })).roles, ['Reader']);
  const driver = { ...live, origin: 'https://fixture.invalid' };
  driver.page = async (_path, options) => {
    let selector, attribute;
    const sandbox = { document: { querySelector(value) { selector = value; return { getAttribute(value) { attribute = value; return '/record?id=one'; } }; } } };
    const probeValue = vm.runInNewContext(options.probeExpression, sandbox);
    assert.equal(sandbox.injected, undefined); assert.equal(selector, hostile); assert.equal(attribute, hostile);
    return { probeValue };
  };
  const found = await __testing.discoverTarget(driver, { discover: { from: 'page', selector: hostile, attribute: hostile, path: '/' } });
  assert.ok(found, 'discovery executes the quoted selector and attribute as data');
});
