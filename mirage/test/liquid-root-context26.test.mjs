// @test-kind observation: two native Power Pages include renders per run (runSha256 per capture, 2026-11-08) in power-pages-original-scalar-context-evidence.json; the power-pages-original-scalar-context replay suite covers the same 25 recorded programs as includes under the same observed configuration, while this test also renders the original expressions with an explicit context object and pins the fixture hash, which the replay does not do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { observedConfig } from '../lib/project-config.mjs';

const portal = {
  templates: {},
  snippets: {},
  settings: {},
  pages: [],
  webFiles: [],
  records: [],
  weblinks: {},
  sitemarkers: {},
  website: {},
  pageTemplates: [],
};

test('observed scalar filters reproduce nine exact repeated native programs', async () => {
  const bytes = readFileSync(new URL('./fixtures/power-pages-original-scalar-context-evidence.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
  );
  const evidence = JSON.parse(bytes);
  const observed = {
    liquidEscapeOnce: 'passthrough',
    liquidStripHtmlScriptText: 'preserve',
    liquidFilterRegistration: 'observed',
    liquidHtmlVoidSerialization: 'html',
  };
  for (const n of ['010', '013', '014', '015', '016', '021', '022', '023', '024']) {
    const [first, second] = evidence.captures.map(
      (capture) => capture.cases.find((item) => item.id === `original-context-${n}`).facts,
    );
    assert.deepEqual(first, second, n);
    assert.equal(first.outcome, 'rendered-child', n);
    const engine = createPortalRenderer({ ...portal, observed });
    assert.equal(await engine.renderString(first.originalSource, first.input), first.output, n);
    const included = createPortalRenderer({
      ...portal,
      observed,
      templates: { proof: { id: 'proof', name: 'proof', source: first.nativeSource } },
    });
    assert.equal(await included.renderString("{% include 'proof' %}"), first.output, n);
  }
});

// @test-kind contract+security: observed text transforms are opt-in and do not alter the HTML sanitizer.
test('text transform observations preserve the default and sanitizer contracts', async () => {
  for (const [key, value] of Object.entries({
    liquidEscapeOnce: 'passthrough',
    liquidStripHtmlScriptText: 'preserve',
  })) {
    assert.throws(() => observedConfig({ [key]: value }), /evidence/);
    assert.equal(observedConfig({ [key]: value, evidence: 'fixture' })[key], value);
    assert.throws(() => observedConfig({ [key]: 'invalid', evidence: 'fixture' }), new RegExp(key));
  }
  const source = '{{ s | escape_once }}|{{ html | strip_html }}|{{ html | html_safe_escape }}';
  const input = { s: '1 &lt; 2 & 3', html: '<p>Hello</p><script>x</script><img src=x onerror=alert(1)>' };
  assert.equal(
    await createPortalRenderer(portal).renderString(source, input),
    '1 &lt; 2 &amp; 3|Hello|<p>Hello</p><img src="x" />',
  );
  const engine = createPortalRenderer({
    ...portal,
    observed: { liquidEscapeOnce: 'passthrough', liquidStripHtmlScriptText: 'preserve' },
  });
  assert.equal(await engine.renderString(source, input), '1 &lt; 2 & 3|Hellox|<p>Hello</p><img src="x" />');
});
