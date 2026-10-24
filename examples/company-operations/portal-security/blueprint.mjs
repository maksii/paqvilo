import { createHash } from 'node:crypto';
import { referenceRoles } from './reference-projections.mjs';

export const roleNames = {
  COMPANYMANAGER: 'Company manager',
  BRANCHMANAGER: 'Branch manager',
  TEAMLEADER: 'Team leader',
  EMPLOYEE: 'Employee',
  CONTRACTOR: 'External contractor',
  HR: 'HR officer',
  IT: 'IT asset administrator',
  FACILITIES: 'Facilities coordinator',
  PROCUREMENT: 'Procurement officer',
  AUDITOR: 'Operations auditor',
  ORGADMIN: 'Organisation administrator',
  CTO: 'CTO',
  TESTRUNNER: 'Test Runner',
};
export function componentId(key) {
  const value = createHash('sha256')
    .update('company-operations-portal-v1:' + key)
    .digest('hex')
    .slice(0, 32)
    .split('');
  value[12] = '5';
  value[16] = '8';
  const s = value.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const privileges = (letters) => ({
  read: letters.includes('R'),
  create: letters.includes('C'),
  write: letters.includes('U'),
  delete: letters.includes('D'),
  append: letters.includes('A'),
  appendTo: letters.includes('T'),
});
export function buildBlueprint(schema, catalogue) {
  const nodes = [],
    roles = Object.entries(roleNames).map(([code, label]) => ({
      code,
      name: `CO ${label}`,
      id: componentId('role:' + code),
      anonymous: false,
      authenticatedDefault: false,
    }));
  function node(
    role,
    path,
    table,
    rights,
    parent = null,
    relationship = null,
    scope = parent ? 'Parent' : 'Contact',
    active = true,
  ) {
    const key = `${role}-${path}-${table.replace('pqvd_', '').toUpperCase()}`;
    if (nodes.some((n) => n.key === key)) throw new Error('Duplicate permission ' + key);
    const n = {
      key,
      id: componentId('permission:' + key),
      name: 'CO ' + key,
      role,
      table,
      scope,
      parent: parent?.key ?? null,
      relationship,
      active,
      privileges: privileges(rights),
    };
    nodes.push(n);
    return n;
  }
  // Each role root follows its dedicated principal, never the generic grantee.
  const roots = {};
  for (const code of Object.keys(roleNames).filter((c) => c !== 'TESTRUNNER'))
    roots[code] = node(code, 'GRANTS', 'pqvd_accesspermission', 'R', null, 'pqvd_contact_access_' + code.toLowerCase());
  const matrix = {
    COMPANYMANAGER: {
      account: 'RCU',
      directory: 'RCU',
      employment: 'R',
      equipment: 'RCU',
      assignment: 'RCU',
      finance: 'R',
      location: 'RCU',
      service: 'RCU',
    },
    BRANCHMANAGER: {
      account: 'RU',
      directory: 'RCU',
      department: 'RCU',
      employment: 'R',
      equipment: 'RCU',
      assignment: 'RCU',
      finance: 'R',
      location: 'RCU',
      service: 'RCU',
    },
    HR: { account: 'R', directory: 'RCU', employment: 'RCU', terms: 'RCU', equipment: 'R', assignment: 'R' },
    IT: {
      account: 'R',
      directory: 'R',
      employment: 'R',
      equipment: 'RCU',
      assignment: 'RCU',
      location: 'R',
      service: 'RCU',
    },
    FACILITIES: { account: 'R', directory: 'R', equipment: 'R', location: 'RCU', service: 'RCU' },
    PROCUREMENT: { account: 'R', equipment: 'RC', finance: 'RCU' },
    AUDITOR: {
      account: 'R',
      directory: 'R',
      employment: 'R',
      equipment: 'R',
      assignment: 'R',
      finance: 'R',
      location: 'R',
      service: 'R',
    },
    ORGADMIN: {
      account: 'RCU',
      directory: 'RCU',
      employment: 'R',
      equipment: 'R',
      assignment: 'R',
      location: 'RCU',
      service: 'R',
    },
    CTO: {
      account: 'R',
      directory: 'R',
      employment: 'R',
      equipment: 'RCU',
      assignment: 'RCU',
      finance: 'R',
      location: 'R',
      service: 'RCU',
    },
  };
  const mutable = (rights) => rights + (rights.includes('C') || rights.includes('U') ? 'A' : '');
  function service(role, path, parent, relationship, rights) {
    let n = node(role, path, 'pqvd_servicerequest', mutable(rights), parent, relationship);
    for (const [table, rel] of [
      ['pqvd_workorder', 'pqvd_request_workorders'],
      ['pqvd_worktask', 'pqvd_workorder_tasks'],
      ['pqvd_checklistitem', 'pqvd_task_checklistitems'],
      ['pqvd_inspection', 'pqvd_checklistitem_inspections'],
      ['pqvd_finding', 'pqvd_inspection_findings'],
    ])
      n = node(role, path, table, mutable(rights), n, rel);
  }
  for (const [role, m] of Object.entries(matrix)) {
    const path = 'WORKFORCE',
      account = node(role, path, 'account', mutable(m.account), roots[role], 'pqvd_access_accounts');
    if (role === 'BRANCHMANAGER') node(role, 'UNITS', 'account', 'RCUA', account, 'account_parent_account');
    const directory = m.directory
      ? node(role, path, 'pqvd_orgcontact', mutable(m.directory), account, 'pqvd_account_orgcontacts')
      : null;
    let employment = null;
    if (m.employment)
      employment = node(role, path, 'pqvd_employment', mutable(m.employment), directory, 'pqvd_orgcontact_employments');
    if (m.directory)
      node(
        role,
        'DEPARTMENT',
        'pqvd_department',
        mutable(m.department ?? m.account),
        account,
        'pqvd_account_departments',
      );
    if (m.terms) node(role, 'TERMS', 'pqvd_employmentterms', mutable(m.terms), employment, 'pqvd_employment_terms');
    const equipment = node(
      role,
      'EQUIPMENT',
      'pqvd_equipment',
      mutable(m.equipment),
      account,
      'pqvd_account_equipments',
    );
    if (m.finance)
      node(role, 'FINANCE', 'pqvd_equipmentfinance', mutable(m.finance), equipment, 'pqvd_equipment_finance');
    if (m.location) {
      const site = node(role, 'LOCATIONS', 'pqvd_site', mutable(m.location), account, 'pqvd_account_sites'),
        building = node(role, 'LOCATIONS', 'pqvd_building', mutable(m.location), site, 'pqvd_site_buildings');
      node(role, 'LOCATIONS', 'pqvd_room', mutable(m.location), building, 'pqvd_building_rooms');
    }
    if (m.assignment) {
      const assignment = node(
        role,
        path,
        'pqvd_assignment',
        mutable(m.assignment),
        employment,
        'pqvd_employment_assignments',
      );
      if (m.service) service(role, path, assignment, 'pqvd_assignment_requests', m.service);
      node(role, 'EQUIPMENT', 'pqvd_assignment', mutable(m.assignment), equipment, 'pqvd_equipment_assignments');
    }
    if (m.service) service(role, 'EQUIPMENT', equipment, 'pqvd_equipment_requests', m.service);
  }
  for (const role of ['EMPLOYEE', 'CONTRACTOR', 'TEAMLEADER']) {
    const root = roots[role];
    node(role, 'PROFILE', 'account', 'R', root, 'pqvd_access_accounts');
    node(role, 'DIRECTORY', 'pqvd_orgcontact', 'R', root, 'pqvd_access_orgcontacts');
    const employment = node(role, 'ENGAGEMENT', 'pqvd_employment', 'R', root, 'pqvd_access_employments');
    const assignment = node(role, 'ENGAGEMENT', 'pqvd_assignment', 'R', employment, 'pqvd_employment_assignments');
    const equipment = node(role, 'CURRENT', 'pqvd_equipment', 'R', root, 'pqvd_access_equipments');
    if (role === 'TEAMLEADER') node(role, 'DEPARTMENT', 'pqvd_department', 'R', root, 'pqvd_access_departments');
    service(role, 'ENGAGEMENT', assignment, 'pqvd_assignment_requests', role === 'TEAMLEADER' ? 'RCU' : 'R');
    service(role, 'CURRENT', equipment, 'pqvd_equipment_requests', 'R');
    if (role !== 'TEAMLEADER')
      node(role, 'REQUESTCREATE', 'pqvd_servicerequest', 'CA', assignment, 'pqvd_assignment_requests');
  }
  // Append To is granted only on actual lookup targets of mutable descendants.
  // It never authorizes writing projection N:N relationships: roots have no Append.
  for (const child of nodes.filter((n) => n.parent && (n.privileges.create || n.privileges.write))) {
    const parent = nodes.find((n) => n.key === child.parent);
    if (parent.table !== 'pqvd_accesspermission') parent.privileges.appendTo = true;
  }
  for (const role of ['COMPANYMANAGER', 'BRANCHMANAGER', 'IT', 'CTO'])
    for (const n of nodes.filter((n) => n.role === role && n.table === 'pqvd_room')) n.privileges.appendTo = true;
  // Binding Account to Equipment fails with scoped Append To alone, so the Account
  // also gets scoped Append; Account scalar writes stay unavailable.
  nodes.find((n) => n.key === 'IT-WORKFORCE-ACCOUNT').privileges.append = true;
  // Binding Room fails with Append To alone in the same way.
  nodes.find((n) => n.key === 'IT-LOCATIONS-ROOM').privileges.append = true;
  if (schema.relationships.some((r) => r.name === 'pqvd_access_currencies'))
    for (const role of referenceRoles) {
      const rights = ['HR', 'PROCUREMENT'].includes(role) ? 'RT' : 'R';
      if (schema.relationships.some((r) => r.name === 'pqvd_access_currencyreferences')) {
        node(role, 'CURRENCYREFERENCE', 'pqvd_currencyreference', 'R', roots[role], 'pqvd_access_currencyreferences');
        // Preserve the original system leaf registry identities. Adding the
        // custom target must not strand active legacy grants or rename a GUID.
        node(role, 'CURRENCYREFERENCE', 'transactioncurrency', rights, roots[role], 'pqvd_access_currencies');
      } else node(role, 'CURRENCYREFERENCE', 'transactioncurrency', rights, roots[role], 'pqvd_access_currencies');
      node(role, 'VENDORREFERENCE', 'account', rights, roots[role], 'pqvd_access_referenceaccounts');
    }
  const contact = node('TESTRUNNER', 'SELF', 'contact', 'RAT', null, null, 'Self');
  const run = node('TESTRUNNER', 'RUNS', 'pqvd_testrun', 'RCUAT', null, 'pqvd_contact_testruns');
  // Only disposable equipment explicitly tied to the actor's own test run can
  // receive Delete. The business trees retain their no-Delete equipment rights.
  if (schema.relationships.some((r) => r.name === 'pqvd_testrun_canaryequipments'))
    node('TESTRUNNER', 'CANARYCLEANUP', 'pqvd_equipment', 'D', run, 'pqvd_testrun_canaryequipments');
  node('TESTRUNNER', 'RESULTS', 'pqvd_testresult', 'RCUAT', run, 'pqvd_testrun_results');
  node('TESTRUNNER', 'PROBES', 'pqvd_crudprobe', 'RCUDAT', null, 'pqvd_contact_crudprobes');
  const operation = node('TESTRUNNER', 'OPERATIONS', 'pqvd_testoperation', 'RCUAT', run, 'pqvd_testrun_operations');
  node('TESTRUNNER', 'EVENTS', 'pqvd_pluginevent', 'R', operation, 'pqvd_testoperation_events');
  node('TESTRUNNER', 'NODES', 'pqvd_chainnode', 'R', operation, 'pqvd_testoperation_chainnodes');
  // Probe binds active operation; results bind operation as well as run.
  contact.privileges.appendTo = true;
  const assignments = catalogue.personas.map((p) => ({
    persona: p.key,
    contactId: p.contactId,
    roles: [...new Set([...p.webRoles, 'TESTRUNNER'])],
  }));
  const result = {
    schemaVersion: 1,
    datasetVersion: catalogue.version,
    roles,
    nodes,
    assignments,
    limitations: [
      'Traditional authorization only. Enhanced data model is supported; enhanced authorization is not enabled.',
      'Shared Contact is a Self leaf only. HR membership creation needs separately qualified Contact binding; blocked until supplied.',
      ...(schema.relationships.some((r) => r.name === 'pqvd_access_currencies')
        ? []
        : [
            'Currency/vendor reference binding is blocked until dedicated scoped reference projections exist. No Global workaround.',
          ]),
      'Creation requiring maintained scope projections/business invariants stays blocked until enforcing services are installed.',
      'Backend metadata verification is not signed-in portal runtime verification.',
    ],
  };
  validateBlueprint(result, schema);
  return result;
}

export function assertNoActiveOrphans(b) {
  const nodes = new Map(b.nodes.map((n) => [n.key, n]));
  for (const child of b.nodes.filter((n) => n.active && n.parent)) {
    const parent = nodes.get(child.parent);
    if (!parent?.active)
      throw new Error('Active orphan permission is unsafe after observed global visibility fallback: ' + child.key);
  }
}
export function validateBlueprint(b, schema) {
  assertNoActiveOrphans(b);
  const tables = new Set(schema.tables.map((t) => t.name)),
    byKey = new Map(b.nodes.map((n) => [n.key, n]));
  if (byKey.size !== b.nodes.length) throw new Error('Duplicate permission keys');
  const roles = new Set(b.roles.map((r) => r.code)),
    relationships = new Map(schema.relationships.map((r) => [r.name, r]));
  relationships.set('account_parent_account', { kind: 'oneToMany', parent: 'account', child: 'account' });
  for (const n of b.nodes) {
    if (!tables.has(n.table) || !roles.has(n.role)) throw new Error('Unknown table/role ' + n.key);
    if (n.scope === 'Global' || n.scope === 'Account') throw new Error('Unscoped/global business access ' + n.key);
    if (n.table !== 'pqvd_crudprobe' && n.privileges.delete) {
      const narrowCanary =
        n.key === 'TESTRUNNER-CANARYCLEANUP-EQUIPMENT' &&
        n.role === 'TESTRUNNER' &&
        n.parent === 'TESTRUNNER-RUNS-TESTRUN' &&
        n.relationship === 'pqvd_testrun_canaryequipments' &&
        Object.entries(n.privileges).every(([right, value]) => value === (right === 'delete'));
      if (!narrowCanary) throw new Error('Unexpected Delete ' + n.key);
    }
    if (n.table === 'pqvd_accesspermission' && Object.entries(n.privileges).some(([p, v]) => p !== 'read' && v))
      throw new Error('Mutable security root ' + n.key);
    const path = new Set();
    let current = n;
    while (current) {
      if (path.has(current.key)) throw new Error('Permission cycle');
      path.add(current.key);
      current = current.parent ? byKey.get(current.parent) : null;
    }
    if (n.parent) {
      const p = byKey.get(n.parent),
        r = relationships.get(n.relationship);
      if (!p || p.role !== n.role || n.scope !== 'Parent') throw new Error('Invalid parent role ' + n.key);
      if (!r) throw new Error('Unknown relationship ' + n.relationship);
      const ends = [r.parent ?? r.entity1, r.child ?? r.entity2];
      if (!ends.includes(n.table) || !ends.includes(p.table))
        throw new Error('Relationship endpoint mismatch ' + n.key);
    } else if (n.scope === 'Contact') {
      const r = relationships.get(n.relationship);
      if (!r || r.parent !== 'contact' || r.child !== n.table) throw new Error('Invalid Contact root ' + n.key);
      if (n.role !== 'TESTRUNNER' && n.relationship !== `pqvd_contact_access_${n.role.toLowerCase()}`)
        throw new Error('Scope multiplication root ' + n.key);
    } else if (n.scope !== 'Self' || n.table !== 'contact') throw new Error('Unexpected root scope ' + n.key);
  }
  for (const a of b.assignments) if (a.roles.some((r) => !roles.has(r))) throw new Error('Unknown assigned role');
  const finding = byKey.get('IT-WORKFORCE-FINDING');
  let depth = 0;
  for (let n = finding; n; n = n.parent ? byKey.get(n.parent) : null) depth++;
  if (depth !== 11) throw new Error('IT workforce path must have 11 nodes');
  return {
    roles: b.roles.length,
    permissions: b.nodes.length,
    assignments: b.assignments.length,
    maxWorkforceDepth: depth,
  };
}
