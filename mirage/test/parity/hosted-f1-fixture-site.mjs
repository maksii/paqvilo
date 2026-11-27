// The site hosted session F1 recorded its portal Web API runs on, rebuilt from invented sources: the session's own
// three-table schema (an item table with a contact, an account and a hierarchical self lookup; a child table under it; a
// custom activity table), its Web API settings and table permissions, and the synthetic rows the session seeded (the
// item's date and image columns are left out: no replayed case reads them). The
// table, column and relationship names are the ones the session created for the recording (prefix pqf1); the row ids are
// the session's own fixed synthetic ids. The signed-in contact and its account are invented here: the recorded ones were
// live records. Shared by the portal-webapi replay adapter for the hosted-f1-* suites.
import fs from 'node:fs/promises';
import path from 'node:path';

/** The invented signed-in contact and its account; the converter writes `{contact}` for the recorded contact. */
export const F1_CONTACT = '0f100000-0000-4000-8000-00000000c001';
export const F1_ACCOUNT = '0f100000-0000-4000-8000-00000000a001';
export const F1_ROLE = 'pqf1 F1 role';

export const fixed = (n) => `f1f1f1f1-0000-4000-8000-${String(n).padStart(12, '0')}`;

// The item table's Web API column list as the session set it, and the other tables' lists. The contact list is the
// recorded site's own (without a column of another schema the invented contact does not have).
export const F1_SETTINGS = {
  'Webapi/pqf1_item/enabled': 'true',
  'Webapi/pqf1_item/fields':
    'pqf1_itemid,pqf1_name,pqf1_amount,pqf1_when,pqf1_day,pqf1_tzi,pqf1_file,pqf1_image,pqf1_thumb,pqf1_contact,pqf1_account,pqf1_parentitem',
  'Webapi/pqf1_child/enabled': 'true',
  'Webapi/pqf1_child/fields': 'pqf1_childid,pqf1_name,pqf1_amount,pqf1_tag,pqf1_item',
  'Webapi/contact/enabled': 'true',
  'Webapi/contact/fields': 'contactid,firstname,fullname,lastname',
};

// Rows the session seeded (its cases.mjs): an item tree under "A root", an item outside the contact's scope, children,
// one task, relative-date rows and DST boundary rows (the second run had four more DST rows; both sets are here).
const ITEM = { aRoot: 1001, aChild1: 1002, aChild2: 1003, aGrand: 1004, bRoot: 1005, hidden: 1006, file: 1007 };
const ITEMS = [
  [ITEM.aRoot, 'A root', 10, null, true],
  [ITEM.aChild1, 'A child 1', 20, ITEM.aRoot, true],
  [ITEM.aChild2, 'A child 2', 30, ITEM.aRoot, true],
  [ITEM.aGrand, 'A grandchild', 40, ITEM.aChild1, true],
  [ITEM.bRoot, 'B root', 50, null, true],
  [ITEM.hidden, 'Hidden other', 60, ITEM.aRoot, false],
  [ITEM.file, 'File holder', 70, null, true],
];
const CHILDREN = [
  [1101, 'C1 of A root', 'x', 1, ITEM.aRoot],
  [1102, 'C2 of A root', 'y', 2, ITEM.aRoot],
  [1103, 'C3 of A child 1', 'x', 3, ITEM.aChild1],
  [1104, 'C4 of Hidden other', 'x', 4, ITEM.hidden],
];
const DATED = ['d_m1', 'd_m6', 'd_m13', 'd_m20', 'd_m26', 'd_m40', 'd_p3', 'd_p11', 'd_p20'].map((key, index) => [
  1301 + index,
  `date ${key}`,
]);
const DST = [
  'dst us-start 06:30Z',
  'dst us-start 07:30Z',
  'dst eu-start 00:30Z',
  'dst eu-start 01:30Z',
  'dst eu-start 22:30Z prev',
  'dst eu-start 23:30Z prev',
  'dst summer 0615 21:30Z',
  'dst summer 0616 04:30Z',
  'dst winter 0115 21:30Z',
  'dst winter 0116 04:30Z',
].map((name, index) => [1401 + index, name]);

export const reference = (id, logicalName, name) => ({ id, logical_name: logicalName, name });

function rows() {
  const name = new Map(ITEMS.map(([n, label]) => [n, label]));
  const contact = reference(F1_CONTACT, 'contact', 'Invented Reader');
  const item = (n, label, extra = {}) => ({ pqf1_itemid: fixed(n), pqf1_name: label, statecode: 0, ...extra });
  return {
    contact: [
      {
        contactid: F1_CONTACT,
        firstname: 'Invented',
        lastname: 'Reader',
        fullname: 'Invented Reader',
        parentcustomerid: reference(F1_ACCOUNT, 'account', 'Invented Account'),
      },
    ],
    account: [{ accountid: F1_ACCOUNT, name: 'Invented Account' }],
    pqf1_item: [
      ...ITEMS.map(([n, label, amount, parent, mine]) =>
        item(n, label, {
          pqf1_amount: amount,
          ...(parent ? { pqf1_parentitem: reference(fixed(parent), 'pqf1_item', name.get(parent)) } : {}),
          ...(mine ? { pqf1_contact: contact } : {}),
        }),
      ),
      ...[...DATED, ...DST].map(([n, label]) => item(n, label, { pqf1_contact: contact })),
    ],
    pqf1_child: CHILDREN.map(([n, label, tag, amount, parent]) => ({
      pqf1_childid: fixed(n),
      pqf1_name: label,
      pqf1_tag: tag,
      pqf1_amount: amount,
      pqf1_item: reference(fixed(parent), 'pqf1_item', name.get(parent)),
      statecode: 0,
    })),
    pqf1_task: [
      {
        activityid: fixed(1201),
        subject: 'pqf1 task one',
        pqf1_note: 'task note',
        description: 'task description',
        activitytypecode: 'pqf1_task',
        statecode: 0,
      },
    ],
  };
}

// The F1 role's table permissions as the session created them: contact scope on items through pqf1_contact, parent scope
// on children through the item, Global read on tasks; and the recorded contact's read of its own contact row, which its
// expansions of pqf1_contact show.
const permissions = () => [
  {
    id: fixed(21),
    entity: 'pqf1_item',
    scope: 'contact',
    field: 'pqf1_contact',
    roles: [F1_ROLE],
    operations: ['read', 'update', 'create', 'append', 'appendTo'],
  },
  {
    id: fixed(22),
    entity: 'pqf1_child',
    scope: 'parent',
    parentPermissionId: fixed(21),
    relationship: { entity: 'pqf1_item', from: 'pqf1_item', to: 'pqf1_itemid' },
    roles: [F1_ROLE],
    operations: ['read'],
  },
  { id: fixed(23), entity: 'pqf1_task', scope: 'global', roles: [F1_ROLE], operations: ['read'] },
  { id: fixed(25), entity: 'contact', scope: 'self', roles: [F1_ROLE], operations: ['read'] },
];

/** The runtime state the site starts from: the seeded rows and permissions; the Solution supplies the mappings. */
export function hostedF1State() {
  return {
    version: 1,
    mappings: {},
    tables: rows(),
    permissions: permissions(),
    settings: { permissionMode: 'enforce' },
    simulator: { mode: 'local', pageMode: 'local', endpoints: [] },
  };
}

// ---- Solution XML of the session's schema

export const attribute = (name, type, extra = '') =>
  `<attribute PhysicalName="${name}"><Type>${type}</Type><Name>${name}</Name><LogicalName>${name}</LogicalName>` +
  `<RequiredLevel>none</RequiredLevel><ValidForUpdateApi>1</ValidForUpdateApi><ValidForReadApi>1</ValidForReadApi>` +
  `<ValidForCreateApi>1</ValidForCreateApi>${extra}</attribute>`;
export const primaryName = (name) =>
  attribute(name, 'nvarchar', '<DisplayMask>PrimaryName|ValidForAdvancedFind</DisplayMask>');
const dateColumn = (name, behavior, format) =>
  attribute(name, 'datetime', `<Format>${format}</Format><Behavior>${behavior}</Behavior>`);
export const system = (prefix) => [
  attribute(`${prefix}id`, 'primarykey'),
  attribute('ownerid', 'owner'),
  attribute('statecode', 'state'),
  attribute('statuscode', 'status'),
  attribute('createdon', 'datetime', '<ValidForCreateApi>0</ValidForCreateApi>'),
  attribute('modifiedon', 'datetime'),
];

const TABLES = {
  pqf1_item: {
    set: 'pqf1_items',
    activity: false,
    attributes: [
      ...system('pqf1_item'),
      primaryName('pqf1_name'),
      attribute('pqf1_amount', 'int'),
      attribute('pqf1_secret', 'nvarchar'),
      dateColumn('pqf1_when', '1', 'datetime'),
      dateColumn('pqf1_day', '2', 'date'),
      dateColumn('pqf1_tzi', '3', 'datetime'),
      attribute('pqf1_file', 'file', '<MaxValue>32768</MaxValue>'),
      attribute('pqf1_contact', 'lookup'),
      attribute('pqf1_account', 'lookup'),
      attribute('pqf1_parentitem', 'lookup'),
    ],
  },
  pqf1_child: {
    set: 'pqf1_children',
    activity: false,
    attributes: [
      ...system('pqf1_child'),
      primaryName('pqf1_name'),
      attribute('pqf1_amount', 'int'),
      attribute('pqf1_tag', 'nvarchar'),
      attribute('pqf1_item', 'lookup'),
    ],
  },
  pqf1_task: {
    set: 'pqf1_tasks',
    activity: true,
    attributes: [
      attribute('activityid', 'primarykey'),
      primaryName('subject'),
      attribute('description', 'memo'),
      attribute('activitytypecode', 'entityname'),
      attribute('ownerid', 'owner'),
      attribute('statecode', 'state'),
      attribute('statuscode', 'status'),
      attribute('pqf1_note', 'nvarchar'),
    ],
  },
};

const entityXml = (name, table) =>
  `<?xml version="1.0" encoding="utf-8"?><Entity><Name>${name}</Name><EntityInfo><entity Name="${name}">` +
  `<attributes>${table.attributes.join('')}</attributes><EntitySetName>${table.set}</EntitySetName>` +
  `<OwnershipTypeMask>UserOwned</OwnershipTypeMask><IsActivity>${table.activity ? 1 : 0}</IsActivity>` +
  (table.virtual ? '<TableType>Virtual</TableType>' : '') +
  (table.extra ?? '') +
  `</entity></EntityInfo></Entity>`;

// One-to-many relationships as the session's provision step named them: <lookup>_<referenced>_<referencing>, the lookup
// as the single-valued navigation and the schema name as the collection-valued one.
const RELATIONSHIPS = [
  ['pqf1_contact', 'pqf1_item', 'contact'],
  ['pqf1_account', 'pqf1_item', 'account'],
  ['pqf1_parentitem', 'pqf1_item', 'pqf1_item'],
  ['pqf1_item', 'pqf1_child', 'pqf1_item'],
];
const relationshipXml = ([lookup, referencing, referenced]) =>
  `<EntityRelationship Name="${lookup}_${referenced}_${referencing}"><EntityRelationshipType>OneToMany</EntityRelationshipType>` +
  `<IsHierarchical>${referencing === referenced ? 1 : 0}</IsHierarchical>` +
  `<ReferencingEntityName>${referencing}</ReferencingEntityName><ReferencedEntityName>${referenced}</ReferencedEntityName>` +
  `<CascadeDelete>RemoveLink</CascadeDelete><ReferencingAttributeName>${lookup}</ReferencingAttributeName>` +
  `<EntityRelationshipRoles><EntityRelationshipRole><NavigationPropertyName>${lookup}</NavigationPropertyName>` +
  `<RelationshipRoleType>1</RelationshipRoleType></EntityRelationshipRole><EntityRelationshipRole>` +
  `<NavigationPropertyName>${lookup}_${referenced}_${referencing}</NavigationPropertyName>` +
  `<RelationshipRoleType>0</RelationshipRoleType></EntityRelationshipRole></EntityRelationshipRoles></EntityRelationship>`;

const settingsYaml = (settings) =>
  Object.entries(settings)
    .map(([name, value]) => `- adx_name: ${name}\n  adx_value: '${String(value).replaceAll("'", "''")}'\n`)
    .join('');

/**
 * Writes the site into `directory` (portal source in `portal`, the Solution in `solution`) with `settings` over the
 * session's own Web API settings (a null value removes one), and returns the simulator options for it.
 */
export async function writeHostedF1Site(directory, settings = {}) {
  return writeSchemaSite(directory, {
    tables: TABLES,
    relationships: RELATIONSHIPS,
    settings: { ...F1_SETTINGS, ...settings },
    initial: hostedF1State(),
  });
}

/**
 * Writes a portal source (`portal`) with `settings` (a null value is left out) and a Solution (`solution`) of `tables`
 * ({ set, activity?, virtual?, attributes }) and one-to-many `relationships` ([lookup, referencing, referenced]) into
 * `directory`, and returns the simulator options for it with `initial` as its runtime state.
 */
export async function writeSchemaSite(
  directory,
  { tables, relationships, settings, initial, name = 'pqf1 replay site' },
) {
  const portal = path.join(directory, 'portal');
  const solution = path.join(directory, 'solution');
  const effective = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== null));
  await fs.mkdir(portal, { recursive: true });
  await fs.writeFile(path.join(portal, 'website.yml'), `adx_websiteid: ${fixed(1)}\nadx_name: ${name}\n`);
  await fs.writeFile(path.join(portal, 'sitesetting.yml'), settingsYaml(effective));
  for (const [table, definition] of Object.entries(tables)) {
    const folder = path.join(solution, 'Entities', table);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'Entity.xml'), entityXml(table, definition));
  }
  await fs.mkdir(path.join(solution, 'Other', 'Relationships'), { recursive: true });
  await fs.writeFile(
    path.join(solution, 'Other', 'Relationships', 'pqf1.xml'),
    `<?xml version="1.0" encoding="utf-8"?><EntityRelationships>${relationships.map(relationshipXml).join('')}</EntityRelationships>`,
  );
  return { sourceDir: portal, solutionRoots: [solution], initial, watch: false, port: 0 };
}
