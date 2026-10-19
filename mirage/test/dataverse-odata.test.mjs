import test from 'node:test';
import assert from 'node:assert/strict';
import { DataError } from '../lib/data-error.mjs';
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

test('preferenceApplied echoes only applied preferences; continue-on-error only for a batch', () => {
  const all = parsePrefer('odata.include-annotations="*", odata.maxpagesize=2, return=representation, odata.continue-on-error, odata.track-changes, respond-async');
  assert.equal(preferenceApplied(all, { paged: true }), 'odata.include-annotations="*", odata.maxpagesize=2, return=representation');
  assert.equal(preferenceApplied(all, { paged: true, batch: true }), 'odata.include-annotations="*", odata.maxpagesize=2, return=representation, odata.continue-on-error');
  assert.equal(preferenceApplied(parsePrefer('odata.track-changes, respond-async'), { batch: true }), null);
  assert.equal(preferenceApplied(parsePrefer('odata.continue-on-error')), null);
  assert.equal(preferenceApplied(parsePrefer('odata.continue-on-error'), { batch: true }), 'odata.continue-on-error');
});

test('CDS error annotations follow code and message, match each name, and survive orderAnnotations', () => {
  const error = new DataError('Record not found', 404, 'NotFound', { id: G1 });
  const annotated = dataverseError(error, { logical: 'account', id: G1, prefer: parsePrefer('odata.include-annotations="*"') });
  const keys = [
    'code',
    'message',
    '@Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus',
    '@Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode',
    '@Microsoft.PowerApps.CDS.HelpLink',
    '@Microsoft.PowerApps.CDS.TraceText',
    '@Microsoft.PowerApps.CDS.InnerError.Message',
  ];
  assert.deepEqual(Object.keys(annotated.body.error), keys);
  assert.deepEqual(Object.keys(orderAnnotations(annotated.body).error), keys);

  const names = (pattern) =>
    Object.keys(dataverseError(error, { logical: 'account', id: G1, prefer: parsePrefer(`odata.include-annotations="${pattern}"`) }).body.error)
      .filter((key) => key.startsWith('@'));
  assert.deepEqual(names('Microsoft.PowerApps.CDS.ErrorDetails*'), [
    '@Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus',
    '@Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode',
  ]);
  assert.deepEqual(names('Microsoft.PowerApps.CDS.HelpLink'), ['@Microsoft.PowerApps.CDS.HelpLink']);
  assert.deepEqual(names('Microsoft.PowerApps.CDS.InnerError.Message'), ['@Microsoft.PowerApps.CDS.InnerError.Message']);
  assert.equal(names('Microsoft.PowerApps.CDS.*').length, 5);
  assert.equal(names('*').length, 5);
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
  assert.deepEqual(notFound.body, { error: { code: '0x80040217', message: `account With Id = ${G1} Does Not Exist` } });
  assert.equal(notFound.headers['REQ_ID'], 'req-1');
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

  const annotated = dataverseError(error, { logical: 'account', id: G1, prefer: parsePrefer('odata.include-annotations="*"') });
  assert.equal(annotated.body.error['@Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus'], '0');
  assert.equal(annotated.body.error['@Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode'], '-2146233088');
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
