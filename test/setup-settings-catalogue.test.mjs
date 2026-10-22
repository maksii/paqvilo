import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { settingsCatalogue } from '../lense/setup/settings-catalogue.mjs';
import { MIRAGE_SETTINGS, parseSetting } from '../mirage/lib/config-keys.mjs';
import { catalogueRoot } from '../lense/config.mjs';
import { resolveProjectConfig } from '../mirage/lib/project-config.mjs';

const kinds = { catalogue: settingsCatalogue('catalogue'), project: settingsCatalogue('project') };
const all = [...kinds.catalogue, ...kinds.project];

test('every Mirage setting appears with its registered doc, contract and redaction', () => {
  for (const key of Object.keys(MIRAGE_SETTINGS)) {
    const entries = all.filter(item => item.key === key);
    assert.ok(entries.length, `${key} is missing`);
    for (const entry of entries) {
      assert.equal(entry.doc, MIRAGE_SETTINGS[key].doc);
      assert.equal(entry.contract, MIRAGE_SETTINGS[key].contract ?? null);
      assert.equal(entry.pending, false, `${key} parser is registered`);
    }
  }
  for (const key of ['secrets', 'connections', 'dataverse.applications']) assert.ok(all.filter(item => item.key === key).every(item => item.redact), key);
  for (const entry of all) {
    assert.ok(['catalogue', 'site', 'project', 'portal'].includes(entry.scope), entry.key);
    assert.ok(['string', 'number', 'boolean', 'choice', 'list', 'object'].includes(entry.kind), entry.key);
    assert.ok(Number.isInteger(entry.stage) && entry.stage >= 1 && entry.stage <= 10, entry.key);
    assert.ok(entry.doc, entry.key);
  }
});

test('every example parses as YAML, passes its validator and holds no literal secret', async () => {
  for (const entry of all) {
    const value = YAML.parse(entry.example);
    assert.ok(value && typeof value === 'object', entry.key);
    // A connectorScripts sha256 is the public hash of a script's text, not a secret.
    assert.doesNotMatch(entry.example.replace(/sha256: "[0-9a-f]{64}"/g, ''), /AccountKey=|SharedAccessKey|password\s*[:=]|clientSecret|protectedValue|[A-Za-z0-9+/]{32,}={0,2}/i, entry.key);
    const top = entry.key.split('.')[0];
    if (MIRAGE_SETTINGS[top]) parseSetting(top, value[top], { base: process.cwd() });
    else if (entry.scope === 'catalogue') catalogueRoot(value);
    else if (entry.scope === 'site') catalogueRoot({ sites: { invented: top === 'source' || top === 'environments' ? value : { source: '.', ...value } } });
    else await resolveProjectConfig({ version: 2, portals: [{ id: 'invented-portal', path: '.' }], ...value }, 'invented.project.yml', { checkSources: false });
  }
  for (const key of ['secrets']) assert.match(all.find(item => item.key === key).example, /variable:/);
});

test('choices match the parsers that enforce them', () => {
  const check = (key, choices, wrap) => {
    for (const choice of choices) parseSetting(key, wrap(choice));
    assert.throws(() => parseSetting(key, wrap('invented-choice')));
  };
  const entry = key => kinds.catalogue.find(item => item.key === key) ?? kinds.project.find(item => item.key === key);
  for (const key of ['solutionOrder', 'presetMode', 'presetConfiguration', 'dataModel']) check(key, entry(key).choices, value => value);
  check('runtime', entry('runtime').choices, kind => ({ kind }));
  check('simulation', entry('simulation').choices, level => ({ level }));
  check('identityProvider', entry('identityProvider').choices, presentation => ({ presentation }));
  for (const value of entry('portals').choices) catalogueRoot({ portals: value });
  assert.throws(() => catalogueRoot({ portals: 'invented-choice' }));
  for (const value of entry('scope').choices) catalogueRoot({ sites: { invented: { scope: value } } });
  assert.throws(() => catalogueRoot({ sites: { invented: { scope: 'invented-choice' } } }));
});
