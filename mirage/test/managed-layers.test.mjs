// @test-kind unproven: local model of managed solution layer stacks over invented archives; no native layer capture is replayed
// Managed layer stacks and the overwrite customizations option.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { stringColumn as column, tableBody, startAdminApi } from './support/web-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { readSolutionZip } from '../lib/solution-schema.mjs';
import { zipOf, solutionImportJob } from '../lib/dataverse-solutions.mjs';

async function server(owner) {
  const store = await new DataStore({ state: emptyState() }).init();
  const captured = {};
  const { request } = await startAdminApi(owner, store, {
    extensions: [
      ...EXTENSIONS,
      {
        name: 'capture',
        install(value) {
          captured.api = value;
        },
      },
    ],
  });
  return { store, request, api: captured.api };
}

// fx_base (managed) brings fx_widget with fx_code MaxLength 20; fx_ext is the same archive renamed with MaxLength 200.
// Both are exported once per file; each test imports them into its own organization.
let base, ext;
before(async () => {
  const closers = [];
  const src = await server({ after: (fn) => closers.push(fn) });
  const publisher = await src.request('POST', '/publishers', {
    uniquename: 'fx_pub',
    friendlyname: 'Fx',
    customizationprefix: 'fx',
    customizationoptionvalueprefix: 10000,
  });
  assert.equal(publisher.status, 204);
  const pub = (await src.request('GET', "/publishers?$select=publisherid&$filter=uniquename eq 'fx_pub'")).json.value[0]
    .publisherid;
  assert.equal(
    (
      await src.request('POST', '/solutions', {
        uniquename: 'fx_base',
        friendlyname: 'fx_base',
        version: '1.0.0.0',
        'publisherid@odata.bind': `/publishers(${pub})`,
      })
    ).status,
    204,
  );
  const H = { 'MSCRM.SolutionUniqueName': 'fx_base' };
  assert.equal((await src.request('POST', '/EntityDefinitions', tableBody('fx_widget'), H)).status, 204);
  assert.equal(
    (
      await src.request(
        'POST',
        "/EntityDefinitions(LogicalName='fx_widget')/Attributes",
        column('fx_Code', { MaxLength: 20 }),
        H,
      )
    ).status,
    204,
  );
  const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
  assert.equal(
    (
      await src.request(
        'POST',
        '/GlobalOptionSetDefinitions',
        {
          '@odata.type': '#Microsoft.Dynamics.CRM.OptionSetMetadata',
          Name: 'fx_tier',
          OptionSetType: 'Picklist',
          DisplayName: label('Tier'),
          Options: [{ Value: 100000000, Label: label('Gold') }],
        },
        H,
      )
    ).status,
    204,
  );
  base = Buffer.from(
    (await src.request('POST', '/ExportSolution', { SolutionName: 'fx_base', Managed: true })).json.ExportSolutionFile,
    'base64',
  );
  ext = zipOf(
    readSolutionZip(base).map((entry) => ({
      name: entry.name,
      data: Buffer.from(
        entry.xml != null
          ? entry.xml
              .replace(/<UniqueName>fx_base<\/UniqueName>/g, '<UniqueName>fx_ext</UniqueName>')
              .replace(/(<attribute PhysicalName="fx_Code">[\s\S]*?<MaxLength>)20(<\/MaxLength>)/i, '$1200$2')
          : entry.read(),
      ),
    })),
  );
  for (const close of closers) await close();
});

const importZip = (dst, zip, overwrite = false) =>
  dst.request('POST', '/ImportSolution', {
    CustomizationFile: zip.toString('base64'),
    OverwriteUnmanagedCustomizations: overwrite,
  });
const maxLength = async (dst) =>
  (
    await dst.request(
      'GET',
      "/EntityDefinitions(LogicalName='fx_widget')/Attributes(LogicalName='fx_code')/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=MaxLength",
    )
  ).json.MaxLength;
const stackOf = (dst) => {
  const solutions = dst.store.state.tables.solution;
  const layer = Object.values(dst.store.state.dataverse.managedLayers).find(
    (item) => item.kind === 'attribute' && item.name === 'fx_code',
  );
  return (layer?.stack ?? []).map(
    (entry) => solutions.find((s) => s.solutionid === entry.solutionid)?.uniquename ?? entry.solutionid,
  );
};
// Waits for the uninstall's own asyncoperation to complete and requires it to have succeeded.
async function uninstall(dst, name) {
  const started = await dst.request('POST', '/UninstallSolutionAsync', { SolutionUniqueName: name });
  assert.equal(started.status, 200);
  const job = await solutionImportJob({ store: dst.store }, started.json.AsyncOperationId);
  assert.equal(job.statuscode, 30, job.message);
  assert.equal(
    dst.store.state.tables.solution.some((s) => s.uniquename === name),
    false,
  );
}

test('uninstalling an upper managed layer restores the lower managed definition', async (t) => {
  const dst = await server(t);
  assert.equal((await importZip(dst, base)).status, 204);
  assert.equal((await importZip(dst, ext, true)).status, 204);
  assert.equal(await maxLength(dst), 200);
  assert.deepEqual(stackOf(dst), ['fx_base', 'fx_ext']);
  await uninstall(dst, 'fx_ext');
  assert.equal(await maxLength(dst), 20);
  assert.deepEqual(stackOf(dst), ['fx_base']);
});

test('a second managed layer becomes active without OverwriteUnmanagedCustomizations when no unmanaged layer is on top', async (t) => {
  const dst = await server(t);
  await importZip(dst, base);
  assert.equal((await importZip(dst, ext, false)).status, 204);
  assert.equal(await maxLength(dst), 200);
});

test('an unmanaged customization stays on top across a managed import without overwrite and is replaced with overwrite', async (t) => {
  const dst = await server(t);
  await importZip(dst, base);
  const id = (
    await dst.request(
      'GET',
      "/EntityDefinitions(LogicalName='fx_widget')/Attributes(LogicalName='fx_code')?$select=MetadataId",
    )
  ).json.MetadataId;
  assert.equal(
    (
      await dst.request('PUT', `/EntityDefinitions(LogicalName='fx_widget')/Attributes(${id})`, {
        ...column('fx_Code', { MaxLength: 50 }),
        LogicalName: 'fx_code',
      })
    ).status,
    204,
  );
  await importZip(dst, ext, false);
  assert.equal(await maxLength(dst), 50);
  const layers = (
    await dst.request('GET', `/RetrieveComponentLayers(ComponentId=${id},SolutionComponentName='attribute')`)
  ).json.Layers;
  assert.deepEqual(
    layers.map((row) => row.msdyn_solutionname),
    ['fx_base', 'fx_ext', 'Active'],
  );
  await importZip(dst, ext, true);
  assert.equal(await maxLength(dst), 200);
  // RemoveActiveCustomization has nothing left to remove once the overwrite replaced the unmanaged layer.
  const removed = await dst.request('POST', '/RemoveActiveCustomization', { LogicalName: 'attribute', Id: id });
  assert.equal(removed.json.Success, false);
});

test('a legacy single-entry managed layer reads as a one-entry stack and still uninstalls', async (t) => {
  const dst = await server(t);
  await importZip(dst, base);
  const solutionid = dst.store.state.tables.solution.find((s) => s.uniquename === 'fx_base').solutionid;
  await dst.store.transact(() => {
    for (const layer of Object.values(dst.store.state.dataverse.managedLayers)) {
      const top = layer.stack.at(-1);
      delete layer.stack;
      Object.assign(layer, { body: top.body, solutionid, seq: top.seq });
    }
  });
  await uninstall(dst, 'fx_base');
  assert.equal(dst.store.state.mappings.fx_widget, undefined);
  assert.equal(Object.values(dst.store.state.dataverse.managedLayers ?? {}).length, 0);
});

// A Solution role carried by two managed solutions: uninstalling the upper one restores the lower one's privileges (the
// managed solution below takes effect); the last layer removes the role row and its grants.
test('uninstalling the upper managed layer of a Solution role restores the lower privileges; the last removes the role', async (t) => {
  const ROLE = '77777777-7777-4777-8777-777777777781';
  const withRole = (unique, privileges) =>
    zipOf([
      ...readSolutionZip(base).map((entry) => ({
        name: entry.name,
        data: Buffer.from(
          entry.xml != null
            ? entry.xml.replace(/<UniqueName>fx_base<\/UniqueName>/g, `<UniqueName>${unique}</UniqueName>`)
            : entry.read(),
        ),
      })),
      {
        name: 'Roles/Fx Clerk.xml',
        data: Buffer.from(
          `<Role id="{${ROLE}}" name="Fx Clerk"><RolePrivileges>${privileges.map((name) => `<RolePrivilege name="${name}" level="Global" />`).join('')}</RolePrivileges></Role>`,
        ),
      },
    ]);
  const dst = await server(t);
  const privileges = async () =>
    ((await dst.request('GET', `/RetrieveRolePrivilegesRole(RoleId=${ROLE})`)).json?.RolePrivileges ?? [])
      .map((p) => p.PrivilegeName)
      .sort();
  assert.equal((await importZip(dst, withRole('fx_base', ['prvReadfx_widget']))).status, 204);
  assert.equal((await importZip(dst, withRole('fx_ext', ['prvReadfx_widget', 'prvWritefx_widget']))).status, 204);
  assert.deepEqual(await privileges(), ['prvReadfx_widget', 'prvWritefx_widget']);
  await uninstall(dst, 'fx_ext');
  assert.deepEqual(await privileges(), ['prvReadfx_widget']);
  await uninstall(dst, 'fx_base');
  assert.equal(
    dst.store.state.tables.role.some((row) => row.roleid === ROLE),
    false,
  );
  assert.equal(
    dst.store.state.tables.roleprivileges.some((row) => (row.roleid?.id ?? row.roleid) === ROLE),
    false,
  );
});

// Field security profiles share the role's layer table (dataverse-security.mjs SECURITY_LAYERS): uninstalling the upper
// managed layer restores the lower permissions; the last layer removes the profile, its permissions and its user/team
// associations, and the role with its user/team role associations.
test('uninstalling Solution field security profile and role layers restores the lower layer, then removes them with their associations', async (t) => {
  const ROLE = '77777777-7777-4777-8777-777777777781',
    FSP = '77777777-7777-4777-8777-777777777782';
  const profile = (canupdate) =>
    `<FieldSecurityProfiles><FieldSecurityProfile fieldsecurityprofileid="{${FSP}}" name="Fx Code Readers"><FieldPermissions><FieldPermission entityname="fx_widget" attributelogicalname="fx_code" canread="4" cancreate="0" canupdate="${canupdate}" /></FieldPermissions></FieldSecurityProfile></FieldSecurityProfiles>`;
  const variant = (unique, canupdate) =>
    zipOf([
      ...readSolutionZip(base).map((entry) => ({
        name: entry.name,
        data: Buffer.from(
          entry.xml != null
            ? entry.xml
                .replace(/<UniqueName>fx_base<\/UniqueName>/g, `<UniqueName>${unique}</UniqueName>`)
                .replace(/<\/ImportExportXml>\s*$/, (end) =>
                  /customizations\.xml$/i.test(entry.name) ? `${profile(canupdate)}${end}` : end,
                )
            : entry.read(),
        ),
      })),
      {
        name: 'Roles/Fx Clerk.xml',
        data: Buffer.from(
          `<Role id="{${ROLE}}" name="Fx Clerk"><RolePrivileges><RolePrivilege name="prvReadfx_widget" level="Global" /></RolePrivileges></Role>`,
        ),
      },
    ]);
  const dst = await server(t);
  const tables = new Proxy({}, { get: (_, name) => dst.store.state.tables[name] });
  const ref = (row) => row?.id ?? row;
  const permissions = () =>
    (tables.fieldpermission ?? []).filter((p) => ref(p.fieldsecurityprofileid) === FSP).map((p) => p.canupdate);
  assert.equal((await importZip(dst, variant('fx_base', 0))).status, 204);
  assert.equal((await importZip(dst, variant('fx_ext', 4))).status, 204);
  assert.deepEqual(permissions(), [4]);
  const user = tables.systemuser[0].systemuserid,
    team = '77777777-7777-4777-8777-0000000000d1';
  await dst.store.transact(() => {
    (dst.store.state.tables.systemuserprofiles ??= []).push({
      systemuserprofileid: '77777777-7777-4777-8777-0000000000c1',
      systemuserid: { id: user },
      fieldsecurityprofileid: { id: FSP },
    });
    (dst.store.state.tables.teamprofiles ??= []).push({
      teamprofileid: '77777777-7777-4777-8777-0000000000c2',
      teamid: { id: team },
      fieldsecurityprofileid: { id: FSP },
    });
    (dst.store.state.tables.systemuserroles ??= []).push({
      systemuserroleid: '77777777-7777-4777-8777-0000000000c3',
      systemuserid: { id: user },
      roleid: { id: ROLE },
    });
    (dst.store.state.tables.teamroles ??= []).push({
      teamroleid: '77777777-7777-4777-8777-0000000000c4',
      teamid: { id: team },
      roleid: { id: ROLE },
    });
  });
  await uninstall(dst, 'fx_ext');
  assert.deepEqual(permissions(), [0], 'the lower layer takes effect');
  assert.equal(tables.systemuserprofiles.length, 1);
  await uninstall(dst, 'fx_base');
  assert.equal(
    tables.fieldsecurityprofile.some((p) => p.fieldsecurityprofileid === FSP),
    false,
  );
  assert.deepEqual(permissions(), []);
  for (const name of ['systemuserprofiles', 'teamprofiles'])
    assert.equal(
      tables[name].some((r) => ref(r.fieldsecurityprofileid) === FSP),
      false,
      name,
    );
  for (const name of ['role', 'systemuserroles', 'teamroles'])
    assert.equal(
      tables[name].some((r) => ref(r.roleid) === ROLE),
      false,
      name,
    );
});

// @test-kind contract: the module's own managed-import rule applied to every component of an imported managed table:
// the table, its columns (the primary name column and its system columns included) and its global choice report IsManaged;
// the columns and the choice the archive brings carry the solution layer; a column created on top stays unmanaged
test('every component of an imported managed table reports IsManaged and has its solution layer', async (t) => {
  const dst = await server(t);
  assert.equal((await importZip(dst, base)).status, 204);
  const table = (await dst.request('GET', "/EntityDefinitions(LogicalName='fx_widget')?$select=IsManaged")).json;
  assert.equal(table.IsManaged, true);
  const columns = async () =>
    (
      await dst.request(
        'GET',
        "/EntityDefinitions(LogicalName='fx_widget')/Attributes?$select=LogicalName,IsManaged,MetadataId",
      )
    ).json.value;
  const layersOf = async (kind, id) =>
    (await dst.request('GET', `/RetrieveComponentLayers(ComponentId=${id},SolutionComponentName='${kind}')`)).json
      .Layers;
  for (const column of await columns()) assert.equal(column.IsManaged, true, column.LogicalName);
  for (const name of ['fx_name', 'fx_code']) {
    const column = (await columns()).find((item) => item.LogicalName === name);
    assert.ok(
      (await layersOf('attribute', column.MetadataId)).some((layer) => layer.msdyn_solutionname === 'fx_base'),
      name,
    );
  }
  const tier = (await dst.request('GET', "/GlobalOptionSetDefinitions(Name='fx_tier')")).json;
  assert.equal(tier.IsManaged, true);
  // A managed choice is deleted only by the uninstall that owns its layer, as a managed table, column or key is.
  const deleted = await dst.request('DELETE', "/GlobalOptionSetDefinitions(Name='fx_tier')");
  assert.equal(deleted.status, 400);
  assert.equal(deleted.json.error.code, '0x8004f013');
  // The primary name column keeps its role under the managed layer.
  const primary = (
    await dst.request(
      'GET',
      "/EntityDefinitions(LogicalName='fx_widget')/Attributes(LogicalName='fx_name')/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=IsPrimaryName",
    )
  ).json;
  assert.equal(primary.IsPrimaryName, true);
  // Removing a customization of the primary name column restores its managed definition as the primary name column.
  const nameId = (await columns()).find((item) => item.LogicalName === 'fx_name').MetadataId;
  assert.equal(
    (
      await dst.request('PUT', `/EntityDefinitions(LogicalName='fx_widget')/Attributes(${nameId})`, {
        MaxLength: 90,
      })
    ).status,
    204,
  );
  assert.equal(
    (await dst.request('POST', '/RemoveActiveCustomization', { LogicalName: 'attribute', Id: nameId })).json.Success,
    true,
  );
  const restored = (
    await dst.request(
      'GET',
      "/EntityDefinitions(LogicalName='fx_widget')/Attributes(LogicalName='fx_name')/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=IsPrimaryName,IsManaged,MaxLength",
    )
  ).json;
  assert.deepEqual([restored.IsPrimaryName, restored.IsManaged], [true, true]);
  assert.notEqual(restored.MaxLength, 90);
  // A column created on top of the managed table is the unmanaged customization it is.
  assert.equal(
    (await dst.request('POST', "/EntityDefinitions(LogicalName='fx_widget')/Attributes", column('fx_Note'))).status,
    204,
  );
  assert.equal((await columns()).find((item) => item.LogicalName === 'fx_note').IsManaged, false);
});
