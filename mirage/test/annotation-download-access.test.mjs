// @test-kind security: portal annotation downloads and storage restoration respect the reader's column security.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatorFixture } from './fixtures/source-site.mjs';
import { signInHeaders } from '../testing.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';

const guid = (n) => `42000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const website = guid(1);
const member = guid(2);
const anonymous = guid(3);
const contact = guid(4);
const routed = guid(5);
const inline = guid(6);
const content = 'fixture bytes';
const encoded = Buffer.from(content).toString('base64');
const note = (recordId) => ({
  annotationid: recordId,
  subject: 'Invented generic attachment',
  filename: 'fixture.txt',
  mimetype: 'text/plain',
  documentbody: encoded,
  objectid: { id: contact, logical_name: 'contact' },
});

async function annotationFixture(t, enhancedAuthorization) {
  const sim = await simulatorFixture(t, {
    prefix: 'annotation-access-',
    files: {
      'website.yml': `adx_websiteid: ${website}\nadx_name: Invented\nadx_enhancedauthorization: ${enhancedAuthorization}`,
      'webrole.yml': `- adx_webroleid: ${member}\n  adx_name: Reader\n- adx_webroleid: ${anonymous}\n  adx_name: Visitor\n  adx_anonymoususersrole: true`,
      'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
      'sitesetting.yml':
        '- adx_sitesettingid: settings-enabled\n  adx_name: Webapi/annotation/enabled\n  adx_value: true\n- adx_sitesettingid: settings-fields\n  adx_name: Webapi/annotation/fields\n  adx_value: annotationid,documentbody,filename',
    },
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        annotation: {
          entitySet: 'annotations',
          idColumn: 'annotationid',
          fields: { documentbody: { dataverseType: 'nvarchar', columnMetadata: { isSecured: true } } },
        },
      },
      permissions: [
        {
          id: 'annotations',
          entity: 'annotation',
          scope: 'global',
          roles: ['Reader', 'Visitor'],
          operations: ['read'],
        },
      ],
      tables: {
        contact: [{ contactid: contact, fullname: 'Invented Reader', statecode: 0 }],
        annotation: [note(routed)],
      },
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        permissionSource: 'configured',
        contactRoles: [{ contactId: contact, roleId: member }],
      },
    },
  });
  // New native writes use the storage hook. This fixture also provides a legacy inline row for the same read path.
  await sim.store.transact(() => sim.store.state.tables.annotation.push(note(inline)));
  const rows = sim.store.tableRows('annotation');
  assert.equal(rows.find((row) => row.annotationid === routed).documentbody, null);
  assert.match(rows.find((row) => row.annotationid === routed).__blobkey, /^annotations\//);
  assert.equal(rows.find((row) => row.annotationid === inline).documentbody, encoded);
  const signedIn = signInHeaders(sim, contact);
  const read = (url, headers, method = 'GET') => fetch(sim.url + url, { method, headers });
  return { sim, read, signedIn };
}

async function grantBodyRead(sim) {
  const user = sim.store.tableRows('systemuser').find((row) => row.fullname === 'Invented Reader');
  assert.ok(user);
  const profile = { id: guid(7), logical_name: 'fieldsecurityprofile' };
  await sim.store.transact(() => {
    const tables = sim.store.state.tables;
    tables.fieldsecurityprofile.push({ fieldsecurityprofileid: profile.id, name: 'Attachment readers' });
    tables.fieldpermission.push({
      fieldpermissionid: guid(8),
      fieldsecurityprofileid: profile,
      entityname: 'annotation',
      attributelogicalname: 'documentbody',
      canread: 4,
    });
    tables.systemuserprofiles.push({
      systemuserprofileid: guid(9),
      systemuserid: { id: user.systemuserid, logical_name: 'systemuser' },
      fieldsecurityprofileid: profile,
    });
  });
}

const nativeLink = (id) => `/_entity/annotation/${id}/${website}`;
const entityApi = (id) => `/_api/annotations(${id})?$select=annotationid,filename,documentbody`;
const propertyApi = (id) => `/_api/annotations(${id})/documentbody/$value`;

test('standard portal application-user reads preserve generic anonymous and authenticated attachment downloads', async (t) => {
  const { read, signedIn } = await annotationFixture(t, 0);
  for (const headers of [{}, signedIn]) {
    for (const id of [routed, inline]) {
      const response = await read(nativeLink(id), headers);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), content);
    }
  }
});

test('enhanced annotation Read leaves native links empty until the visitor gains documentbody Read', async (t) => {
  const { sim, read, signedIn } = await annotationFixture(t, 3);
  for (const headers of [{}, signedIn]) {
    for (const id of [routed, inline]) {
      assert.equal((await read(nativeLink(id), headers)).status, 204);
      assert.equal((await read(nativeLink(id), headers, 'HEAD')).status, 204);
    }
  }

  await grantBodyRead(sim);
  for (const id of [routed, inline]) {
    const download = await read(nativeLink(id), signedIn);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), content);
    assert.equal((await read(nativeLink(id), signedIn, 'HEAD')).headers.get('content-length'), String(content.length));
    assert.equal((await read(nativeLink(id), {})).status, 204);
  }
});

test('portal API storage restoration honors the same protected column without hiding readable metadata', async (t) => {
  const { sim, read, signedIn } = await annotationFixture(t, 3);
  for (const headers of [{}, signedIn]) {
    for (const id of [routed, inline]) {
      const entity = await read(entityApi(id), headers);
      assert.equal(entity.status, 200, 'the caller has annotation Read');
      const row = await entity.json();
      assert.equal(row.filename, 'fixture.txt');
      assert.equal(row.documentbody, null);
      assert.equal((await read(propertyApi(id), headers)).status, 204);
    }
  }
  await grantBodyRead(sim);
  for (const id of [routed, inline]) {
    assert.equal((await (await read(entityApi(id), signedIn)).json()).documentbody, encoded);
    assert.equal(await (await read(propertyApi(id), signedIn)).text(), encoded);
    assert.equal((await read(propertyApi(id), {})).status, 204);
  }
});

async function maskBody(sim) {
  await sim.store.transact(() => {
    const { maskingrule, attributemaskingrule } = sim.store.state.tables;
    maskingrule.push({ maskingruleid: guid(10), regularexpression: '.', maskedcharacter: '*' });
    attributemaskingrule.push({
      attributemaskingruleid: guid(11),
      maskingruleid: { id: guid(10), logical_name: 'maskingrule' },
      entityname: 'annotation',
      attributelogicalname: 'documentbody',
    });
  });
}

test('raw annotation downloads respect the modeled column masking rule after a Read grant', async (t) => {
  const { sim, read, signedIn } = await annotationFixture(t, 3);
  await read(entityApi(routed), signedIn);
  await grantBodyRead(sim);
  await maskBody(sim);
  for (const id of [routed, inline]) {
    assert.equal((await read(nativeLink(id), signedIn)).status, 204);
  }
  assert.equal((await (await read(entityApi(inline), signedIn)).json()).documentbody, '*'.repeat(encoded.length));
  assert.equal((await (await read(entityApi(routed), signedIn)).json()).documentbody, null);
});

test('a record field share admits only its attachment and does not expose raw bytes through a masked column', async (t) => {
  const { sim, read, signedIn } = await annotationFixture(t, 3);
  assert.equal((await read(entityApi(routed), signedIn)).status, 200);
  const user = sim.store.tableRows('systemuser').find((row) => row.fullname === 'Invented Reader');
  const [organization] = sim.store.tableRows('organization');
  assert.ok(user && organization?.organizationid);
  await sim.store.transact(() => {
    sim.store.state.tables.principalobjectattributeaccess.push({
      principalobjectattributeaccessid: guid(12),
      objectid: { id: routed, logical_name: 'annotation' },
      attributeid: uuidV5(organization.organizationid, 'attribute:annotation:documentbody'),
      principalid: { id: user.systemuserid, logical_name: 'systemuser' },
      readaccess: true,
    });
  });
  const allowed = await read(nativeLink(routed), signedIn);
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), content);
  assert.equal((await read(nativeLink(inline), signedIn)).status, 204);

  await maskBody(sim);
  assert.equal((await read(nativeLink(routed), signedIn)).status, 204);
  assert.equal((await read(propertyApi(routed), signedIn)).status, 204);
});
