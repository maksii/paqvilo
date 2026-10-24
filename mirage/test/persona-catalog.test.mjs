import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePersonaCatalog,
  mergePersonaCatalogs,
  resolvePersonaCatalog,
  personaStartPath,
} from '../lib/persona-catalog.mjs';
import { indexPersonaCatalog, filterPersonaIndex, personaFilters, closestPersonaKeys } from '../lib/persona-search.mjs';

const guid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const catalog = () => ({
  version: 1,
  groups: [{ id: 'writers', label: 'Writers', subgroups: [{ id: 'own', label: 'Own records' }] }],
  personas: [
    {
      key: 'writer-one',
      contactId: guid(1),
      group: 'writers',
      subgroup: 'own',
      tags: ['writer'],
      description: 'Own records\nAdditional detail',
    },
  ],
});

test('persona catalogues validate source paths, versions, references and duplicate keys', () => {
  assert.deepEqual(validatePersonaCatalog(catalog(), 'Data pack synthetic'), catalog());
  const invalid = [
    [
      (value) => {
        value.version = 2;
      },
      /Data pack synthetic: personaCatalog.version must be 1/,
    ],
    [
      (value) => {
        delete value.personas[0].group;
      },
      /personaCatalog.personas\[0\].group is required/,
    ],
    [
      (value) => {
        value.personas[0].group = 'missing';
      },
      /personas\[0\].group "missing" is not a declared group/,
    ],
    [
      (value) => {
        value.personas.push({ ...value.personas[0] });
      },
      /personas\[1\].key "writer-one" repeats personas\[0\]/,
    ],
    [
      (value) => {
        value.personas[0].contactId = 'unknown';
      },
      /personas\[0\].contactId/,
    ],
    [
      (value) => {
        value.personas[0].roles = ['Administrator'];
      },
      /personas\[0\].roles is an unknown field/,
    ],
    [
      (value) => {
        value.personas[0].startPath = 'https://external.invalid/';
      },
      /personas\[0\].startPath must be a relative path/,
    ],
    [
      (value) => {
        value.groups[0].subgroups[0].subgroups = [];
      },
      /subgroups\[0\].subgroups is an unknown field/,
    ],
    [
      (value) => {
        value.personas[0].context = 'missing';
      },
      /personas\[0\].context/,
    ],
    [
      (value) => {
        value.groups = Array(1);
      },
      /groups\[0\] must be an object/,
    ],
    [
      (value) => {
        value.personas[0].tags = Array(1);
      },
      /personas\[0\].tags/,
    ],
    [
      (value) => {
        value.contexts = [{ id: 'invalid', label: 'Invalid', environmentVariables: new Date() }];
      },
      /contexts\[0\].environmentVariables/,
    ],
  ];
  for (const [mutate, pattern] of invalid) {
    const value = catalog();
    mutate(value);
    assert.throws(() => validatePersonaCatalog(value, 'Data pack synthetic'), pattern);
  }
});

test('context descriptions reuse configured profiles, typed variables, snippets and browser setup', () => {
  const value = catalog();
  value.personas[0].context = 'variant';
  value.contexts = [
    {
      id: 'variant',
      label: 'Variant',
      deploymentProfile: { profile: 'test', enabled: { pages: true } },
      environmentVariables: { Sample_Enabled: false, Sample_Number: 2 },
      portalOverrides: { snippets: { Greeting: 'Hello' }, settings: { Feature: 'true' } },
      browser: { locale: 'en-GB', timezoneId: 'Europe/Warsaw', viewport: { width: 1280, height: 800 } },
      extensions: { 'synthetic:workflow': { variant: 1 } },
    },
  ];
  assert.deepEqual(validatePersonaCatalog(value), value);
  value.contexts[0].portalOverrides.roles = {};
  assert.throws(() => validatePersonaCatalog(value), /portalOverrides.roles is an unknown field/);
});

test('dataset merges keep existing personas/groups while adding subgroups, contexts and scenarios', () => {
  const existing = catalog(),
    generated = catalog();
  existing.personas[0].label = 'Local edit';
  generated.personas[0].label = 'Generated';
  generated.groups[0].label = 'Generated group';
  generated.groups[0].subgroups.push({ id: 'shared', label: 'Shared records' });
  generated.personas.push({ key: 'writer-two', contactId: guid(2), group: 'writers', subgroup: 'shared' });
  const merged = mergePersonaCatalogs(existing, generated);
  assert.equal(merged.personas[0].label, 'Local edit');
  assert.equal(merged.groups[0].label, 'Writers');
  assert.equal(merged.groups[0].subgroups.length, 2);
  assert.equal(merged.personas.length, 2);
  validatePersonaCatalog(merged);
});

test('joined catalogues derive identities from contacts, retain state precedence and diagnose only state orphans', () => {
  const pack = catalog();
  pack.personas.push({ key: 'pack-missing', contactId: guid(8), group: 'writers' });
  const state = catalog();
  state.personas[0].label = 'Curated label';
  state.personas[0].contactId = `{${guid(1).toUpperCase()}}`;
  state.personas.push({ key: 'state-missing', contactId: guid(9), group: 'writers' });
  // Joining never trusts authored grants, even if its caller bypassed validation.
  state.personas[0].roles = ['Administrator'];
  state.personas[0].account = { id: guid(99), name: 'Authored' };
  const result = resolvePersonaCatalog({
    contacts: [
      {
        contactId: guid(1),
        name: 'Actual Contact',
        roles: ['Writer'],
        accountId: guid(3),
        accountName: 'Actual account',
        active: true,
      },
      { contactId: guid(2), name: 'Other Contact', roles: [], active: true },
      { contactId: guid(4), name: 'Inactive', active: false },
    ],
    catalogs: [
      { source: 'pack:synthetic', catalog: pack },
      { source: 'state', state: true, catalog: state },
    ],
    defaultContactId: guid(1),
  });
  assert.equal(result.personas.length, 1);
  assert.equal(result.other.length, 1);
  assert.equal(result.total, 2);
  assert.equal(result.personas[0].label, 'Curated label');
  assert.deepEqual(result.personas[0].roles, ['Writer']);
  assert.deepEqual(result.personas[0].account, { id: guid(3), name: 'Actual account' });
  assert.equal(result.personas[0].default, true);
  assert.equal(result.skipped, 1);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].key, 'state-missing');
  assert.equal(result.groups[0].count, 1);
  assert.equal(result.groups[0].subgroups[0].count, 1);
});

test('persona paths reject external, escaped and control-character navigation', () => {
  assert.throws(
    () => personaStartPath('https://other.example/', 'returnUrl'),
    /^Error: returnUrl must be a relative path/,
  );
  assert.equal(personaStartPath('/requests/?search=one#details'), '/requests/?search=one#details');
  for (const path of [
    'https://external.invalid/',
    '//external.invalid',
    '/\\external.invalid',
    '/%2fexternal.invalid',
    '/%5cexternal.invalid',
    '/%0d%0aLocation:elsewhere',
    '/%',
  ])
    assert.throws(() => personaStartPath(path), /path|encoding/);
});

test('search folds accents and case, combines terms with AND and filter values with OR', () => {
  const report = {
    groups: [{ id: 'requests', label: 'Requesters', subgroups: [{ id: 'own', label: 'Own records' }] }],
    personas: [
      {
        key: 'manager-one',
        label: 'Réquester',
        name: 'Actual Contact',
        email: 'manager@example.invalid',
        group: 'requests',
        subgroup: 'own',
        roles: ['Manager'],
        tags: ['org-a'],
        account: { id: guid(1), name: 'Account A' },
        description: 'Own applications',
      },
      {
        key: 'reviewer-two',
        label: 'Reviewer',
        group: 'requests',
        roles: ['Reviewer'],
        tags: ['org-b'],
        account: { id: guid(2), name: 'Account B' },
      },
    ],
    other: [{ contactId: guid(3), label: 'Unassigned', roles: [], account: {} }],
  };
  const index = indexPersonaCatalog(report);
  assert.equal(filterPersonaIndex(index, { q: 'MANAGER org-a' }).length, 1);
  assert.equal(filterPersonaIndex(index, { q: 'requester actual own' }).length, 1);
  assert.equal(filterPersonaIndex(index, { q: 'manager org-b' }).length, 0);
  assert.equal(filterPersonaIndex(index, { roles: ['Manager', 'Reviewer'], accounts: [guid(1)] }).length, 1);
  assert.equal(filterPersonaIndex(index, { hideNoRoles: true }).length, 2);
  assert.deepEqual(personaFilters('q=manager&role=Manager&role=Reviewer&tag=org-a&rolesOnly=1'), {
    q: 'manager',
    roles: ['Manager', 'Reviewer'],
    accounts: [],
    groups: [],
    tags: ['org-a'],
    hideNoRoles: true,
  });
  assert.equal(closestPersonaKeys('manager-on', report.personas)[0], 'manager-one');
});

test('persona search transliterates letters without Unicode decompositions in both directions', () => {
  for (const [label, query] of [
    ['Ørsted', 'Orsted'],
    ['Ægir', 'AEgir'],
    ['Œuvre', 'oeuvre'],
    ['Straße', 'strasse'],
    ['Đorđe', 'Dorde'],
    ['Łódź', 'Lodz'],
  ]) {
    for (const [name, q] of [
      [label, query],
      [query, label],
    ])
      assert.equal(
        filterPersonaIndex(indexPersonaCatalog({ personas: [{ key: 'one', label: name }] }), { q }).length,
        1,
        `${name}: ${q}`,
      );
  }
});
