// @test-kind security: contextual condition substitution and label stripping of hostile markup do work linear in its length.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contextualViewFetchXml, plainText, renderComponent } from '../lib/platform.mjs';

// The work bound, at both sizes: each scan that must read the hostile run steps over it (so the counted scanners, not an
// uncounted pattern, decided the input), and the total stays within a small multiple of the input length. A rescan or
// backtracking regression grows with the square of the run and exceeds the bound by orders of magnitude.
const RUN_SCALES = [1, 2];
const SCAN_FACTOR = 4;
const SCAN_SLACK = 64;

function assertLinearWork(work, length, label, { run = length, readers = 1 } = {}) {
  assert.ok(
    work >= readers * run - SCAN_SLACK && work <= SCAN_FACTOR * length + SCAN_SLACK,
    `${label}: ${work} positions for ${length}`,
  );
}

test('contextual view substitution preserves unknown attributes and quoted tag delimiters', () => {
  const source =
    '<fetch><entity name="item"><filter><condition note="literal > and /> text" uitype="contact" value = \'old\' custom="kept"/><condition uitype="account" custom=\'a/>b\' /><condition uitype="adx_website" ><value>untouched child</value></condition></filter></entity></fetch>';
  const expected =
    '<fetch><entity name="item"><filter><condition note="literal > and /> text" uitype="contact" value="person&amp;one" custom="kept"/><condition uitype="account" custom=\'a/>b\'  value="account"/><condition uitype="adx_website" value="site" ><value>untouched child</value></condition></filter></entity></fetch>';
  assert.equal(
    contextualViewFetchXml(source, {
      user: { contactId: 'person&one', accountId: 'account' },
      website: { id: 'site' },
    }),
    expected,
  );
  assert.equal(
    contextualViewFetchXml('<CONDITION UITYPe=\'contact\' VALUE = "old" data-note="value=\'not the value\'"/>', {
      identity: { id: 'person' },
    }),
    '<CONDITION UITYPe=\'contact\' value="person" data-note="value=\'not the value\'"/>',
  );
  assert.equal(
    contextualViewFetchXml("<condition note=\"uitype='contact' value='literal'\"/>", { identity: { id: 'person' } }),
    "<condition note=\"uitype='contact' value='literal'\"/>",
  );
  for (const source of [
    '<condition data-uitype="contact" value="old"/>',
    '<condition custom:uitype="contact" value="old"/>',
  ])
    assert.equal(contextualViewFetchXml(source, { identity: { id: 'person' } }), source);
  assert.equal(
    contextualViewFetchXml('<condition uitype="contact" custom:value="old" data-value="kept"/>', {
      identity: { id: 'person' },
    }),
    '<condition uitype="contact" custom:value="old" data-value="kept" value="person"/>',
  );
});

test('contextual conditions retain missing-principal defaults and leave unknown or unterminated markup authored', () => {
  assert.equal(
    contextualViewFetchXml('<condition uitype="contact"/>'),
    '<condition uitype="contact" value="00000000-0000-0000-0000-000000000000"/>',
  );
  assert.equal(
    contextualViewFetchXml('<condition uitype="account"/>', { user: { parentcustomerid: { id: 'parent' } } }),
    '<condition uitype="account" value="parent"/>',
  );
  for (const source of [
    '<condition uitype="unknown"/>',
    '<condition uitype="constructor"/>',
    '<condition uitype="__proto__"/>',
    '<condition uitype="contact"',
    '<condition uitype="contact" note="unterminated >',
    '<condition uitype="contact" value=unquoted/>',
  ])
    assert.equal(contextualViewFetchXml(source, { user: { id: 'person' } }), source);
  assert.equal(
    contextualViewFetchXml('<condition uitype="contact"/ \t>'),
    '<condition uitype="contact" value="00000000-0000-0000-0000-000000000000"/ \t>',
  );
});

test('condition scanning remains bounded for repeated incomplete tags and long closing whitespace', () => {
  for (const scale of RUN_SCALES) {
    const incomplete = '<condition '.repeat(1000 * scale),
      spaces = ' '.repeat(5000 * scale),
      source = '<condition uitype="contact"' + spaces + '>';
    let stats = { positions: 0 };
    assert.equal(contextualViewFetchXml(incomplete, { user: { id: 'person' } }, stats), incomplete);
    assertLinearWork(stats.positions, incomplete.length, 'repeated incomplete tags');
    stats = { positions: 0 };
    assert.equal(
      contextualViewFetchXml(source, { user: { id: 'person' } }, stats),
      '<condition uitype="contact" value="person"' + spaces + '>',
    );
    // The tag-end, attribute and closing-whitespace scans each step over the spaces.
    assertLinearWork(stats.positions, source.length, 'long closing whitespace', { run: spaces.length, readers: 3 });
  }
});

async function renderSectionLabel(label) {
  const portal = {
    forms: [{ id: 'form', name: 'Invented', mode: 100000000 }],
    records: [],
    website: { id: 'site' },
    pages: [],
    settings: {},
  };
  const schemas = {
    form: {
      entity: 'item',
      title: 'Invented',
      fields: [],
      layout: [{ name: 'main', columns: [{ sections: [{ name: 'section', label, showLabel: false, rows: [] }] }] }],
    },
  };
  const store = {
    resolveMapping: () => ({ idColumn: 'itemid', entitySet: 'items' }),
    allowed: () => true,
    query: async () => ({ value: [] }),
  };
  return renderComponent(
    'entityform',
    'Invented',
    { request: { params: {} }, user: { id: 'person' } },
    { portal, schemas, store },
  );
}

test('plain native section labels retain legacy tag stripping, whitespace entities and malformed tails', async () => {
  for (const [label, expected] of [
    ['<b>Title</b>&nbsp;<i>More</i>', 'Title More'],
    ['before <broken', 'before &lt;broken'],
    ['<<b>Title</b>', 'Title'],
    ["before <a title='a/>b'>after</a> tail", 'before b&#39;&gt;after tail'],
  ])
    assert.ok((await renderSectionLabel(label)).includes('<fieldset aria-label="' + expected + '">'), label);
});

test('native labels with many unmatched opening delimiters remain authored without quadratic stripping', async () => {
  for (const scale of RUN_SCALES) {
    const count = 5000 * scale,
      label = '<'.repeat(count) + 'tail',
      stats = { positions: 0 };
    assert.ok((await renderSectionLabel(label)).includes('<fieldset aria-label="' + '&lt;'.repeat(count) + 'tail">'));
    // The section label is rendered through this stripper.
    assert.equal(plainText(label, stats), label);
    assertLinearWork(stats.positions, label.length, 'unmatched opening delimiters');
  }
});
