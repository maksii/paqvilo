// Solution security roles and field security profiles become rows of the security tables; a managed import replaces a
// custom role's privileges.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { ensureSecurityModel, createPrincipals } from '../lib/dataverse-security.mjs';
import { scanSolutionSources, buildSolutionSchema, readSolutionZip } from '../lib/solution-schema.mjs';
import { securityDefinitions, inventoryEntry } from '../lib/solution-inventory.mjs';
import { zipOf } from '../lib/dataverse-solutions.mjs';

const ROLE = '77777777-7777-4777-8777-777777777781';
const FSP = '77777777-7777-4777-8777-777777777782';
const USER_OID = '77777777-7777-4777-8777-777777777783';
const APP = '55555555-5555-4555-8555-555555555555';
const roleXml = (privileges) =>
  `<Role id="{${ROLE}}" name="Fx Clerk"><RolePrivileges>${privileges.map(([name, level]) => `<RolePrivilege name="${name}" level="${level}" />`).join('')}</RolePrivileges></Role>`;
const profileXml = `<FieldSecurityProfiles><FieldSecurityProfile fieldsecurityprofileid="{${FSP}}" name="Fx Secret Readers"><FieldPermissions><FieldPermission entityname="fx_item" attributelogicalname="fx_secret" canread="4" cancreate="0" canupdate="0" /></FieldPermissions></FieldSecurityProfile></FieldSecurityProfiles>`;
const entityXml =
  '<Entity><Name>fx_item</Name><EntityInfo><entity Name="fx_item"><EntitySetName>fx_items</EntitySetName><PrimaryIdAttribute>fx_itemid</PrimaryIdAttribute><PrimaryNameAttribute>fx_name</PrimaryNameAttribute><attributes><attribute PhysicalName="fx_itemid"><Name>fx_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="fx_name"><Name>fx_name</Name><Type>nvarchar</Type></attribute><attribute PhysicalName="fx_secret"><Name>fx_secret</Name><Type>nvarchar</Type><IsSecured>1</IsSecured></attribute></attributes></entity></EntityInfo></Entity>';

async function layer(root, name, files) {
  const dir = path.join(root, name);
  const all = {
    'Other/Solution.xml': `<ImportExportXml><SolutionManifest><UniqueName>${name}</UniqueName><Version>1.0.0.0</Version><Managed>0</Managed></SolutionManifest></ImportExportXml>`,
    ...files,
  };
  for (const [relative, content] of Object.entries(all)) {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.writeFile(path.join(dir, relative), content);
  }
  return dir;
}

// The schema the organization seeds from: the Solution tables plus the security definitions of the inventory.
async function sourceSchema(t, layers) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'solution-security-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dirs = [];
  for (const [name, files] of layers) dirs.push(await layer(root, name, files));
  const scan = await scanSolutionSources(dirs, { order: 'explicit' });
  return { ...buildSolutionSchema(scan), ...securityDefinitions(scan.inventory) };
}

// Privilege names compare case-insensitively (the noun's case comes from the table's schema name).
const depths = (map) => new Map([...map].map(([name, depth]) => [name.toLowerCase(), depth]));

async function seeded(schema) {
  const store = await new DataStore({ state: emptyState() }).init();
  const settings = dataverseSettings({
    enabled: true,
    organizationId: '77777777-7777-4777-8777-777777777790',
    tenantId: '77777777-7777-4777-8777-777777777791',
    users: [{ domainname: 'clerk@example.test', objectId: USER_OID, fullname: 'Clerk', roles: ['Fx Clerk'] }],
  });
  await ensureSecurityModel(store, settings, { schema });
  const principals = createPrincipals(store, { organizationId: settings.organizationId, schema });
  return { store, user: principals.byObjectId(USER_OID), principals };
}

test('role and profile files are read into privileges and permissions, and stay behaviour-level only when read', () => {
  const [role] = inventoryEntry('Roles/Fx Clerk.xml', {
    text: roleXml([
      ['prvReadfx_item', 'Global'],
      ['prvCreatefx_item', 'Basic'],
    ]),
    component: 'role',
    componentName: 'Fx Clerk',
  });
  assert.deepEqual(
    [role.level, role.reason, role.id, role.privileges],
    [
      'behaviour',
      null,
      ROLE,
      [
        { name: 'prvReadfx_item', depth: 'Global' },
        { name: 'prvCreatefx_item', depth: 'Basic' },
      ],
    ],
  );
  // A YAML role is read (security roles are stored as XML internally and converted to YAML); only an unreadable file
  // stays inventory.
  const [unread] = inventoryEntry('Roles/Fx Clerk.yml', {
    text: 'name: [unclosed',
    component: 'role',
    componentName: 'Fx Clerk',
  });
  assert.deepEqual([unread.level, unread.reason], ['inventory', 'ROLE_NOT_IMPORTED']);
});

test('a YAML role and field security profile import the same privileges and permissions as their XML form', () => {
  const roleYaml = `Role:\n  '@id': '{${ROLE}}'\n  '@name': Fx Clerk\n  RolePrivileges:\n    RolePrivilege:\n      - '@name': prvReadfx_item\n        '@level': Global\n      - '@name': prvCreatefx_item\n        '@level': Basic\n`;
  const profileYaml = `FieldSecurityProfile:\n  '@fieldsecurityprofileid': '{${FSP}}'\n  '@name': Fx Secret Readers\n  FieldPermissions:\n    FieldPermission:\n      - '@entityname': fx_item\n        '@attributelogicalname': fx_secret\n        '@canread': '4'\n        '@cancreate': '0'\n        '@canupdate': '0'\n`;
  const facts = (file, text, component, componentName) =>
    securityDefinitions(inventoryEntry(file, { text, component, componentName }));
  assert.deepEqual(
    facts('roles/Fx Clerk.yml', roleYaml, 'role', 'Fx Clerk'),
    facts(
      'Roles/Fx Clerk.xml',
      roleXml([
        ['prvReadfx_item', 'Global'],
        ['prvCreatefx_item', 'Basic'],
      ]),
      'role',
      'Fx Clerk',
    ),
  );
  const yamlProfile = facts(
    'fieldsecurityprofiles/Fx Secret Readers.yml',
    profileYaml,
    'fieldsecurityprofile',
    'Fx Secret Readers',
  );
  assert.deepEqual(
    yamlProfile,
    facts('FieldSecurityProfiles/Fx Secret Readers.xml', profileXml, 'fieldsecurityprofile', 'Fx Secret Readers'),
  );
  assert.equal(yamlProfile.fieldSecurityProfiles[0].permissions.length, 1);
});

test('a configured user holds a Solution role with its privileges and Solution id; the profile and its permissions are rows', async (t) => {
  const schema = await sourceSchema(t, [
    [
      'InventedSecurity',
      {
        'Entities/fx_item/Entity.xml': entityXml,
        'Roles/Fx Clerk.xml': roleXml([
          ['prvReadfx_item', 'Global'],
          ['prvCreatefx_item', 'Basic'],
          ['prvReadfx_missing', 'Global'],
        ]),
        'Other/Customizations.xml': `<ImportExportXml><Entities /><Roles />${profileXml}</ImportExportXml>`,
      },
    ],
  ]);
  const { store, user, principals } = await seeded(schema);
  assert.ok(store.state.tables.role.some((row) => row.roleid === ROLE && row.name === 'Fx Clerk'));
  assert.deepEqual(
    principals.roles(user).map((role) => role.name),
    ['Fx Clerk'],
  );
  const privileges = depths(principals.privileges(user));
  assert.equal(privileges.get('prvreadfx_item'), 8);
  assert.equal(privileges.get('prvcreatefx_item'), 1);
  assert.equal(privileges.has('prvwritefx_item'), false);
  // An unknown privilege name is reported and not granted.
  assert.deepEqual(
    store.state.dataverse.securityDiagnostics.map((d) => [d.code, d.privilege]),
    [['SOLUTION_ROLE_PRIVILEGE_UNKNOWN', 'prvReadfx_missing']],
  );
  assert.ok(
    store.state.tables.fieldsecurityprofile.some(
      (row) => row.fieldsecurityprofileid === FSP && row.name === 'Fx Secret Readers',
    ),
  );
  assert.deepEqual(
    store.state.tables.fieldpermission
      .filter((row) => row.fieldsecurityprofileid.id === FSP)
      .map((row) => [row.entityname, row.attributelogicalname, row.canread, row.canupdate]),
    [['fx_item', 'fx_secret', 4, 0]],
  );
});

test('a later layer replaces the role privilege set', async (t) => {
  const schema = await sourceSchema(t, [
    [
      'InventedBase',
      {
        'Entities/fx_item/Entity.xml': entityXml,
        'Roles/Fx Clerk.xml': roleXml([
          ['prvReadfx_item', 'Global'],
          ['prvCreatefx_item', 'Basic'],
        ]),
      },
    ],
    ['InventedTop', { 'Roles/Fx Clerk.xml': roleXml([['prvReadfx_item', 'Local']]) }],
  ]);
  const { user, principals } = await seeded(schema);
  const privileges = depths(principals.privileges(user));
  assert.equal(privileges.get('prvreadfx_item'), 2);
  assert.equal(privileges.has('prvcreatefx_item'), false);
});

test('ImportSolution imports a managed role and profile; a role changed after import keeps its unmanaged layer on re-import', async (t) => {
  const variable = `PAQ_SECURITY_SECRET_${process.pid}`;
  process.env[variable] = 'invented-secret';
  t.after(() => {
    delete process.env[variable];
  });
  const start = async () => {
    const store = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      tds: { enabled: false },
      applications: [
        { appId: APP, displayName: 'Invented', secretEnvironmentVariable: variable, roles: ['System Administrator'] },
      ],
    });
    const api = await startDataverseApi({ store, settings, log: () => {} });
    t.after(() => api.close());
    const token = (
      await (
        await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: APP,
            client_secret: 'invented-secret',
            scope: `${api.origin}/.default`,
          }),
        })
      ).json()
    ).access_token;
    const request = async (method, url, body, headers = {}) => {
      const response = await fetch(`${api.origin}/api/data/v9.2${url}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
        body: body && JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, json: text ? JSON.parse(text) : null };
    };
    return { store, request };
  };
  const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
  const src = await start();
  await src.request('POST', '/publishers', {
    uniquename: 'fx_pub',
    friendlyname: 'Fx',
    customizationprefix: 'fx',
    customizationoptionvalueprefix: 10000,
  });
  const pub = (await src.request('GET', "/publishers?$select=publisherid&$filter=uniquename eq 'fx_pub'")).json.value[0]
    .publisherid;
  await src.request('POST', '/solutions', {
    uniquename: 'fx_sec',
    friendlyname: 'fx_sec',
    version: '1.0.0.0',
    'publisherid@odata.bind': `/publishers(${pub})`,
  });

  assert.equal(
    (
      await src.request(
        'POST',
        '/EntityDefinitions',
        {
          '@odata.type': '#Microsoft.Dynamics.CRM.EntityMetadata',
          SchemaName: 'fx_Item',
          DisplayName: label('Item'),
          DisplayCollectionName: label('Items'),
          OwnershipType: 'UserOwned',
          IsActivity: false,
          HasActivities: false,
          HasNotes: false,
          Attributes: [
            {
              '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
              SchemaName: 'fx_Name',
              DisplayName: label('Name'),
              IsPrimaryName: true,
              MaxLength: 100,
            },
          ],
        },
        { 'MSCRM.SolutionUniqueName': 'fx_sec' },
      )
    ).status,
    204,
  );
  const exported = Buffer.from(
    (await src.request('POST', '/ExportSolution', { SolutionName: 'fx_sec', Managed: true })).json.ExportSolutionFile,
    'base64',
  );
  const withSecurity = (privileges) =>
    zipOf([
      ...readSolutionZip(exported).map((entry) => ({
        name: entry.name,
        data: Buffer.from(
          entry.xml != null
            ? entry.xml.replace(/<\/ImportExportXml>\s*$/, (end) =>
                /customizations\.xml$/i.test(entry.name) ? `${profileXml}${end}` : end,
              )
            : entry.read(),
        ),
      })),
      { name: 'Roles/Fx Clerk.xml', data: Buffer.from(roleXml(privileges)) },
    ]);
  const dst = await start();
  const imported = await dst.request('POST', '/ImportSolution', {
    CustomizationFile: withSecurity([['prvReadfx_Item', 'Global']]).toString('base64'),
  });
  assert.equal(imported.status, 204, JSON.stringify(imported.json));
  const role = dst.store.state.tables.role.find((row) => row.roleid === ROLE);
  assert.deepEqual([role?.name, role?.ismanaged], ['Fx Clerk', true]);
  assert.ok(dst.store.state.tables.fieldpermission.some((row) => row.attributelogicalname === 'fx_secret'));
  const privilegesOf = async () =>
    (await dst.request('GET', `/RetrieveRolePrivilegesRole(RoleId=${ROLE})`)).json.RolePrivileges.map((p) => [
      p.PrivilegeName,
      p.Depth,
    ]);
  assert.deepEqual(await privilegesOf(), [['prvReadfx_item', 'Global']]);
  // A re-import replaces the managed privilege set.
  await dst.request('POST', '/ImportSolution', {
    CustomizationFile: withSecurity([['prvReadfx_Item', 'Basic']]).toString('base64'),
  });
  assert.deepEqual(await privilegesOf(), [['prvReadfx_item', 'Basic']]);
  // A customization on top (AddPrivilegesRole) survives the next managed import.
  const write = dst.store.state.tables.privilege.find(
    (row) => row.name.toLowerCase() === 'prvwritefx_item',
  ).privilegeid;
  assert.equal(
    (
      await dst.request('POST', `/roles(${ROLE})/Microsoft.Dynamics.CRM.AddPrivilegesRole`, {
        Privileges: [{ PrivilegeId: write, Depth: 'Global' }],
      })
    ).status,
    204,
  );
  await dst.request('POST', '/ImportSolution', {
    CustomizationFile: withSecurity([['prvReadfx_Item', 'Local']]).toString('base64'),
  });
  assert.deepEqual((await privilegesOf()).sort(), [
    ['prvReadfx_item', 'Basic'],
    ['prvWritefx_item', 'Global'],
  ]);
});
