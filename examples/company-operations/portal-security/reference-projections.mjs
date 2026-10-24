import { createHash } from 'node:crypto';
export const currencyReferenceTable = {
  name: 'pqvd_currencyreference',
  entitySetName: 'pqvd_currencyreferences',
  solution: 'PaqviloCompanyOperationsCore',
  label: 'Currency Reference',
  pluralLabel: 'Currency References',
  ownership: 'organization',
  primaryName: { name: 'pqvd_name', label: 'Name', maxLength: 160, required: 'required' },
  columns: [
    { name: 'pqvd_code', label: 'ISO Code', type: 'string', maxLength: 3, required: 'required' },
    { name: 'pqvd_symbol', label: 'Symbol', type: 'string', maxLength: 10, required: 'none' },
    { name: 'pqvd_precision', label: 'Precision', type: 'integer', min: 0, max: 4, required: 'none' },
  ],
  keys: [
    { name: 'pqvd_ak_currencyreference_code', columns: ['pqvd_code'] },
    { name: 'pqvd_ak_currencyreference_currency', columns: ['pqvd_systemcurrencyid'] },
  ],
};
const fixtureId = (key) => {
  const b = createHash('sha1')
    .update('paqvilo-company-operations-fixtures-v1:' + key)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6] & 15) | 80;
  b[8] = (b[8] & 63) | 128;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export const referenceRelationships = [
  {
    name: 'pqvd_access_currencies',
    kind: 'manyToMany',
    parent: 'pqvd_accesspermission',
    child: 'transactioncurrency',
    solution: 'PaqviloCompanyOperationsCore',
    intersectName: 'pqvd_access_currencies',
    intersectColumns: ['pqvd_accesspermissionid', 'transactioncurrencyid'],
  },
  {
    name: 'pqvd_access_referenceaccounts',
    kind: 'manyToMany',
    parent: 'pqvd_accesspermission',
    child: 'account',
    solution: 'PaqviloCompanyOperationsCore',
    intersectName: 'pqvd_access_referenceaccounts',
    intersectColumns: ['pqvd_accesspermissionid', 'accountid'],
  },
  {
    name: 'pqvd_access_currencyreferences',
    kind: 'manyToMany',
    parent: 'pqvd_accesspermission',
    child: 'pqvd_currencyreference',
    solution: 'PaqviloCompanyOperationsCore',
    intersectName: 'pqvd_access_currencyreferences',
    intersectColumns: ['pqvd_accesspermissionid', 'pqvd_currencyreferenceid'],
  },
  {
    name: 'pqvd_transactioncurrency_references',
    kind: 'oneToMany',
    parent: 'transactioncurrency',
    child: 'pqvd_currencyreference',
    solution: 'PaqviloCompanyOperationsCore',
    lookup: { name: 'pqvd_systemcurrencyid', label: 'System Currency', required: 'required' },
    cascade: {
      Assign: 'NoCascade',
      Delete: 'Restrict',
      Merge: 'NoCascade',
      Reparent: 'NoCascade',
      Share: 'NoCascade',
      Unshare: 'NoCascade',
    },
  },
];
export const referenceRoles = ['COMPANYMANAGER', 'BRANCHMANAGER', 'HR', 'PROCUREMENT', 'AUDITOR', 'CTO'];
export function extendReferenceSchema(manifest) {
  if (!manifest.tables.some((table) => table.name === currencyReferenceTable.name))
    manifest.tables.push(structuredClone(currencyReferenceTable));
  const table = manifest.tables.find((table) => table.name === currencyReferenceTable.name);
  table.label = currencyReferenceTable.label;
  table.pluralLabel = currencyReferenceTable.pluralLabel;
  for (const relation of referenceRelationships)
    if (!manifest.relationships.some((r) => r.name === relation.name))
      manifest.relationships.push(structuredClone(relation));
  return manifest;
}
export function extendReferenceCatalogue(catalogue, schema) {
  const observable =
    schema.tables.some((table) => table.name === 'pqvd_currencyreference') &&
    schema.relationships.some((relation) => relation.name === 'pqvd_access_currencyreferences');
  const currencies = new Map();
  for (const currency of observable
    ? catalogue.records.filter((record) => record.table === 'transactioncurrency')
    : []) {
    const code = currency.fields.isocurrencycode,
      key = 'currencyreference-' + code;
    if (!/^[A-Z]{3}$/.test(code)) throw new Error('CurrencyReference requires an actual three-letter ISO code.');
    let reference = catalogue.records.find((record) => record.key === key);
    if (!reference) {
      reference = {
        key,
        id: fixtureId(key),
        table: 'pqvd_currencyreference',
        fields: {
          pqvd_name: currency.fields.currencyname,
          pqvd_code: code,
          pqvd_symbol: currency.fields.currencysymbol,
          pqvd_precision: currency.fields.currencyprecision,
        },
        refs: { pqvd_systemcurrencyid: currency.key },
        deferredRefs: [],
      };
      catalogue.records.push(reference);
    }
    if (
      reference.table !== 'pqvd_currencyreference' ||
      reference.refs.pqvd_systemcurrencyid !== currency.key ||
      reference.fields.pqvd_code !== code
    )
      throw new Error('CurrencyReference source mapping drift; do not overwrite an existing reference.');
    currencies.set(currency.key, key);
  }
  if (observable && catalogue.tables && !catalogue.tables.some((table) => table.name === 'pqvd_currencyreference'))
    catalogue.tables.push({
      name: 'pqvd_currencyreference',
      entitySet: 'pqvd_currencyreferences',
      primaryId: 'pqvd_currencyreferenceid',
      keys: currencyReferenceTable.keys.map((key) => key.columns),
    });
  const rows = new Map(catalogue.records.map((r) => [r.key, r])),
    active = schema.choices.find((c) => c.name === 'pqvd_accessstate').options.find((o) => o.label === 'Active').value;
  const association = (relationship, key) =>
    catalogue.associations.find((a) => a.relationship === relationship && a.from === key)?.to ?? [];
  // Vendor/currency projections are separate leaves; they never join the
  // operational account projection, and clearing a principal revokes them.
  for (const grant of catalogue.records.filter((r) => r.table === 'pqvd_accesspermission')) {
    const role = rows.get(grant.refs.pqvd_roleid)?.fields.pqvd_code,
      principal = grant.refs['pqvd_' + role?.toLowerCase() + 'principalid'];
    const references = {
      pqvd_access_currencies: new Set(),
      pqvd_access_referenceaccounts: new Set(),
      ...(observable ? { pqvd_access_currencyreferences: new Set() } : {}),
    };
    if (
      referenceRoles.includes(role) &&
      grant.fields.pqvd_accessstate === active &&
      principal === grant.refs.pqvd_granteecontactid
    ) {
      const accounts = new Set(association('pqvd_access_accounts', grant.key));
      for (const detail of catalogue.records.filter((r) =>
        role === 'HR' ? r.table === 'pqvd_employmentterms' : r.table === 'pqvd_equipmentfinance',
      )) {
        const parent = rows.get(detail.refs[role === 'HR' ? 'pqvd_employmentid' : 'pqvd_equipmentid']),
          membership = role === 'HR' ? rows.get(parent?.refs.pqvd_orgcontactid) : null,
          account = role === 'HR' ? membership?.refs.pqvd_accountid : parent?.refs.pqvd_accountid;
        if (!accounts.has(account)) continue;
        if (detail.refs.transactioncurrencyid) {
          references.pqvd_access_currencies.add(detail.refs.transactioncurrencyid);
          if (observable) {
            const reference = currencies.get(detail.refs.transactioncurrencyid);
            if (!reference) throw new Error('A Money currency lacks its one-to-one observable reference.');
            references.pqvd_access_currencyreferences.add(reference);
          }
        }
        const vendor = detail.refs.pqvd_supplieraccountid ?? parent?.refs.pqvd_supplieraccountid;
        if (vendor) references.pqvd_access_referenceaccounts.add(vendor);
      }
    }
    for (const [relationship, set] of Object.entries(references)) {
      const record = { relationship, from: grant.key, to: [...set].sort() },
        existing = catalogue.associations.find((a) => a.relationship === relationship && a.from === grant.key);
      if (existing) existing.to = record.to;
      else catalogue.associations.push(record);
    }
  }
  return catalogue;
}
