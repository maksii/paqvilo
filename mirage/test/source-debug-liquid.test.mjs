// @test-kind contract: debugger annotations preserve Liquid data while retaining executable script maps and original locations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { debugMarkup } from '../lib/source-debug.mjs';
import { tokenize } from '../lib/liquid-engine.mjs';
import { profileFixture } from './fixtures/deployment-profiles.mjs';

test('debugger skips quoted script markup in Liquid output and tag tokens', async (t) => {
  const fixture = await profileFixture(t),
    file = path.join(fixture.sourceDir, 'Quoted.webtemplate.source.html');
  const expression = "{{ '<b>label</b><img src=x onerror=bad()><script>bad()</script>' | html_safe_escape }}";
  const assignment = "{% assign markup = '<script>alsoData()</script>' %}";
  const script = '<script>window.authored = true;</script>';
  const source = expression + '\n' + assignment + '\n' + script;
  await fs.writeFile(file, source);
  const edits = [];
  const actual = debugMarkup(source, file, { onEdits: (rows) => edits.push(...rows) });
  assert.ok(actual.startsWith(expression + '\n' + assignment + '\n<script>window.authored = true;'));
  assert.equal(edits.length, 1, 'only authored executable script receives a trailer');
  assert.equal(edits[0].from, source.indexOf('window.authored'));
  assert.match(actual, /\?inline=1/);
  assert.doesNotMatch(actual, /\?inline=2/);
  const encoded = /sourceMappingURL=data:application\/json;charset=utf-8;base64,([\w+/=]+)/.exec(actual)[1];
  const map = JSON.parse(Buffer.from(encoded, 'base64'));
  assert.deepEqual(map.sourcesContent, [source]);
  assert.match(actual, /window.authored = true;\n\/\/# sourceURL=/);
});

test('unterminated Liquid tokens cannot acquire script trailers in their parse error text', async (t) => {
  const fixture = await profileFixture(t),
    file = path.join(fixture.sourceDir, 'Unterminated.webtemplate.source.html');
  for (const source of ["{{ '<script>data()</script>' | escape", "{% assign markup = '<script>data()</script>'"]) {
    await fs.writeFile(file, source);
    assert.equal(debugMarkup(source, file), source);
  }
});

test('raw token-looking text retains executable HTML script mapping', async (t) => {
  const fixture = await profileFixture(t),
    file = path.join(fixture.sourceDir, 'Raw.webtemplate.source.html');
  const source = "{% raw %}{{ '<script>window.raw = true;</script>' }}{% endraw %}";
  await fs.writeFile(file, source);
  const edits = [];
  const actual = debugMarkup(source, file, { onEdits: (rows) => edits.push(...rows) });
  assert.equal(edits.length, 1);
  assert.equal(edits[0].from, source.indexOf('window.raw'));
  assert.match(actual, /window.raw = true;\n\/\/# sourceURL=/);
  assert.ok(actual.startsWith("{% raw %}{{ '<script>"));
  assert.ok(actual.endsWith("</script>' }}{% endraw %}"));
});

test('quoted Liquid delimiters stay data and backslashes follow parser quote semantics', async (t) => {
  const fixture = await profileFixture(t),
    file = path.join(fixture.sourceDir, 'Delimiters.webtemplate.source.html');
  const quoted = [
    "{{ '}}<script>quotedOutput()</script>' | escape }}",
    '{% assign value = "%}<script>quotedTag()</script>" %}',
    String.raw`{{ '\' }}`,
    String.raw`{{ "\" }}`,
  ];
  const executable = '<script>window.actual = true;</script>';
  for (const token of quoted) {
    const source = token + '\n' + executable;
    assert.equal(tokenize(source)[0], token, 'debug scanner uses the same termination as the Liquid parser');
    await fs.writeFile(file, source);
    const edits = [];
    const actual = debugMarkup(source, file, { onEdits: (rows) => edits.push(...rows) });
    assert.equal(edits.length, 1);
    assert.equal(edits[0].from, source.indexOf('window.actual'));
    assert.ok(actual.startsWith(token + '\n<script>window.actual = true;'));
    assert.match(actual, /\?inline=1/);
  }
});

test('raw body quotes and unmatched tokens cannot consume endraw or later Liquid data', async (t) => {
  const fixture = await profileFixture(t),
    file = path.join(fixture.sourceDir, 'Raw-boundary.webtemplate.source.html');
  const source = `{% raw %}<script>window.raw = "{% unfinished";</script>{% endraw %}{{ '}}<script>data()</script>' | escape }}<script>window.actual = true;</script>`;
  await fs.writeFile(file, source);
  const edits = [];
  const actual = debugMarkup(source, file, { onEdits: (rows) => edits.push(...rows) });
  assert.equal(edits.length, 2);
  assert.deepEqual(
    edits.map((edit) => edit.from).sort((a, b) => a - b),
    [source.indexOf('window.raw'), source.indexOf('window.actual')],
  );
  assert.ok(actual.includes("{{ '}}<script>data()</script>' | escape }}"));
});
