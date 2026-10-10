import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { SITE } from './fixture.mjs';

let dir;
let sources;
let versions;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rewrite-safety-'));
  sources = [];
  versions = new Map();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

function source(rel, base, text, props = {}) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  versions.set(file, base);
  sources.push({ rel, file, kind: 'web-template', mode: 'markup', ...props });
}
function makeRewriter(options = {}) {
  const baseline = { cache: new Map(), changedFiles: () => new Set(versions.keys()), show: (file) => versions.get(file) };
  return new HtmlRewriter({ model: { inlineSources: sources, languageCodes: new Set(['en-us', 'pl-pl']) }, site: SITE, baseline, ...options });
}
const rewrite = (body, url = '/', options = {}) => makeRewriter(options).rewrite(body, url);
const script = (rel, before, after) => source(rel, before, after, { kind: 'basic-form-js', mode: 'block', tag: 'script' });

test('page copy patches stay on the page they belong to', () => {
  source('copy.html', '<p>Shared original text</p>', '<p>Only this page changed</p>', { kind: 'page-copy', pageUrl: '/one' });
  const body = '<main><p>Shared original text</p></main>';
  assert.equal(rewrite(body, '/two').html, body);
  assert.equal(rewrite(body, '/en-US/one').html, '<main><p>Only this page changed</p></main>');
});

test('page sources with missing URL metadata cannot override other pages', () => {
  source('page.js', 'shared();', 'wrongPage();', { kind: 'page-js', mode: 'block', tag: 'script', pageUrl: null });
  source('copy.html', '<p>Shared text</p>', '<p>Wrong page</p>', { kind: 'page-copy', pageUrl: null });
  const body = '<script>shared();</script><p>Shared text</p>';
  assert.equal(rewrite(body).html, body);
});

test('Liquid string-literal whitespace changes are never treated as the same expression', () => {
  const before = `<p>{{ label | replace: 'two  spaces', 'one' }}</p>`;
  const after = `<b>{{ label | replace: 'two spaces', 'one' }}</b>`;
  source('template.html', before, after);
  const body = '<p>The original rendered value</p>';
  const result = rewrite(body);
  assert.equal(result.html, body);
  assert.match(result.notes[0].reason, /only the portal can evaluate/);
});

test('different values for a repeated Liquid expression cannot overwrite each other', () => {
  source('template.html', '<p>{{ item }}</p><b>{{ item }}</b>', '<p class="new">{{ item }}</p><b>{{ item }}</b>');
  const body = '<p>First result</p><b>Second result</b>';
  assert.equal(rewrite(body).html, body);
});

test('Liquid comment and capture bodies cannot patch unrelated matching rendered text', () => {
  for (const tag of ['comment', 'capture saved']) {
    source(`${tag}.html`, `{% ${tag} %}\n<p>Shared literal text</p>\n{% end${tag.split(' ')[0]} %}`, `{% ${tag} %}\n<p>Changed literal text</p>\n{% end${tag.split(' ')[0]} %}`);
  }
  const rewriter = makeRewriter();
  const body = '<p>Shared literal text</p>';
  assert.equal(rewriter.rewrite(body, '/').html, body);
  assert.equal(rewriter.unsupported.length, 2);
  assert.ok(rewriter.unsupported.every((item) => /comment\/capture body/.test(item.reason)));
});

test('Liquid raw bodies patch literal output markers without trying to evaluate them', () => {
  source('raw.html', '{% raw %}\n<p>{{ original }}</p>\n{% endraw %}', '{% raw %}\n<b>{{ changed }}</b>\n{% endraw %}');
  const result = rewrite('<p>{{ original }}</p>\n');
  assert.equal(result.html, '<b>{{ changed }}</b>\n');
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.notes, []);
});

test('multiline Liquid tags and outputs cannot use their inner lines as literal anchors', () => {
  source('tag.html', '{% assign name =\n  "Shared literal text"\n%}', '{% assign name =\n  "Changed literal text"\n%}');
  source('output.html', '{{\n  shared.value\n}}', '{{\n  changed.value\n}}');
  const body = '<script>\n  "Shared literal text"\n  shared.value\n</script>';
  const rewriter = makeRewriter();
  assert.equal(rewriter.rewrite(body, '/').html, body);
  assert.equal(rewriter.unsupported.length, 2);
});

test('Liquid output delimiters inside quoted filter arguments do not end the expression', () => {
  source('template.html', '<p>{{ label | replace: "}}", "x" }}</p>', '<b>{{ label | replace: "}}", "x" }}</b>');
  const result = rewrite('<p>Rendered result</p>');
  assert.equal(result.html, '<b>Rendered result</b>');
});

test('localized Values require an anchor that distinguishes their baseline languages', () => {
  const file = path.join(dir, 'localized.json');
  const before = ['<button>Shared action</button>\n<p>English context</p>\n', '<button>Shared action</button>\n<p>Polish context</p>\n'];
  const after = ['<button>Changed action</button>\n<p>English context</p>\n', before[1]];
  fs.writeFileSync(file, JSON.stringify(after));
  versions.set(file, JSON.stringify(before));
  sources = before.map((_, i) => ({ file, rel: `localized.json#value.${i}`, field: 'value', fieldPath: ['value'], lcid: i === 0 ? 1033 : 1045, kind: 'web-template', mode: 'markup', extract: raw => JSON.parse(raw)[i] }));
  const rewriter = makeRewriter();
  assert.equal(rewriter.rewrite(before[0], '/en-US/').html, after[0]);
  assert.equal(rewriter.rewrite(before[1], '/pl-PL/').html, before[1]);
  assert.deepEqual(rewriter.unsupported, []);
});

test('identical localized baseline Values are refused instead of cross-applying a language edit', () => {
  const file = path.join(dir, 'localized.json');
  const before = '<button>Shared action</button>';
  fs.writeFileSync(file, JSON.stringify(['<button>English edit</button>', before]));
  versions.set(file, JSON.stringify([before, before]));
  sources = [1033, 1045].map((lcid, i) => ({ file, rel: `localized.json#value.${i}`, field: 'value', fieldPath: ['value'], lcid, kind: 'web-template', mode: 'markup', extract: raw => JSON.parse(raw)[i] }));
  const rewriter = makeRewriter();
  for (const url of ['/en-US/', '/pl-PL/']) assert.equal(rewriter.rewrite(before, url).html, before);
  assert.equal(rewriter.unsupported.length, 1);
  assert.match(rewriter.unsupported[0].reason, /another localized Value/);
});

test('unreadable extracted fields and inactive parents have format-neutral diagnostics', () => {
  source('form.yml', 'before', 'invalid', { kind: 'web-template', extract: () => null, format: 'yaml', field: '0.adx_description' });
  const model = { inlineSources: sources, inactiveSources: [{ file: sources[0].file, rel: 'form.yml#inactive' }] };
  const rewriter = makeRewriter({ model });
  assert.ok(rewriter.unsupported.some((item) => /record or its parent is inactive/.test(item.reason)));
  assert.ok(rewriter.unsupported.some((item) => /source field.*metadata/.test(item.reason)));
  assert.ok(rewriter.unsupported.every((item) => !/<content>|not valid JSON|root page is inactive/.test(item.reason)));
});

test('classic language page copy and snippet anchors grow to distinguish variants', () => {
  for (const kind of ['page-copy', 'content-snippet']) {
    sources = [];
    versions.clear();
    const suffix = kind === 'page-copy' ? 'webpage.copy.html' : 'contentsnippet.value.html';
    const english = '<button>Shared action</button>\n<p>English context</p>\n';
    const polish = '<button>Shared action</button>\n<p>Polish context</p>\n';
    source(`Value.en-US.${suffix}`, english, english.replace('Shared action', 'English edit'), { kind, pageUrl: kind === 'page-copy' ? '/one' : null, snippetName: 'Actions' });
    source(`Value.pl-PL.${suffix}`, polish, polish, { kind, pageUrl: kind === 'page-copy' ? '/one' : null, snippetName: 'Actions' });
    const rewriter = makeRewriter();
    assert.equal(rewriter.rewrite(english, '/en-US/one').html, english.replace('Shared action', 'English edit'));
    assert.equal(rewriter.rewrite(polish, '/pl-PL/one').html, polish);
    assert.deepEqual(rewriter.unsupported, []);
    versions.set(sources[1].file, english);
    const ambiguous = makeRewriter();
    assert.equal(ambiguous.rewrite(english, '/one').html, english);
    assert.ok(ambiguous.unsupported.some((item) => /language cannot be determined safely/.test(item.reason)));
  }
});

test('classic page-script language variants cannot claim an identical rendered baseline', () => {
  for (const [locale, text] of [['en-US', 'english();'], ['pl-PL', 'polish();']]) {
    source(`web-pages/one/content-pages/One.${locale}.webpage.custom_javascript.js`, 'shared();', text, { kind: 'page-js', mode: 'block', tag: 'script', pageUrl: '/one' });
  }
  const body = '<html><body><script>shared();</script></body></html>';
  const result = rewrite(body, '/one');
  assert.equal(result.html, body);
  assert.equal(result.applied.length, 0);
  assert.match(result.notes[0].reason, /language variants.*identity cannot be determined safely/);
  for (const file of versions.keys()) versions.set(file, '');
  const fresh = rewrite('<html><body></body></html>', '/one');
  assert.equal(fresh.applied.length, 0);
  assert.match(fresh.notes[0].reason, /language variants.*baseline/);
  versions.set(sources[0].file, 'englishOriginal();');
  versions.set(sources[1].file, 'polish();');
  const distinct = rewrite('<script>englishOriginal();</script>', '/one');
  assert.equal(distinct.html, '<script>english();</script>');
  assert.deepEqual(distinct.notes, []);
  assert.equal(rewrite('<script>polish();</script>', '/one').html, '<script>polish();</script>');
});

test('new snippet expressions refuse differing language Values but allow identical ones', () => {
  source('template.html', '<nav>Original</nav>', '<nav>{{ snippets["Action"] }}</nav>');
  source('Action.en-US.contentsnippet.value.html', 'English', 'English', { kind: 'content-snippet', snippetName: 'Action' });
  source('Action.pl-PL.contentsnippet.value.html', 'Polish', 'Polish', { kind: 'content-snippet', snippetName: 'Action' });
  const body = '<nav>Original</nav>';
  const result = rewrite(body);
  assert.equal(result.html, body);
  assert.match(result.notes[0].reason, /differing local language variants.*language cannot be determined safely/);
  fs.writeFileSync(sources[2].file, 'English');
  assert.equal(rewrite(body).html, '<nav>English</nav>');
});

test('script-looking text inside comments and raw-text elements is left intact', () => {
  script('form.js', 'old();', 'new();');
  const inert = '<!-- <script>old();</script> --><textarea><script>old();</script></textarea><title><script>old();</script></title>';
  assert.equal(rewrite(`${inert}<script>old();</script>`).html, `${inert}<script>new();</script>`);
});

test('HTML malformed-comment recovery matches browser script boundaries', () => {
  script('form.js', 'old();', 'new();');
  for (const comment of ['<!-->', '<!--->', '<!-- example --!>', '<?probe <script>old();</script>']) {
    assert.equal(rewrite(`${comment}<script>old();</script>`).html, `${comment}<script>new();</script>`);
  }
});

test('quoted > characters and src-like attribute text do not confuse script detection', () => {
  script('form.js', 'old();', 'new();');
  const opening = '<SCRIPT data-note="x > y; src=example" type="text/javascript">';
  assert.equal(rewrite(`${opening}old();</SCRIPT >`).html, `${opening}new();</SCRIPT >`);
});

test('HTML script boundaries accept closing-tag attributes without confusing custom elements', () => {
  script('form.js', 'old();', 'new();');
  for (const closing of ['</script ignored>', '</script/>', '</script data-note="x > y">']) {
    assert.equal(rewrite(`<script>old();${closing}<p>After</p>`).html, `<script>new();${closing}<p>After</p>`);
  }
  const custom = '<script.foo>old();</script.foo><script>old();</script>';
  assert.equal(rewrite(custom).html, '<script.foo>old();</script.foo><script>new();</script>');
});

test('HTML double-escaped script text does not end the executable block early', () => {
  const before = "const a = '<!--<script>';\nconst b = '</script>';\nwindow.probe = 1;";
  const after = before.replace('probe = 1', 'probe = 2');
  script('form.js', before, after);
  assert.equal(rewrite(`<script>${before}</script>`).html, `<script>${after}</script>`);
});

test('script double-escaped --!> stays script text rather than using normal comment recovery', () => {
  const before = "const a = '<!--<script>--!>';\nconst b = '</script>';\nwindow.probe = 1;";
  const after = before.replace('probe = 1', 'probe = 2');
  script('form.js', before, after);
  assert.equal(rewrite(`<script>${before}</script><p>After</p>`).html, `<script>${after}</script><p>After</p>`);
});

test('local inline code cannot close its HTML element early or hide its closing tag', () => {
  for (const after of ['const label = "</script>";', 'const label = "<!--<script>";']) {
    sources = [];
    versions.clear();
    script('form.js', 'old();', after);
    const body = '<script>old();</script><p>After</p>';
    const result = rewrite(body);
    assert.equal(result.html, body);
    assert.deepEqual(result.applied, []);
    assert.match(result.notes[0].reason, /HTML closing boundary/);
  }
  sources = [];
  versions.clear();
  source('style.css', '.old {}', '.new { content: "</style>"; }', { kind: 'page-css', mode: 'block', tag: 'style', pageUrl: '/' });
  const body = '<style>.old {}</style><p>After</p>';
  assert.equal(rewrite(body).html, body);
});

test('new page blocks with HTML closing-boundary text are diagnosed before injection', () => {
  source('page.js', '', 'const label = "</script>";', { kind: 'page-js', mode: 'block', tag: 'script', pageUrl: '/' });
  const body = '<html><body></body></html>';
  const result = rewrite(body);
  assert.equal(result.html, body);
  assert.equal(result.applied.length, 0);
  assert.match(result.notes[0].reason, /HTML closing boundary/);
  assert.match(rewrite(body, '/', { sourceMaps: true }).html, /src="\/__paqvilo\/inline\/page.js"/);
});

test('unterminated tags are consumed once even when they contain many apparent tag starts', { timeout: 5000 }, () => {
  script('form.js', 'old();', 'new();');
  const rewriter = makeRewriter();
  for (const body of ['<script '.repeat(100_000), `<script>old();${'</script '.repeat(100_000)}`]) {
    assert.equal(rewriter.rewrite(body, '/').html, body);
  }
});

test('browser-supported script MIME and language values are recognized after HTML decoding', () => {
  script('form.js', 'old();', 'new();');
  for (const attrs of ['type="application/x-javascript"', 'type="text/javascript1.5"', 'type="text/jscript"', 'type="text&#x2f;javascript"', 'type="text&sol;javascript"', 'language="javascript"', 'language=""']) {
    assert.equal(rewrite(`<script ${attrs}>old();</script>`).html, `<script ${attrs}>new();</script>`);
  }
  const inert = '<script language="vbscript">old();</script>';
  assert.equal(rewrite(inert).html, inert);
});

test('an empty script type is JavaScript, while external scripts and non-CSS styles remain intact', () => {
  script('form.js', 'old();', 'new();');
  source('style.css', '.old {}', '.new {}', { kind: 'page-css', mode: 'block', tag: 'style', pageUrl: '/' });
  assert.equal(rewrite('<script type="">old();</script>').html, '<script type="">new();</script>');
  const body = '<script src="/file.js">old();</script><style type="text/less">.old {}</style>';
  assert.equal(rewrite(body).html, body);
});

test('source maps keep inline modules in place to preserve relative import URLs', () => {
  script('form.js', 'import "./module.js";', 'import "./new-module.js";');
  const body = '<script type="module" async>import "./module.js";</script>';
  assert.equal(rewrite(body, '/', { sourceMaps: true }).html, '<script type="module" async>import "./new-module.js";</script>');
});

test('source maps preserve relative dynamic imports in existing and newly injected classic scripts', () => {
  script('form.js', 'import("./module.js");', 'import /* comment */ ("./new-module.js");');
  const body = '<script>import("./module.js");</script>';
  assert.equal(rewrite(body, '/', { sourceMaps: true }).html, '<script>import /* comment */ ("./new-module.js");</script>');
  source('page.js', '', 'import("./page.js");', { kind: 'page-js', mode: 'block', tag: 'script', pageUrl: '/' });
  assert.equal(rewrite('<html><body></body></html>', '/', { sourceMaps: true }).html, '<html><body><script type="text/javascript">\nimport("./page.js");\n</script>\n</body></html>');
});

test('externalising a classic script preserves async-like text inside other attributes', () => {
  script('form.js', 'old();', 'new();');
  const result = rewrite('<script data-note="use async mode" async defer>old();</script>', '/', { sourceMaps: true });
  assert.equal(result.html, '<script data-note="use async mode" src="/__paqvilo/inline/form.js"></script>');
});

test('externalising a classic script removes integrity that only becomes active with src', () => {
  script('form.js', 'old();', 'new();');
  const result = rewrite('<script nonce="local" integrity="sha256-stale" data-note="integrity=keep">old();</script>', '/', { sourceMaps: true });
  assert.equal(result.html, '<script nonce="local" data-note="integrity=keep" src="/__paqvilo/inline/form.js"></script>');
});

test('every repeated snippet is patched, including occurrences past 200', () => {
  source('snippet.html', 'Original repeated snippet', 'Updated repeated snippet', { kind: 'content-snippet' });
  const result = rewrite('<p>Original repeated snippet</p>\r\n'.repeat(1_000));
  assert.equal(result.html, '<p>Updated repeated snippet</p>\r\n'.repeat(1_000));
  assert.equal(result.applied[0].action, 'patched 1000 changes');
});

test('equally matching clones with different local contents are reported instead of guessed', () => {
  script('first.js', 'shared();', 'local();');
  script('second.js', 'shared();', 'shared();');
  const body = '<script>shared();</script>';
  const result = rewrite(body);
  assert.equal(result.html, body);
  assert.match(result.notes[0].reason, /multiple local sources/);
});

test('new page scripts are inserted at a real body closing tag, not one printed in a comment', () => {
  source('page.js', '', 'fresh();', { kind: 'page-js', mode: 'block', tag: 'script', pageUrl: '/' });
  const body = '<html><head></head><body>content</body></html><!-- example: </body> -->';
  assert.equal(rewrite(body).html, '<html><head></head><body>content<script type="text/javascript">\nfresh();\n</script>\n</body></html><!-- example: </body> -->');
  const fragment = '<textarea>example: </body></textarea><!-- </body> -->';
  assert.equal(rewrite(fragment).html, fragment);
});

test('incremental refresh reads only saved files; full refresh invalidates every source', () => {
  for (let i = 0; i < 100; i++) script(`form-${i}.js`, `before${i}();`, `after${i}();`);
  const rewriter = makeRewriter();
  const originalRead = fs.readFileSync;
  const readFiles = [];
  fs.readFileSync = function (file, ...args) {
    readFiles.push(file);
    return originalRead.call(this, file, ...args);
  };
  try {
    fs.writeFileSync(sources[0].file, 'saved0();');
    rewriter.refresh([sources[0].file]);
    assert.deepEqual(readFiles, [sources[0].file]);
    assert.equal(rewriter.rewrite('<script>before0();</script>', '/').html, '<script>saved0();</script>');
    assert.equal(rewriter.rewrite('<script>before1();</script>', '/').html, '<script>after1();</script>');
    fs.writeFileSync(sources[1].file, 'saved1();');
    readFiles.length = 0;
    rewriter.refresh();
    assert.equal(readFiles.length, 100);
    assert.equal(rewriter.rewrite('<script>before1();</script>', '/').html, '<script>saved1();</script>');
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('enhanced sources sharing a file share the raw read but retain separate extracted fields', () => {
  const file = path.join(dir, 'component.xml');
  fs.writeFileSync(file, JSON.stringify({ js: 'changed();', copy: '<p>Changed copy</p>' }));
  versions.set(file, JSON.stringify({ js: 'original();', copy: '<p>Original copy</p>' }));
  sources.push(
    { rel: 'component.xml#js', file, kind: 'page-js', pageUrl: '/', mode: 'block', tag: 'script', extract: (raw) => JSON.parse(raw).js },
    { rel: 'component.xml#copy', file, kind: 'page-copy', pageUrl: '/', mode: 'markup', extract: (raw) => JSON.parse(raw).copy },
  );
  const rewriter = makeRewriter();
  assert.equal(rewriter.sourceCache.size, 1);
  assert.equal(rewriter.rewrite('<script>original();</script><p>Original copy</p>', '/').html, '<script>changed();</script><p>Changed copy</p>');
  fs.writeFileSync(file, JSON.stringify({ js: 'saved();', copy: '<p>Saved copy</p>' }));
  rewriter.refresh([file]);
  assert.equal(rewriter.rewrite('<script>original();</script><p>Original copy</p>', '/').html, '<script>saved();</script><p>Saved copy</p>');
});

test('cached source reads reject a directory replaced by an external junction', () => {
  script('mapped/form.js', 'original();', 'local();');
  const rewriter = makeRewriter({ model: { sourceDir: dir, inlineSources: sources } });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rewrite-outside-'));
  const mapped = path.join(dir, 'mapped');
  fs.writeFileSync(path.join(outside, 'form.js'), 'outsideSecret();');
  fs.renameSync(mapped, path.join(dir, 'original-directory'));
  fs.symlinkSync(outside, mapped, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    // An unrelated refresh must validate even a still-cached file, not only invalidated paths.
    rewriter.refresh([]);
    assert.equal(rewriter.sourceCache.size, 0);
    assert.equal(rewriter.rewrite('<script>original();</script>', '/').html, '<script>original();</script>');
  } finally {
    fs.unlinkSync(mapped);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('unchanged derived lines are reused, and a formerly identical baseline still matches after a rewrite', () => {
  script('form.js', 'original();', 'original();');
  const rewriter = makeRewriter();
  const lines = rewriter.blocks[0].lines;
  rewriter.refresh([]);
  assert.equal(rewriter.blocks[0].lines, lines);
  fs.writeFileSync(sources[0].file, 'completelyDifferent();');
  rewriter.refresh([sources[0].file]);
  assert.notEqual(rewriter.blocks[0].lines, lines);
  assert.equal(rewriter.rewrite('<script>original();</script>', '/').html, '<script>completelyDifferent();</script>');
});

test('large markup files keep safe distant edits separate from unchanged Liquid logic', () => {
  const before = Array.from({ length: 8000 }, (_, i) => `<p>Unique literal ${i}</p>\n`);
  before[4000] = '{% if user %}\n';
  const after = [...before];
  after[1] = '<p>First safe edit</p>\n';
  after[7998] = '<p>Last safe edit</p>\n';
  source('large-template.html', before.join(''), after.join(''));
  const rewriter = makeRewriter();
  assert.deepEqual(rewriter.unsupported, []);
  const rendered = before.join('').replace('{% if user %}', '');
  const result = rewriter.rewrite(rendered, '/');
  assert.ok(result.html.includes('First safe edit'));
  assert.ok(result.html.includes('Last safe edit'));
  assert.equal(result.applied[0].action, 'patched 2 changes');
});

test('async construction preloads stable sources with bounded concurrency and shared changed state', async () => {
  for (let i = 0; i < 40; i++) script(`form-${i}.js`, `original${i}();`, `local${i}();`);
  const changed = new Set(versions.keys());
  const baseline = { cache: new Map(), changedFiles: () => { throw new Error('shared changed state must avoid another Git scan'); }, show: (file) => versions.get(file) };
  const open = fs.promises.open;
  const syncRead = fs.readFileSync;
  let running = 0;
  let maximum = 0;
  let synchronous = 0;
  fs.promises.open = async (...args) => {
    maximum = Math.max(maximum, ++running);
    let handle;
    try { handle = await open(...args); } catch (error) { running--; throw error; }
    const close = handle.close.bind(handle);
    handle.close = async () => { try { return await close(); } finally { running--; } };
    return handle;
  };
  fs.readFileSync = (...args) => { synchronous++; return syncRead(...args); };
  try {
    const rewriter = await HtmlRewriter.create({ model: { sourceDir: dir, inlineSources: sources }, site: SITE, baseline, changedFiles: changed });
    assert.equal(synchronous, 0);
    assert.ok(maximum > 1 && maximum <= 16);
    assert.equal(rewriter.rewrite('<script>original0();</script>', '/').html, '<script>local0();</script>');
    rewriter.refresh([]);
    assert.equal(synchronous, 0);
  } finally {
    fs.promises.open = open;
    fs.readFileSync = syncRead;
  }
});

test('async construction retries a source that finishes saving during prefetch', async () => {
  script('form.js', 'original();', 'firstLocal();');
  const open = fs.promises.open;
  let saved = false;
  fs.promises.open = async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle);
    handle.read = async (...input) => {
      const result = await read(...input);
      if (!saved && args[0] === sources[0].file) {
        saved = true;
        fs.writeFileSync(sources[0].file, 'finishedSavingTheLatestVersion();');
      }
      return result;
    };
    return handle;
  };
  try {
    const baseline = { cache: new Map(), changedFiles: () => new Set(versions.keys()), show: (file) => versions.get(file) };
    const rewriter = await HtmlRewriter.create({ model: { sourceDir: dir, inlineSources: sources }, site: SITE, baseline });
    assert.equal(rewriter.rewrite('<script>original();</script>', '/').html, '<script>finishedSavingTheLatestVersion();</script>');
  } finally {
    fs.promises.open = open;
  }
});

test('async construction revalidates early files after other reads finish', async () => {
  script('first.js', 'firstOriginal();', 'firstLocal();');
  script('second.js', 'secondOriginal();', 'secondLocal();');
  const open = fs.promises.open;
  const realpath = fs.promises.realpath;
  let firstClosed = false;
  let releaseFirst;
  const firstReady = new Promise((resolve) => { releaseFirst = resolve; });
  fs.promises.realpath = async (...args) => {
    const result = await realpath(...args);
    if (args[0] === sources[0].file && firstClosed) setImmediate(releaseFirst);
    return result;
  };
  fs.promises.open = async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.close = async () => { await close(); if (args[0] === sources[0].file) firstClosed = true; };
    handle.read = async (...input) => {
      const result = await read(...input);
      if (args[0] === sources[1].file) {
        await firstReady;
        fs.writeFileSync(sources[0].file, 'latestSavedWhileAnotherSourceWasLoading();');
      }
      return result;
    };
    return handle;
  };
  try {
    const baseline = { changedFiles: () => new Set(versions.keys()), show: (file) => versions.get(file) };
    const rewriter = await HtmlRewriter.create({ model: { sourceDir: dir, inlineSources: sources }, site: SITE, baseline });
    assert.equal(rewriter.rewrite('<script>firstOriginal();</script>', '/').html, '<script>latestSavedWhileAnotherSourceWasLoading();</script>');
  } finally {
    fs.promises.open = open;
    fs.promises.realpath = realpath;
  }
});

test('explicit source revalidation invalidates only stale bytes and follows the shared changed snapshot', () => {
  script('first.js', 'firstOriginal();', 'firstLocal();');
  script('second.js', 'secondOriginal();', 'secondLocal();');
  const changed = new Set([sources[0].file]);
  const rewriter = makeRewriter({ changedFiles: changed, site: { ...SITE, scope: 'changed' } });
  fs.writeFileSync(sources[1].file, 'latestSecond();');
  changed.delete(sources[0].file);
  changed.add(sources[1].file);
  const originalRead = fs.readFileSync;
  const reads = [];
  fs.readFileSync = (file, ...args) => { reads.push(file); return originalRead(file, ...args); };
  try {
    rewriter.refresh([], { revalidate: true });
    assert.deepEqual(reads, [sources[1].file]);
    assert.equal(rewriter.rewrite('<script>firstLocal();</script><script>secondOriginal();</script>', '/').html, '<script>firstLocal();</script><script>latestSecond();</script>');
    assert.equal(rewriter.blocks.find((block) => block.rel === 'first.js').active, false);
    assert.equal(rewriter.blocks.find((block) => block.rel === 'second.js').active, true);
  } finally { fs.readFileSync = originalRead; }
});
