// Miscellaneous platform messages in the Dataverse API (dataverse-misc-messages.mjs), over HTTP against one server: FetchXML and
// QueryExpression conversion and validation, RetrieveTimestamp, the knowledge article and kbarticle searches, knowledge versions and
// views, rollup, virtual table events, composite data sources, certificate credentials, the managed identity subject, business
// process flow instances and SetProcess.
// @test-kind contract: Paqvilo's designed behaviour of the miscellaneous Dataverse messages; texts the module marks as guesses are not proof
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { modelOf, parsedFetch, queryJson } from '../lib/dataverse-misc-messages.mjs';
import { toFetchXml } from '../lib/dataverse-soap-query.mjs';
import { hashSecret } from '../lib/dataverse-auth.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { bearerCall, signedInRequester } from './support/web-api.mjs';

const APP_ID = '22222222-2222-2222-2222-222222222222';
const PUBLIC_APP_ID = '44444444-4444-4444-4444-444444444444';
const SECRET_VAR = 'PAQVILO_MISC_MESSAGES_SECRET';
const TENANT = '00112233-4455-6677-8899-aabbccddeeff';
const PASSWORD = 'Pass!23';
const NONE_OID = '77777777-7777-7777-7777-777777777777';
const ART_ONE = 'a1000000-0000-4000-8000-000000000001';
const ART_TWO = 'a1000000-0000-4000-8000-000000000002';
const ART_THREE = 'a1000000-0000-4000-8000-000000000003';
const KB_ONE = 'b1000000-0000-4000-8000-000000000001';
const KB_TWO = 'b1000000-0000-4000-8000-000000000002';
const KB_THREE = 'b1000000-0000-4000-8000-000000000003';
const SUBJECT_A = 'c1000000-0000-4000-8000-00000000000a';
const SUBJECT_B = 'c1000000-0000-4000-8000-00000000000b';
const UNKNOWN = 'd1000000-0000-4000-8000-000000000000';
const CRM = 'Microsoft.Dynamics.CRM.';

const ART_V1 = 'e1000000-0000-4000-8000-000000000001';
const ART_VIEW = 'e1000000-0000-4000-8000-000000000002';
const LANG_FR = 'f1000000-0000-4000-8000-000000000001';
const LANG_EN = 'f1000000-0000-4000-8000-000000000002';
const LANG_UNKNOWN = 'f1000000-0000-4000-8000-0000000000ff';
const ACCOUNT_A = 'a2000000-0000-4000-8000-00000000000a';
const ACCOUNT_B = 'a2000000-0000-4000-8000-00000000000b';
const ACCOUNT_C = 'a2000000-0000-4000-8000-00000000000c';
const ACT_A = 'b2000000-0000-4000-8000-00000000000a';
const ACT_B = 'b2000000-0000-4000-8000-00000000000b';
const ACT_C = 'b2000000-0000-4000-8000-00000000000c';
const VIRTUAL = 'c2000000-0000-4000-8000-000000000001';
const WIDGET_ONE = 'd2000000-0000-4000-8000-000000000001';
const WIDGET_TWO = 'd2000000-0000-4000-8000-000000000002';
const MANAGED = 'e2000000-0000-4000-8000-000000000001';
const PLUGIN_ASSEMBLY = 'f2000000-0000-4000-8000-000000000001';
const THUMB = 'AB'.repeat(20);
const WORKFLOW = '91000000-0000-4000-8000-000000000001';
const STAGE_ONE = '92000000-0000-4000-8000-000000000001';
const STAGE_TWO = '92000000-0000-4000-8000-000000000002';
const STAGE_THREE = '92000000-0000-4000-8000-000000000003';
const INSTANCE_OLD = '93000000-0000-4000-8000-000000000001';
const INSTANCE_NEW = '93000000-0000-4000-8000-000000000002';

// A query with filters, nested filters, an order, a link and TopCount. Too long for a URL segment (260 characters), so it is
// converted through the module functions directly; the HTTP tests use SHORT.
const FETCH =
  `<fetch distinct="true" top="5"><entity name="contoso_widget"><attribute name="name"/><order attribute="name" descending="true"/>` +
  `<filter type="and"><condition attribute="status" operator="eq" value="1"/><filter type="or">` +
  `<condition attribute="name" operator="like" value="a%"/><condition attribute="name" operator="null"/></filter></filter>` +
  `<link-entity name="contoso_owner" from="contoso_ownerid" to="contoso_owner" alias="own" link-type="outer">` +
  `<attribute name="contoso_name"/></link-entity></entity></fetch>`;
const SHORT = `<fetch top="5"><entity name="contoso_widget"><attribute name="name"/></entity></fetch>`;

function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: 'contoso_widgets',
    idColumn: 'contoso_widgetid',
    nameColumn: 'name',
    userConfigured: true,
    fields: { name: { dataverseType: 'nvarchar' }, status: { dataverseType: 'int' } },
    relationships: {},
  };
  state.mappings.new_samplevirtual = {
    logicalName: 'new_samplevirtual',
    entitySet: 'new_samplevirtuals',
    idColumn: 'new_samplevirtualid',
    isVirtual: true,
    userConfigured: true,
    fields: { name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.mappings.new_samplebpf = {
    logicalName: 'new_samplebpf',
    entitySet: 'new_samplebpfs',
    idColumn: 'new_samplebpfid',
    userConfigured: true,
    fields: {
      bpf_contoso_widgetid: { dataverseType: 'uniqueidentifier' },
      activestageid: { dataverseType: 'uniqueidentifier' },
      traversedpath: { dataverseType: 'nvarchar' },
    },
    relationships: {},
  };
  state.tables.contoso_widget = [];
  state.tables.new_samplebpf = [];
  // Present at start-up: the virtual table's external event routes are registered from it.
  state.tables.virtualentitymetadata = [
    {
      virtualentitymetadataid: VIRTUAL,
      name: 'new_samplevirtual',
      isonexternalcreatedenabled: true,
      isonexternalupdatedenabled: true,
      isonexternaldeletedenabled: true,
      ischangedfieldsenabledforupdateevent: false,
    },
  ];
  return state;
}

let api;
let store;
let origin;
let appToken;
let noneToken;
let metadata;

before(async () => {
  process.env[SECRET_VAR] = 'misc-messages-secret';
  store = await new DataStore({ state: fixtureState() }).init();
  const settings = dataverseSettings({
    enabled: true,
    tenantId: TENANT,
    applications: [
      {
        appId: APP_ID,
        displayName: 'Misc app',
        secretEnvironmentVariable: SECRET_VAR,
        roles: ['System Administrator'],
      },
      { appId: PUBLIC_APP_ID, displayName: 'Public app', publicClient: true, redirectUris: ['http://localhost:1/cb'] },
    ],
    users: [{ domainname: 'none@example.test', fullname: 'None', objectId: NONE_OID, roles: [] }],
  });
  api = await startDataverseApi({ store, settings, log: () => {}, extensions: EXTENSIONS });
  origin = api.origin;
  const organizationId = api.organizationId;
  await store.transact(() => {
    const tables = store.state.tables;
    store.state.dataverse.passwords ??= {};
    store.state.dataverse.passwords[uuidV5(organizationId, `systemuser:oid:${NONE_OID}`)] = hashSecret(PASSWORD);
    // Knowledge rows: two versions of one article (ART_ONE is the latest, ART_TWO its older version), one more article for the
    // searches, and two articles for the version and view messages.
    tables.knowledgearticle = [
      {
        knowledgearticleid: ART_ONE,
        title: 'Alpha guide',
        description: '',
        keywords: '',
        content: 'first',
        statecode: 1,
        islatestversion: true,
        rootarticleid: ART_ONE,
      },
      {
        knowledgearticleid: ART_TWO,
        title: 'Alpha guide',
        description: '',
        keywords: '',
        content: 'older',
        statecode: 0,
        islatestversion: false,
        rootarticleid: ART_ONE,
      },
      {
        knowledgearticleid: ART_THREE,
        title: 'Gamma',
        description: '',
        keywords: '',
        content: 'alpha inside',
        statecode: 1,
        islatestversion: true,
        rootarticleid: ART_THREE,
      },
      {
        knowledgearticleid: ART_V1,
        title: 'Version one',
        rootarticleid: ART_V1,
        majorversionnumber: 1,
        minorversionnumber: 0,
        islatestversion: true,
        languagelocaleid: LANG_EN,
        statecode: 1,
        statuscode: 2,
        content: 'v1',
      },
      {
        knowledgearticleid: ART_VIEW,
        title: 'Viewed',
        rootarticleid: ART_VIEW,
        majorversionnumber: 1,
        minorversionnumber: 0,
        islatestversion: true,
        statecode: 1,
        statuscode: 2,
      },
    ];
    tables.knowledgearticleviews = [];
    tables.subject = [
      { subjectid: SUBJECT_A, title: 'Networking' },
      { subjectid: SUBJECT_B, title: 'Billing' },
    ];
    tables.kbarticle = [
      {
        kbarticleid: KB_ONE,
        title: 'Beta fix',
        keywords: 'router, reboot',
        content: 'reboot steps',
        subjectid: SUBJECT_A,
      },
      { kbarticleid: KB_TWO, title: 'Other', keywords: 'beta', content: '', subjectid: SUBJECT_B },
      { kbarticleid: KB_THREE, title: 'Beta note', keywords: '', content: '', subjectid: SUBJECT_A },
    ];
    tables.languagelocale = [
      { languagelocaleid: LANG_FR, localeid: 1036, code: 'fr-FR' },
      { languagelocaleid: LANG_EN, localeid: 1033, code: 'en-US' },
    ];
    tables.account = [
      { accountid: ACCOUNT_A, name: 'Parent account' },
      { accountid: ACCOUNT_B, name: 'Child account', parentaccountid: ACCOUNT_A },
      { accountid: ACCOUNT_C, name: 'Unrelated account' },
    ];
    tables.activitypointer = [
      { activityid: ACT_A, subject: 'On parent', regardingobjectid: ACCOUNT_A, regardingobjectidtype: 'account' },
      { activityid: ACT_B, subject: 'On child', regardingobjectid: ACCOUNT_B, regardingobjectidtype: 'account' },
      { activityid: ACT_C, subject: 'On unrelated', regardingobjectid: ACCOUNT_C, regardingobjectidtype: 'account' },
    ];
    tables.managedidentity = [{ managedidentityid: MANAGED, name: 'contoso identity' }];
    tables.pluginassembly = [
      { pluginassemblyid: PLUGIN_ASSEMBLY, name: 'Contoso.Plugins', managedidentityid: MANAGED },
    ];
    tables.workflow = [
      {
        workflowid: WORKFLOW,
        name: 'Contoso flow',
        category: 4,
        primaryentity: 'contoso_widget',
        statecode: 1,
        uniquename: 'new_samplebpf',
      },
    ];
    tables.processstage = [
      { processstageid: STAGE_ONE, processid: WORKFLOW, stagename: 'Qualify' },
      { processstageid: STAGE_TWO, processid: WORKFLOW, stagename: 'Develop' },
      { processstageid: STAGE_THREE, processid: WORKFLOW, stagename: 'Close' },
    ];
    tables.new_samplebpf = [
      {
        new_samplebpfid: INSTANCE_OLD,
        bpf_contoso_widgetid: WIDGET_ONE,
        processid: WORKFLOW,
        activestageid: STAGE_ONE,
        traversedpath: STAGE_ONE,
        modifiedon: '2026-10-01T09:00:00Z',
      },
      {
        new_samplebpfid: INSTANCE_NEW,
        bpf_contoso_widgetid: WIDGET_ONE,
        processid: WORKFLOW,
        activestageid: STAGE_TWO,
        traversedpath: `${STAGE_THREE},${STAGE_ONE}`,
        modifiedon: '2026-10-05T09:00:00Z',
      },
    ];
    tables.contoso_widget = [
      { contoso_widgetid: WIDGET_ONE, name: 'One' },
      { contoso_widgetid: WIDGET_TWO, name: 'Two' },
    ];
  });
  appToken = await token({
    grant_type: 'client_credentials',
    client_id: APP_ID,
    client_secret: process.env[SECRET_VAR],
    scope: `${origin}/.default`,
  });
  noneToken = await token({
    grant_type: 'password',
    client_id: PUBLIC_APP_ID,
    username: 'none@example.test',
    password: PASSWORD,
    scope: `${origin}/.default`,
  });
});

after(async () => {
  delete process.env[SECRET_VAR];
  await api?.close();
});

async function token(form) {
  const response = await fetch(`${origin}/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  assert.equal(response.status, 200);
  return (await response.json()).access_token;
}

// One request. The default token is the System Administrator application.
const call = (path, options) => bearerCall(origin, () => appToken)(path, options);
const webApi = (suffix) => `/api/data/v9.2/${suffix}`;
const fetchXmlToQuery = (xml, token) =>
  call(webApi(`FetchXmlToQueryExpression(FetchXml='${encodeURIComponent(xml)}')`), { token });
const queryToFetchXml = (query) =>
  call(webApi('QueryExpressionToFetchXml'), { method: 'POST', body: { Query: query } });
const encoded = (value) => encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value));
const ref = (set, id) => ({ '@odata.id': `${set}(${id})` });
// The full $metadata document is large to build; the declaration checks share one read.
const metadataText = async () => (metadata ??= await (await call(webApi('$metadata'))).text());

async function errorOf(response, status) {
  const text = await response.text();
  assert.equal(response.status, status, `expected ${status}, got ${response.status}: ${text}`);
  return { message: JSON.parse(text).error.message, text };
}

describe('query conversion, validation, timestamp and knowledge searches', () => {
  it('FetchXmlToQueryExpression converts FetchXML to a QueryExpression with SDK operator names', async () => {
    const { Query } = await (await fetchXmlToQuery(SHORT)).json();
    assert.equal(Query.EntityName, 'contoso_widget');
    assert.equal(Query.TopCount, 5);
    assert.deepEqual(Query.ColumnSet.Columns, ['name']);
    // The long query, converted through the module.
    const long = queryJson(parsedFetch(FETCH));
    assert.equal(long.Distinct, true);
    assert.equal(long.Criteria.Conditions[0].Operator, 'Equal');
    assert.deepEqual(long.Criteria.Conditions[0].Values, ['1']);
    assert.equal(long.Criteria.Filters[0].FilterOperator, 'Or');
    assert.equal(long.Criteria.Filters[0].Conditions[1].Operator, 'Null');
    assert.equal(long.LinkEntities[0].JoinOperator, 'LeftOuter');
    assert.equal(long.LinkEntities[0].LinkToEntityName, 'contoso_owner');
    assert.equal(long.Orders[0].AttributeName, 'name');
  });

  it('FetchXmlToQueryExpression refuses malformed FetchXML, and an operator with no QueryExpression equivalent', async () => {
    assert.match(
      (await errorOf(await fetchXmlToQuery('<entity name="contoso_widget"/>'), 400)).message,
      /complete fetch element/,
    );
    const unsupported = `<fetch><entity name="contoso_widget"><filter><condition attribute="name" operator="in-fiscal-year" value="1"/></filter></entity></fetch>`;
    assert.throws(
      () => queryJson(parsedFetch(unsupported)),
      (error) => error.status === 400 && /no QueryExpression equivalent/.test(error.message),
    );
  });

  it('QueryExpressionToFetchXml renders a QueryExpression and round trips with FetchXmlToQueryExpression', async () => {
    // Module level: the long query survives a QueryExpression -> FetchXML -> QueryExpression round trip unchanged.
    const first = queryJson(parsedFetch(FETCH));
    const xml = toFetchXml(modelOf(first), { primaryIdOf: () => 'contoso_widgetid' });
    assert.deepEqual(queryJson(parsedFetch(xml)), first);
    // HTTP: the minimal query renders to SHORT, and converting back and forth is stable.
    const minimal = { EntityName: 'contoso_widget', ColumnSet: { AllColumns: false, Columns: ['name'] }, TopCount: 5 };
    const rendered = await (await queryToFetchXml(minimal)).json();
    assert.equal(rendered['@odata.context'].endsWith('Microsoft.Dynamics.CRM.QueryExpressionToFetchXmlResponse'), true);
    assert.equal(rendered.FetchXml, SHORT);
    const query = await (await fetchXmlToQuery(rendered.FetchXml)).json();
    const again = await (await queryToFetchXml(query.Query)).json();
    assert.equal(again.FetchXml, rendered.FetchXml);
  });

  it('QueryExpressionToFetchXml refuses a missing Query, a TopCount with paging, and a sub-query', async () => {
    assert.match(
      (await errorOf(await call(webApi('QueryExpressionToFetchXml'), { method: 'POST', body: {} }), 400)).message,
      /Query is required/,
    );
    const topAndPaging = { EntityName: 'contoso_widget', TopCount: 5, PageInfo: { Count: 10, PageNumber: 1 } };
    assert.match((await errorOf(await queryToFetchXml(topAndPaging), 400)).message, /TopCount cannot be combined/);
    const subQuery = { EntityName: 'contoso_widget', SubQueryExpression: { EntityName: 'contoso_widget' } };
    assert.match((await errorOf(await queryToFetchXml(subQuery), 501)).message, /not simulated/);
  });

  it("ValidateFetchXmlExpression answers an empty result for valid FetchXML and the parser's 400 for malformed input", async () => {
    const valid = await call(webApi(`ValidateFetchXmlExpression(FetchXml='${encodeURIComponent(SHORT)}')`));
    assert.equal(valid.status, 200);
    assert.deepEqual((await valid.json()).ValidationResults.Messages, []);
    await errorOf(await call(webApi(`ValidateFetchXmlExpression(FetchXml='${encodeURIComponent('<fetch>')}')`)), 400);
  });

  // @test-kind security: validating a saved query requires its read privilege
  it('ValidateSavedQuery answers 204 for valid FetchXML, refuses malformed FetchXML, and needs the saved query read privilege', async () => {
    const path = webApi(`savedqueries/${CRM}ValidateSavedQuery`);
    const valid = await call(path, { method: 'POST', body: { FetchXml: FETCH, QueryType: 0 } });
    assert.equal(valid.status, 204);
    await errorOf(await call(path, { method: 'POST', body: { FetchXml: '<fetch>', QueryType: 0 } }), 400);
    const denied = await errorOf(
      await call(path, { method: 'POST', body: { FetchXml: FETCH, QueryType: 0 }, token: noneToken }),
      403,
    );
    assert.match(denied.message, /prvReadSavedQuery/);
  });

  it('RetrieveTimestamp returns the current server time as an ISO timestamp', async () => {
    // The organization runs on wall time here, so the answer lies between the moments the call started and ended.
    const started = Date.now();
    const body = await (await call(webApi('RetrieveTimestamp'))).json();
    const ended = Date.now();
    assert.match(body.Timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const answered = Date.parse(body.Timestamp);
    assert.ok(answered >= started && answered <= ended, `${body.Timestamp} outside the call`);
  });

  it('FullTextSearchKnowledgeArticle finds articles by text, filters by state and drops older versions on request', async () => {
    const path = webApi('FullTextSearchKnowledgeArticle');
    const all = await (await call(path, { method: 'POST', body: { SearchText: 'alpha' } })).json();
    assert.deepEqual(all.value.map((row) => row.knowledgearticleid).sort(), [ART_ONE, ART_TWO, ART_THREE].sort());
    const active = await (await call(path, { method: 'POST', body: { SearchText: 'alpha', StateCode: 1 } })).json();
    assert.deepEqual(active.value.map((row) => row.knowledgearticleid).sort(), [ART_ONE, ART_THREE].sort());
    const latest = await (
      await call(path, { method: 'POST', body: { SearchText: 'alpha', RemoveDuplicates: true } })
    ).json();
    assert.deepEqual(latest.value.map((row) => row.knowledgearticleid).sort(), [ART_ONE, ART_THREE].sort());
  });

  // @test-kind security: searching articles requires the knowledge article read privilege
  it('FullTextSearchKnowledgeArticle refuses a missing SearchText and needs the knowledge article read privilege', async () => {
    const path = webApi('FullTextSearchKnowledgeArticle');
    assert.match(
      (await errorOf(await call(path, { method: 'POST', body: {} }), 400)).message,
      /SearchText is required/,
    );
    const denied = await errorOf(
      await call(path, { method: 'POST', body: { SearchText: 'alpha' }, token: noneToken }),
      403,
    );
    assert.match(denied.message, /prvReadKnowledgeArticle/);
  });

  it('the kbarticle searches match title, keywords and body, and the subject narrows them', async () => {
    const search = (name, text, subject) =>
      call(webApi(`kbarticles/${CRM}${name}(SearchText='${text}',Subject=@s)${subject ? `?@s=${subject}` : ''}`));
    const titles = await (await search('SearchByTitleKbArticle', 'beta')).json();
    assert.deepEqual(titles.value.map((row) => row.kbarticleid).sort(), [KB_ONE, KB_THREE].sort());
    assert.equal((await (await search('SearchByTitleKbArticle', 'beta', SUBJECT_B)).json()).value.length, 0);
    const keywords = await (await search('SearchByKeywordsKbArticle', 'beta')).json();
    assert.deepEqual(
      keywords.value.map((row) => row.kbarticleid),
      [KB_TWO],
    );
    const body = await (await search('SearchByBodyKbArticle', 'reboot')).json();
    assert.deepEqual(
      body.value.map((row) => row.kbarticleid),
      [KB_ONE],
    );
    assert.match((await errorOf(await search('SearchByTitleKbArticle', ''), 400)).message, /SearchText is required/);
    const denied = await errorOf(
      await call(webApi(`kbarticles/${CRM}SearchByTitleKbArticle(SearchText='beta',Subject=@s)`), { token: noneToken }),
      403,
    );
    assert.match(denied.message, /prvReadKbArticle/);
  });

  // @test-kind security: the lookup requires the kbarticle read privilege
  it("RetrieveByTopIncidentSubjectKbArticle returns the subject's articles and needs the kbarticle read privilege", async () => {
    const found = await (
      await call(webApi(`subjects(${SUBJECT_A})/${CRM}RetrieveByTopIncidentSubjectKbArticle`))
    ).json();
    assert.deepEqual(found.value.map((row) => row.kbarticleid).sort(), [KB_ONE, KB_THREE].sort());
    await errorOf(await call(webApi(`subjects(${UNKNOWN})/${CRM}RetrieveByTopIncidentSubjectKbArticle`)), 404);
    const denied = await errorOf(
      await call(webApi(`subjects(${SUBJECT_A})/${CRM}RetrieveByTopIncidentSubjectKbArticle`), { token: noneToken }),
      403,
    );
    assert.match(denied.message, /prvReadKbArticle/);
  });
});

describe('knowledge versions, rollup, virtual events, composite data sources, certificates, FIC, BPF and SetProcess', () => {
  it('IncrementKnowledgeArticleViewCount adds to the day row and the article total', async () => {
    const path = (count) =>
      webApi(
        `IncrementKnowledgeArticleViewCount(Source=@s,ViewDate=@d,Location=@l,Count=@c)?@s=${encoded(ref('knowledgearticles', ART_VIEW))}&@d=${encoded('2026-10-20T10:00:00Z')}&@l=1&@c=${count}`,
      );
    const first = await call(path(3));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).knowledgearticleview, 3);
    const second = await (await call(path(2))).json();
    assert.equal(second.knowledgearticleview, 5, 'same article, UTC day and location add to one row');
    const article = store.state.tables.knowledgearticle.find((row) => row.knowledgearticleid === ART_VIEW);
    assert.equal(article.knowledgearticleviews, 5);
    assert.equal(store.state.tables.knowledgearticleviews.length, 1);
  });

  it('CreateKnowledgeArticleVersion makes a major version latest; a translation to an unknown locale is 0x80061400', async () => {
    const version = await call(webApi('CreateKnowledgeArticleVersion'), {
      method: 'POST',
      body: { Source: ref('knowledgearticles', ART_V1), IsMajor: true },
    });
    assert.equal(version.status, 200, await version.clone().text());
    const fresh = await version.json();
    assert.equal(fresh.majorversionnumber, 2);
    assert.equal(fresh.minorversionnumber, 0);
    assert.equal(fresh.rootarticleid, ART_V1);
    assert.equal(fresh.islatestversion, true);
    assert.equal(
      store.state.tables.knowledgearticle.find((row) => row.knowledgearticleid === ART_V1).islatestversion,
      false,
    );

    const unknown = await call(webApi('CreateKnowledgeArticleTranslation'), {
      method: 'POST',
      body: {
        Source: ref('knowledgearticles', ART_V1),
        Language: ref('languagelocales', LANG_UNKNOWN),
        IsMajor: false,
      },
    });
    assert.match((await errorOf(unknown, 400)).text, /0x80061400/);

    const translated = await call(webApi('CreateKnowledgeArticleTranslation'), {
      method: 'POST',
      body: { Source: ref('knowledgearticles', ART_V1), Language: ref('languagelocales', LANG_FR), IsMajor: false },
    });
    assert.equal(translated.status, 200);
    const copy = await translated.json();
    assert.equal(copy.languagelocaleid, LANG_FR);
    assert.equal(copy.isprimary, false);
    assert.match(
      (
        await errorOf(
          await call(webApi('CreateKnowledgeArticleTranslation'), {
            method: 'POST',
            body: {
              Source: ref('knowledgearticles', ART_V1),
              Language: ref('languagelocales', LANG_FR),
              IsMajor: false,
            },
          }),
          400,
        )
      ).text,
      /0x80061403/,
    );
  });

  it('Rollup Related returns activities of the account and its child account; an invalid type is 0x80040234', async () => {
    const query = {
      '@odata.type': 'Microsoft.Dynamics.CRM.QueryExpression',
      EntityName: 'activitypointer',
      ColumnSet: { AllColumns: false, Columns: ['subject'] },
    };
    const rollupPath = (type, target = ref('accounts', ACCOUNT_A)) =>
      webApi(`Rollup(Target=@t,Query=@q,RollupType=@r)?@t=${encoded(target)}&@q=${encoded(query)}&@r=${encoded(type)}`);
    const relatedResponse = await call(rollupPath(`${CRM}RollupType'Related'`));
    assert.equal(relatedResponse.status, 200, await relatedResponse.clone().text());
    const related = await relatedResponse.json();
    assert.deepEqual(related.value.map((row) => row.activityid).sort(), [ACT_A, ACT_B].sort());
    // activitypointer takes Related or Extended for an account, so None is refused as an invalid type.
    assert.match((await errorOf(await call(rollupPath('0')), 400)).text, /0x80040234/);
    assert.match((await errorOf(await call(rollupPath('Bogus')), 400)).text, /0x80040234/);
  });

  it('OnExternalUpdated refuses a non-virtual table and accepts a virtual one with 204', async () => {
    const path = webApi('OnExternalUpdated');
    const plain = await call(path, {
      method: 'POST',
      body: { Target: ref('contoso_widgets', WIDGET_ONE), ChangedFields: [] },
    });
    assert.match((await errorOf(plain, 400)).text, /0x80040203/);
    const changed = await call(path, {
      method: 'POST',
      body: { Target: ref('new_samplevirtuals', VIRTUAL), ChangedFields: ['name'] },
    });
    assert.match((await errorOf(changed, 400)).text, /0x80073019/, 'changed fields are not enabled for this table');
    store.state.tables.virtualentitymetadata[0].ischangedfieldsenabledforupdateevent = true;
    const accepted = await call(path, {
      method: 'POST',
      body: { Target: ref('new_samplevirtuals', VIRTUAL), ChangedFields: ['name'] },
    });
    assert.equal(accepted.status, 204);
    store.state.tables.virtualentitymetadata[0].ischangedfieldsenabledforupdateevent = false;
  });

  it('external virtual events dispatch their snapshot asynchronously and leave external rows untouched', async () => {
    const observed = [];
    const step = {
      id: VIRTUAL,
      name: 'Invented external observer',
      entity: 'new_samplevirtual',
      message: 'OnExternalCreated',
      enabled: true,
      stage: 40,
      rank: 1,
      mode: 1,
      typeName: 'Invented.External',
      assemblyId: PLUGIN_ASSEMBLY,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
    };
    const handlers = new Map([
      [
        step.typeName,
        (event) => {
          observed.push(event.context);
        },
      ],
    ]);
    const items = () => pluginCatalogue({ plugins: { steps: [step] }, handlers });
    const runner = createAsyncPluginRunner({ store, items, handlers, runtimes: new Map() });
    try {
      const response = await call(webApi('new_samplevirtuals/Microsoft.Dynamics.CRM.OnExternalCreated'), {
        method: 'POST',
        body: {
          Target: { '@odata.type': CRM + 'new_samplevirtual', new_samplevirtualid: VIRTUAL, name: 'External snapshot' },
        },
      });
      assert.equal(response.status, 204, await response.clone().text());
      await runner.drain();
      assert.equal(observed.length, 1);
      assert.equal(observed[0].MessageName, 'OnExternalCreated');
      assert.equal(observed[0].Mode, 1);
      assert.equal(observed[0].InputParameters.Target.name, 'External snapshot');
      assert.deepEqual(store.tableRows('new_samplevirtual'), []);
      store.state.tables.virtualentitymetadata[0].isonexternalcreatedenabled = false;
      const disabled = await call(webApi('OnExternalCreated'), {
        method: 'POST',
        body: { Target: ref('new_samplevirtuals', VIRTUAL) },
      });
      assert.match((await errorOf(disabled, 400)).text, /0x80090309/);
    } finally {
      store.state.tables.virtualentitymetadata[0].isonexternalcreatedenabled = true;
      await runner.close();
    }
  });

  it('undocumented platform contracts remain discoverable with explicit implementation errors', async () => {
    const metadata = await metadataText();
    for (const name of [
      '_Downloademailasattachment',
      '_InvokeHideReserveEntities',
      '_SyncKnowledgeManagementSettings',
      'cascadeAsync_SuccessAPI',
    ]) {
      assert.ok(metadata.includes(`Action Name="${name}"`), name);
      const response = await call(webApi(name), { method: 'POST', body: {} });
      assert.match((await errorOf(response, 501)).text, /no configured local implementation/);
    }
    assert.ok(metadata.includes('Property Name="emailRecordData" Type="Edm.String"'));
  });

  it('UpsertCompositeDataSource links a child and RetrieveAllCompositeDataSources returns both', async () => {
    const upsert = await call(webApi('UpsertCompositeDataSource'), {
      method: 'POST',
      body: {
        ParentDisplayName: 'Parent source',
        ParentSchemaName: 'new_ParentSource',
        ParentParameterKey: 'parentKey',
        ParentApiId: '/api/parent',
        ParentValue: 'parent-value',
        ChildDisplayName: 'Child source',
        ChildSchemaName: 'new_ChildSource',
        ChildParameterKey: 'childKey',
        ChildValue: 'child-value',
      },
    });
    assert.equal(upsert.status, 204);
    const all = await (
      await call(webApi(`RetrieveAllCompositeDataSources(ParentSchemaName='new_ParentSource')`))
    ).json();
    assert.deepEqual(all.value.map((row) => row.schemaname).sort(), ['new_ChildSource', 'new_ParentSource']);
    const parent = all.value.find((row) => row.schemaname === 'new_ParentSource');
    assert.equal(parent.environmentvariabledefinition_environmentvariablevalue[0].value, 'parent-value');
    const both = await (
      await call(
        webApi("RetrieveCompositeDataSource(ParentSchemaName='new_ParentSource',ChildSchemaName='new_ChildSource')"),
      )
    ).json();
    assert.equal(both.value.length, 2);
    const missing = await call(webApi("RetrieveAllCompositeDataSources(ParentSchemaName='new_Nothing')"));
    assert.match((await errorOf(missing, 404)).text, /0x80095004/);
  });

  it('certificate credentials are added, listed and removed; a missing one is 0x8005e239', async () => {
    const add = (thumbprint) =>
      call(webApi('AddCertificateCredential'), {
        method: 'POST',
        body: { thumbprint, entityId: MANAGED, entityLogicalName: 'managedidentity' },
      });
    assert.equal((await add(THUMB)).status, 204);
    assert.equal((await add(THUMB)).status, 204, 'the same thumbprint again is a no-op');
    const listed = await (
      await call(webApi('GetCertificateCredential'), {
        method: 'POST',
        body: { entityLogicalName: 'managedidentity', entityId: MANAGED },
      })
    ).json();
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0].thumbprint, THUMB);
    const certificateCredentialId = uuidV5(MANAGED, `cc:${THUMB}`);
    const remove = (id) =>
      call(webApi('RemoveCertificateCredential'), {
        method: 'POST',
        body: { entityLogicalName: 'managedidentity', entityId: MANAGED, certificateCredentialId: id },
      });
    assert.equal((await remove(certificateCredentialId)).status, 204);
    assert.match((await errorOf(await remove(certificateCredentialId), 404)).text, /0x8005e239/);
    assert.match((await errorOf(await add('not-hex'), 400)).text, /0x8005e23a/);
  });

  it('GetComponentManagedIdentityFIC builds the eid1 subject with the encoded tenant id', async () => {
    const response = await call(
      webApi(`GetComponentManagedIdentityFIC(ComponentName='PluginAssembly',ComponentId=${PLUGIN_ASSEMBLY})`),
    );
    assert.equal(response.status, 200);
    const { FICSubject } = await response.json();
    // .NET byte order for the tenant id: 33 22 11 00 55 44 77 66 88 99 aa bb cc dd ee ff, base64url without padding.
    const encodedTenant = Buffer.from('33221100554477668899aabbccddeeff', 'hex').toString('base64url');
    assert.match(
      FICSubject,
      new RegExp(
        `^/eid1/c/pub/t/${encodedTenant}/a/qzXoWDkuqUa3l6zM5mM0Rw/n/plugin/e/Default-${TENANT}/h/[0-9a-f]{64}$`,
      ),
    );
  });

  it('RetrieveProcessInstances orders by modifiedon and RetrieveActivePath follows traversedpath', async () => {
    const instances = await (
      await call(webApi(`RetrieveProcessInstances(EntityId=${WIDGET_ONE},EntityLogicalName='contoso_widget')`))
    ).json();
    assert.deepEqual(
      instances.value.map((row) => row.new_samplebpfid),
      [INSTANCE_NEW, INSTANCE_OLD],
    );
    assert.equal(instances.value[0].processstageid, STAGE_TWO);
    const path = await (await call(webApi(`RetrieveActivePath(ProcessInstanceId=${INSTANCE_NEW})`))).json();
    assert.deepEqual(
      path.value.map((row) => row.processstageid),
      [STAGE_THREE, STAGE_ONE, STAGE_TWO],
    );
    const unknown = await call(webApi(`RetrieveActivePath(ProcessInstanceId=${WIDGET_TWO})`));
    assert.match((await errorOf(unknown, 404)).text, /0x80060370/);
  });

  it('SetProcess is in $metadata and answers 501 0x80040216 by default; the new messages are declared in $metadata', async () => {
    const metadata = await metadataText();
    for (const name of [
      'IncrementKnowledgeArticleViewCount',
      'CreateKnowledgeArticleVersion',
      'CreateKnowledgeArticleTranslation',
      'Rollup',
      'OnExternalUpdated',
      'UpsertCompositeDataSource',
      'RetrieveCompositeDataSource',
      'RetrieveAllCompositeDataSources',
      'AddCertificateCredential',
      'GetCertificateCredential',
      'RemoveCertificateCredential',
      'GetComponentManagedIdentityFIC',
      'RetrieveProcessInstances',
      'RetrieveActivePath',
      'SetProcess',
    ]) {
      assert.match(metadata, new RegExp(`Name="${name}"`), `${name} is declared`);
    }
    const set = await call(webApi('SetProcess'), { method: 'POST', body: {} });
    const error = await errorOf(set, 501);
    assert.match(error.text, /0x80040216/);
    assert.match(error.message, /SetProcess is for internal use only and is not simulated\./);
  });
});

// A Basic User (an application with the Basic User role) holds the basic privileges and sees only the rows it owns; the
// administrator application sees all rows. The assertions are refusals and unchanged rows.
describe('knowledge rows and environment variable definitions follow the caller access', () => {
  const BASIC_APP = '33333333-3333-4333-8333-333333333333';
  const BASIC_SECRET_VAR = 'PAQVILO_MISC_BASIC_SECRET';
  const NONE_APP = '55555555-5555-4555-8555-555555555555';
  const NONE_SECRET_VAR = 'PAQVILO_MISC_NONE_SECRET';
  const PREFER = { prefer: 'return=representation' };
  let accessServer;
  let accessStore;
  let admin;
  let basic;
  let none;

  before(async () => {
    process.env[BASIC_SECRET_VAR] = 'misc-basic-secret';
    process.env[NONE_SECRET_VAR] = 'misc-none-secret';
    accessStore = await new DataStore({ state: emptyState() }).init();
    await accessStore.transact(() => {
      accessStore.state.tables.languagelocale = [{ languagelocaleid: LANG_FR, localeid: 1036, code: 'fr-FR' }];
    });
    const settings = dataverseSettings({
      enabled: true,
      tenantId: TENANT,
      applications: [
        {
          appId: APP_ID,
          displayName: 'Misc app',
          secretEnvironmentVariable: SECRET_VAR,
          roles: ['System Administrator'],
        },
        {
          appId: BASIC_APP,
          displayName: 'Misc basic app',
          secretEnvironmentVariable: BASIC_SECRET_VAR,
          roles: ['Basic User'],
        },
        {
          appId: NONE_APP,
          displayName: 'Misc no-role app',
          secretEnvironmentVariable: NONE_SECRET_VAR,
          roles: [],
        },
      ],
    });
    accessServer = await startDataverseApi({ store: accessStore, settings, log: () => {}, extensions: EXTENSIONS });
    // The requester takes a path that starts with a slash; the calls below name the set or function only.
    const relative = (request) => (method, path, body, headers) => request(method, `/${path}`, body, headers);
    admin = relative(await signedInRequester(accessServer, APP_ID, process.env[SECRET_VAR]));
    basic = relative(await signedInRequester(accessServer, BASIC_APP, process.env[BASIC_SECRET_VAR]));
    none = relative(await signedInRequester(accessServer, NONE_APP, process.env[NONE_SECRET_VAR]));
  });

  after(async () => {
    delete process.env[BASIC_SECRET_VAR];
    delete process.env[NONE_SECRET_VAR];
    await accessServer?.close();
  });

  // @test-kind security: RetrieveProcessInstances checks the table read privilege before the primary row, so a caller without it cannot tell an existing id from a missing one (R1-7)
  it('RetrieveProcessInstances answers the same 403 for an existing and a missing id to a caller without read on the table', async () => {
    const existing = await adminArticle('Instance probe');
    const missing = '00000000-0000-4000-8000-0000000000aa';
    const path = (id) => `RetrieveProcessInstances(EntityId=${id},EntityLogicalName='knowledgearticle')`;
    const forExisting = await none('GET', path(existing));
    const forMissing = await none('GET', path(missing));
    assert.equal(forExisting.status, 403, JSON.stringify(forExisting.json));
    assert.equal(forMissing.status, 403, JSON.stringify(forMissing.json));
    assert.equal(forMissing.json.error.code, forExisting.json.error.code);
  });

  // @test-kind security: the two upserts address one value row per definition, whichever of them wrote the definition first (R1-5)
  it('UpsertEnvironmentVariable and UpsertCompositeDataSource keep one value row for a definition, in either order', async () => {
    const valueRowsOf = (schema) => {
      const [definition] = definitionsNamed(schema);
      return tableOf('environmentvariablevalue').filter(
        (row) =>
          (row.environmentvariabledefinitionid?.id ?? row.environmentvariabledefinitionid) ===
          definition.environmentvariabledefinitionid,
      );
    };
    const plain = await admin('POST', 'UpsertEnvironmentVariable', {
      SchemaName: 'new_plainfirst',
      Type: 100000004,
      Value: 'one',
    });
    assert.equal(plain.status, 204, JSON.stringify(plain.json));
    const composite = await admin('POST', 'UpsertCompositeDataSource', {
      ParentSchemaName: 'new_plainfirst',
      ParentParameterKey: 'pk',
      ParentValue: 'two',
    });
    assert.equal(composite.status, 204, JSON.stringify(composite.json));
    assert.deepEqual(
      valueRowsOf('new_plainfirst').map((row) => row.value),
      ['two'],
    );
    const compositeFirst = await admin('POST', 'UpsertCompositeDataSource', {
      ParentSchemaName: 'new_compositefirst',
      ParentParameterKey: 'pk',
      ParentValue: 'one',
    });
    assert.equal(compositeFirst.status, 204, JSON.stringify(compositeFirst.json));
    const plainSecond = await admin('POST', 'UpsertEnvironmentVariable', {
      SchemaName: 'new_compositefirst',
      Type: 100000004,
      Value: 'two',
    });
    assert.equal(plainSecond.status, 204, JSON.stringify(plainSecond.json));
    assert.deepEqual(
      valueRowsOf('new_compositefirst').map((row) => row.value),
      ['two'],
    );
  });

  const tableOf = (logical) => accessStore.state.tables[logical] ?? [];
  const rowById = (logical, column, id) => tableOf(logical).find((row) => row[column] === id);
  const copiesOf = (id) =>
    tableOf('knowledgearticle').filter((row) => row.knowledgearticleid === id || row.rootarticleid === id);
  const definitionsNamed = (schema) =>
    tableOf('environmentvariabledefinition').filter((row) => String(row.schemaname).toLowerCase() === schema);
  const incrementPath = (article) =>
    `IncrementKnowledgeArticleViewCount(Source=@s,ViewDate=@d,Location=@l,Count=@c)?@s=${encoded(ref('knowledgearticles', article))}&@d=${encoded('2026-10-20T10:00:00Z')}&@l=1&@c=1`;
  const adminArticle = async (title) => {
    const created = await admin('POST', 'knowledgearticles', { title, content: `${title} body` }, PREFER);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    return created.json.knowledgearticleid;
  };

  // @test-kind security: a knowledge search returns only the rows the caller may read, as the Dataverse read filter applies (DV3b-2)
  it('the knowledge searches return only the articles the caller may read', async () => {
    await adminArticle('Vault plan');
    const found = await basic('POST', 'FullTextSearchKnowledgeArticle', { SearchText: 'vault' });
    assert.equal(found.status, 200);
    assert.deepEqual(found.json.value, []);
    const own = await basic('POST', 'knowledgearticles', { title: 'Vault note', content: 'basic vault' }, PREFER);
    assert.equal(own.status, 201, JSON.stringify(own.json));
    const mine = await basic('POST', 'FullTextSearchKnowledgeArticle', { SearchText: 'vault' });
    assert.deepEqual(
      mine.json.value.map((row) => row.knowledgearticleid),
      [own.json.knowledgearticleid],
    );
  });

  // @test-kind security: a version or translation needs read on its source article, and a refused copy is never stored (DV3b-2)
  it('CreateKnowledgeArticleVersion and CreateKnowledgeArticleTranslation refuse an article the caller may not read', async () => {
    const article = await adminArticle('Vault plan');
    const copies = copiesOf(article).length;
    const version = await basic('POST', 'CreateKnowledgeArticleVersion', {
      Source: ref('knowledgearticles', article),
      IsMajor: true,
    });
    assert.equal(version.status, 403);
    const translation = await basic('POST', 'CreateKnowledgeArticleTranslation', {
      Source: ref('knowledgearticles', article),
      Language: ref('languagelocales', LANG_FR),
    });
    assert.equal(translation.status, 403);
    assert.equal(copiesOf(article).length, copies, 'no copy of the refused article is stored');
    const allowed = await admin('POST', 'CreateKnowledgeArticleVersion', {
      Source: ref('knowledgearticles', article),
      IsMajor: true,
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
  });

  // @test-kind security: a copy is owned by the caller that made it, not by the owner of the source (DV3b-2)
  it('a version made by the administrator is owned by the administrator, not by the owner of the source', async () => {
    const own = await basic('POST', 'knowledgearticles', { title: 'Basic note', content: 'basic body' }, PREFER);
    assert.equal(own.status, 201, JSON.stringify(own.json));
    const version = await admin('POST', 'CreateKnowledgeArticleVersion', {
      Source: ref('knowledgearticles', own.json.knowledgearticleid),
      IsMajor: true,
    });
    assert.equal(version.status, 200, JSON.stringify(version.json));
    const copy = rowById('knowledgearticle', 'knowledgearticleid', version.json.knowledgearticleid);
    const adminNote = rowById('knowledgearticle', 'knowledgearticleid', await adminArticle('Admin note'));
    assert.deepEqual(copy.ownerid, adminNote.ownerid);
    assert.notDeepEqual(
      copy.ownerid,
      rowById('knowledgearticle', 'knowledgearticleid', own.json.knowledgearticleid).ownerid,
    );
  });

  // @test-kind security: a view count is written only when the caller may read the article (DV3b-2)
  it('IncrementKnowledgeArticleViewCount refuses a Basic User on an article it cannot read and writes no view', async () => {
    const article = await adminArticle('Vault plan');
    const views = tableOf('knowledgearticleviews').length;
    const refused = await basic('GET', incrementPath(article));
    assert.equal(refused.status, 403);
    assert.equal(tableOf('knowledgearticleviews').length, views);
    assert.equal((await admin('GET', incrementPath(article))).status, 200);
  });

  // @test-kind security: an upsert never changes a definition the caller does not own, and adds no second definition (DV3b-3)
  it('UpsertCompositeDataSource refuses a Basic User for an admin definition and keeps one definition of the schema name', async () => {
    const made = await admin(
      'POST',
      'environmentvariabledefinitions',
      { schemaname: 'new_apikey', displayname: 'API key', type: 100000000 },
      PREFER,
    );
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const refused = await basic('POST', 'UpsertCompositeDataSource', {
      ParentSchemaName: 'new_apikey',
      ParentParameterKey: 'k',
      ParentValue: 'ATTACKER-VALUE',
    });
    assert.equal(refused.status, 403);
    const named = definitionsNamed('new_apikey');
    assert.equal(named.length, 1);
    assert.equal(named[0].type, 100000000);
    assert.equal(named[0].displayname, 'API key');
  });

  // @test-kind security: an existing definition that is not a data source is refused with 0x80040237 (DV3b-3)
  it('UpsertCompositeDataSource answers 412 0x80040237 for an ordinary definition of the same schema name', async () => {
    const made = await admin(
      'POST',
      'environmentvariabledefinitions',
      { schemaname: 'new_plainkey', displayname: 'Plain', type: 100000000 },
      PREFER,
    );
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const refused = await admin('POST', 'UpsertCompositeDataSource', {
      ParentSchemaName: 'new_plainkey',
      ParentParameterKey: 'k',
      ParentValue: 'NEW-VALUE',
    });
    assert.equal(refused.status, 412);
    assert.match(JSON.stringify(refused.json), /0x80040237/);
    assert.equal(definitionsNamed('new_plainkey').length, 1);
    assert.equal(
      rowById(
        'environmentvariabledefinition',
        'environmentvariabledefinitionid',
        made.json.environmentvariabledefinitionid,
      ).type,
      100000000,
    );
  });

  // @test-kind security: the retrieve functions omit the values of a caller without read on the value table (DV3b-3)
  it('the retrieve functions omit environment variable values from a caller without read on the value table', async () => {
    // Environment variable definitions are user owned: the Basic User creates the pair without values (it holds no create
    // privilege on the value table), and the administrator writes the values afterwards, so the caller reads the
    // definitions it owns but not the values.
    const pair = (parentValue, childValue) => ({
      ParentDisplayName: 'Pipeline',
      ParentSchemaName: 'new_pipeline',
      ParentParameterKey: 'pk',
      ParentApiId: '/api/pipeline',
      ParentValue: parentValue,
      ChildDisplayName: 'Pipeline child',
      ChildSchemaName: 'new_pipelinechild',
      ChildParameterKey: 'ck',
      ChildValue: childValue,
    });
    const created = await basic('POST', 'UpsertCompositeDataSource', pair(null, null));
    assert.equal(created.status, 204, JSON.stringify(created.json));
    const upsert = await admin('POST', 'UpsertCompositeDataSource', pair('ADMIN-VALUE-SECRET', 'CHILD-VALUE-SECRET'));
    assert.equal(upsert.status, 204, JSON.stringify(upsert.json));
    const all = await basic('GET', "RetrieveAllCompositeDataSources(ParentSchemaName='new_pipeline')");
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.equal(all.json.value.length, 2);
    assert.deepEqual(all.json.value[0].environmentvariabledefinition_environmentvariablevalue, []);
    const both = await basic(
      'GET',
      "RetrieveCompositeDataSource(ParentSchemaName='new_pipeline',ChildSchemaName='new_pipelinechild')",
    );
    assert.equal(both.status, 200, JSON.stringify(both.json));
    assert.doesNotMatch(JSON.stringify([all.json, both.json]), /SECRET/);
    const adminAll = await admin('GET', "RetrieveAllCompositeDataSources(ParentSchemaName='new_pipeline')");
    assert.equal(
      adminAll.json.value[0].environmentvariabledefinition_environmentvariablevalue[0].value,
      'ADMIN-VALUE-SECRET',
    );
  });
});
