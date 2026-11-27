// A Dataverse Web API session over an invented Solution folder, for replay adapters that load sources the way an export
// does. files maps Solution-relative paths to text; the session signs in one System Administrator application user.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../api.mjs';
import { makeTemporaryDirectory, removeFixtureDirectory } from '../../testing/owned-fixture.mjs';
import { tokenFor } from './dataverse-fixtures.mjs';

const APP_ID = '60000000-0000-4000-8000-000000000001';
const SECRET_VARIABLE = 'MIRAGE_SOLUTION_WEB_API_SECRET';

// The state and status reason pair every exported custom table carries: Active (0, reason 1) and Inactive (1, reason 2).
const STATE_STATUS = [
  [
    'statecode',
    'state',
    '<optionset><OptionSetType>state</OptionSetType><states>' +
      '<state value="0" defaultstatus="1" invariantname="Active"><labels><label description="Active" languagecode="1033" /></labels></state>' +
      '<state value="1" defaultstatus="2" invariantname="Inactive"><labels><label description="Inactive" languagecode="1033" /></labels></state>' +
      '</states></optionset>',
  ],
  [
    'statuscode',
    'status',
    '<optionset><OptionSetType>status</OptionSetType><statuses>' +
      '<status value="1" state="0"><labels><label description="Active" languagecode="1033" /></labels></status>' +
      '<status value="2" state="1"><labels><label description="Inactive" languagecode="1033" /></labels></status>' +
      '</statuses></optionset>',
  ],
];

/** Entity XML of one invented user-owned table: { table, set, id, name, attributes: [[name, type, innerXml]] }. */
export function entityXml({ table, set, id = `${table}id`, name, attributes }) {
  const attribute = ([column, type, extra = '']) =>
    `<attribute PhysicalName="${column}"><Type>${type}</Type><Name>${column}</Name><LogicalName>${column}</LogicalName>${extra}</attribute>`;
  return (
    `<Entity><Name>${table}</Name><EntityInfo><entity Name="${table}"><EntitySetName>${set}</EntitySetName>` +
    `<PrimaryIdAttribute>${id}</PrimaryIdAttribute><PrimaryNameAttribute>${name}</PrimaryNameAttribute>` +
    '<OwnershipTypeMask>UserOwned</OwnershipTypeMask>' +
    `<attributes>${[[id, 'primarykey'], ...STATE_STATUS, ...attributes].map(attribute).join('')}</attributes></entity></EntityInfo></Entity>`
  );
}

/**
 * One exported EntityRelationship: { schemaName, type: 'OneToMany', referencing, referenced, lookup, cascade: { Assign, ... } }
 * or { schemaName, type: 'ManyToMany', first, second, intersect }. Navigation names are the export's: the lookup on the
 * referencing side, the schema name on both sides of an N:N.
 */
export function relationshipXml(relationship) {
  const { schemaName, type } = relationship;
  if (type === 'ManyToMany') {
    const role = (ordinal) =>
      `<EntityRelationshipRole><NavPaneDisplayOption>UseLabel</NavPaneDisplayOption><NavigationPropertyName>${schemaName}</NavigationPropertyName><AssociationRoleOrdinal>${ordinal}</AssociationRoleOrdinal></EntityRelationshipRole>`;
    return (
      `<EntityRelationship Name="${schemaName}"><EntityRelationshipType>ManyToMany</EntityRelationshipType>` +
      `<FirstEntityName>${relationship.first}</FirstEntityName><SecondEntityName>${relationship.second}</SecondEntityName>` +
      `<IntersectEntityName>${relationship.intersect}</IntersectEntityName><EntityRelationshipRoles>${role(1)}${role(2)}</EntityRelationshipRoles></EntityRelationship>`
    );
  }
  const cascade = Object.entries(relationship.cascade ?? {})
    .map(([action, value]) => `<Cascade${action}>${value}</Cascade${action}>`)
    .join('');
  return (
    `<EntityRelationship Name="${schemaName}"><EntityRelationshipType>OneToMany</EntityRelationshipType>` +
    `<ReferencingEntityName>${relationship.referencing}</ReferencingEntityName><ReferencedEntityName>${relationship.referenced}</ReferencedEntityName>` +
    `${cascade}<ReferencingAttributeName>${relationship.lookup}</ReferencingAttributeName><EntityRelationshipRoles>` +
    `<EntityRelationshipRole><NavigationPropertyName>${relationship.lookup}</NavigationPropertyName><RelationshipRoleType>1</RelationshipRoleType></EntityRelationshipRole>` +
    `<EntityRelationshipRole><NavigationPropertyName>${schemaName}</NavigationPropertyName><RelationshipRoleType>0</RelationshipRoleType></EntityRelationshipRole>` +
    '</EntityRelationshipRoles></EntityRelationship>'
  );
}
export const relationshipsXml = (relationships) =>
  `<EntityRelationships>${relationships.map(relationshipXml).join('')}</EntityRelationships>`;

/**
 * Starts a simulator over files (Solution-relative path -> text) with clock (epoch ms, fixed) and returns
 * { call(route, init), close() }; call answers { status, body } of /api/data/v9.2/<route> as the application user.
 */
export async function solutionWebApi(files, { clock } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-solution-web-api-'));
  let sim = null;
  const previous = process.env[SECRET_VARIABLE];
  const close = async () => {
    await sim?.close();
    if (previous === undefined) delete process.env[SECRET_VARIABLE];
    else process.env[SECRET_VARIABLE] = previous;
    await removeFixtureDirectory(root);
  };
  try {
    for (const [relative, body] of Object.entries({
      'Other/Solution.xml':
        '<ImportExportXml><SolutionManifest><UniqueName>InventedReplay</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
      ...files,
    })) {
      const file = path.join(root, 'solution', relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body);
    }
    process.env[SECRET_VARIABLE] = 'invented-solution-web-api-secret';
    sim = await createSimulator({
      runtime: { kind: 'dataverse-api' },
      solutionRoots: [path.join(root, 'solution')],
      port: 0,
      watch: false,
      ...(clock === undefined ? {} : { clock: () => clock }),
      dataverse: {
        enabled: true,
        port: 0,
        tds: { enabled: false },
        applications: [
          {
            appId: APP_ID,
            displayName: 'Replay',
            secretEnvironmentVariable: SECRET_VARIABLE,
            roles: ['System Administrator'],
          },
        ],
      },
    });
    const info = await (
      await fetch(new URL(sim.url).origin + '/_sim/api/dataverse', { headers: { 'x-sim-csrf': sim.csrf } })
    ).json();
    const token = await tokenFor(info, APP_ID, SECRET_VARIABLE);
    const base = `${info.origin}/api/data/v9.2/`;
    const call = async (route, { body, headers, ...init } = {}) => {
      const response = await fetch(base + route, {
        ...init,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    return { call, close, base };
  } catch (error) {
    await close();
    throw error;
  }
}
