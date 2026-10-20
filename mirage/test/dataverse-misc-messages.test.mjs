// Miscellaneous platform messages in the Dataverse API, over HTTP: FetchXML and QueryExpression conversion and validation,
// RetrieveTimestamp, the knowledge article search, and the kbarticle searches. Invented schema (contoso_widget and the
// standard knowledge tables with invented rows) and GUIDs only; loopback only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { modelOf, parsedFetch, queryJson } from "../lib/dataverse-misc-messages.mjs";
import { toFetchXml } from "../lib/dataverse-soap-query.mjs";
import { hashSecret } from "../lib/dataverse-auth.mjs";
import { uuidV5 } from "../lib/dataverse-security.mjs";

const APP_ID = "22222222-2222-2222-2222-222222222222";
const PUBLIC_APP_ID = "44444444-4444-4444-4444-444444444444";
const SECRET_VAR = "PAQVILO_MISC_MESSAGES_SECRET";
const PASSWORD = "Pass!23";
const NONE_OID = "77777777-7777-7777-7777-777777777777";
const ART_ONE = "a1000000-0000-4000-8000-000000000001";
const ART_TWO = "a1000000-0000-4000-8000-000000000002";
const ART_THREE = "a1000000-0000-4000-8000-000000000003";
const KB_ONE = "b1000000-0000-4000-8000-000000000001";
const KB_TWO = "b1000000-0000-4000-8000-000000000002";
const KB_THREE = "b1000000-0000-4000-8000-000000000003";
const SUBJECT_A = "c1000000-0000-4000-8000-00000000000a";
const SUBJECT_B = "c1000000-0000-4000-8000-00000000000b";
const UNKNOWN = "d1000000-0000-4000-8000-000000000000";
const CRM = "Microsoft.Dynamics.CRM.";

// A query with filters, nested filters, an order, a link and TopCount. Too long for a URL segment (260 characters), so it is
// converted through the module functions directly; the HTTP tests use SHORT.
const FETCH = `<fetch distinct="true" top="5"><entity name="contoso_widget"><attribute name="name"/><order attribute="name" descending="true"/>` +
  `<filter type="and"><condition attribute="status" operator="eq" value="1"/><filter type="or">` +
  `<condition attribute="name" operator="like" value="a%"/><condition attribute="name" operator="null"/></filter></filter>` +
  `<link-entity name="contoso_owner" from="contoso_ownerid" to="contoso_owner" alias="own" link-type="outer">` +
  `<attribute name="contoso_name"/></link-entity></entity></fetch>`;
const SHORT = `<fetch top="5"><entity name="contoso_widget"><attribute name="name"/></entity></fetch>`;

function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: "contoso_widget", entitySet: "contoso_widgets", idColumn: "contoso_widgetid", nameColumn: "name", userConfigured: true,
    fields: { name: { dataverseType: "nvarchar" }, status: { dataverseType: "int" } }, relationships: {},
  };
  state.tables.contoso_widget = [];
  return state;
}

describe("dataverse misc messages: conversions, validation, timestamp and knowledge searches over HTTP", () => {
  let api;
  let store;
  let origin;
  let tenantId;
  let appToken;
  let noneToken;

  before(async () => {
    process.env[SECRET_VAR] = "misc-messages-secret";
    store = await new DataStore({ state: fixtureState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        { appId: APP_ID, displayName: "Misc app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] },
        { appId: PUBLIC_APP_ID, displayName: "Public app", publicClient: true, redirectUris: ["http://localhost:1/cb"] },
      ],
      users: [{ domainname: "none@example.test", fullname: "None", objectId: NONE_OID, roles: [] }],
    });
    api = await startDataverseApi({ store, settings, log: () => {}, extensions: EXTENSIONS });
    origin = api.origin;
    tenantId = api.tenantId;
    const organizationId = api.organizationId;
    await store.transact(() => {
      store.state.dataverse.passwords ??= {};
      store.state.dataverse.passwords[uuidV5(organizationId, `systemuser:oid:${NONE_OID}`)] = hashSecret(PASSWORD);
      // Invented knowledge rows: two versions of one article (ART_ONE is the latest, ART_TWO its older version) and one more article.
      store.state.tables.knowledgearticle ??= [];
      store.state.tables.knowledgearticle.push(
        { knowledgearticleid: ART_ONE, title: "Alpha guide", description: "", keywords: "", content: "first", statecode: 1, islatestversion: true, rootarticleid: ART_ONE },
        { knowledgearticleid: ART_TWO, title: "Alpha guide", description: "", keywords: "", content: "older", statecode: 0, islatestversion: false, rootarticleid: ART_ONE },
        { knowledgearticleid: ART_THREE, title: "Gamma", description: "", keywords: "", content: "alpha inside", statecode: 1, islatestversion: true, rootarticleid: ART_THREE },
      );
      store.state.tables.subject ??= [];
      store.state.tables.subject.push({ subjectid: SUBJECT_A, title: "Networking" }, { subjectid: SUBJECT_B, title: "Billing" });
      store.state.tables.kbarticle ??= [];
      store.state.tables.kbarticle.push(
        { kbarticleid: KB_ONE, title: "Beta fix", keywords: "router, reboot", content: "reboot steps", subjectid: SUBJECT_A },
        { kbarticleid: KB_TWO, title: "Other", keywords: "beta", content: "", subjectid: SUBJECT_B },
        { kbarticleid: KB_THREE, title: "Beta note", keywords: "", content: "", subjectid: SUBJECT_A },
      );
    });
    appToken = await clientToken();
    noneToken = await userToken();
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  async function clientToken() {
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${origin}/.default` }),
    });
    return (await response.json()).access_token;
  }

  async function userToken() {
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: PUBLIC_APP_ID, username: "none@example.test", password: PASSWORD, scope: `${origin}/.default` }),
    });
    return (await response.json()).access_token;
  }

  // One request. A JSON body is serialised. The default token is the System Administrator application.
  const call = (path, { token = appToken, method = "GET", body } = {}) =>
    fetch(`${origin}${path}`, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const webApi = (suffix) => `/api/data/v9.2/${suffix}`;
  const fetchXmlToQuery = (xml, token) => call(webApi(`FetchXmlToQueryExpression(FetchXml='${encodeURIComponent(xml)}')`), { token });
  const queryToFetchXml = (query) => call(webApi("QueryExpressionToFetchXml"), { method: "POST", body: { Query: query } });

  async function errorOf(response, status) {
    assert.equal(response.status, status, `expected ${status}`);
    return (await response.json()).error;
  }

  it("FetchXmlToQueryExpression converts FetchXML to a QueryExpression with SDK operator names", async () => {
    const { Query } = await (await fetchXmlToQuery(SHORT)).json();
    assert.equal(Query.EntityName, "contoso_widget");
    assert.equal(Query.TopCount, 5);
    assert.deepEqual(Query.ColumnSet.Columns, ["name"]);
    // The long query, converted through the module.
    const long = queryJson(parsedFetch(FETCH));
    assert.equal(long.Distinct, true);
    assert.equal(long.Criteria.Conditions[0].Operator, "Equal");
    assert.deepEqual(long.Criteria.Conditions[0].Values, ["1"]);
    assert.equal(long.Criteria.Filters[0].FilterOperator, "Or");
    assert.equal(long.Criteria.Filters[0].Conditions[1].Operator, "Null");
    assert.equal(long.LinkEntities[0].JoinOperator, "LeftOuter");
    assert.equal(long.LinkEntities[0].LinkToEntityName, "contoso_owner");
    assert.equal(long.Orders[0].AttributeName, "name");
  });

  it("FetchXmlToQueryExpression refuses malformed FetchXML, and an operator with no QueryExpression equivalent", async () => {
    assert.match((await errorOf(await fetchXmlToQuery("<entity name=\"contoso_widget\"/>"), 400)).message, /complete fetch element/);
    const unsupported = `<fetch><entity name="contoso_widget"><filter><condition attribute="name" operator="in-fiscal-year" value="1"/></filter></entity></fetch>`;
    assert.throws(() => queryJson(parsedFetch(unsupported)), (error) => error.status === 400 && /no QueryExpression equivalent/.test(error.message));
  });

  it("QueryExpressionToFetchXml renders a QueryExpression and round trips with FetchXmlToQueryExpression", async () => {
    // Module level: the long query survives a QueryExpression -> FetchXML -> QueryExpression round trip unchanged.
    const first = queryJson(parsedFetch(FETCH));
    const xml = toFetchXml(modelOf(first), { primaryIdOf: () => "contoso_widgetid" });
    assert.deepEqual(queryJson(parsedFetch(xml)), first);
    // HTTP: the minimal query renders to SHORT, and converting back and forth is stable.
    const minimal = { EntityName: "contoso_widget", ColumnSet: { AllColumns: false, Columns: ["name"] }, TopCount: 5 };
    const rendered = await (await queryToFetchXml(minimal)).json();
    assert.equal(rendered["@odata.context"].endsWith("Microsoft.Dynamics.CRM.QueryExpressionToFetchXmlResponse"), true);
    assert.equal(rendered.FetchXml, SHORT);
    const query = await (await fetchXmlToQuery(rendered.FetchXml)).json();
    const again = await (await queryToFetchXml(query.Query)).json();
    assert.equal(again.FetchXml, rendered.FetchXml);
  });

  it("QueryExpressionToFetchXml refuses a missing Query, a TopCount with paging, and a sub-query", async () => {
    assert.match((await errorOf(await call(webApi("QueryExpressionToFetchXml"), { method: "POST", body: {} }), 400)).message, /Query is required/);
    const topAndPaging = { EntityName: "contoso_widget", TopCount: 5, PageInfo: { Count: 10, PageNumber: 1 } };
    assert.match((await errorOf(await queryToFetchXml(topAndPaging), 400)).message, /TopCount cannot be combined/);
    const subQuery = { EntityName: "contoso_widget", SubQueryExpression: { EntityName: "contoso_widget" } };
    assert.match((await errorOf(await queryToFetchXml(subQuery), 501)).message, /not simulated/);
  });

  it("ValidateFetchXmlExpression answers an empty result for valid FetchXML and the parser's 400 for malformed input", async () => {
    const valid = await call(webApi(`ValidateFetchXmlExpression(FetchXml='${encodeURIComponent(SHORT)}')`));
    assert.equal(valid.status, 200);
    assert.deepEqual((await valid.json()).ValidationResults.Messages, []);
    await errorOf(await call(webApi(`ValidateFetchXmlExpression(FetchXml='${encodeURIComponent("<fetch>")}')`)), 400);
  });

  it("ValidateSavedQuery answers 204 for valid FetchXML, refuses malformed FetchXML, and needs the saved query read privilege", async () => {
    const path = webApi(`savedqueries/${CRM}ValidateSavedQuery`);
    const valid = await call(path, { method: "POST", body: { FetchXml: FETCH, QueryType: 0 } });
    assert.equal(valid.status, 204);
    await errorOf(await call(path, { method: "POST", body: { FetchXml: "<fetch>", QueryType: 0 } }), 400);
    const denied = await errorOf(await call(path, { method: "POST", body: { FetchXml: FETCH, QueryType: 0 }, token: noneToken }), 403);
    assert.match(denied.message, /prvReadSavedQuery/);
  });

  it("RetrieveTimestamp returns a timestamp string", async () => {
    const body = await (await call(webApi("RetrieveTimestamp"))).json();
    assert.match(body.Timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("FullTextSearchKnowledgeArticle finds articles by text, filters by state and drops older versions on request", async () => {
    const path = webApi("FullTextSearchKnowledgeArticle");
    const all = await (await call(path, { method: "POST", body: { SearchText: "alpha" } })).json();
    assert.deepEqual(all.value.map((row) => row.knowledgearticleid).sort(), [ART_ONE, ART_TWO, ART_THREE].sort());
    const active = await (await call(path, { method: "POST", body: { SearchText: "alpha", StateCode: 1 } })).json();
    assert.deepEqual(active.value.map((row) => row.knowledgearticleid).sort(), [ART_ONE, ART_THREE].sort());
    const latest = await (await call(path, { method: "POST", body: { SearchText: "alpha", RemoveDuplicates: true } })).json();
    assert.deepEqual(latest.value.map((row) => row.knowledgearticleid).sort(), [ART_ONE, ART_THREE].sort());
  });

  it("FullTextSearchKnowledgeArticle refuses a missing SearchText and needs the knowledge article read privilege", async () => {
    const path = webApi("FullTextSearchKnowledgeArticle");
    assert.match((await errorOf(await call(path, { method: "POST", body: {} }), 400)).message, /SearchText is required/);
    const denied = await errorOf(await call(path, { method: "POST", body: { SearchText: "alpha" }, token: noneToken }), 403);
    assert.match(denied.message, /prvReadKnowledgeArticle/);
  });

  it("the kbarticle searches match title, keywords and body, and the subject narrows them", async () => {
    const search = (name, text, subject) =>
      call(webApi(`kbarticles/${CRM}${name}(SearchText='${text}',Subject=@s)${subject ? `?@s=${subject}` : ""}`));
    const titles = await (await search("SearchByTitleKbArticle", "beta")).json();
    assert.deepEqual(titles.value.map((row) => row.kbarticleid).sort(), [KB_ONE, KB_THREE].sort());
    assert.equal((await (await search("SearchByTitleKbArticle", "beta", SUBJECT_B)).json()).value.length, 0);
    const keywords = await (await search("SearchByKeywordsKbArticle", "beta")).json();
    assert.deepEqual(keywords.value.map((row) => row.kbarticleid), [KB_TWO]);
    const body = await (await search("SearchByBodyKbArticle", "reboot")).json();
    assert.deepEqual(body.value.map((row) => row.kbarticleid), [KB_ONE]);
    assert.match((await errorOf(await search("SearchByTitleKbArticle", ""), 400)).message, /SearchText is required/);
    const denied = await errorOf(await call(webApi(`kbarticles/${CRM}SearchByTitleKbArticle(SearchText='beta',Subject=@s)`), { token: noneToken }), 403);
    assert.match(denied.message, /prvReadKbArticle/);
  });

  it("RetrieveByTopIncidentSubjectKbArticle returns the subject's articles and needs the kbarticle read privilege", async () => {
    const found = await (await call(webApi(`subjects(${SUBJECT_A})/${CRM}RetrieveByTopIncidentSubjectKbArticle`))).json();
    assert.deepEqual(found.value.map((row) => row.kbarticleid).sort(), [KB_ONE, KB_THREE].sort());
    await errorOf(await call(webApi(`subjects(${UNKNOWN})/${CRM}RetrieveByTopIncidentSubjectKbArticle`)), 404);
    const denied = await errorOf(await call(webApi(`subjects(${SUBJECT_A})/${CRM}RetrieveByTopIncidentSubjectKbArticle`), { token: noneToken }), 403);
    assert.match(denied.message, /prvReadKbArticle/);
  });
});
