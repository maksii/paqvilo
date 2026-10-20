import test from 'node:test';
import assert from 'node:assert/strict';
import { DataError } from '../lib/data-error.mjs';
import { dateTimeRangeError } from '../lib/dataverse-values.mjs';
import {
  VERSIONS,
  parseDataverseRoute,
  parseKey,
  parseFunctionParameters,
  parsePrefer,
  preferenceApplied,
  annotationMatcher,
  contextUrl,
  entityUrl,
  encodeSkipToken,
  decodeSkipToken,
  fetchXmlPagingCookie,
  dataverseError,
  baseHeaders,
  JSON_CONTENT_TYPE,
  orderAnnotations,
  assertKeyText,
  preferMalformedResponse,
  skipTokenQueryValue,
} from '../lib/dataverse-odata.mjs';

const G1 = '00000000-0000-0000-0000-000000000001';
const G2 = '00000000-0000-0000-0000-000000000002';
const route = (path) => parseDataverseRoute(`/api/data/v9.2/${path}`);

test('versions and service, metadata, batch, collection and count routes', () => {
  assert.deepEqual(VERSIONS, ['v9.0', 'v9.1', 'v9.2']);
  assert.deepEqual(parseDataverseRoute('/api/data/v9.2/'), { version: 'v9.2', kind: 'service' });
  assert.deepEqual(parseDataverseRoute('/api/data/v9.2'), { version: 'v9.2', kind: 'service' });
  assert.deepEqual(route('$metadata'), { version: 'v9.2', kind: 'metadata' });
  assert.deepEqual(route('$batch'), { version: 'v9.2', kind: 'batch' });
  assert.deepEqual(route('accounts'), { version: 'v9.2', kind: 'collection', set: 'accounts' });
  assert.deepEqual(route('accounts/$count'), { version: 'v9.2', kind: 'count', set: 'accounts' });
});

test('entity keys: GUID, alternate key and percent-encoded paths', () => {
  assert.deepEqual(route(`accounts(${G1})`), { version: 'v9.2', kind: 'entity', set: 'accounts', key: G1 });
  const alt = route("accounts(accountnumber='X',name='O''Brien')");
  assert.deepEqual(alt, { version: 'v9.2', kind: 'entity', set: 'accounts', key: "accountnumber='X',name='O''Brien'" });
  assert.deepEqual(parseKey(alt.key), { alternate: { accountnumber: 'X', name: "O'Brien" } });
  assert.deepEqual(parseKey(`{${G1.toUpperCase()}}`), { id: G1 });
  assert.equal(parseKey('abc'), null);
  assert.equal(route(`accounts%28${G1}%29`).kind, 'entity');
});

test('property, value, member, ref, navigationRef and navigationCount routes', () => {
  assert.deepEqual(route(`accounts(${G1})/name`), { version: 'v9.2', kind: 'property', set: 'accounts', key: G1, segment: 'name' });
  assert.deepEqual(route(`accounts(${G1})/name/$value`), { version: 'v9.2', kind: 'value', set: 'accounts', key: G1, segment: 'name' });
  assert.deepEqual(route(`accounts(${G1})/primarycontactid/$ref`), { version: 'v9.2', kind: 'ref', set: 'accounts', key: G1, segment: 'primarycontactid' });
  assert.deepEqual(route(`accounts(${G1})/contact_customer_accounts(${G2})`), {
    version: 'v9.2', kind: 'member', set: 'accounts', key: G1, segment: 'contact_customer_accounts', segmentKey: G2,
  });
  assert.deepEqual(route(`accounts(${G1})/primarycontactid(${G2})/$ref`), {
    version: 'v9.2', kind: 'navigationRef', set: 'accounts', key: G1, segment: 'primarycontactid', targetKey: G2,
  });
  assert.deepEqual(route(`accounts(${G1})/contact_customer_accounts/$count`), {
    version: 'v9.2', kind: 'navigationCount', set: 'accounts', key: G1, segment: 'contact_customer_accounts',
  });
});

test('functions with params, without parens, and bound operations on set and collection', () => {
  assert.deepEqual(route('WhoAmI'), { version: 'v9.2', kind: 'function', name: 'WhoAmI', params: undefined });
  assert.deepEqual(route('RetrieveTotalRecordCount(EntityNames=@p1)'), {
    version: 'v9.2', kind: 'function', name: 'RetrieveTotalRecordCount', params: 'EntityNames=@p1',
  });
  assert.deepEqual(route(`accounts(${G1})/Microsoft.Dynamics.CRM.RetrievePrincipalAccess(Target=@p1)`), {
    version: 'v9.2', kind: 'boundFunction', set: 'accounts', key: G1, name: 'RetrievePrincipalAccess', params: 'Target=@p1',
  });
  assert.deepEqual(route(`accounts(${G1})/Microsoft.Dynamics.CRM.WinOpportunity`), {
    version: 'v9.2', kind: 'boundAction', set: 'accounts', key: G1, name: 'WinOpportunity', params: undefined,
  });
  assert.deepEqual(route('accounts/Microsoft.Dynamics.CRM.BulkDelete'), {
    version: 'v9.2', kind: 'boundAction', set: 'accounts', key: null, name: 'BulkDelete', params: undefined,
  });
});

test('metadata routes', () => {
  assert.deepEqual(route("EntityDefinitions(LogicalName='account')/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata"), {
    version: 'v9.2', kind: 'metadataEntity', set: 'EntityDefinitions', key: "LogicalName='account'",
    segment: 'Attributes', segmentKey: null, cast: 'PicklistAttributeMetadata',
  });
  assert.deepEqual(route(`EntityDefinitions(${G1})/Attributes(${G2})`), {
    version: 'v9.2', kind: 'metadataEntity', set: 'EntityDefinitions', key: G1, segment: 'Attributes', segmentKey: G2, cast: null,
  });
  assert.deepEqual(route('EntityDefinitions'), {
    version: 'v9.2', kind: 'metadataEntity', set: 'EntityDefinitions', key: null, segment: null, segmentKey: null, cast: null,
  });
});

test('guid literals, parameter aliases in keys and unknown shapes are rejected', () => {
  assert.equal(route(`accounts(guid'${G1}')`).kind, 'invalid');
  assert.match(route(`accounts(guid'${G1}')`).message, /OData v3 syntax/);
  assert.equal(route('accounts(accountid=@p1)').kind, 'invalid');
  assert.equal(route('accounts/name/$batch').kind, 'unknown');
});

test('other versions, non-Dataverse paths, SOAP and discovery', () => {
  assert.equal(parseDataverseRoute('/api/data/v9.3/accounts'), null);
  assert.equal(parseDataverseRoute('/api/data/v8.2/accounts'), null);
  assert.equal(parseDataverseRoute('/_api/accounts'), null);
  assert.deepEqual(parseDataverseRoute('/XRMServices/2011/Organization.svc/web'), { kind: 'soap' });
  assert.deepEqual(parseDataverseRoute('/api/discovery/v2.0/Instances'), { kind: 'discovery', key: null });
  assert.deepEqual(parseDataverseRoute('/api/discovery/v2.0/Instances(abc)'), { kind: 'discovery', key: 'abc' });
});

test('parseFunctionParameters: inline literals, enum, escapes and aliases', () => {
  assert.deepEqual(parseFunctionParameters(undefined, new URLSearchParams()), {});
  assert.deepEqual(
    parseFunctionParameters("Name='O''Brien',Count=3,Flag=true,Level=Microsoft.Dynamics.CRM.Level'Member'", new URLSearchParams()),
    { Name: "O'Brien", Count: 3, Flag: true, Level: 'Member' },
  );
  assert.deepEqual(parseFunctionParameters('Name=@p1,Missing=@p9', new URLSearchParams({ '@p1': 'Adventure' })), {
    Name: 'Adventure', Missing: null,
  });
});

test('parseFunctionParameters: JSON array aliases and odata.id objects', () => {
  const search = new URLSearchParams({ '@p2': `[{"@odata.id":"accounts(${G1})"}]` });
  assert.deepEqual(parseFunctionParameters('Targets=@p2', search), { Targets: [{ '@odata.id': `accounts(${G1})` }] });
  assert.deepEqual(parseFunctionParameters(`Target={'@odata.id':'accounts(${G1})'}`, new URLSearchParams()), {
    Target: { '@odata.id': `accounts(${G1})` },
  });
  const single = new URLSearchParams({ '@p3': `{'@odata.id':'accounts(${G1})'}` });
  assert.deepEqual(parseFunctionParameters('Target=@p3', single), { Target: { '@odata.id': `accounts(${G1})` } });
});

test('parsePrefer: separators, quoted and unquoted forms, and applied echo', () => {
  assert.equal(parsePrefer('odata.include-annotations="*"').annotations, '*');
  assert.equal(parsePrefer('odata.include-annotations=*').annotations, '*');
  assert.deepEqual(parsePrefer('odata.include-annotations="Microsoft.Dynamics.CRM.fetchxmlpagingcookie,Microsoft.Dynamics.CRM.morerecords"').annotations, [
    'Microsoft.Dynamics.CRM.fetchxmlpagingcookie',
    'Microsoft.Dynamics.CRM.morerecords',
  ]);
  const mixed = parsePrefer('odata.maxpagesize=2, return=representation; odata.continue-on-error');
  assert.equal(mixed.maxPageSize, 2);
  assert.equal(mixed.representation, true);
  assert.equal(mixed.continueOnError, true);
  const array = parsePrefer(['odata.maxpagesize=2', 'odata.track-changes']);
  assert.equal(array.maxPageSize, 2);
  assert.equal(array.trackChanges, true);
  assert.deepEqual(parsePrefer(undefined), {
    annotations: null, maxPageSize: null, representation: false, continueOnError: false, trackChanges: false, respondAsync: false, raw: '',
  });
  assert.equal(preferenceApplied(parsePrefer('odata.include-annotations="*", odata.maxpagesize=2'), { paged: true }), 'odata.include-annotations="*", odata.maxpagesize=2');
  assert.equal(preferenceApplied(parsePrefer('odata.maxpagesize=2'), { paged: false }), null);
  assert.equal(preferenceApplied(parsePrefer('odata.maxpagesize=9000'), { paged: true }), null);
});

test('annotation matcher and URL helpers', () => {
  assert.equal(annotationMatcher('Microsoft.Dynamics.CRM.*')('Microsoft.Dynamics.CRM.totalrecordcount'), true);
  assert.equal(annotationMatcher('*')('OData.Community.Display.V1.FormattedValue'), true);
  assert.equal(contextUrl('https://org.example', 'v9.2', 'accounts(name)/$entity'), 'https://org.example/api/data/v9.2/$metadata#accounts(name)/$entity');
  assert.equal(entityUrl('https://org.example', 'v9.2', 'accounts', G1), `https://org.example/api/data/v9.2/accounts(${G1})`);
});

test('skiptoken encodes the documented paging cookie exactly and round-trips', () => {
  // Research sample (webapi-contract.md, paging nextLink), percent-encoded once in the query string.
  const sample = '%3Ccookie%20pagenumber=%222%22%20pagingcookie=%22%253ccookie%2520page%253d%25221%2522%253e%253ccontactid%2520last%253d%2522%257bD5026A4D-D01C-ED11-B83E-000D3A572421%257d%2522%2520first%253d%2522%257b49B0BE2E-D01C-ED11-B83E-000D3A572421%257d%2522%2520%252f%253e%253c%252fcookie%253e%22%20istracking=%22False%22%20/%3E';
  const state = {
    pageNumber: 2,
    lastId: 'd5026a4d-d01c-ed11-b83e-000d3a572421',
    firstId: '49b0be2e-d01c-ed11-b83e-000d3a572421',
    idColumn: 'contactid',
  };
  // Annotation form of the same cookie (pagingcookie attribute percent-encoded twice, lowercase escapes).
  const annotation = '<cookie pagenumber="2" pagingcookie="%253ccookie%2520page%253d%25221%2522%253e%253ccontactid%2520last%253d%2522%257bD5026A4D-D01C-ED11-B83E-000D3A572421%257d%2522%2520first%253d%2522%257b49B0BE2E-D01C-ED11-B83E-000D3A572421%257d%2522%2520%252f%253e%253c%252fcookie%253e" istracking="False" />';
  assert.equal(encodeSkipToken(state), annotation);
  assert.equal(fetchXmlPagingCookie(state), annotation);
  assert.deepEqual(decodeSkipToken(sample), state);
  assert.deepEqual(decodeSkipToken(annotation), state);
  const counted = { ...state, pageNumber: 3, countOfRecords: 1 };
  assert.deepEqual(decodeSkipToken(encodeSkipToken(counted)), counted);
  assert.equal(decodeSkipToken('<cookie pagenumber="x"'), null);
  // The query form is the cookie as the query decodes it, escaped on < > " space and % only.
  const cookie = decodeURIComponent(annotation);
  assert.equal(skipTokenQueryValue(cookie), sample);
  assert.equal(decodeURIComponent(skipTokenQueryValue(cookie)), cookie);
  assert.deepEqual(decodeSkipToken(skipTokenQueryValue(cookie)), state);
  assert.deepEqual(decodeSkipToken(encodeURIComponent(annotation)), state);
  assert.equal(skipTokenQueryValue('a%b<c>"d e'), 'a%25b%3Cc%3E%22d%20e');
});

test('entityUrl is header-safe: keys are percent-encoded, no CR/LF, ASCII only', () => {
  const base = 'https://org.example';
  assert.equal(entityUrl(base, 'v9.2', 'widgets', "code='日本'"), `${base}/api/data/v9.2/widgets(code='%E6%97%A5%E6%9C%AC')`);
  const injected = entityUrl(base, 'v9.2', 'widgets', "code='a\r\nX-Evil: 1'");
  assert.equal(injected, `${base}/api/data/v9.2/widgets(code='a%0D%0AX-Evil:%201')`);
  assert.doesNotMatch(injected, /[\r\n]/);
  assert.match(entityUrl(base, 'v9.2', 'widgets', "code='日本 é'"), /^[\x20-\x7e]+$/);
  assert.equal(entityUrl(base, 'v9.2', 'widgets', "code='a\"<>%#?,=()'"), `${base}/api/data/v9.2/widgets(code='a%22%3C%3E%25%23%3F,=()')`);
  assert.equal(entityUrl(base, 'v9.2', 'accounts', G1), `${base}/api/data/v9.2/accounts(${G1})`);
});

test('key text with control characters is a DataError 400 0x80060888, mapped to the Web API envelope', () => {
  for (const text of ["code='a\r\nX-Evil: 1'", "code='a\tb'", "code='a\x7fb'"]) {
    assert.throws(() => parseKey(text), (error) => error instanceof DataError && error.status === 400 && error.details.innerCode === '0x80060888');
  }
  assert.throws(() => assertKeyText('x\u0000'), DataError);
  assert.equal(assertKeyText(G1), undefined);
  let thrown;
  try {
    parseKey("code='a\r\nb'");
  } catch (error) {
    thrown = error;
  }
  const mapped = dataverseError(thrown, { requestId: 'req-3' });
  assert.equal(mapped.status, 400);
  assert.deepEqual(mapped.body, { error: { code: '0x80060888', message: 'Invalid URI: the key segment contains control characters.' } });
});

test('path segments longer than 260 characters are invalid requests (400)', () => {
  assert.deepEqual(route('a'.repeat(261)), { version: 'v9.2', kind: 'invalid', status: 400, message: 'Bad Request - Invalid URL' });
  assert.equal(route('a'.repeat(260)).kind, 'collection');
  assert.equal(route(`accounts(${G1})/${'b'.repeat(261)}`).status, 400);
});

test('parsePrefer flags a backslash outside a quoted-string and unterminated quotes; preferMalformedResponse shape', () => {
  const raw = 'odata.include-annotations=\\"*\\"';
  const bad = parsePrefer(raw);
  assert.deepEqual(bad.malformed, {
    preference: 'odata.include-annotations',
    position: 26,
    detail: "the escape character '\\' is not inside a quoted-string",
    raw,
  });
  const response = preferMalformedResponse(bad.malformed);
  assert.equal(response.status, 400);
  assert.equal(response.body.ErrorCode, '0x80097303');
  assert.equal(
    response.body.Message,
    "Error identified on the 'odata.include-annotations' value inside the 'Prefer' header. Refer to the following link for more details: https://go.microsoft.com/fwlink/?linkid=2300109. See exception message for more details 'An error occurred when parsing the HTTP header 'Prefer'. The header value '" +
      raw + "' is incorrect at position '26' because the escape character '\\' is not inside a quoted-string.'.",
  );

  const unterminated = parsePrefer('odata.maxpagesize=2, odata.include-annotations="*');
  assert.deepEqual(unterminated.malformed, {
    preference: 'odata.include-annotations',
    position: 47,
    detail: 'the quoted-string is not terminated',
    raw: 'odata.maxpagesize=2, odata.include-annotations="*',
  });
  assert.match(preferMalformedResponse(unterminated.malformed).body.Message, /because the quoted-string is not terminated\.'\.$/);

  assert.equal('malformed' in parsePrefer('odata.include-annotations="*"'), false);
  assert.equal('malformed' in parsePrefer('odata.include-annotations="a\\b"'), false);
  assert.deepEqual(parsePrefer('odata.include-annotations="a\\b"').annotations, ['a\\b']);
});

test('preferenceApplied echoes only applied preferences, representation first; continue-on-error and respond-async are never echoed', () => {
  const all = parsePrefer('odata.include-annotations="*", odata.maxpagesize=2, return=representation, odata.continue-on-error, odata.track-changes, respond-async');
  assert.equal(preferenceApplied(all, { paged: true }), 'return=representation, odata.include-annotations="*", odata.maxpagesize=2');
  assert.equal(preferenceApplied(all, { paged: true, tracked: true }), 'return=representation, odata.include-annotations="*", odata.maxpagesize=2, odata.track-changes');
  assert.equal(preferenceApplied(parsePrefer('odata.track-changes, respond-async'), { paged: true }), null);
  assert.equal(preferenceApplied(parsePrefer('odata.continue-on-error'), { paged: true }), null);
  assert.equal(preferenceApplied(parsePrefer('odata.continue-on-error')), null);
  // maxpagesize=0 pages with the default size and is echoed on a paged response only.
  assert.equal(preferenceApplied(parsePrefer('odata.maxpagesize=0'), { paged: true }), 'odata.maxpagesize=0');
  assert.equal(preferenceApplied(parsePrefer('odata.maxpagesize=0'), { paged: false }), null);
});

test('the first return preference wins when duplicate values conflict', () => {
  const minimal = parsePrefer('return=minimal,return=representation');
  assert.equal(minimal.representation, false);
  assert.equal(preferenceApplied(minimal), null);
  const representation = parsePrefer('return=representation,return=minimal');
  assert.equal(representation.representation, true);
  assert.equal(preferenceApplied(representation), 'return=representation');
});

test('a validation fault adds TraceText for its operation step, and POST or GET adds the Api* details; a route or reader error has none', () => {
  const fault = new DataError('A validation error occurred.', 400, 'InvalidValue', { innerCode: '0x80044331' });
  const prefer = parsePrefer('odata.include-annotations="*"');
  const created = dataverseError(fault, { prefer, method: 'POST', requestId: 'req-8', logical: 'widget' }).body.error;
  assert.equal(created['@Microsoft.PowerApps.CDS.ErrorDetails.ApiExceptionSourceKey'], 'Plugin/Microsoft.Crm.ObjectModel.TargetAttributeValidationPlugin');
  const createStep = created['@Microsoft.PowerApps.CDS.ErrorDetails.ApiStepKey'];
  assert.match(createStep, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(dataverseError(fault, { prefer, method: 'POST' }).body.error['@Microsoft.PowerApps.CDS.ErrorDetails.ApiStepKey'], createStep);
  assert.equal(created['@Microsoft.PowerApps.CDS.ErrorDetails.ApiExceptionMessageName'], 'StringLengthTooLong');
  assert.equal(created['@Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus'], undefined);
  assert.equal(created['@Microsoft.PowerApps.CDS.TraceText'], `\r\n[Microsoft.Crm.ObjectModel: Microsoft.Crm.ObjectModel.TargetAttributeValidationPlugin]\r\n[${createStep}: TargetAttributeValidationPlugin]\r\n\r\n`);

  const patched = dataverseError(fault, { prefer, method: 'PATCH', requestId: 'req-8' }).body.error;
  assert.equal(patched['@Microsoft.PowerApps.CDS.ErrorDetails.ApiStepKey'], undefined);
  assert.match(patched['@Microsoft.PowerApps.CDS.TraceText'], /\[[0-9a-f-]{36}: TargetAttributeValidationPlugin\]/);
  assert.ok(!patched['@Microsoft.PowerApps.CDS.TraceText'].includes(createStep));

  // A reader error (0x80048d19) carries no annotations at all, even when the Prefer header asks for them.
  const reader = dataverseError(new DataError('bad payload', 400, 'InvalidLookup', { innerCode: '0x80048d19' }), { prefer, method: 'POST', requestId: 'req-8' });
  assert.deepEqual(reader.body.error, { code: '0x80048d19', message: 'bad payload' });
  // A route-level error carries no annotations and one REQ_ID line.
  const route = dataverseError(new DataError('Resource not found', 404, 'UnknownEntity', { route: true }), { prefer, requestId: 'req-8' });
  assert.deepEqual(route.body.error, { code: '0x8006088a', message: 'Resource not found' });
  assert.equal(route.headers.REQ_ID, 'req-8');
});

test('elastic bulk fault details are exposed only through the requested annotation', () => {
  const entries = [{ RequestIndex: 1, Id: '11111111-2222-4000-8000-000000000001', StatusCode: 400 }];
  const error = new DataError('One bulk target failed.', 400, 'InvalidRequest', { innerCode: '0x80060888', bulkApiErrorDetails: entries });
  const annotation = '@Microsoft.PowerApps.CDS.ErrorDetails.Plugin.BulkApiErrorDetails';
  assert.equal(dataverseError(error).body.error[annotation], undefined);
  const requested = dataverseError(error, { prefer: parsePrefer('odata.include-annotations="Microsoft.PowerApps.CDS.ErrorDetails*"') }).body.error;
  assert.deepEqual(JSON.parse(requested[annotation]), entries);
});

test('an engine error repeats the request id on REQ_ID; a route-level error carries it once', () => {
  const engine = dataverseError(new DataError('Record not found', 404, 'NotFound', { id: G1 }), { logical: 'account', id: G1, requestId: 'req-9' });
  assert.deepEqual(engine.headers.REQ_ID, ['req-9', 'req-9']);
  const route = dataverseError(new DataError('bad path', 400, 'InvalidRequest', { route: true }), { requestId: 'req-9' });
  assert.equal(route.headers.REQ_ID, 'req-9');
});

test('a keyed 405 answers the Allow list of its resource (PUT and POST), and a collection 405 keeps the default', () => {
  const keyed = (method, allow) => dataverseError(new DataError('Method not allowed', 405, 'InvalidRequest', { innerCode: '0x80060888', httpStatus: 405, allow }), { requestId: 'req-11' });
  assert.equal(keyed('PUT', 'GET,PATCH,DELETE,OPTIONS,GET,HEAD,POST').headers.Allow, 'GET,PATCH,DELETE,OPTIONS,GET,HEAD,POST');
  assert.equal(keyed('POST', 'GET,PUT,PATCH,DELETE,OPTIONS,GET,HEAD,POST').headers.Allow, 'GET,PUT,PATCH,DELETE,OPTIONS,GET,HEAD,POST');
  const collection = dataverseError(new DataError('Method not allowed', 405, 'InvalidRequest', { innerCode: '0x80060888', httpStatus: 405 }), { requestId: 'req-11' });
  assert.equal(collection.headers.Allow, 'OPTIONS,GET,HEAD,POST');
});

test('a date below 1753 or an unparsable date answers the CrmDateTime minimum message (0x80040239)', () => {
  const below = dataverseError(dateTimeRangeError('1752-12-31T00:00:00Z'), { requestId: 'req-10' });
  assert.equal(below.body.error.code, '0x80040239');
  assert.equal(below.body.error.message, 'DateTime is less than minumum value supported by CrmDateTime. Actual value: 12/31/1752 00:00:00, Minimum value supported: 01/01/1753 00:00:00');
  const unparsed = dataverseError(dateTimeRangeError('bad'), { requestId: 'req-10' });
  assert.match(unparsed.body.error.message, /Actual value: 01\/01\/0001 00:00:00, Minimum value supported: 01\/01\/1753 00:00:00$/);
});

test('CDS error annotations follow the error origin, match each name, and survive orderAnnotations', () => {
  const error = new DataError('Record not found', 404, 'NotFound', { id: G1 });
  const annotated = dataverseError(error, { logical: 'account', id: G1, method: 'GET', requestId: 'req-7', prefer: parsePrefer('odata.include-annotations="*"') });
  const api = ['ApiExceptionSourceKey', 'ApiStepKey', 'ApiDepthKey', 'ApiActivityIdKey', 'ApiPluginSolutionNameKey', 'ApiStepSolutionNameKey', 'ApiExceptionCategory', 'ApiExceptionMessageName', 'ApiExceptionHttpStatusCode']
    .map((name) => `@Microsoft.PowerApps.CDS.ErrorDetails.${name}`);
  const keys = ['code', 'message', ...api, '@Microsoft.PowerApps.CDS.HelpLink', '@Microsoft.PowerApps.CDS.InnerError.Message'];
  assert.deepEqual(Object.keys(annotated.body.error), keys);
  assert.deepEqual(Object.keys(orderAnnotations(annotated.body).error), keys);
  assert.equal(annotated.body.error['@Microsoft.PowerApps.CDS.ErrorDetails.ApiActivityIdKey'], 'req-7');
  assert.equal(annotated.body.error['@Microsoft.PowerApps.CDS.ErrorDetails.ApiExceptionMessageName'], 'ObjectDoesNotExist');
  assert.equal(annotated.body.error['@Microsoft.PowerApps.CDS.ErrorDetails.ApiExceptionHttpStatusCode'], '404');

  // PATCH is neither POST nor GET: no Api* details. No platform error carries OperationStatus or SubErrorCode.
  const patched = dataverseError(error, { logical: 'account', id: G1, method: 'PATCH', prefer: parsePrefer('odata.include-annotations="*"') });
  assert.deepEqual(Object.keys(patched.body.error), ['code', 'message', '@Microsoft.PowerApps.CDS.HelpLink', '@Microsoft.PowerApps.CDS.InnerError.Message']);

  const names = (pattern) =>
    Object.keys(dataverseError(error, { logical: 'account', id: G1, method: 'GET', requestId: 'req-7', prefer: parsePrefer(`odata.include-annotations="${pattern}"`) }).body.error)
      .filter((key) => key.startsWith('@'));
  assert.deepEqual(names('Microsoft.PowerApps.CDS.ErrorDetails*'), api);
  assert.deepEqual(names('Microsoft.PowerApps.CDS.HelpLink'), ['@Microsoft.PowerApps.CDS.HelpLink']);
  assert.deepEqual(names('Microsoft.PowerApps.CDS.InnerError.Message'), ['@Microsoft.PowerApps.CDS.InnerError.Message']);
  assert.equal(names('Microsoft.PowerApps.CDS.*').length, 11);
  assert.equal(names('*').length, 11);
  assert.deepEqual(names('Microsoft.Dynamics.CRM.*'), []);
});

test('413 maps to PayloadTooLarge (and its alias); InvalidBatch maps to 0x80048d19', () => {
  for (const code of ['PayloadTooLarge', 'RequestEntityTooLarge']) {
    const mapped = dataverseError(new DataError('too large', 413, code), { requestId: 'req-4' });
    assert.equal(mapped.status, 413);
    assert.equal(mapped.body.error.code, '0x8004418a');
  }
  assert.equal(dataverseError(new DataError('bad batch', 400, 'InvalidBatch'), { requestId: 'req-4' }).body.error.code, '0x80048d19');
});

test('duplicate entity key maps to 0x80060892 with the entity key message when key details are present', () => {
  const duplicate = new DataError('A record that has the attribute values W3 already exists.', 412, 'DuplicateRecord', {
    keyName: 'widget_code',
    columns: ['code', 'region'],
    innerCode: '0x80040237',
  });
  assert.deepEqual(dataverseError(duplicate, { requestId: 'req-5' }).body, {
    error: {
      code: '0x80060892',
      message: 'Entity Key widget_code violated. A record with the same value for code, region already exists. A duplicate record cannot be created. Select one or more unique values and try again.',
    },
  });
  const plain = dataverseError(new DataError('duplicate', 412, 'DuplicateRecord'), { requestId: 'req-5' });
  assert.deepEqual(plain.body, { error: { code: '0x80060892', message: 'duplicate' } });
});

test('dataverseError maps store codes to Dataverse status, code and message', () => {
  const options = { requestId: 'req-1', origin: 'https://org.example', tenantId: 't1', logical: 'account' };
  const notFound = dataverseError(new DataError('Record not found', 404, 'NotFound'), { ...options, id: G1 });
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.body, { error: { code: '0x80040217', message: `Entity 'account' With Id = ${G1} Does Not Exist` } });
  assert.deepEqual(notFound.headers['REQ_ID'], ['req-1', 'req-1']);
  assert.equal(notFound.headers['Content-Type'], JSON_CONTENT_TYPE);

  const denied = dataverseError(new DataError('Privilege denied', 403, 'PermissionDenied', { innerCode: '0x80040220' }), options);
  assert.deepEqual(denied, { status: 403, body: { error: { code: '0x80040220', message: 'Privilege denied' } }, headers: denied.headers });

  const unknownEntity = dataverseError(new DataError('x', 404, 'UnknownEntity', { segment: 'widgets' }), options);
  assert.deepEqual(unknownEntity.body, { error: { code: '0x8006088a', message: "Resource not found for the segment 'widgets'." } });

  const precondition = dataverseError(new DataError('stale', 412, 'PreconditionFailed'), options);
  assert.equal(precondition.status, 412);
  assert.equal(precondition.body.error.code, '0x80060882');

  const unexpected = dataverseError(new Error('boom'), options);
  assert.deepEqual(unexpected, {
    status: 500,
    body: { error: { code: '0x80040216', message: 'An unexpected error occurred.' } },
    headers: unexpected.headers,
  });
  assert.equal(unexpected.headers['OData-Version'], '4.0');
  assert.deepEqual(baseHeaders('req-2')['REQ_ID'], 'req-2');
});

test('baseHeaders carries no x-ms-ratelimit headers, and a limiter message passes through dataverseError unchanged', () => {
  assert.equal(Object.keys(baseHeaders('req-6')).some((name) => name.startsWith('x-ms-ratelimit')), false);
  const limited = 'Number of requests exceeded the limit of 100 over time window of 300 seconds.';
  const mapped = dataverseError(new DataError(limited, 429, 'ServiceProtection', { innerCode: '0x80072322' }), { requestId: 'req-6' });
  assert.equal(mapped.status, 429);
  assert.equal(mapped.body.error.message, limited);
  // unverified: an unauthenticated 401 is answered without the x-ms-ratelimit headers.
  const unauthenticated = dataverseError(new DataError('', 401, 'Unauthorized'), { requestId: 'req-6' });
  assert.equal(Object.keys(unauthenticated.headers).some((name) => name.startsWith('x-ms-ratelimit')), false);
});

test('dataverseError: 401 has no body and a WWW-Authenticate challenge; 429 adds Retry-After', () => {
  const options = { requestId: 'req-1', origin: 'https://org.example', tenantId: 't1' };
  const unauthorized = dataverseError(new DataError('Missing token', 401, 'Unauthorized'), options);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body, null);
  assert.equal(unauthorized.headers['WWW-Authenticate'], 'Bearer authorization_uri="https://org.example/t1/oauth2/authorize", resource_id="https://org.example/"');
  assert.equal(unauthorized.headers['Content-Type'], undefined);

  const invalid = dataverseError(new DataError('Expired', 401, 'Unauthorized', { reason: 'invalid_token' }), options);
  assert.match(invalid.headers['WWW-Authenticate'], /^Bearer error="invalid_token", error_description="Error during token validation!", authorization_uri=/);

  const throttled = dataverseError(new DataError('slow down', 429, 'ServiceProtection'), options);
  assert.equal(throttled.status, 429);
  assert.equal(throttled.body.error.code, '0x80072322');
  assert.equal(throttled.headers['Retry-After'], '300');
});

test('dataverseError adds the CDS annotations only when the Prefer header asks for them', () => {
  const error = new DataError('Record not found', 404, 'NotFound', { id: G1 });
  const plain = dataverseError(error, { logical: 'account', id: G1 });
  assert.equal(Object.keys(plain.body.error).length, 2);

  const annotated = dataverseError(error, { logical: 'account', id: G1, method: 'GET', prefer: parsePrefer('odata.include-annotations="*"') });
  assert.equal(annotated.body.error['@Microsoft.PowerApps.CDS.ErrorDetails.ApiExceptionMessageName'], 'ObjectDoesNotExist');
  assert.equal(annotated.body.error['@Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus'], undefined);
  assert.equal(annotated.body.error['@Microsoft.PowerApps.CDS.HelpLink'], 'http://go.microsoft.com/fwlink/?LinkID=398563&error=Microsoft.Crm.CrmException%3a80040217&client=platform');
  assert.equal(annotated.body.error['@Microsoft.PowerApps.CDS.InnerError.Message'], annotated.body.error.message);
});

test('orderAnnotations: annotations precede their values, context first, nextLink last, recursive', () => {
  const ordered = orderAnnotations({
    value: [{ 'name@x': 1, name: 'a' }],
    'b@odata.type': 'T',
    b: 2,
    '@odata.nextLink': 'next',
    '@odata.count': 5,
    '@Microsoft.Dynamics.CRM.totalrecordcount': 3,
    '@odata.context': 'ctx',
    '@odata.etag': 'W/"1"',
  });
  assert.deepEqual(Object.keys(ordered), [
    '@odata.context',
    '@odata.count',
    '@odata.etag',
    '@Microsoft.Dynamics.CRM.totalrecordcount',
    'value',
    'b@odata.type',
    'b',
    '@odata.nextLink',
  ]);
  assert.deepEqual(Object.keys(ordered.value[0]), ['name@x', 'name']);
});

test('one-segment operation candidates: bare name, name(...) and name()', () => {
  const bare = route('new_widgets');
  assert.deepEqual(bare, { version: 'v9.2', kind: 'collection', set: 'new_widgets' });
  assert.deepEqual(bare.candidate, { name: 'new_widgets', params: '' });
  const keyed = route('new_widgets(a=1)');
  assert.deepEqual(keyed, { version: 'v9.2', kind: 'entity', set: 'new_widgets', key: 'a=1' });
  assert.deepEqual(keyed.candidate, { name: 'new_widgets', params: 'a=1' });
  const empty = route('sample_Api()');
  assert.deepEqual(empty, { version: 'v9.2', kind: 'function', name: 'sample_Api', params: '' });
  assert.deepEqual(empty.candidate, { name: 'sample_Api', params: '' });
  // Capitalised names keep the existing function route, unchanged by the candidate rule.
  assert.deepEqual(route('WhoAmI()'), { version: 'v9.2', kind: 'function', name: 'WhoAmI', params: '' });
  assert.equal(route('1bad()').kind, 'unknown');
  assert.equal(route('new_widgets()/name').kind, 'unknown');
});

test('bound operations accept a publisher prefix in the CRM namespace', () => {
  assert.deepEqual(route(`accounts(${G1})/Microsoft.Dynamics.CRM.new_Calculate(Amount=2)`), {
    version: 'v9.2', kind: 'boundFunction', set: 'accounts', key: G1, name: 'new_Calculate', params: 'Amount=2',
  });
  assert.deepEqual(route('accounts/Microsoft.Dynamics.CRM.sample_Api'), {
    version: 'v9.2', kind: 'boundAction', set: 'accounts', key: null, name: 'sample_Api', params: undefined,
  });
});

test('relationship metadata by collection cast and by key cast', () => {
  assert.deepEqual(route('RelationshipDefinitions/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata'), {
    version: 'v9.2', kind: 'metadataEntity', set: 'RelationshipDefinitions', key: null, segment: null, segmentKey: null, cast: 'OneToManyRelationshipMetadata',
  });
  assert.deepEqual(route(`RelationshipDefinitions(${G1})/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata`), {
    version: 'v9.2', kind: 'metadataEntity', set: 'RelationshipDefinitions', key: G1, segment: null, segmentKey: null, cast: 'ManyToManyRelationshipMetadata',
  });
  assert.equal(route('RelationshipDefinitions/Microsoft.Dynamics.CRM.AttributeMetadata').kind, 'unknown');
});

test('OptionSet and GlobalOptionSet sub-paths on an entity attribute', () => {
  const base = {
    version: 'v9.2', kind: 'metadataEntity', set: 'EntityDefinitions', key: G1, segment: 'Attributes', segmentKey: G2, cast: 'PicklistAttributeMetadata',
  };
  assert.deepEqual(route(`EntityDefinitions(${G1})/Attributes(${G2})/Microsoft.Dynamics.CRM.PicklistAttributeMetadata/OptionSet`), { ...base, subSegment: 'OptionSet' });
  assert.deepEqual(route(`EntityDefinitions(${G1})/Attributes(${G2})/Microsoft.Dynamics.CRM.PicklistAttributeMetadata/GlobalOptionSet`), {
    ...base, subSegment: 'GlobalOptionSet',
  });
  assert.equal(route(`EntityDefinitions(${G1})/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata/OptionSet`).kind, 'unknown');
  assert.equal(route(`EntityDefinitions(${G1})/Keys(${G2})/OptionSet`).kind, 'unknown');
});

test('entity keys route without a method (parser is method-agnostic)', () => {
  assert.deepEqual(route(`EntityDefinitions(${G1})/Keys(${G2})`), {
    version: 'v9.2', kind: 'metadataEntity', set: 'EntityDefinitions', key: G1, segment: 'Keys', segmentKey: G2, cast: null,
  });
});

test('every gap-review and Wave 1 inner code maps to its status, matched case-insensitively', () => {
  const cases = [
    ['0x80040333', 412], ['0x8004f502', 403], ['0x8004f507', 403], ['0x8004f504', 403], ['0x80048d37', 403],
    ['0x80072321', 429], ['0x80072326', 429],
    ['0x80044a02', 400], ['0x80072553', 400], ['0x80090487', 400], ['0x80090017', 400], ['0x80048d1a', 400],
    ['0x8004032d', 400], ['0x80048408', 400], ['0x8004f00e', 400], ['0x80044352', 400], ['0x80044366', 400],
    ['0x80060304', 400], ['0x8006089b', 400], ['0x80047013', 400], ['0x80048340', 400], ['0x80048331', 400],
    ['0x80048d36', 400], ['0x80041128', 400], ['0x8004430d', 400], ['0x80041102', 400], ['0x80041130', 400],
    ['0x8004e023', 400], ['0x80040239', 400], ['0x80041120', 400], ['0x80072491', 400], ['0x80048d19', 400],
  ];
  for (const [inner, status] of cases) {
    const result = dataverseError(new DataError('x', status, 'InvalidRequest', { innerCode: inner }), {});
    assert.equal(result.status, status, inner);
    assert.equal(result.body.error.code, inner.toLowerCase(), inner);
    const upper = dataverseError(new DataError('x', status, 'InvalidRequest', { innerCode: inner.toUpperCase().replace('0X', '0x') }), {});
    assert.equal(upper.status, status, inner);
    assert.equal(upper.body.error.code, inner.toLowerCase(), inner);
  }
});

test('Global Discovery and records non-hex codes render with the status the throw site passes', () => {
  const invalidKey = dataverseError(new DataError("Invalid key predicate 'x'.", 400, 'InvalidKey'), {});
  assert.equal(invalidKey.status, 400);
  assert.equal(invalidKey.body.error.code, '0x80040203');
  assert.equal(dataverseError(new DataError('Invalid $filter expression', 400, 'InvalidQuery'), {}).status, 400);
  assert.equal(dataverseError(new DataError("Resource not found for the segment 'x'.", 404, 'UnknownResource', { segment: 'x' }), {}).status, 404);
  assert.equal(dataverseError(new DataError('No HTTP resource', 404, 'UnknownResource', { innerCode: '' }), {}).status, 404);
});

test('every 429 gets Retry-After from its details, including the concurrency and execution-time limits', () => {
  const concurrent = dataverseError(new DataError('concurrent', 429, 'ServiceProtection', { innerCode: '0x80072326', retryAfter: 1 }), {});
  assert.equal(concurrent.status, 429);
  assert.equal(concurrent.body.error.code, '0x80072326');
  assert.equal(concurrent.headers['Retry-After'], '1');
  const execution = dataverseError(new DataError('execution', 429, 'ServiceProtection', { innerCode: '0x80072321', retryAfter: 42 }), {});
  assert.equal(execution.status, 429);
  assert.equal(execution.headers['Retry-After'], '42');
  assert.equal(dataverseError(new DataError('execution', 429, 'ServiceProtection', { innerCode: '0x80072321' }), {}).headers['Retry-After'], '300');
});

test('dataverseError keeps the message of a 500 that names its Dataverse code, and sends nosniff only from the engine', () => {
  // A 500 with innerCode 0x0 is a deliberate Dataverse error; an internal exception still gets the generic message.
  const named = dataverseError(new DataError('Guid should contain 32 digits with 4 dashes.', 500, 'InvalidRequest', { innerCode: '0x0' }), {});
  assert.deepEqual(named.body, { error: { code: '0x0', message: 'Guid should contain 32 digits with 4 dashes.' } });
  assert.equal(named.headers['x-content-type-options'], 'nosniff');
  // The payload reader (0x80048d19) and route-resolution errors carry no nosniff; engine errors do.
  const payload = dataverseError(new DataError('bad payload', 400, 'InvalidLookup', { innerCode: '0x80048d19' }), {});
  assert.equal(payload.headers['x-content-type-options'], undefined);
  const routed = dataverseError(new DataError('segment', 404, 'UnknownEntity', { segment: 'widgets', route: true }), {});
  assert.equal(routed.headers['x-content-type-options'], undefined);
  assert.equal(routed.headers['Content-Type'], JSON_CONTENT_TYPE);
  // An error can name its own Content-Type (the file download route answers plain application/json).
  const plain = dataverseError(new DataError('missing', 404, 'NotFound', { innerCode: '0x80040217', contentType: 'application/json' }), {});
  assert.equal(plain.headers['Content-Type'], 'application/json');
});

test('baseHeaders carries Expires, Allow and Public on every Dataverse response', () => {
  const headers = baseHeaders('req-7');
  assert.equal(headers.expires, '-1');
  assert.equal(headers.Allow, 'OPTIONS,GET,HEAD,POST');
  assert.equal(headers.Public, 'OPTIONS,GET,HEAD,POST');
});
