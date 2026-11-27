// The site of hosted session F1's follow-up (2026-11-27) rebuilt from invented sources: the session's four-table schema
// (pqf1_root, Contact scope through pqf1_contact, with a lookup to the virtual table; pqf1_glob, Global scope, with a
// lookup to pqf1_root; pqf1_kid, Global scope, under both; pqf1_vrow, a virtual table under pqf1_root served by a custom
// provider), its Web API settings and table permissions, and the synthetic rows it seeded. The provider is invented here:
// it answers the session's three rows, or throws as the session's failure switch made the live provider throw. The
// signed-in contact is the replay site's invented contact. Shared by the portal-webapi adapter for the hosted-f1-nav-*
// suites.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  attribute,
  F1_CONTACT,
  F1_ROLE,
  fixed,
  primaryName,
  reference,
  system,
  writeSchemaSite,
} from './hosted-f1-fixture-site.mjs';

// The Web API settings as the session created them (trial-nav.mjs --site): each list names a lookup by its logical name.
export const NAV_SETTINGS = {
  'Webapi/pqf1_root/enabled': 'true',
  'Webapi/pqf1_root/fields': 'pqf1_rootid,pqf1_name,pqf1_contact,pqf1_vrow',
  'Webapi/pqf1_vrow/enabled': 'true',
  'Webapi/pqf1_vrow/fields': 'pqf1_vrowid,pqf1_name,pqf1_code,pqf1_query,pqf1_root',
  'Webapi/pqf1_glob/enabled': 'true',
  'Webapi/pqf1_glob/fields': 'pqf1_globid,pqf1_name,pqf1_root',
  'Webapi/pqf1_kid/enabled': 'true',
  'Webapi/pqf1_kid/fields': 'pqf1_kidid,pqf1_name,pqf1_root,pqf1_glob',
};

const R = { r1: fixed(6001), r2: fixed(6002), r3: fixed(6003) };
const G = { g1: fixed(6011), g2: fixed(6012) };
const V = { v1: fixed(3001), v2: fixed(3002), v3: fixed(3003) };
const root = (id, name) => reference(id, 'pqf1_root', name);

/** The provider's rows (the session's provider answered these three). */
export const PROVIDER_ROWS = [
  { pqf1_vrowid: V.v1, pqf1_name: 'virtual one', pqf1_code: 'x', pqf1_amount: 1, pqf1_root: root(R.r1, 'R1') },
  { pqf1_vrowid: V.v2, pqf1_name: 'virtual two', pqf1_code: 'y', pqf1_amount: 2, pqf1_root: root(R.r1, 'R1') },
  { pqf1_vrowid: V.v3, pqf1_name: 'virtual three', pqf1_code: 'x', pqf1_amount: 3, pqf1_root: root(R.r2, 'R2') },
];

function state() {
  const contact = reference(F1_CONTACT, 'contact', 'Invented Reader');
  const vrow = (id, name) => reference(id, 'pqf1_vrow', name);
  return {
    version: 1,
    mappings: {},
    tables: {
      contact: [{ contactid: F1_CONTACT, firstname: 'Invented', lastname: 'Reader', fullname: 'Invented Reader' }],
      pqf1_root: [
        {
          pqf1_rootid: R.r1,
          pqf1_name: 'R1',
          pqf1_contact: contact,
          pqf1_vrow: vrow(V.v1, 'virtual one'),
          statecode: 0,
        },
        {
          pqf1_rootid: R.r2,
          pqf1_name: 'R2',
          pqf1_contact: contact,
          pqf1_vrow: vrow(V.v2, 'virtual two'),
          statecode: 0,
        },
        { pqf1_rootid: R.r3, pqf1_name: 'R3 hidden', pqf1_vrow: vrow(V.v3, 'virtual three'), statecode: 0 },
      ],
      pqf1_glob: [
        { pqf1_globid: G.g1, pqf1_name: 'G1', pqf1_root: root(R.r1, 'R1'), statecode: 0 },
        { pqf1_globid: G.g2, pqf1_name: 'G2', pqf1_root: root(R.r2, 'R2'), statecode: 0 },
      ],
      pqf1_kid: [
        {
          pqf1_kidid: fixed(6021),
          pqf1_name: 'K1',
          pqf1_root: root(R.r1, 'R1'),
          pqf1_glob: reference(G.g1, 'pqf1_glob', 'G1'),
        },
        {
          pqf1_kidid: fixed(6022),
          pqf1_name: 'K2',
          pqf1_root: root(R.r1, 'R1'),
          pqf1_glob: reference(G.g1, 'pqf1_glob', 'G1'),
        },
        {
          pqf1_kidid: fixed(6023),
          pqf1_name: 'K3',
          pqf1_root: root(R.r2, 'R2'),
          pqf1_glob: reference(G.g2, 'pqf1_glob', 'G2'),
        },
      ],
      pqf1_vrow: [],
    },
    // Read for the session's Authenticated Users role: pqf1_root in Contact scope, the others Global.
    permissions: [
      {
        id: fixed(6101),
        entity: 'pqf1_root',
        scope: 'contact',
        field: 'pqf1_contact',
        roles: [F1_ROLE],
        operations: ['read'],
      },
      ...['pqf1_vrow', 'pqf1_glob', 'pqf1_kid'].map((entity, index) => ({
        id: fixed(6102 + index),
        entity,
        scope: 'global',
        roles: [F1_ROLE],
        operations: ['read'],
      })),
    ],
    settings: { permissionMode: 'enforce' },
    simulator: { mode: 'local', pageMode: 'local', endpoints: [] },
  };
}

const TABLES = {
  pqf1_root: {
    set: 'pqf1_roots',
    attributes: [
      ...system('pqf1_root'),
      primaryName('pqf1_name'),
      attribute('pqf1_contact', 'lookup'),
      attribute('pqf1_vrow', 'lookup'),
    ],
  },
  pqf1_glob: {
    set: 'pqf1_globs',
    attributes: [...system('pqf1_glob'), primaryName('pqf1_name'), attribute('pqf1_root', 'lookup')],
  },
  pqf1_kid: {
    set: 'pqf1_kids',
    attributes: [
      ...system('pqf1_kid'),
      primaryName('pqf1_name'),
      attribute('pqf1_root', 'lookup'),
      attribute('pqf1_glob', 'lookup'),
    ],
  },
  pqf1_vrow: {
    set: 'pqf1_vrows',
    virtual: true,
    attributes: [
      attribute('pqf1_vrowid', 'primarykey'),
      primaryName('pqf1_name'),
      attribute('pqf1_code', 'nvarchar'),
      attribute('pqf1_amount', 'int'),
      attribute('pqf1_query', 'memo'),
      attribute('pqf1_root', 'lookup'),
    ],
  },
};
const RELATIONSHIPS = [
  ['pqf1_contact', 'pqf1_root', 'contact'],
  ['pqf1_root', 'pqf1_vrow', 'pqf1_root'],
  ['pqf1_vrow', 'pqf1_root', 'pqf1_vrow'],
  ['pqf1_root', 'pqf1_glob', 'pqf1_root'],
  ['pqf1_root', 'pqf1_kid', 'pqf1_root'],
  ['pqf1_glob', 'pqf1_kid', 'pqf1_glob'],
];

/**
 * Writes the site and its provider pack into `directory`. `provider` is "healthy" or "throwing"; a `switchFile` holding
 * "throwing" makes the provider throw from then on, as the session's failure switch did. The provider counts its calls
 * in `calls.json` beside it.
 */
export async function writeHostedF1NavSite(directory, { provider = 'healthy', switchFile = null } = {}) {
  const pack = path.join(directory, 'provider.mjs');
  const calls = path.join(directory, 'calls.json');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(calls, '0');
  await fs.writeFile(
    pack,
    `import fs from 'node:fs/promises';
const rows = ${JSON.stringify(PROVIDER_ROWS)};
const answer = async (value) => {
  await fs.writeFile(${JSON.stringify(calls)}, String(Number(await fs.readFile(${JSON.stringify(calls)}, 'utf8')) + 1));
  const mode = ${JSON.stringify(switchFile)} ? (await fs.readFile(${JSON.stringify(switchFile)}, 'utf8')).trim() : ${JSON.stringify(provider)};
  if (mode === 'throwing') throw new Error('pqf1 provider failure switch is on');
  return structuredClone(value);
};
export default { id: 'pqf1-nav-provider', name: 'pqf1 virtual provider', description: 'Invented replay provider',
  matches: () => true, presets: () => ({}), virtualTableProviders: { pqf1_vrow: {
    retrieve: async (id) => answer(rows.find((row) => row.pqf1_vrowid === id) ?? null),
    retrieveMultiple: async () => answer(rows),
  } } };
`,
  );
  const options = await writeSchemaSite(directory, {
    tables: TABLES,
    relationships: RELATIONSHIPS,
    settings: NAV_SETTINGS,
    initial: state(),
    name: 'pqf1 nav replay site',
  });
  return { ...options, projectRoot: directory, dataPacks: [{ module: pack }] };
}
