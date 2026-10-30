import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseSolutionXml } from '../lib/solution-xml.mjs';
import { classifySolutionPath } from '../lib/solution-schema.mjs';
import { createSolutionMetadataOverlay } from '../lib/dataverse-solution-metadata.mjs';
import { decodeXml } from '../lib/importer.mjs';

test('solution XML scans delimiters and attributes while preserving quoted markup, CDATA and recovery', () => {
  const root = parseSolutionXml(
    '<?xml version="1.0"?><root><!-- omitted --><item label="a > b" other=\'&quot;x&quot;\'/><text><![CDATA[<raw>&amp;]]></text></root>',
  );
  assert.deepEqual(root.children[0].attrs, { label: 'a > b', other: '"x"' });
  assert.equal(root.children[1].text, '<raw>&amp;');
  assert.equal(parseSolutionXml('<root><child></root>', { recover: true }).recovered, 1);
  for (const source of ['<root x="one" x="two"/>', '<root x=unquoted/>', '<root invalid/>', '<root a="unterminated>']) {
    assert.throws(() => parseSolutionXml(source), /Malformed|Duplicate/);
  }
  assert.throws(() => parseSolutionXml('<root><!-- unterminated'), /Malformed/);
  assert.throws(() => parseSolutionXml('<root><![CDATA[unterminated'), /Malformed/);
  const attrs = parseSolutionXml('<root __proto__="plain" constructor="value"/>').attrs;
  assert.equal(Object.getPrototypeOf(attrs), Object.prototype);
  assert.equal(Object.hasOwn(attrs, '__proto__'), true);
  assert.equal(attrs.__proto__, 'plain');
});

test('CDATA decoding retains incomplete sections and the first closing delimiter semantics', () => {
  assert.equal(decodeXml('a<![CDATA[x&amp;]]>b<![CDATA[y]]>c'), 'ax&byc');
  assert.equal(decodeXml('a<![CDATA[incomplete&amp;'), 'a<![CDATA[incomplete&');
  assert.equal(decodeXml('<![CDATA[a<![CDATA[b]]>c]]>'), 'a<![CDATA[bc]]>');
});

test('solution path segment classification preserves nested precedence, case and source identity', () => {
  const cases = [
    ['base\\ENTITIES\\Sample_Item\\ENTITY.XML', { kind: 'entity', entityDir: 'Sample_Item' }],
    ['base/Entities/Sample_Item/FormXml/main/a.xml', { kind: 'form', entityDir: 'Sample_Item' }],
    ['base/Entities/Sample_Item/SavedQueries/folder/a.xml', { kind: 'view', entityDir: 'Sample_Item' }],
    ['AppModules/Workflows/a.xml', { kind: 'app' }],
    ['Workflows/PluginTypes/a.xml', { kind: 'workflow' }],
    ['PluginTypes/sub/a.xml', { kind: 'plugin' }],
    ['AppModuleSiteMaps/sub/a.xml', { kind: 'app' }],
    ['SiteMaps/a.xml', { kind: 'app' }],
    ['Other/Relationships/a.xml', { kind: 'relationships' }],
    ['Other/OptionSets/a.xml', { kind: 'optionset' }],
    ['root/relationships.xml', { kind: 'relationships' }],
    ['root/customizations.xml', { kind: 'customizations' }],
    ['root/Other/Solution.xml', { kind: 'solution' }],
    ['solution.xml', { kind: 'solution' }],
    ['root/solution.xml', null],
    [
      'environmentvariabledefinitions/Sample_Url/environmentvariablevalue.json',
      { kind: 'envvalue', envDir: 'Sample_Url' },
    ],
    [
      'environmentvariabledefinitions/Sample_Url/environmentvariabledefinition.xml',
      { kind: 'envdef', envDir: 'Sample_Url' },
    ],
    ['AppModules/.xml', null],
    ['Other/OptionSets/.xml', null],
    ['Entities//Entity.xml', null],
  ];
  for (const [source, expected] of cases) assert.deepEqual(classifySolutionPath(source), expected, source);
});

test('imported solution metadata scans nested XML entries and excludes non-metadata assets', () => {
  const visited = [];
  const overlay = createSolutionMetadataOverlay({
    parseDocument(_text, info) {
      visited.push(info.name);
      return {};
    },
  });
  const names = [
    'wrapper/Entities/sample/Privileges.xml',
    'wrapper/AppModules/app.xml',
    'wrapper/AppModuleSiteMaps/app.xml',
    'wrapper/OptionSets/sample.xml',
    'wrapper/Relationships/sample.xml',
    'wrapper/solution.xml',
    'wrapper/customizations.xml',
    'Other/Solution.xml',
  ];
  const bytes = Buffer.from('<root/>');
  const entries = [...names, 'WebResources/app.xml', 'Entities/sample/app.js'].map((name) => ({
    name,
    content: bytes.toString('base64'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  overlay({}, { dataverse: { solutionAssets: { layers: [{ id: 'sample-layer', uniqueName: 'sample', entries }] } } });
  assert.deepEqual(visited, names);
});

// Linear scans of these 40,000-400,000 character inputs need milliseconds of CPU; super-linear backtracking needs
// seconds or more. The budget bounds the child's CPU time for the adversarial work only (module loading and a busy
// machine do not count); the wall-clock limit only stops a runaway child.
const ADVERSARIAL_CPU_BUDGET_MS = 1000;
const RUNAWAY_LIMIT_MS = 60000;
test('long malformed XML and repeated solution path segments finish within a bounded worker', () => {
  const xml = new URL('../lib/solution-xml.mjs', import.meta.url).href;
  const importer = new URL('../lib/importer.mjs', import.meta.url).href;
  const schema = new URL('../lib/solution-schema.mjs', import.meta.url).href;
  const metadata = new URL('../lib/dataverse-solution-metadata.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import {parseSolutionXml} from ${JSON.stringify(xml)};
    import {decodeXml} from ${JSON.stringify(importer)};
    import {classifySolutionPath} from ${JSON.stringify(schema)};
    import {createSolutionMetadataOverlay} from ${JSON.stringify(metadata)};
    const started = process.cpuUsage();
    for (const opener of ['<!--', '<![CDATA[', '<?'])
      assert.throws(() => parseSolutionXml('<root>' + opener.repeat(40000)), /Malformed/);
    assert.throws(() => parseSolutionXml('<root ' + 'a'.repeat(400000) + '/>'), /Malformed/);
    const cdata = '<![CDATA['.repeat(40000);
    assert.equal(decodeXml(cdata), cdata);
    const name = 'Entities/sample/FormXml/AppModules/'.repeat(20000) + 'invalid.txt';
    assert.equal(classifySolutionPath(name), null);
    const overlay = createSolutionMetadataOverlay();
    overlay({}, {dataverse: {solutionAssets: {layers: [{id: 'sample', entries: [{name}]}]}}});
    const used = process.cpuUsage(started);
    process.stdout.write(String((used.user + used.system) / 1000));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: RUNAWAY_LIMIT_MS,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const cpuMs = Number(result.stdout);
  assert.ok(cpuMs >= 0 && cpuMs < ADVERSARIAL_CPU_BUDGET_MS, `${result.stdout} ms CPU for the adversarial inputs`);
});
