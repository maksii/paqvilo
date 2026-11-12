// @test-kind unproven: the checks in this file exercise solution parser security with local fixtures; no native capture establishes the behaviour they assert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { descendants, parseSolutionXml, serializeXml } from '../lib/solution-xml.mjs';
import { classifySolutionPath, readSolutionZip } from '../lib/solution-schema.mjs';
import {
  readSolutionAssetEntries,
  SolutionArchiveError,
  writeSolutionAssetEntries,
} from '../lib/dataverse-solution-assets.mjs';
import { createSolutionMetadataOverlay } from '../lib/dataverse-solution-metadata.mjs';
import { decodeXml } from '../lib/importer.mjs';

// @test-kind security+contract: solution XML scans delimiters and attributes while preserving quoted markup, CDATA and recovery
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

// @test-kind contract: CDATA decoding retains incomplete sections and the first closing delimiter semantics
test('CDATA decoding retains incomplete sections and the first closing delimiter semantics', () => {
  assert.equal(decodeXml('a<![CDATA[x&amp;]]>b<![CDATA[y]]>c'), 'ax&amp;byc');
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
// @test-kind security+contract: long malformed XML and repeated solution path segments finish within a bounded worker
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

const element = (name, attrs = {}, children = [], text = '') => ({ name, attrs, text, children });
// @test-kind contract: descendants keeps document order and serializeXml walks a deep solution tree without recursion.
test('descendants and serializeXml handle 200000 siblings and a 20000-deep chain', () => {
  const labels = Array.from({ length: 200_000 }, (_, index) => element('label', { index: String(index) }));
  const wide = element('root', {}, [element('Entity', {}, labels)]);
  const found = descendants(wide, 'label');
  assert.equal(found.length, 200_000);
  assert.ok(found.every((node, index) => node.attrs.index === String(index)));
  assert.ok(serializeXml(wide).endsWith('<label index="199999"></label></Entity></root>'));
  let chain = element('target', { id: 'leaf' }, [], 'a<b');
  for (let depth = 0; depth < 20_000; depth++) chain = element('item', {}, [chain]);
  assert.equal(descendants(chain, 'target')[0].attrs.id, 'leaf');
  assert.equal(
    serializeXml(chain),
    `${'<item>'.repeat(20_000)}<target id="leaf">a&lt;b</target>${'</item>'.repeat(20_000)}`,
  );
});

const hostileFile = (name, text) => ({ name, data: Buffer.from(text) });
const refusedWith = (code) => (error) => error instanceof SolutionArchiveError && error.code === code;
const centralRecords = (zip) => {
  const records = [];
  let cursor = zip.readUInt32LE(zip.length - 6);
  for (let index = 0; index < zip.readUInt16LE(zip.length - 12); index++) {
    records.push(cursor);
    cursor += 46 + zip.readUInt16LE(cursor + 28) + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  return records;
};

// @test-kind security: two central entries that name one local header are refused from the directory, before any inflate
test('solution ZIP refuses central entries that share one local header', () => {
  const twins = writeSolutionAssetEntries([
    hostileFile('a/customizations.xml', '<x/>'),
    hostileFile('b/customizations.xml', '<x/>'),
  ]);
  const [first, second] = centralRecords(twins);
  twins.write('a', second + 46);
  twins.writeUInt32LE(twins.readUInt32LE(first + 42), second + 42);
  assert.throws(() => readSolutionZip(twins), refusedWith('EntryPath'));
});

// @test-kind security: a second entry whose local header lies inside a first entry's payload is refused as overlapping
test('solution ZIP refuses an entry whose local header lies inside another entry payload', () => {
  const embedded = writeSolutionAssetEntries([hostileFile('customizations.xml', '<x/>')]);
  // Random bytes keep the first payload stored, so the embedded local header is addressable in the archive.
  const payload = Buffer.concat([embedded, randomBytes(65536)]);
  const nested = writeSolutionAssetEntries([
    hostileFile('Other/Solution.xml', payload),
    hostileFile('customizations.xml', '<x/>'),
  ]);
  const [first, second] = centralRecords(nested);
  assert.equal(nested.readUInt16LE(first + 10), 0, 'the first payload is stored');
  nested.writeUInt32LE(nested.readUInt32LE(first + 42) + 30 + 'Other/Solution.xml'.length, second + 42);
  assert.throws(() => readSolutionZip(nested), refusedWith('InvalidArchive'));
});

// @test-kind security: declared sizes that sum above the archive budget are refused from the central directory before inflate
test('solution ZIP refuses declared sizes above the budget before inflating', () => {
  const zip = writeSolutionAssetEntries([
    hostileFile('Other/Solution.xml', '<s/>'),
    hostileFile('customizations.xml', '<x/>'),
    hostileFile('relationships.xml', '<r/>'),
  ]);
  const declared = 100 * 1024 * 1024;
  for (const record of centralRecords(zip)) {
    zip.writeUInt32LE(declared, record + 24);
    zip.writeUInt32LE(declared, zip.readUInt32LE(record + 42) + 22);
  }
  assert.throws(() => readSolutionZip(zip), refusedWith('ArchiveLimit'));
});

// @test-kind security: an entry count above the limit and a local offset outside the archive are refused before any entry is read
test('solution ZIP refuses entry counts above the limit and offsets outside the archive', () => {
  const counted = writeSolutionAssetEntries([hostileFile('customizations.xml', '<x/>')]);
  counted.writeUInt16LE(10001, counted.length - 14);
  counted.writeUInt16LE(10001, counted.length - 12);
  assert.throws(() => readSolutionZip(counted), refusedWith('ArchiveLimit'));
  const outside = writeSolutionAssetEntries([hostileFile('customizations.xml', '<x/>')]);
  outside.writeUInt32LE(outside.length + 1000, centralRecords(outside)[0] + 42);
  assert.throws(() => readSolutionZip(outside), refusedWith('InvalidArchive'));
});

// Renames an entry of a writer-built archive. Local and central names have one length, so both are rewritten in place.
const renamed = (zip, from, to) => {
  assert.equal(from.length, to.length);
  for (let at = zip.indexOf(from); at >= 0; at = zip.indexOf(from, at + to.length)) zip.write(to, at, 'latin1');
  return zip;
};
const kept = (name) => ({ name, data: Buffer.from('<r/>') });

// @test-kind security: the scan reader skips cosmetic name rules for an entry it never classifies and keeps them for a kept entry
test('solution ZIP scan accepts a colon in an entry it never reads and refuses one in an entry it keeps', () => {
  const ignored = renamed(writeSolutionAssetEntries([hostileFile('WebResources/a;b.js', 'x')]), 'a;b', 'a:b');
  assert.deepEqual(readSolutionZip(ignored), []);
  const keptColon = renamed(writeSolutionAssetEntries([kept('Other/Relationships/a;b.xml')]), 'a;b', 'a:b');
  assert.throws(() => readSolutionZip(keptColon), refusedWith('EntryPath'));
});

// @test-kind security: traversal and absolute names still fail the scan reader for an entry it never reads
test('solution ZIP scan refuses a traversal name on an entry it never reads', () => {
  const zip = renamed(writeSolutionAssetEntries([hostileFile('Ig/x.xml', 'x')]), 'Ig/x.xml', '../x.xml');
  assert.throws(() => readSolutionZip(zip), refusedWith('EntryPath'));
});

// @test-kind security: two kept entries whose names differ only in case are ambiguous and fail the scan reader
test('solution ZIP scan refuses two kept entries whose names differ only in case', () => {
  const zip = renamed(
    writeSolutionAssetEntries([kept('Other/Relationships/ab.xml'), kept('Other/Relationships/xy.xml')]),
    'Other/Relationships/xy.xml',
    'Other/Relationships/AB.xml',
  );
  assert.throws(() => readSolutionZip(zip), refusedWith('EntryPath'));
});

// @test-kind security: two entries the scan never reads may differ only in case, because neither is read
test('solution ZIP scan accepts two entries it never reads whose names differ only in case', () => {
  const zip = renamed(
    writeSolutionAssetEntries([hostileFile('WebResources/ab.js', 'x'), hostileFile('WebResources/xy.js', 'y')]),
    'WebResources/xy.js',
    'WebResources/AB.js',
  );
  assert.deepEqual(readSolutionZip(zip), []);
});

// @test-kind contract: the scan reader reads an archive up to 256 MiB, while the upload path keeps its 128 MiB ceiling
test('solution ZIP scan reads a 129 MiB archive that the upload path refuses', () => {
  const MiB = 1024 * 1024;
  const zip = writeSolutionAssetEntries(
    [
      hostileFile('Padding/one.bin', randomBytes(65 * MiB)),
      hostileFile('Padding/two.bin', randomBytes(64 * MiB)),
      kept('Other/Relationships/a.xml'),
    ],
    { archiveBytes: 256 * MiB },
  );
  assert.ok(zip.length > 128 * MiB);
  assert.deepEqual(
    readSolutionZip(zip).map((entry) => entry.name),
    ['Other/Relationships/a.xml'],
  );
  assert.throws(() => readSolutionAssetEntries(zip), refusedWith('ArchiveLimit'));
});

// @test-kind contract: an entity outside a CDATA section decodes beside it, and the CDATA body stays literal
test('decodeXml decodes entities outside CDATA and keeps the CDATA body literal beside them', () => {
  assert.equal(decodeXml('&amp;<![CDATA[&amp;]]>'), '&&amp;');
  assert.equal(decodeXml('&<![CDATA[&]]>'), '&&');
});
