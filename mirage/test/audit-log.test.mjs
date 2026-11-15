// @test-kind contract: Paqvilo's own simulator administration, CLI, configuration and runtime behaviour
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog, auditQuery, auditText } from '../lib/audit-log.mjs';
import { redactSecrets } from '../lib/sim-messaging-routes.mjs';
import { workerAnswer } from './support/worker-answer.mjs';

test('audit correlates nested calls, records outcomes, bounds retention and paginates detached entries', () => {
  const audit = new AuditLog({ limit: 3 });
  const request = audit.begin({
    kind: 'page',
    path: '/products/?token=secret',
    identity: { id: 'alice', roles: ['Member'] },
  });
  const fetch = audit.begin({
    kind: 'liquid-fetchxml',
    path: '/products/',
    entity: 'product',
    query: '<fetch><entity name="product"/></fetch>',
    correlationId: request.correlationId,
    parentId: request.id,
  });
  fetch.finish({ rowCount: 45 });
  request.finish({ status: 200 });
  const denied = audit.begin({
    kind: 'api',
    method: 'PATCH',
    path: '/_api/products(foreign)',
    identity: { id: 'alice', roles: ['Member'] },
  });
  denied.finish({
    status: 403,
    error: { code: 'PermissionDenied', message: 'Scoped update denied' },
  });
  denied.finish({ status: 200 });
  const page = audit.list({ pageSize: 2 });
  assert.equal(page.items.length, 2);
  assert.equal(page.total, 3);
  assert.equal(page.pageCount, 2);
  assert.equal(page.items[0].outcome, 'denied');
  assert.equal(page.items[1].rowCount, 45);
  assert.equal(page.items[1].parentId, request.id);
  assert.equal(page.items[1].correlationId, request.correlationId);
  page.items[1].identity.roles.push('Injected');
  assert.deepEqual(audit.list({ kind: 'liquid-fetchxml' }).items[0].identity.roles, []);
  assert.equal(audit.list({ search: 'Scoped update' }).total, 1);
  assert.equal(audit.list({ page: 2, pageSize: 2 }).items[0].path, '/products/');
  audit
    .begin({ kind: 'api', path: '/_api/products' })
    .finish({ status: 502, error: new Error('upstream unavailable') });
  assert.equal(audit.list().retained, 3);
  assert.equal(audit.list().dropped, 1);
  assert.equal(audit.list({ outcome: 'error' }).total, 1);
  audit.clear();
  assert.equal(audit.list().total, 0);
  assert.equal(audit.list().latestSequence, 4);
});

test('audit isolates concurrent actors and freezes sequence windows without hiding retention loss', () => {
  const audit = new AuditLog({ limit: 3 });
  const add = (contactId) => audit.begin({ kind: 'api', identity: { contactId } }).finish();
  add('{ABC}');
  add('other');
  add('abc');
  const upper = audit.list().latestSequence;
  add('abc');
  const filters = { contactId: 'ABC', afterSequence: 1, throughSequence: upper };
  const page = audit.list(new URLSearchParams(filters));
  assert.deepEqual(
    page.items.map((item) => item.sequence),
    [3],
  );
  assert.equal(page.dropped, 1);
  assert.equal(page.oldestSequence, 2);
  assert.equal(page.latestSequence, 4);
  assert.deepEqual(audit.export(filters).items, page.items);
  assert.equal(audit.export().latestSequence, 4);
  for (const invalid of [-1, 1.5, '1suffix', Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => audit.list({ afterSequence: invalid }),
      (error) => error.code === 'InvalidAuditSequence' && error.status === 400,
    );
  audit.clear();
  assert.equal(audit.list().oldestSequence, null);
  assert.equal(audit.list().latestSequence, 4);
});

// @test-kind contract+security: the audit never retains headers, payloads or credential values
test('audit does not retain headers, payloads or credential query/error values', () => {
  const audit = new AuditLog();
  audit
    .begin({
      path: 'https://user:PASS@portal.test/_api/contacts?access_token=TOPSECRET',
      headers: { authorization: 'SECRET' },
      body: { password: 'SECRET' },
      query: new URLSearchParams({
        access_token: 'TOPSECRET',
        $filter: "password eq 'HIDDEN' and fullname eq 'Example'",
        fetchXml:
          '<fetch><entity name="x"><filter><condition attribute="secret" value="HIDDENXML"/></filter></entity></fetch>',
      }),
    })
    .finish({
      status: 500,
      error: {
        code: 'FAIL',
        message: 'Bearer BEARERSECRET access_token=ANOTHER secret: "THING"',
      },
    });
  const text = JSON.stringify(audit.export());
  for (const sensitive of [
    'TOPSECRET',
    'HIDDEN',
    'HIDDENXML',
    'BEARERSECRET',
    'ANOTHER',
    'THING',
    'PASS',
    'authorization',
  ])
    assert.equal(text.includes(sensitive), false, sensitive);
  assert.ok(text.includes('fullname'));
  assert.ok(text.includes('[redacted]'));
  const nested = auditText(
    '<condition attribute="client_secret" operator="in"><value>DO_NOT_STORE</value><value>ALSO_PRIVATE</value></condition>',
  );
  assert.doesNotMatch(nested, /DO_NOT_STORE|ALSO_PRIVATE/);
  assert.doesNotMatch(auditText('password="' + 'PRIVATE'.repeat(3000) + '"', 30), /PRIVATE/);
});

// @test-kind contract+security: auditText redacts credential query parameters and authentication schemes
test('auditText redacts credential query parameters and the Basic, Digest and SharedAccessSignature schemes', () => {
  assert.equal(
    auditText('https://fn.example.test/api/x?code=KEY123&sig=SIG456&name=keep'),
    'https://fn.example.test/api/x?code=[redacted]&sig=[redacted]&name=keep',
  );
  assert.equal(
    auditText('https://blob.example.test/c/b?sv=2024-01-01&se=2030&sig=abc%2Fdef'),
    'https://blob.example.test/c/b?sv=2024-01-01&se=2030&sig=[redacted]',
  );
  assert.doesNotMatch(auditText('Authorization: Basic dXNlcjpwYXNzd29yZA=='), /dXNl/);
  assert.equal(auditText('{"value":"Basic dXNlcjpwYXNzd29yZA=="}'), '{"value":"Basic [redacted]"}');
  assert.equal(
    auditText('SharedAccessSignature sr=https%3A%2F%2Fx&sig=SIGNATURE&se=1&skn=policy'),
    'SharedAccessSignature [redacted]',
  );
  assert.equal(auditText('Digest username="u", realm="r", nonce="n", response="HASH"'), 'Digest [redacted]');
  assert.equal(auditText('Basic plan for the Digest of changes'), 'Basic plan for the Digest of changes');
  assert.equal(auditText('statuscode=1&barcode=7'), 'statuscode=1&barcode=7', 'only whole parameter names');
  assert.deepEqual(auditQuery(new URLSearchParams('code=KEY&sig=S&page=2')), {
    code: '[redacted]',
    sig: '[redacted]',
    page: '2',
  });
  assert.deepEqual(auditQuery({ code: 'KEY', page: 2 }), { code: '[redacted]', page: 2 });
});

// @test-kind security: invitation credential query keys are redacted by name while other query parameters keep their values
test('auditQuery redacts the InvitationCode and invitation query values and keeps page and invitationStatus', () => {
  assert.deepEqual(
    auditQuery(new URLSearchParams('InvitationCode=INV-1&invitation=INV-2&page=2&invitationStatus=sent')),
    {
      InvitationCode: '[redacted]',
      invitation: '[redacted]',
      page: '2',
      invitationStatus: 'sent',
    },
  );
  assert.deepEqual(auditQuery({ invitationcode: 'INV-1', invitation: 'INV-2', page: 2 }), {
    invitationcode: '[redacted]',
    invitation: '[redacted]',
    page: 2,
  });
});

// @test-kind security: the string form of a query redacts invitation codes by key, as the URLSearchParams form does
test('auditQuery string form redacts InvitationCode and invitation and keeps page and invitationStatus', () => {
  const redacted = auditQuery('InvitationCode=INV-1&invitation=INV-2&page=2&invitationStatus=sent');
  assert.doesNotMatch(redacted, /INV-1|INV-2/);
  assert.match(redacted, /page=2/);
  assert.match(redacted, /invitationStatus=sent/);
});

// @test-kind security: free text redacts invitation codes in URL queries with the same key set as the query forms
test('auditText redacts invitation codes and signatures in free text and keeps page', () => {
  const redacted = auditText(
    'GET /Account/Login/RedeemInvitation?InvitationCode=INV-1&page=2 then /x?invitation=INV-2&sig=S1',
  );
  assert.doesNotMatch(redacted, /INV-1|INV-2|S1/);
  assert.match(redacted, /page=2/);
});

// @test-kind security: credentials behind HTML- or URL-encoded separators and entity-quoted JSON keys are redacted
test('auditText redacts query credentials behind encoded separators and entity-quoted JSON credentials', () => {
  assert.equal(
    auditText('https://x.example.test/api?a=1&sig=SECRET1'),
    'https://x.example.test/api?a=1&sig=[redacted]',
  );
  assert.equal(
    auditText('https://x.example.test/api?a=1%26sig=SECRET2'),
    'https://x.example.test/api?a=1%26sig=[redacted]',
  );
  assert.equal(
    auditText('https://x.example.test/api?a=1&amp;sig=SECRET3'),
    'https://x.example.test/api?a=1&amp;sig=[redacted]',
  );
  assert.equal(
    auditText('https://x.example.test/api?a=1&#38;sig=SECRET3'),
    'https://x.example.test/api?a=1&#38;sig=[redacted]',
  );
  assert.equal(
    auditText('https://x.example.test/api?sig=SECRET5&a=1'),
    'https://x.example.test/api?sig=[redacted]&a=1',
  );
  assert.equal(auditText('&quot;password&quot;:&quot;SECRET4&quot;'), '&quot;password&quot;:[redacted]');
  assert.equal(
    auditText('&#34;password&#34;:&#34;SECRET6&#34;,&#34;a&#34;:1'),
    '&#34;password&#34;:[redacted],&#34;a&#34;:1',
  );
});

test('audit filters by path, entity, status class, method and correlation, lists kinds and notifies observers', () => {
  const audit = new AuditLog();
  const observed = [];
  const unsubscribe = audit.subscribe((entry) => observed.push(entry));
  const page = audit.begin({ kind: 'page', method: 'GET', path: '/workspace/' });
  const read = audit.begin({
    kind: 'liquid-fetchxml',
    path: '/workspace/',
    entity: 'Contact',
    correlationId: page.correlationId,
    parentId: page.id,
  });
  read.finish({ rowCount: 2 });
  page.finish({ status: 200 });
  const redirect = audit.begin({ kind: 'page', method: 'GET', path: '/old-guidance/' });
  redirect.finish({ status: 301 });
  const service = audit.begin({ kind: 'native-service', method: 'POST', path: '/_services/lookup', entity: 'account' });
  service.finish({ status: 500, error: { code: 'ServiceFailed', message: 'Lookup failed' } });
  const unknown = audit.begin({ kind: 'Not A Kind', path: '/x' });
  unknown.finish({ status: 404 });
  assert.equal(audit.entries.find((entry) => entry.path === '/x').kind, 'api', 'invalid kinds fall back to api');
  assert.deepEqual(
    audit
      .list({ path: 'WORKSPACE' })
      .items.map((item) => item.kind)
      .sort(),
    ['liquid-fetchxml', 'page'],
  );
  assert.deepEqual(
    audit.list({ entity: 'contact' }).items.map((item) => item.kind),
    ['liquid-fetchxml'],
  );
  assert.deepEqual(
    audit.list({ status: '3xx' }).items.map((item) => item.path),
    ['/old-guidance/'],
  );
  assert.deepEqual(
    audit.list({ status: '500' }).items.map((item) => item.kind),
    ['native-service'],
  );
  assert.deepEqual(
    audit.list({ method: 'post' }).items.map((item) => item.kind),
    ['native-service'],
  );
  assert.equal(audit.list({ correlationId: page.correlationId }).total, 2);
  const traced = audit.begin({ kind: 'api', path: '/traced', traceId: 'invented-trace', spanId: 'invented-span' });
  traced.finish({ status: 200 });
  assert.deepEqual(
    audit.list({ traceId: 'invented-trace' }).items.map((item) => item.path),
    ['/traced'],
    'traceId keeps the entries of one trace',
  );
  assert.equal(audit.export({ traceId: 'other' }).items.length, 0);
  // The browser session fields are additive and default to null; visitorId and sessionKey filter with the prefix rule.
  assert.deepEqual([audit.entries.at(-1).visitorId, audit.entries.at(-1).sessionKey], [null, null]);
  const visited = audit.begin({
    kind: 'page',
    path: '/visited',
    visitorId: 'ad87d220-0000-4000-8000-0000000000aa',
    sessionKey: 'visitor:ad87d220-0000-4000-8000-0000000000aa',
  });
  visited.finish({ status: 200 });
  observed.pop();
  assert.deepEqual(
    audit.list({ sessionKey: 'visitor:ad87d220' }).items.map((item) => item.path),
    ['/visited'],
  );
  assert.equal(audit.list({ visitorId: 'ad87d220-0000-4000-8000-0000000000aa' }).total, 1);
  assert.equal(audit.list({ visitorId: 'ad87d22' }).total, 0, 'fewer than 8 hex characters match exactly only');
  // A comma list joins a page of activities in one call; more than 200 ids is refused.
  const second = audit.begin({ kind: 'api', path: '/second', traceId: 'invented-trace-2' });
  second.finish({ status: 200 });
  observed.pop();
  assert.deepEqual(
    audit
      .list({ traceId: 'invented-trace, invented-trace-2,unknown' })
      .items.map((item) => item.path)
      .sort(),
    ['/second', '/traced'],
  );
  assert.throws(
    () => audit.list({ traceId: Array.from({ length: 201 }, (_, index) => `t${index}`).join(',') }),
    (error) => error.status === 400 && error.code === 'InvalidAuditFilter' && error.parameter === 'traceId',
  );
  assert.equal(audit.list({ traceId: Array.from({ length: 200 }, (_, index) => `t${index}`).join(',') }).total, 0);
  observed.pop();
  assert.ok(audit.list().kinds.includes('native-service'));
  assert.ok(audit.list().kinds.includes('entity-query'), 'documented kinds remain selectable before they occur');
  const pending = audit.begin({ kind: 'api', path: '/slow' });
  assert.equal(audit.list({ status: 'pending' }).items[0].path, '/slow');
  pending.finish({ status: 200 });
  assert.deepEqual(
    observed.map((entry) => entry.path),
    ['/workspace/', '/workspace/', '/old-guidance/', '/_services/lookup', '/x', '/slow'],
  );
  observed[0].path = 'mutated';
  assert.notEqual(audit.entries[0].path, 'mutated', 'observers receive copies');
  unsubscribe();
  audit.begin({ kind: 'api', path: '/after' }).finish({ status: 200 });
  assert.equal(observed.length, 6);
  audit.subscribe(() => {
    throw new Error('observer failure');
  });
  assert.doesNotThrow(() => audit.begin({ kind: 'api', path: '/still-recorded' }).finish({ status: 200 }));
  assert.equal(audit.entries.at(-1).outcome, 'success');
});

test('audit keeps the simulator error code and a differing portal envelope code', () => {
  const audit = new AuditLog();
  const denied = audit.begin({ kind: 'api', method: 'PATCH', path: '/_api/contacts(1)' });
  denied.finish({
    status: 403,
    error: { code: 'PermissionDenied', message: 'Table permission denies update' },
    portalError: { code: '90040102', message: 'Update denied' },
    simulatorCode: 'PermissionDenied',
  });
  assert.deepEqual(audit.entries[0].error, {
    code: 'PermissionDenied',
    message: 'Table permission denies update',
    portalCode: '90040102',
  });
  const headerOnly = audit.begin({ kind: 'api', path: '/_api/items' });
  headerOnly.finish({
    status: 404,
    portalError: { code: '9004010C', message: 'Table not enabled' },
    simulatorCode: 'UnknownEntity',
  });
  assert.deepEqual(audit.entries[1].error, {
    code: 'UnknownEntity',
    message: 'Table not enabled',
    portalCode: '9004010C',
  });
  const same = audit.begin({ kind: 'api', path: '/_api/other' });
  same.finish({
    status: 400,
    error: { code: 'InvalidRequest', message: 'Bad' },
    portalError: { code: 'InvalidRequest', message: 'Bad' },
  });
  assert.equal(audit.entries[2].error.portalCode, undefined, 'identical codes are not repeated');
  const ok = audit.begin({ kind: 'api', path: '/_api/ok' });
  ok.finish({ status: 200 });
  assert.equal(audit.entries[3].error, undefined);
});

// @test-kind security: ordinary inputs keep the redacted output they had before the redaction window and the linear scan
test('auditText keeps the output of ordinary inputs unchanged', () => {
  const cases = [
    ['Authorization: Bearer ABC.def-123_x', 'Authorization: [redacted] [redacted]'],
    ['Bearer abc123 and more', 'Bearer [redacted] and more'],
    ['password=hunter2&user=bob', 'password=[redacted]&user=bob'],
    [
      'https://fn.example.test/api/x?code=KEY123&sig=SIG456&name=keep',
      'https://fn.example.test/api/x?code=[redacted]&sig=[redacted]&name=keep',
    ],
    ['GET /x?invitation=INV-2&page=2', 'GET /x?invitation=[redacted]&page=2'],
    ['/Account/Login?InvitationCode=INV-1&page=2', '/Account/Login?InvitationCode=[redacted]&page=2'],
    [
      '<fetch><entity name="x"><filter><condition attribute="secret" operator="eq" value="HIDDENXML"/></filter></entity></fetch>',
      '<fetch><entity name="x"><filter><condition attribute="secret" operator="eq" value="[redacted]"/></filter></entity></fetch>',
    ],
    [
      '<condition attribute="client_secret" operator="in"><value>DO_NOT_STORE</value><value>ALSO_PRIVATE</value></condition>',
      '<condition attribute="client_secret" operator="in"><value>[redacted]</value><value>[redacted]</value></condition>',
    ],
    [
      '<condition attribute="name" operator="eq" value="plain"/>',
      '<condition attribute="name" operator="eq" value="plain"/>',
    ],
    [
      '<condition attribute="name"><value>kept</value></condition>',
      '<condition attribute="name"><value>kept</value></condition>',
    ],
    // A value inside a secret-named condition is redacted even when the condition element is not closed.
    [
      '<condition attribute="password"><value>unclosed</value>',
      '<condition attribute="password"><value>[redacted]</value>',
    ],
    ['plain text with nothing secret', 'plain text with nothing secret'],
    ['Basic dXNlcjpwYXNzd29yZA==', 'Basic [redacted]'],
    ['Basic plan for the Digest of changes', 'Basic plan for the Digest of changes'],
    ['Digest username="u", realm="r", nonce="n", response="HASH"', 'Digest [redacted]'],
    ['SharedAccessSignature sr=x&sig=S1&se=1', 'SharedAccessSignature [redacted]'],
    ['{"token": "abc", "value": "keep"}', '{"token": [redacted], "value": "keep"}'],
    ['statuscode=1&barcode=7', 'statuscode=1&barcode=7'],
    // A value inside a secret-named condition is redacted even when the condition element is not closed.
    [
      'aabb <condition attribute="secret"><value>V1</value> unclosed',
      'aabb <condition attribute="secret"><value>[redacted]</value> unclosed',
    ],
    [
      '<condition a="1"/><condition attribute="token" value="T1"/>',
      '<condition a="1"/><condition attribute="token" value="[redacted]"/>',
    ],
    ['token=abc password=def secret: "x y" tail', 'token=[redacted] password=[redacted] secret: [redacted] tail'],
    ['client_secret=ZZ&access_token=YY&x=1', 'client_secret=[redacted]&access_token=[redacted]&x=1'],
    ['Bearer', 'Bearer'],
    ['', ''],
  ];
  for (const [input, expected] of cases) assert.equal(auditText(input), expected, input);
  assert.equal(auditText('password="' + 'x y '.repeat(10) + '"', 30), 'password=[redacted]');
  assert.equal(auditText('a'.repeat(20), 5), 'aaaaa');
  assert.equal(auditText('x'.repeat(13000)), 'x'.repeat(12000));
});

// The check runs in a worker thread: a synchronous check on this thread could not be ended by the test timeout.
const UNCLOSED_CONDITION_CHECK = `
  const { parentPort, workerData } = require('node:worker_threads');
  import(workerData.module).then(({ auditText }) => {
    // Each unit is 20 characters, so the input is exactly 2,000,000 characters long.
    const tags = '<condition>'.padEnd(20).repeat(100000);
    parentPort.postMessage({
      length: tags.length,
      // No tag closes, so the output is the first 12,000 characters: it does not depend on the rest of the input.
      matchesFirstWindow: auditText(tags) === auditText(tags.slice(0, 12000)),
      outputLength: auditText(tags).length,
    });
  });
`;

// @test-kind security: a run of unclosed condition tags costs no more than its first window (no timing involved)
test('auditText output for 100,000 unclosed condition tags equals the output for the first window', async (t) => {
  const result = await workerAnswer(UNCLOSED_CONDITION_CHECK, {
    eval: true,
    workerData: { module: new URL('../lib/audit-log.mjs', import.meta.url).href },
    signal: t.signal,
  });
  assert.deepEqual(result, { length: 2000000, matchesFirstWindow: true, outputLength: 12000 });
});

// @test-kind security: Service Bus, storage and SQL connection-string credentials are masked and their names stay readable
test('auditText masks Service Bus, storage and SQL connection-string credentials and keeps the names readable', () => {
  assert.equal(
    auditText('Endpoint=sb://ns.example.test/;SharedAccessKeyName=RootManage;SharedAccessKey=SBKEY123='),
    'Endpoint=sb://ns.example.test/;SharedAccessKeyName=RootManage;SharedAccessKey=[redacted]',
  );
  assert.equal(
    auditText('DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=STKEY456==;EndpointSuffix=core.windows.net'),
    'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=[redacted];EndpointSuffix=core.windows.net',
  );
  assert.equal(
    auditText('Server=tcp:db.example.test,1433;User ID=app;Pwd=SQLPWD789;Encrypt=true'),
    'Server=tcp:db.example.test,1433;User ID=app;Pwd=[redacted];Encrypt=true',
  );
});

// @test-kind security: subscription keys in headers and URLs and function keys are masked; the query value stops at &
test('auditText masks subscription-key headers and URL values and function keys', () => {
  assert.equal(auditText('Ocp-Apim-Subscription-Key: APIKEY1'), 'Ocp-Apim-Subscription-Key: [redacted]');
  assert.equal(
    auditText('https://api.example.test/v1/items?subscription-key=APIKEY2&page=2'),
    'https://api.example.test/v1/items?subscription-key=[redacted]&page=2',
  );
  assert.equal(auditText('x-functions-key: FNKEY3'), 'x-functions-key: [redacted]');
  assert.equal(auditQuery('subscription-key=APIKEY4&page=2'), 'subscription-key=[redacted]&page=2');
});

// @test-kind security: redactSecrets masks connection-string credentials inside string values and redacts the new key names
test('redactSecrets masks connection-string credentials in string values and redacts the new credential key names', () => {
  assert.deepEqual(
    redactSecrets({
      message: 'Endpoint=sb://ns.example.test/;SharedAccessKey=SBKEY123=',
      nested: [{ text: 'Server=db.example.test;Pwd=SQLPWD789;Encrypt=true' }],
      count: 2,
      'Ocp-Apim-Subscription-Key': 'APIKEY1',
      Pwd: 'SQLPWD2',
      SharedAccessKeyName: 'RootManage',
      AccountName: 'acct',
    }),
    {
      message: 'Endpoint=sb://ns.example.test/;SharedAccessKey=[redacted]',
      nested: [{ text: 'Server=db.example.test;Pwd=[redacted];Encrypt=true' }],
      count: 2,
      'Ocp-Apim-Subscription-Key': '[redacted]',
      Pwd: '[redacted]',
      SharedAccessKeyName: 'RootManage',
      AccountName: 'acct',
    },
  );
});

// @test-kind contract: the signed callback URL a route hands to its caller is returned intact, while free text is masked
test('redactSecrets returns a callback URL intact and masks credentials only in free-text fields', () => {
  const callback = {
    method: 'POST',
    url: 'http://127.0.0.1:8080/_sim/api/flow-triggers/flow/triggers/request/paths/invoke?api-version=1&sp=%2Frun&sv=1.0&sig=CALLBACKSIG',
    message: 'Endpoint=sb://ns.example.test/;SharedAccessKey=SBKEY123=',
  };
  assert.deepEqual(redactSecrets(callback), {
    method: 'POST',
    url: callback.url,
    message: 'Endpoint=sb://ns.example.test/;SharedAccessKey=[redacted]',
  });
});

// @test-kind security: an attribute value or a secret condition value without its closing mark is redacted to the end
test('auditText redacts a secret attribute value that has no closing quote and an unterminated secret condition value', () => {
  const cases = [
    ['a password="abc def', 'a password=[redacted]'],
    ["token='abc def", 'token=[redacted]'],
    ['<condition attribute="password"><value>secret', '<condition attribute="password"><value>[redacted]'],
    [
      '<condition attribute="password"><value>a</value><value>secret tail',
      '<condition attribute="password"><value>[redacted]</value><value>[redacted]',
    ],
    ['<condition attribute="name"><value>kept', '<condition attribute="name"><value>kept'],
    [
      '<condition attribute="password"><value>x</condition> after',
      '<condition attribute="password"><value>[redacted]</condition> after',
    ],
    ['<condition attribute="password" value="abc def', '<condition attribute="password" value="[redacted]'],
    [
      '<condition attribute="password" operator="eq" value=\'x y\'/>',
      '<condition attribute="password" operator="eq" value="[redacted]"/>',
    ],
    [
      '<condition attribute="password"><value>secret<condition attribute="name"><value>kept',
      '<condition attribute="password"><value>[redacted]<condition attribute="name"><value>kept',
    ],
  ];
  for (const [input, expected] of cases) assert.equal(auditText(input), expected, input);
});
