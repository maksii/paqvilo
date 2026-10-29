// Elastic tables over HTTP and SOAP: TableType on create and read back, the documented restrictions, the built-in key and
// system columns, and time-to-live expiry.
// The organization runs on the suite's clock: wall time, or the instant the TTL cases pin (the store stamps modifiedon and
// the expiry filter reads the time through it).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { hashSecret } from '../lib/dataverse-auth.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';
import { NS } from '../lib/dataverse-soap-xml.mjs';
import { METADATA_NS } from '../lib/dataverse-soap-metadata.mjs';
import { expiresAt, sweepExpired } from '../lib/dataverse-elastic.mjs';
import { randomUUID } from 'node:crypto';
import { DataError } from '../lib/data-error.mjs';

const PUBLIC_APP_ID = '44444444-4444-4444-4444-444444444444';
const REDIRECT = 'http://localhost:1/cb';
const PASSWORD = 'Pass!23';
const CUSTOMIZER_OID = '55555555-5555-5555-5555-555555555555';
const BASIC_OID = '66666666-6666-6666-6666-666666666666';
const ADMIN_OID = '77777777-7777-7777-7777-777777777777';
const CRM = 'Microsoft.Dynamics.CRM.';
const SOAP = '/XRMServices/2011/Organization.svc/web';
const ELASTIC = 'new_sensorreading';
const GIZMO = 'new_gizmo';

const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
const textColumn = (schema, extra = {}) => ({
  '@odata.type': `${CRM}StringAttributeMetadata`,
  SchemaName: schema,
  DisplayName: label(schema),
  MaxLength: 100,
  ...extra,
});
const tableBody = (schema, extra = {}) => ({
  '@odata.type': `${CRM}EntityMetadata`,
  SchemaName: schema,
  OwnershipType: 'UserOwned',
  IsActivity: false,
  HasActivities: false,
  HasNotes: false,
  DisplayName: label(schema),
  DisplayCollectionName: label(`${schema}s`),
  Attributes: [textColumn('new_SensorType', { IsPrimaryName: true })],
  ...extra,
});
const column = (type, extra = {}) => ({
  '@odata.type': `${CRM}${type}AttributeMetadata`,
  SchemaName: 'new_Refused',
  DisplayName: label('Refused'),
  ...extra,
});
// A lookup from the standard table to the elastic one, with the none cascade an elastic table requires.
const readingLookup = (schemaName, lookupSchema, lookupLogical) => ({
  '@odata.type': `${CRM}OneToManyRelationshipMetadata`,
  SchemaName: schemaName,
  ReferencedEntity: ELASTIC,
  ReferencedAttribute: `${ELASTIC}id`,
  ReferencingEntity: GIZMO,
  Lookup: { SchemaName: lookupSchema, LogicalName: lookupLogical, DisplayName: label('Reading') },
  CascadeConfiguration: {
    Assign: 'NoCascade',
    Delete: 'NoCascade',
    Merge: 'NoCascade',
    Reparent: 'NoCascade',
    Share: 'NoCascade',
    Unshare: 'NoCascade',
    Archive: 'NoCascade',
    RollupView: 'NoCascade',
  },
});

describe('elastic tables over HTTP and SOAP', () => {
  let api;
  let internal;
  let store;
  let origin;
  let tenantId;
  let customizerId;
  let customizer;
  let basic;
  let admin;
  // null follows wall time; the time-to-live cases pin an instant and move it.
  let clockAt = null;
  const clock = () => clockAt ?? Date.now();

  before(async () => {
    store = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [{ appId: PUBLIC_APP_ID, displayName: 'Public app', publicClient: true, redirectUris: [REDIRECT] }],
      users: [
        {
          domainname: 'customizer@example.test',
          fullname: 'Customizer',
          objectId: CUSTOMIZER_OID,
          roles: ['System Customizer'],
        },
        { domainname: 'basic@example.test', fullname: 'Basic', objectId: BASIC_OID, roles: ['Basic User'] },
        { domainname: 'admin@example.test', fullname: 'Admin', objectId: ADMIN_OID, roles: ['System Administrator'] },
      ],
    });
    // The capture extension hands the test the internal api (the change log and clock), which startDataverseApi does not return.
    const capture = {
      name: 'test-capture',
      install: (value) => {
        internal = value;
      },
    };
    api = await startDataverseApi({ store, settings, log: () => {}, extensions: [...EXTENSIONS, capture], clock });
    origin = api.origin;
    tenantId = api.tenantId;
    const organizationId = api.organizationId;
    customizerId = uuidV5(organizationId, `systemuser:oid:${CUSTOMIZER_OID}`);
    const basicId = uuidV5(organizationId, `systemuser:oid:${BASIC_OID}`);
    const adminId = uuidV5(organizationId, `systemuser:oid:${ADMIN_OID}`);
    await store.transact(() => {
      store.state.dataverse.passwords ??= {};
      store.state.dataverse.passwords[customizerId] = hashSecret(PASSWORD);
      store.state.dataverse.passwords[basicId] = hashSecret(PASSWORD);
      store.state.dataverse.passwords[adminId] = hashSecret(PASSWORD);
    });
    customizer = await userToken('customizer@example.test');
    basic = await userToken('basic@example.test');
    admin = await userToken('admin@example.test');
    // The schema the tests share: the elastic table with a text column, a standard table and a lookup between them.
    for (const [path, body] of [
      [webApi('EntityDefinitions'), tableBody('new_SensorReading', { TableType: 'Elastic' })],
      [webApi(`${definition(ELASTIC)}/Attributes`), column('String', { SchemaName: 'new_Note', MaxLength: 200 })],
      [webApi('EntityDefinitions'), tableBody('new_Gizmo')],
      [
        webApi('RelationshipDefinitions'),
        readingLookup('new_gizmo_sensorreading', 'new_SensorReadingId', 'new_sensorreadingid'),
      ],
    ]) {
      const response = await call(path, { method: 'POST', body });
      assert.equal(response.status, 204, await response.text());
    }
  });

  after(async () => {
    await api?.close();
  });

  async function userToken(username) {
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: PUBLIC_APP_ID,
        username,
        password: PASSWORD,
        scope: `${origin}/.default`,
      }),
    });
    return (await response.json()).access_token;
  }

  const call = (path, { token = customizer, method = 'GET', body, headers = {} } = {}) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const webApi = (suffix) => `/api/data/v9.2/${suffix}`;
  const definition = (logical) => `EntityDefinitions(LogicalName='${logical}')`;
  const errorOf = async (response) => (await response.json()).error;

  async function createTable(body) {
    return call(webApi('EntityDefinitions'), { method: 'POST', body });
  }

  it('creates an elastic table as System Customizer and reads TableType back', async () => {
    const created = await createTable(tableBody('new_SensorProbe', { TableType: 'Elastic' }));
    assert.equal(created.status, 204, await created.clone().text());
    assert.ok(created.headers.get('odata-entityid').includes('EntityDefinitions'));
    const read = await call(
      webApi(
        `${definition('new_sensorprobe')}?$select=LogicalName,TableType,CanCreateCharts,IsDuplicateDetectionEnabled,CanManyToMany`,
      ),
    );
    assert.equal(read.status, 200, await read.clone().text());
    const body = await read.json();
    assert.equal(body.TableType, 'Elastic');
    assert.equal(body.CanCreateCharts, false);
    assert.equal(body.IsDuplicateDetectionEnabled, false);
    assert.equal(body.CanManyToMany, false);
  });

  it('gives an elastic table its system columns and the built-in key, with the partitionid key over the primary key', async () => {
    const mapping = store.state.mappings[ELASTIC];
    assert.equal(mapping.tableType, 'Elastic');
    assert.equal(mapping.fields.partitionid.columnMetadata.maxLength, 100);
    assert.equal(mapping.fields.partitionid.columnMetadata.isManaged, true);
    assert.equal(mapping.fields.ttlinseconds.columnMetadata.minValue, 1);
    assert.equal(mapping.fields.ttlinseconds.columnMetadata.maxValue, 2147483647);
    const [key] = mapping.alternateKeys;
    assert.equal(key.name, 'keyfornosqlentitywithpkpartitionid');
    assert.deepEqual(key.attributes, [`${ELASTIC}id`, 'partitionid']);
    // The system columns are not customizable: a PUT on ttlinseconds is refused.
    const attributeId = uuidV5(api.organizationId, `attribute:${ELASTIC}:ttlinseconds`);
    const put = await call(webApi(`${definition(ELASTIC)}/Attributes(${attributeId})`), {
      method: 'PUT',
      body: { MaxValue: 10 },
    });
    assert.equal(put.status, 400);
  });

  it('reads TableType as Elastic for backgroundoperation and Standard for a standard table', async () => {
    const background = await (
      await call(webApi(`${definition('backgroundoperation')}?$select=LogicalName,TableType`))
    ).json();
    assert.equal(background.TableType, 'Elastic');
    const account = await (await call(webApi(`${definition('account')}?$select=LogicalName,TableType`))).json();
    assert.equal(account.TableType, 'Standard');
    assert.equal(store.state.mappings.backgroundoperation.tableType, 'Elastic');
    assert.equal(store.state.mappings.account.tableType, 'Standard');
  });

  it('refuses a TableType other than Standard or Elastic', async () => {
    const response = await createTable(tableBody('new_Odd', { TableType: 'Virtual' }));
    assert.equal(response.status, 400);
    assert.equal((await errorOf(response)).code, '0x80060888');
  });

  it('refuses the column types and formats an elastic table cannot have', async () => {
    const refused = [
      column('Money'),
      column('MultiSelectPicklist', { OptionSet: { Options: [] } }),
      column('State'),
      column('Status'),
      column('Image'),
      column('String', { SourceType: 1 }),
      column('Integer', { SourceType: 2 }),
      column('String', { FormulaDefinition: '1+1' }),
      column('Integer', { Format: 'Duration' }),
      column('Integer', { Format: { Value: 'TimeZone' } }),
    ];
    for (const attr of refused) {
      const response = await call(webApi(`${definition(ELASTIC)}/Attributes`), { method: 'POST', body: attr });
      assert.equal(
        response.status,
        400,
        `${attr['@odata.type']} ${JSON.stringify(attr.Format ?? attr.SourceType ?? '')}`,
      );
      assert.equal((await errorOf(response)).code, '0x80060888');
    }
  });

  it('still takes a plain string column and a whole number with the None format', async () => {
    const plain = await call(webApi(`${definition(ELASTIC)}/Attributes`), {
      method: 'POST',
      body: column('String', { SchemaName: 'new_Remark', MaxLength: 200 }),
    });
    assert.equal(plain.status, 204, await plain.clone().text());
    const none = await call(webApi(`${definition(ELASTIC)}/Attributes`), {
      method: 'POST',
      body: column('Integer', { SchemaName: 'new_Tally', Format: 'None' }),
    });
    assert.equal(none.status, 204, await none.clone().text());
  });

  it('refuses a custom alternate key on an elastic table', async () => {
    const response = await call(webApi(`${definition(ELASTIC)}/Keys`), {
      method: 'POST',
      body: { SchemaName: 'new_CustomKey', KeyAttributes: ['new_sensortype'] },
    });
    assert.equal(response.status, 400);
    assert.match((await errorOf(response)).message, /can't create custom alternate keys/);
  });

  it('refuses charts and duplicate detection on create, and a create with an unknown TableType', async () => {
    const charts = await createTable(
      tableBody('new_Charted', { TableType: 'Elastic', CanCreateCharts: { Value: true, CanBeChanged: true } }),
    );
    assert.equal(charts.status, 400);
    const duplicates = await createTable(
      tableBody('new_Dupes', { TableType: 'Elastic', IsDuplicateDetectionEnabled: true }),
    );
    assert.equal(duplicates.status, 400);
    assert.equal(store.state.mappings.new_charted, undefined);
  });

  it('refuses N:N with an elastic table', async () => {
    const response = await call(webApi('RelationshipDefinitions'), {
      method: 'POST',
      body: {
        '@odata.type': `${CRM}ManyToManyRelationshipMetadata`,
        SchemaName: 'new_sensorreading_gizmo',
        Entity1LogicalName: ELASTIC,
        Entity2LogicalName: GIZMO,
        IntersectEntityName: 'new_sensorreading_gizmo_link',
        Entity1IntersectAttribute: 'new_sensorreadingid',
        Entity2IntersectAttribute: 'new_gizmoid',
      },
    });
    assert.equal(response.status, 400);
    assert.match((await errorOf(response)).message, /Many-to-many relationships are not supported with elastic tables/);
  });

  it('refuses a lookup on an elastic table, and a relationship to it with a cascade other than None', async () => {
    const lookup = (referenced, referencing, cascade) => ({
      '@odata.type': `${CRM}OneToManyRelationshipMetadata`,
      SchemaName: `new_rel_${referenced}_${referencing}`,
      ReferencedEntity: referenced,
      ReferencedAttribute: `${referenced}id`,
      ReferencingEntity: referencing,
      Lookup: { SchemaName: 'new_RefLookup', LogicalName: 'new_reflookup', DisplayName: label('Ref') },
      ...(cascade ? { CascadeConfiguration: cascade } : {}),
    });
    const onElastic = await call(webApi('RelationshipDefinitions'), { method: 'POST', body: lookup(GIZMO, ELASTIC) });
    assert.equal(onElastic.status, 400);
    const cascading = await call(webApi('RelationshipDefinitions'), {
      method: 'POST',
      body: lookup(ELASTIC, GIZMO, { Assign: 'NoCascade', Delete: 'Cascade' }),
    });
    assert.equal(cascading.status, 400);
    assert.match((await errorOf(cascading)).message, /Cascading behavior must be None/);
  });

  it('creates a lookup from a standard table to an elastic table with the none cascade and the partitionid companion column', async () => {
    const response = await call(webApi('RelationshipDefinitions'), {
      method: 'POST',
      body: readingLookup('new_gizmo_backupreading', 'new_BackupReadingId', 'new_backupreadingid'),
    });
    assert.equal(response.status, 204, await response.clone().text());
    assert.equal(store.state.mappings[GIZMO].fields.new_backupreadingidpid.dataverseType, 'nvarchar');
  });

  it('creates an elastic table over SOAP with TableType Elastic', async () => {
    const soapLabel = (tag, text) =>
      `<m:${tag}><a:LocalizedLabels><a:LocalizedLabel><a:Label>${text}</a:Label><a:LanguageCode>1033</a:LanguageCode></a:LocalizedLabel></a:LocalizedLabels></m:${tag}>`;
    const entity =
      `<b:value i:type="m:EntityMetadata"><m:SchemaName>new_SoapReading</m:SchemaName>${soapLabel('DisplayName', 'Soap Reading')}` +
      `${soapLabel('DisplayCollectionName', 'Soap Readings')}<m:OwnershipType>UserOwned</m:OwnershipType><m:IsActivity>false</m:IsActivity><m:HasActivities>false</m:HasActivities><m:HasNotes>false</m:HasNotes><m:TableType>Elastic</m:TableType></b:value>`;
    const primary =
      `<b:value i:type="m:StringAttributeMetadata"><m:SchemaName>new_SoapName</m:SchemaName>${soapLabel('DisplayName', 'Soap Name')}` +
      `<m:IsPrimaryName>true</m:IsPrimaryName><m:MaxLength>100</m:MaxLength></b:value>`;
    const envelope =
      `<s:Envelope xmlns:s="${NS.s}"><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:CreateEntityRequest" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:a="${NS.a}" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:m="${METADATA_NS}"><a:Parameters>` +
      `<a:KeyValuePairOfstringanyType><b:key>Entity</b:key>${entity}</a:KeyValuePairOfstringanyType>` +
      `<a:KeyValuePairOfstringanyType><b:key>PrimaryAttribute</b:key>${primary}</a:KeyValuePairOfstringanyType>` +
      `</a:Parameters><a:RequestName>CreateEntity</a:RequestName></request></Execute></s:Body></s:Envelope>`;
    const response = await fetch(`${origin}${SOAP}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${customizer}`, 'content-type': 'text/xml; charset=utf-8' },
      body: envelope,
    });
    const xml = await response.text();
    assert.equal(response.status, 200, xml);
    assert.ok(xml.includes('CreateEntityResponse'), xml);
    assert.equal(store.state.mappings.new_soapreading?.tableType, 'Elastic');
    const read = await (await call(webApi(`${definition('new_soapreading')}?$select=LogicalName,TableType`))).json();
    assert.equal(read.TableType, 'Elastic');
  });

  it('refuses the same elastic create to a Basic User', async () => {
    const response = await call(webApi('EntityDefinitions'), {
      token: basic,
      method: 'POST',
      body: tableBody('new_Denied', { TableType: 'Elastic' }),
    });
    assert.equal(response.status, 403);
  });

  describe('partitioned CRUD, upsert and bulk operations', () => {
    const pk = `${ELASTIC}id`;
    const set = 'new_sensorreadings';
    const key = (id, partition) => `${pk}=${id},partitionid='${partition}'`;
    const create = (body) => call(webApi(set), { token: admin, method: 'POST', body });
    const get = (predicate, extra = '') => call(webApi(`${set}(${predicate})${extra}`), { token: admin });
    const patch = (predicate, body, headers = {}) =>
      call(webApi(`${set}(${predicate})`), { token: admin, method: 'PATCH', body, headers });
    const bulk = (name, targets, headers = {}) =>
      call(webApi(`${set}/Microsoft.Dynamics.CRM.${name}`), {
        token: admin,
        method: 'POST',
        body: { Targets: targets },
        headers,
      });

    it('identifies duplicate GUIDs by partition and supports both read addressing styles', async () => {
      const id = randomUUID();
      const a = await create({ [pk]: id, partitionid: 'device-A', new_sensortype: 'first' });
      assert.equal(a.status, 204, await a.clone().text());
      const session = a.headers.get('x-ms-session-token');
      assert.ok(session);
      const b = await create({ [pk]: id, partitionid: 'device-B', new_sensortype: 'second' });
      assert.equal(b.status, 204, await b.clone().text());
      assert.equal((await create({ [pk]: id, partitionid: 'device-A' })).status, 412);
      assert.equal((await get(id)).status, 404, 'a primary id alone addresses only the default partition');
      assert.equal((await (await get(key(id, 'device-A'))).json()).new_sensortype, 'first');
      const latest = await call(webApi(`${set}(${id})?partitionId='device-B'`), {
        token: admin,
        headers: { 'MSCRM.SessionToken': session },
      });
      assert.equal(latest.status, 200);
      assert.equal((await latest.json()).new_sensortype, 'second');
      assert.equal((await get(key(id, 'device-a'))).status, 404, 'partition names are case-sensitive');
    });

    it('updates merge while elastic upserts replace omitted fields and only run the Upsert pipeline', async () => {
      const id = randomUUID();
      assert.equal(
        (await create({ [pk]: id, partitionid: 'replace', new_sensortype: 'before', new_note: 'kept by Update' }))
          .status,
        204,
      );
      assert.equal((await patch(key(id, 'replace'), { new_sensortype: 'updated' }, { 'if-match': '*' })).status, 204);
      assert.equal((await (await get(key(id, 'replace'))).json()).new_note, 'kept by Update');
      const seen = [];
      const previous = store.pluginPipeline;
      store.setPluginPipeline((frame) => {
        seen.push([frame.operation, frame.stage]);
      });
      try {
        const upsert = await patch(id, { partitionid: 'replace', new_sensortype: 'replaced' });
        assert.equal(upsert.status, 204, await upsert.clone().text());
        assert.ok(upsert.headers.get('x-ms-session-token'));
        assert.deepEqual(
          seen.filter(([operation]) => operation !== 'retrieve'),
          [
            ['upsert', 10],
            ['upsert', 20],
            ['upsert', 40],
          ],
        );
      } finally {
        store.pluginPipeline = previous;
      }
      const row = await (await get(key(id, 'replace'))).json();
      assert.equal(row.new_sensortype, 'replaced');
      assert.equal(row.new_note, null);
      assert.equal(row.statecode, undefined, 'elastic rows have no state/status columns');
    });

    it('does not change a partition and ignores partitionId on PATCH', async () => {
      const id = randomUUID();
      assert.equal((await create({ [pk]: id, partitionid: 'fixed', new_sensortype: 'original' })).status, 204);
      const changed = await patch(
        key(id, 'fixed'),
        { partitionid: 'other', new_sensortype: 'bad' },
        { 'if-match': '*' },
      );
      assert.equal(changed.status, 400, await changed.clone().text());
      const ignored = await call(webApi(`${set}(${id})?partitionId='fixed'`), {
        token: admin,
        method: 'PATCH',
        headers: { 'if-match': '*' },
        body: { new_sensortype: 'bad' },
      });
      assert.equal(ignored.status, 404);
      assert.equal((await (await get(key(id, 'fixed'))).json()).new_sensortype, 'original');
    });

    it('a default-partition row can coexist with the same id in a custom partition, and deletion is scoped', async () => {
      const id = randomUUID();
      assert.equal((await create({ [pk]: id, new_sensortype: 'default' })).status, 204);
      assert.equal((await create({ [pk]: id, partitionid: 'delete', new_sensortype: 'custom' })).status, 204);
      const removed = await call(webApi(`${set}(${id})?partitionId=delete`), { token: admin, method: 'DELETE' });
      assert.equal(removed.status, 204, await removed.clone().text());
      assert.equal(removed.headers.get('x-ms-session-token'), null, 'native delete omits the token');
      assert.equal((await get(key(id, 'delete'))).status, 404);
      assert.equal((await (await get(id)).json()).new_sensortype, 'default');
    });

    it('lookup bindings preserve the partition companion and resolve the requested partition', async () => {
      const id = randomUUID();
      for (const partitionid of ['related-A', 'related-B'])
        assert.equal((await create({ [pk]: id, partitionid, new_sensortype: partitionid })).status, 204);
      const mapping = store.resolveMapping(GIZMO);
      const navigation = Object.entries(mapping.relationships).find(
        ([, rel]) => rel.entity === ELASTIC && rel.from === 'new_sensorreadingid',
      )?.[0];
      assert.ok(navigation);
      const parent = await call(webApi(mapping.entitySet), {
        token: admin,
        method: 'POST',
        body: { new_sensortype: 'linked', [`${navigation}@odata.bind`]: `/${set}(${key(id, 'related-B')})` },
      });
      assert.equal(parent.status, 204, await parent.clone().text());
      const parentId = /\(([0-9a-f-]{36})\)/.exec(parent.headers.get('OData-EntityId'))[1];
      assert.equal(store.get(GIZMO, parentId, { admin: true }).new_sensorreadingidpid, 'related-B');
      const related = await call(webApi(`${mapping.entitySet}(${parentId})/${navigation}?$select=new_sensortype`), {
        token: admin,
      });
      assert.equal(related.status, 200, await related.clone().text());
      assert.equal((await related.json()).new_sensortype, 'related-B');
      const explicit = await call(webApi(`${mapping.entitySet}(${parentId})`), {
        token: admin,
        method: 'PATCH',
        headers: { 'if-match': '*' },
        body: { new_sensorreadingidpid: 'related-A', [`${navigation}@odata.bind`]: `/${set}(${id})` },
      });
      assert.equal(explicit.status, 204, await explicit.clone().text());
      const changed = await call(webApi(`${mapping.entitySet}(${parentId})/${navigation}?$select=new_sensortype`), {
        token: admin,
      });
      assert.equal((await changed.json()).new_sensortype, 'related-A');
      const unresolved = await call(webApi(`${mapping.entitySet}(${parentId})`), {
        token: admin,
        method: 'PATCH',
        headers: { 'if-match': '*' },
        body: { new_sensorreadingidpid: null, [`${navigation}@odata.bind`]: `/${set}(${id})` },
      });
      assert.equal(unresolved.status, 204, await unresolved.clone().text());
      const stored = store.get(GIZMO, parentId, { admin: true });
      assert.equal(stored.new_sensorreadingid.id, id);
      assert.equal(stored.new_sensorreadingidpid, null);
      const missing = await call(webApi(`${mapping.entitySet}(${parentId})/${navigation}`), { token: admin });
      assert.equal(missing.status, 204, 'an omitted custom partition persists an unresolved lookup');
    });

    it('bulk creates continue after a refused row and preserve both successful rows', async () => {
      const first = randomUUID(),
        last = randomUUID();
      const result = await bulk(
        'CreateMultiple',
        [
          { [pk]: first, partitionid: 'bulk', new_sensortype: 'first' },
          { [pk]: randomUUID(), partitionid: 'bulk', ttlinseconds: 0 },
          { [pk]: last, partitionid: 'bulk', new_sensortype: 'last' },
        ],
        { Prefer: 'odata.include-annotations="Microsoft.PowerApps.CDS.ErrorDetails.*"' },
      );
      assert.equal(result.status, 400, await result.clone().text());
      const error = (await result.json()).error;
      const details = error['@Microsoft.PowerApps.CDS.ErrorDetails.Plugin.BulkApiErrorDetails'];
      assert.ok(details, JSON.stringify(error));
      assert.equal(JSON.parse(details)[0].RequestIndex, 1);
      assert.equal((await get(key(first, 'bulk'))).status, 200);
      assert.equal((await get(key(last, 'bulk'))).status, 200);
    });

    it('UpdateMultiple, UpsertMultiple and DeleteMultiple distinguish the same id in different partitions', async () => {
      const id = randomUUID();
      const targets = ['north', 'south'].map((partitionid) => ({ [pk]: id, partitionid, new_sensortype: partitionid }));
      assert.equal((await bulk('CreateMultiple', targets)).status, 200);
      assert.equal(
        (
          await bulk(
            'UpdateMultiple',
            targets.map((row) => ({ ...row, new_note: 'merge' })),
          )
        ).status,
        204,
      );
      assert.equal(
        (
          await bulk(
            'UpsertMultiple',
            targets.map((row) => ({ ...row, new_sensortype: `new ${row.partitionid}` })),
          )
        ).status,
        204,
      );
      assert.equal((await (await get(key(id, 'north'))).json()).new_note, null);
      assert.equal((await (await get(key(id, 'south'))).json()).new_sensortype, 'new south');
      assert.equal((await bulk('DeleteMultiple', [{ [pk]: id, partitionid: 'north' }])).status, 204);
      assert.equal((await get(key(id, 'north'))).status, 404);
      assert.equal((await get(key(id, 'south'))).status, 200);
    });

    it('a failed mixed transaction rolls back standard rows and retains only committed elastic change events', async () => {
      const standardId = randomUUID(),
        elasticId = randomUUID();
      const revision = internal.changes.current();
      await assert.rejects(
        internal.runAtomic(() => {
          store.createRecord(
            GIZMO,
            { new_gizmoid: standardId, new_sensortype: 'rollback' },
            { admin: true, dataverse: true },
          );
          store.createRecord(
            ELASTIC,
            { [pk]: elasticId, partitionid: 'transaction', new_sensortype: 'committed' },
            { admin: true, dataverse: true },
          );
          throw new DataError('Later request refused', 400, 'InvalidRequest');
        }),
        /Later request refused/,
      );
      assert.equal(store.get(GIZMO, standardId, { admin: true }), null);
      assert.equal((await get(key(elasticId, 'transaction'))).status, 200);
      await store.flushCommittedEvents();
      assert.equal((await internal.changes.since(GIZMO, revision)).changed.includes(standardId), false);
      assert.ok((await internal.changes.since(ELASTIC, revision)).changed.includes(elasticId));
    });

    it('an elastic PostOperation refusal preserves the main write while PreValidation cancels it', async () => {
      const committed = randomUUID(),
        refused = randomUUID();
      const previous = store.pluginPipeline;
      store.setPluginPipeline((frame) => {
        if (
          frame.entity === ELASTIC &&
          frame.operation === 'create' &&
          ((frame.record[pk] === committed && frame.stage === 40) ||
            (frame.record[pk] === refused && frame.stage === 10))
        )
          throw new DataError('Invented plugin refusal', 400, 'LocalPluginInvalid');
      });
      try {
        assert.equal((await create({ [pk]: committed, partitionid: 'plugins' })).status, 400);
        assert.equal((await create({ [pk]: refused, partitionid: 'plugins' })).status, 400);
      } finally {
        store.pluginPipeline = previous;
      }
      assert.equal((await get(key(committed, 'plugins'))).status, 200);
      assert.equal((await get(key(refused, 'plugins'))).status, 404);
    });
  });

  describe('Cosmos JSON queries and elastic query limits', () => {
    const query = (args, token = admin) => {
      const entries = Object.entries(args);
      const params = new URLSearchParams(
        entries.map(([, value], index) => [
          `@p${index}`,
          typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : JSON.stringify(value),
        ]),
      );
      return call(
        webApi(`ExecuteCosmosSqlQuery(${entries.map(([name], index) => `${name}=@p${index}`).join(',')})?${params}`),
        { token },
      );
    };

    it('queries nested JSON with typed parameters, partition scope, sorting and bound continuation cookies', async () => {
      const added = await call(webApi(`${definition(ELASTIC)}/Attributes`), {
        method: 'POST',
        body: textColumn('new_Payload', { MaxLength: 4000, FormatName: { Value: 'Json' } }),
      });
      assert.equal(added.status, 204, await added.clone().text());
      for (const [partitionid, power] of [
        ['json', 12],
        ['json', 7],
        ['json', 4],
        ['other-json', 20],
      ]) {
        const created = await call(webApi('new_sensorreadings'), {
          token: admin,
          method: 'POST',
          body: { partitionid, new_sensortype: 'humidity', new_payload: JSON.stringify({ power }) },
        });
        assert.equal(created.status, 204, await created.clone().text());
      }
      const args = {
        QueryText:
          'SELECT c.props.new_payload.power AS power FROM c WHERE c.props.new_sensortype=@kind AND c.props.new_payload.power > @min ORDER BY c.props.new_payload.power DESC',
        EntityLogicalName: ELASTIC,
        PartitionId: 'json',
        PageSize: 1,
        QueryParameters: {
          Keys: ['@kind', '@min'],
          Values: [
            { Type: 'System.String', Value: 'humidity' },
            { Type: 'System.Int32', Value: '5' },
          ],
        },
      };
      const first = await query(args);
      assert.equal(first.status, 200, await first.clone().text());
      const body = await first.json();
      assert.deepEqual(JSON.parse(body.Result), [{ power: 12 }]);
      assert.equal(body.HasMore, true);
      assert.ok(body.PagingCookie);
      const second = await query({ ...args, PagingCookie: body.PagingCookie });
      assert.equal(second.status, 200, await second.clone().text());
      const next = await second.json();
      assert.deepEqual(JSON.parse(next.Result), [{ power: 7 }]);
      assert.equal(next.HasMore, false);
      assert.equal(next.PagingCookie, null);
      assert.equal((await query({ ...args, PartitionId: 'other-json', PagingCookie: body.PagingCookie })).status, 400);
      assert.equal((await query(args, basic)).status, 403);
      assert.equal((await query({ ...args, EntityLogicalName: GIZMO })).status, 400);
      assert.equal((await query({ ...args, QueryText: 'SELECT COUNT(1) FROM c' })).status, 501);
    });

    it('elastic collection pages cap at 500 and collection joins are refused', async () => {
      await store.transact(() => {
        for (let index = 0; index < 501; index++)
          store.createRecord(
            ELASTIC,
            { new_sensorreadingid: randomUUID(), partitionid: 'page-test', new_sensortype: String(index) },
            { admin: true },
          );
      });
      const page = await call(webApi("new_sensorreadings?$select=new_sensortype&$filter=partitionid eq 'page-test'"), {
        token: admin,
      });
      assert.equal(page.status, 200);
      const body = await page.json();
      assert.equal(body.value.length, 500);
      assert.ok(body['@odata.nextLink']);
      const next = await call(body['@odata.nextLink'].replace(origin, ''), { token: admin });
      assert.equal((await next.json()).value.length, 1);
      const count = await call(webApi('new_sensorreadings/$count'), { token: admin });
      assert.equal(await count.text(), '500');
      const fetch =
        '<fetch returntotalrecordcount="true"><entity name="new_sensorreading"><attribute name="new_sensorreadingid"/><filter><condition attribute="partitionid" operator="eq" value="page-test"/></filter></entity></fetch>';
      for (const xml of [fetch, fetch.replace('<fetch ', '<fetch count="9999" ')]) {
        const queried = await call(webApi(`new_sensorreadings?fetchXml=${encodeURIComponent(xml)}`), {
          token: admin,
          headers: { Prefer: 'odata.include-annotations="*"' },
        });
        const data = await queried.json();
        assert.equal(queried.status, 200, JSON.stringify(data));
        assert.equal(data.value.length, 500);
        assert.equal(data['@odata.count'], 500);
        assert.equal(data['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded'], true);
      }
      const linked = await call(
        webApi(
          `new_sensorreadings?fetchXml=${encodeURIComponent('<fetch><entity name="new_sensorreading"><attribute name="new_sensorreadingid"/><link-entity name="new_gizmo" from="new_sensorreadingid" to="new_sensorreadingid"/></entity></fetch>')}`,
        ),
        { token: admin },
      );
      assert.equal(linked.status, 400);
      assert.equal((await linked.json()).error.code, '0x80048d0b');
    });
  });

  describe('time to live', () => {
    let internalApi;
    const rowsOf = () => store.tableRows(ELASTIC);
    const idOf = (row) => row.new_sensorreadingid;
    const create = async (fields) => {
      const response = await call(webApi('new_sensorreadings'), {
        token: admin,
        method: 'POST',
        body: { new_sensortype: 'temp', ...fields },
      });
      assert.equal(response.status, 204, await response.clone().text());
      return rowsOf().at(-1);
    };
    const visible = async (id) =>
      (await call(webApi(`new_sensorreadings(${id})?$select=new_sensortype`), { token: admin })).status;

    before(() => {
      clockAt = Math.floor(Date.now() / 1000) * 1000;
      internalApi = internal;
    });
    after(() => {
      clockAt = null;
    });

    it('hides a row at the second its time to live runs out, and purges it into the change log', async () => {
      clockAt = Math.floor(Date.now() / 1000) * 1000;
      const row = await create({ ttlinseconds: 60 });
      const id = idOf(row);
      assert.equal(expiresAt(row), clockAt + 60_000);
      clockAt += 59_000;
      assert.equal(await visible(id), 200);
      clockAt += 1_000;
      assert.equal(await visible(id), 404);
      assert.equal(
        store.tableRows(ELASTIC).some((r) => idOf(r) === id),
        false,
        'a store reader does not see the expired row',
      );
      assert.equal(
        rowsOf().some((r) => idOf(r) === id),
        false,
      );
      // The 1 s purge timer may already have run; the sweep is idempotent either way.
      await sweepExpired({ store, clock: () => clockAt });
      assert.equal(
        store.state.tables[ELASTIC].some((r) => idOf(r) === id),
        false,
        'the purge removes the row',
      );
      const changes = await internalApi.changes.since(ELASTIC, 0);
      assert.ok(changes.deleted.includes(String(id).toLowerCase()), 'change tracking reports the expiry as a delete');
    });

    it('restarts the countdown when the row is modified', async () => {
      clockAt = Date.now();
      const row = await create({ ttlinseconds: 60 });
      const id = idOf(row);
      clockAt += 50_000;
      const patched = await call(webApi(`new_sensorreadings(${id})`), {
        token: admin,
        method: 'PATCH',
        headers: { 'if-match': '*' },
        body: { new_sensortype: 'humid' },
      });
      assert.equal(patched.status, 204, await patched.clone().text());
      clockAt += 20_000; // 70 s after create, 20 s after the modify
      assert.equal(await visible(id), 200);
      clockAt += 40_000;
      assert.equal(await visible(id), 404);
    });

    it('keeps a row with no time to live indefinitely', async () => {
      clockAt = Date.now();
      const row = await create({});
      clockAt += 86_400_000;
      // Advancing the clock a day also expires the original one-hour bearer.
      admin = await userToken('admin@example.test');
      assert.equal(await visible(idOf(row)), 200);
      assert.equal(expiresAt(row), null);
    });

    it('refuses a time to live outside 1 to 2147483647 seconds', async () => {
      const zero = await call(webApi('new_sensorreadings'), {
        token: admin,
        method: 'POST',
        body: { new_sensortype: 'temp', ttlinseconds: 0 },
      });
      assert.equal(zero.status, 400);
    });
  });
});
