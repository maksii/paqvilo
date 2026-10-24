import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readCatalogue, readManifest, validateCatalogue } from 'paqvilo/dataverse';
import { extendReferenceCatalogue } from './portal-security/reference-projections.mjs';
import { parseArgs } from 'node:util';
import path from 'node:path';
const { values: args } = parseArgs({
  options: { schema: { type: 'string' }, catalogue: { type: 'string' }, out: { type: 'string' } },
});
const catalogue = await readCatalogue(
    args.catalogue ? path.resolve(args.catalogue) : new URL('./data/catalogue.json', import.meta.url),
  ),
  schema = await readManifest(
    args.schema ? path.resolve(args.schema) : new URL('./dataverse/manifest.json', import.meta.url),
  );
const guid = (key) => {
  const b = createHash('sha1')
    .update('paqvilo-company-operations-fixtures-v1:' + key)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6] & 15) | 80;
  b[8] = (b[8] & 63) | 128;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const choice = (name, label) =>
  schema.choices.find((c) => c.name === name).options.find((o) => o.label === label).value;
const add = (key, table, name, fields, refs = {}) =>
  catalogue.records.push({
    key,
    id: guid(key),
    table,
    fields: { ...(table.startsWith('pqvd_') ? { pqvd_name: name } : {}), ...fields },
    refs,
    deferredRefs: [],
  });
const roles = catalogue.records.filter((r) => r.table === 'pqvd_accessrole').map((r) => r.fields.pqvd_code),
  person = 'P-STRESS',
  member = 'MEM-P-STRESS-A-RIV';
add(
  person,
  'contact',
  'Maxwell Scope',
  {
    firstname: 'Maxwell',
    lastname: 'Scope',
    emailaddress1: 'maxwell.scope@people.example.invalid',
    pqvd_personcode: 'CO-P-STRESS',
  },
  { parentcustomerid: 'A-RIV' },
);
add(
  member,
  'pqvd_orgcontact',
  'Maxwell Scope',
  {
    pqvd_code: 'CO-MEM-P-STRESS-A-RIV',
    pqvd_displayname: 'Maxwell Scope',
    pqvd_workemail: 'maxwell.scope@a-riv.example.invalid',
    pqvd_membershipstate: choice('pqvd_membershipstate', 'Active'),
  },
  { pqvd_accountid: 'A-RIV', pqvd_contactid: person },
);
const engagements = {};
for (const [kind, suffix, fraction] of [
  ['Permanent employee', 'permanent', 0.5],
  ['Fixed-term employee', 'fixed', 0.25],
  ['External contractor', 'external', 0.25],
]) {
  const key = 'ENG-P-STRESS-' + suffix;
  engagements[kind] = key;
  add(
    key,
    'pqvd_employment',
    'Maxwell ' + kind,
    {
      pqvd_number: 'CO-' + key,
      pqvd_engagementkind: choice('pqvd_engagementkind', kind),
      pqvd_ftefraction: fraction,
      pqvd_startdate: '2025-01-15',
      pqvd_enddate: kind === 'Permanent employee' ? null : '2027-09-30',
      pqvd_jobtitle: 'Acting operations and technology director',
      pqvd_employmentstate: choice('pqvd_employmentstate', 'Active'),
    },
    {
      pqvd_orgcontactid: member,
      pqvd_departmentid: 'DEPT-A-RIV-2',
      pqvd_manageremploymentid: 'ENG-P01-A-RIV-main',
      ...(kind === 'External contractor' ? { pqvd_supplieraccountid: 'V-STAFF' } : {}),
    },
  );
  add(
    'TERM-' + key,
    'pqvd_employmentterms',
    'Maxwell private ' + suffix,
    {
      pqvd_annualsalary: kind === 'External contractor' ? null : kind === 'Permanent employee' ? 36000 : 18000,
      pqvd_dayrate: kind === 'External contractor' ? 450 : null,
      pqvd_weeklyhours: 40 * fraction,
      pqvd_noticeperioddays: 30,
      pqvd_contractreference: 'CO-STRESS-' + suffix,
    },
    { pqvd_employmentid: key, transactioncurrencyid: 'currency-EUR' },
  );
}
const persona = {
  key: person,
  contactId: guid(person),
  name: 'Maxwell Scope',
  webRoles: roles,
  grants: [],
  stress: true,
  webRoleVariants: [0, 1, 2, 4, 8, 12].map((count) => ({
    id: 'roles-' + count,
    roles: roles.slice(0, count),
    readiness: 'Website-bound role activation variant; backend grants stay seeded',
  })),
};
const row = (key) => catalogue.records.find((r) => r.key === key),
  descendants = (anchor) =>
    catalogue.records
      .filter(
        (r) =>
          r.table === 'account' &&
          (() => {
            let current = r;
            while (current) {
              if (current.key === anchor) return true;
              current = row(current.refs.parentaccountid);
            }
            return false;
          })(),
      )
      .map((r) => r.key);
for (const role of roles) {
  const key = 'G-P-STRESS-' + role,
    engagement =
      role === 'EMPLOYEE'
        ? engagements['Permanent employee']
        : role === 'CONTRACTOR'
          ? engagements['External contractor']
          : null,
    department = role === 'TEAMLEADER' ? 'DEPT-A-RIV-2' : null,
    tree = ['COMPANYMANAGER', 'BRANCHMANAGER', 'AUDITOR'].includes(role),
    account = ['COMPANYMANAGER', 'AUDITOR'].includes(role) ? 'A' : 'A-RIV',
    scope = engagement ? 'Engagement' : department ? 'Department' : 'Organisation',
    scopeKey = engagement
      ? 'ENG-' + guid(engagement).replaceAll('-', '')
      : department
        ? 'DEPT-' + row(department).id.replaceAll('-', '')
        : tree
          ? 'ORG-TREE'
          : 'ORG-SELF';
  const principals = Object.fromEntries(
    roles.map((code) => ['pqvd_' + code.toLowerCase() + 'principalid', code === role ? person : null]),
  );
  add(
    key,
    'pqvd_accesspermission',
    'Stress ' + role,
    {
      pqvd_number: 'CO-' + key,
      pqvd_scopekind: choice('pqvd_scopekind', scope),
      pqvd_scopekey: scopeKey,
      pqvd_includedescendants: tree,
      pqvd_validfrom: '2026-01-01T00:00:00Z',
      pqvd_validuntil: null,
      pqvd_accessstate: choice('pqvd_accessstate', 'Active'),
      pqvd_reason: 'Maximum-capability scoped query-budget fixture',
    },
    {
      pqvd_granteecontactid: person,
      pqvd_scopeaccountid: account,
      pqvd_roleid: 'role-' + role,
      ...(engagement ? { pqvd_employmentid: engagement } : {}),
      ...(department ? { pqvd_departmentid: department } : {}),
      ...principals,
    },
  );
  persona.grants.push(key);
  let accounts,
    members = [],
    departments = [],
    employments = [];
  if (scope === 'Organisation') accounts = tree ? descendants(account) : [account];
  else if (scope === 'Department') {
    accounts = [account];
    departments = [department];
    employments = catalogue.records
      .filter(
        (r) =>
          r.table === 'pqvd_employment' &&
          r.refs.pqvd_departmentid === department &&
          r.fields.pqvd_employmentstate === choice('pqvd_employmentstate', 'Active'),
      )
      .map((r) => r.key);
    members = [...new Set(employments.map((key) => row(key).refs.pqvd_orgcontactid))];
  } else {
    accounts = role === 'EMPLOYEE' ? ['A-RIV', 'A'] : ['A-RIV'];
    employments = [engagement];
    members = catalogue.records
      .filter(
        (r) =>
          r.table === 'pqvd_orgcontact' &&
          r.fields.pqvd_membershipstate === choice('pqvd_membershipstate', 'Active') &&
          (role === 'EMPLOYEE'
            ? row(r.refs.pqvd_accountid).refs.pqvd_rootaccountid === 'A' || r.refs.pqvd_accountid === 'A'
            : catalogue.records.some(
                (e) =>
                  e.table === 'pqvd_employment' &&
                  e.refs.pqvd_orgcontactid === r.key &&
                  e.refs.pqvd_departmentid === 'DEPT-A-RIV-2' &&
                  e.fields.pqvd_employmentstate === choice('pqvd_employmentstate', 'Active'),
              )),
      )
      .map((r) => r.key);
  }
  for (const [relationship, to] of [
    ['pqvd_access_accounts', accounts],
    ['pqvd_access_orgcontacts', members],
    ['pqvd_access_departments', departments],
    ['pqvd_access_employments', employments],
    ['pqvd_access_equipments', []],
  ])
    catalogue.associations.push({ relationship, from: key, to: [...new Set(to)] });
}
catalogue.personas.push(persona);
catalogue.scenarios.push({
  id: 'max-role-query-budget',
  persona: person,
  contactId: guid(person),
  variants: persona.webRoleVariants,
  expected: [
    {
      target: 'EQ-A-RIV-00',
      table: 'pqvd_equipment',
      privilege: 'Read',
      allowed: true,
      reason: 'Scoped technical/management role union',
    },
    {
      target: 'EQ-B-LAKE-00',
      table: 'pqvd_equipment',
      privilege: 'Read',
      allowed: false,
      reason: 'No Northstar role scope',
    },
  ],
  requiredRuntime:
    'QueryBudget website permission variants and observer plugin; SDK administrator reads do not execute the permission oracle',
});
for (const [template, key] of [
  ['RUN-P07', 'RUN-P-STRESS'],
  ['PROBE-P07', 'PROBE-P-STRESS'],
]) {
  const clone = structuredClone(row(template));
  clone.key = key;
  clone.id = guid(key);
  clone.fields.pqvd_name = 'Seed fixture — no execution ' + person;
  if (clone.table === 'pqvd_testrun') {
    clone.fields.pqvd_runkey = 'CO-SEED-P-STRESS';
    clone.fields.pqvd_rolesnapshot = JSON.stringify({ source: 'authored fixture, not observed website roles', roles });
    clone.refs.pqvd_runnercontactid = person;
  } else {
    clone.fields.pqvd_token = 'CO-PROBE-P-STRESS';
    clone.refs.pqvd_ownercontactid = person;
    clone.refs.pqvd_runid = 'RUN-P-STRESS';
  }
  catalogue.records.push(clone);
}
// Existing company employee directory leaves include the additional active member.
for (const grant of catalogue.records.filter(
  (r) =>
    r.table === 'pqvd_accesspermission' &&
    r.refs.pqvd_employeeprincipalid &&
    r.fields.pqvd_accessstate === choice('pqvd_accessstate', 'Active') &&
    row(r.refs.pqvd_scopeaccountid).refs.pqvd_rootaccountid === 'A',
)) {
  const group = catalogue.associations.find(
    (a) => a.from === grant.key && a.relationship === 'pqvd_access_orgcontacts',
  );
  if (group && !group.to.includes(member)) group.to.push(member);
}
// Backend inventory oracles use the full merged dataset; specialized variants
// remain bounded to their authored records.
const rebind = (q, keys) => {
  const pk = catalogue.tables.find((t) => t.name === q.table).primaryId;
  if (keys.length)
    q.fetchXml = q.fetchXml.replace(
      new RegExp(`<condition attribute="${pk}" operator="(?:in|eq)"[^>]*(?:/>|>[\\s\\S]*?</condition>)`),
      `<condition attribute="${pk}" operator="in">${keys.map((key) => '<value>{{ref:' + key + '}}</value>').join('')}</condition>`,
    );
};
for (const q of catalogue.queries) {
  if (/^R(?:0[1-9]|1\d|20|21)$/.test(q.id) || q.id.startsWith('SDK-')) {
    const keys = catalogue.records.filter((r) => r.table === q.table).map((r) => r.key),
      pk = catalogue.tables.find((t) => t.name === q.table).primaryId;
    rebind(q, keys);
    q.expected = keys.map((key) => ({ [pk]: '@ref:' + key }));
  }
}
for (const q of catalogue.queries) {
  if (q.id === 'R25') {
    rebind(
      q,
      catalogue.records.filter((r) => r.table === 'pqvd_orgcontact').map((r) => r.key),
    );
    q.expected = catalogue.records
      .filter((r) => r.table === 'pqvd_employment')
      .map((e) => ({ pqvd_orgcontactid: '@ref:' + e.refs.pqvd_orgcontactid, engagementid: '@ref:' + e.key }));
  }
  if (q.id === 'R26') {
    rebind(
      q,
      catalogue.records.filter((r) => r.table === 'pqvd_accesspermission').map((r) => r.key),
    );
    q.expected = catalogue.associations
      .filter((a) => a.relationship === 'pqvd_access_accounts')
      .flatMap((a) =>
        a.to.map((key) => ({ pqvd_accesspermissionid: '@ref:' + a.from, scopedaccountid: '@ref:' + key })),
      );
  }
}
// Team equipment is the active custody of its explicitly projected employments.
for (const g of catalogue.records.filter(
  (r) => r.table === 'pqvd_accesspermission' && r.refs.pqvd_teamleaderprincipalid,
)) {
  const employmentKeys = catalogue.associations.find(
    (a) => a.from === g.key && a.relationship === 'pqvd_access_employments',
  ).to;
  catalogue.associations.find((a) => a.from === g.key && a.relationship === 'pqvd_access_equipments').to = [
    ...new Set(
      catalogue.records
        .filter(
          (r) =>
            r.table === 'pqvd_assignment' &&
            r.fields.pqvd_assignmentstate === choice('pqvd_assignmentstate', 'Issued') &&
            employmentKeys.includes(r.refs.pqvd_employmentid),
        )
        .map((r) => r.refs.pqvd_equipmentid),
    ),
  ];
}
catalogue.coverage.stress =
  'Additional independent persona with all twelve effective scoped roles and 0/1/2/4/8/12 website-role variants';
extendReferenceCatalogue(catalogue, schema);
const output = args.out ? path.resolve(args.out) : new URL('./data/stress-catalogue.json', import.meta.url);
if (args.out) await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(validateCatalogue(catalogue), null, 2) + '\n');
console.log(
  JSON.stringify({
    records: catalogue.records.length,
    personas: catalogue.personas.length,
    scenarios: catalogue.scenarios.length,
    stressContactId: persona.contactId,
    stressRoles: roles.length,
    links: catalogue.associations.reduce((n, a) => n + a.to.length, 0),
  }),
);
