import { componentId } from './blueprint.mjs';
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildTesterOverlay(
  catalogue,
  contactId,
  { sourcePersona = 'P07', actualPersona = 'P-ACTUAL', originalWebsiteRoles = [] } = {},
) {
  if (!guid.test(contactId) || !/^[-A-Z0-9]+$/.test(actualPersona))
    throw new Error('Contact GUID and safe persona alias required.');
  contactId = contactId.toLowerCase();
  const persona = catalogue.personas.find((p) => p.key === sourcePersona),
    rows = new Map(catalogue.records.map((r) => [r.key, r]));
  if (!persona) throw new Error('Missing source persona');
  if (catalogue.personas.some((p) => p.contactId.toLowerCase() === contactId.toLowerCase()))
    throw new Error('Use the fixture persona directly; do not clone onto a seeded Contact.');
  const source = persona.grants
    .map((key) => rows.get(key))
    .find((r) => rows.get(r?.refs.pqvd_roleid)?.fields.pqvd_code === 'IT');
  if (!source) throw new Error('Source persona needs an IT grant');
  if (!['ORG-SELF', 'ORG-TREE'].includes(source.fields.pqvd_scopekey))
    throw new Error('Baseline tester clone requires an organisation IT scope.');
  const grant = structuredClone(source),
    account = source.refs.pqvd_scopeaccountid;
  grant.key = `G-${actualPersona}-IT-${account}`;
  grant.id = componentId('private-actual-tester:' + contactId + ':IT:' + account);
  grant.fields.pqvd_number = 'CO-ACTUAL-IT-' + contactId.replaceAll('-', '').slice(0, 20);
  grant.fields.pqvd_name = 'Private actual tester IT ' + account;
  grant.fields.pqvd_reason = 'Authorized signed-in runtime tester; cloned IT scope, original fixture unchanged';
  grant.refs.pqvd_granteecontactid = actualPersona;
  grant.refs.pqvd_itprincipalid = actualPersona;
  // A source employment sponsor belongs to the fixture identity; the actual
  // tester appointment is independent and must never impersonate that sponsor.
  grant.refs.pqvd_employmentid = null;
  return {
    schemaVersion: 1,
    private: true,
    actualContactBinding: true,
    records: [
      {
        key: actualPersona,
        id: contactId.toLowerCase(),
        table: 'contact',
        fields: {},
        refs: {},
        deferredRefs: [],
        existingOnly: true,
      },
      grant,
    ],
    associations: catalogue.associations
      .filter((a) => a.from === source.key)
      .map((a) => ({ ...structuredClone(a), from: grant.key })),
    personas: [
      {
        key: actualPersona,
        contactId: contactId.toLowerCase(),
        name: 'Authorized actual tester',
        webRoles: ['IT'],
        grants: [grant.key],
        originalWebsiteRoles,
      },
    ],
    scenarios: [],
    provenance: { sourcePersona, sourceGrant: source.key, baselineRoles: ['IT', 'TESTRUNNER'] },
  };
}

export function buildStressTesterOverlay(catalogue, baseline, { sourcePersona = 'P-STRESS' } = {}) {
  const overlay = structuredClone(baseline),
    actor = overlay.personas[0],
    sourceActor = catalogue.personas.find((p) => p.key === sourcePersona),
    rows = new Map(catalogue.records.map((r) => [r.key, r]));
  if (!sourceActor?.stress) throw new Error('Source must be the authored stress persona');
  overlay.temporaryStress = true;
  const replacements = new Map([[sourceActor.key, actor.key]]),
    members = catalogue.records.filter(
      (r) => r.table === 'pqvd_orgcontact' && r.refs.pqvd_contactid === sourceActor.key,
    ),
    employment = catalogue.records.filter(
      (r) => r.table === 'pqvd_employment' && members.some((m) => m.key === r.refs.pqvd_orgcontactid),
    ),
    terms = catalogue.records.filter(
      (r) => r.table === 'pqvd_employmentterms' && employment.some((e) => e.key === r.refs.pqvd_employmentid),
    ),
    copyRows = [...members, ...employment, ...terms];
  for (const row of copyRows) replacements.set(row.key, row.key.replaceAll(sourceActor.key, actor.key));
  for (const source of copyRows) {
    const row = structuredClone(source);
    row.key = replacements.get(source.key);
    row.id = componentId('private-actual-stress:' + actor.contactId + ':' + row.key);
    row.fields.pqvd_name = 'Authorized runtime stress ' + row.table + ' ' + row.key.split('-').at(-1);
    for (const field of ['pqvd_number', 'pqvd_code', 'pqvd_contractreference'])
      if (field in row.fields)
        row.fields[field] =
          'CO-T-' +
          componentId(actor.contactId + ':' + row.key)
            .replaceAll('-', '')
            .slice(0, 28);
    for (const [field, target] of Object.entries(row.refs))
      if (replacements.has(target)) row.refs[field] = replacements.get(target);
    if (row.table === 'pqvd_orgcontact') {
      row.fields.pqvd_displayname = 'Authorized runtime tester';
      row.fields.pqvd_workemail = 'runtime-tester@people.example.invalid';
    }
    rows.set(row.key, row);
    overlay.records.push(row);
  }
  const newGrantKeys = [],
    grants = [];
  for (const key of sourceActor.grants) {
    const source = rows.get(key),
      role = rows.get(source.refs.pqvd_roleid).fields.pqvd_code;
    if (role === 'IT') {
      grants.push(baseline.records.find((r) => r.table === 'pqvd_accesspermission').key);
      continue;
    }
    const row = structuredClone(source);
    row.key = `G-${actor.key}-STRESS-${role}`;
    row.id = componentId('private-actual-stress:' + actor.contactId + ':' + row.key);
    row.fields.pqvd_name = 'Authorized runtime stress ' + role;
    row.fields.pqvd_number = `CO-T-${actor.contactId.replaceAll('-', '').slice(0, 16)}-${role}`;
    row.fields.pqvd_reason = 'Temporary authorized runtime query-budget/collision persona; fixture original unchanged';
    for (const [field, target] of Object.entries(row.refs))
      if (replacements.has(target)) row.refs[field] = replacements.get(target);
    if (source.fields.pqvd_scopekey.startsWith('ENG-'))
      row.fields.pqvd_scopekey = 'ENG-' + rows.get(row.refs.pqvd_employmentid).id.replaceAll('-', '');
    overlay.records.push(row);
    grants.push(row.key);
    newGrantKeys.push(row.key);
    for (const association of catalogue.associations.filter((a) => a.from === key)) {
      const copy = structuredClone(association);
      copy.from = row.key;
      copy.to = copy.to.map((k) => replacements.get(k) ?? k);
      if (copy.relationship === 'pqvd_access_orgcontacts' && ['EMPLOYEE', 'CONTRACTOR', 'TEAMLEADER'].includes(role))
        copy.to = [...new Set([...association.to, ...members.map((m) => replacements.get(m.key))])];
      if (copy.relationship === 'pqvd_access_employments' && role === 'TEAMLEADER')
        copy.to = [...new Set([...association.to, ...employment.map((e) => replacements.get(e.key))])];
      overlay.associations.push(copy);
    }
  }
  actor.webRoles = [...sourceActor.webRoles];
  actor.grants = grants;
  actor.webRoleVariants = structuredClone(sourceActor.webRoleVariants);
  overlay.provenance.newGrantKeys = newGrantKeys;
  overlay.provenance.temporaryRecordKeys = overlay.records
    .filter((r) => !baseline.records.some((b) => b.key === r.key))
    .map((r) => r.key);
  return overlay;
}
