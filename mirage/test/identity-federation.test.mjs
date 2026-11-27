// @test-kind compatibility: W3C Exclusive XML Canonicalization 1.0 and XML Signature (enveloped, RSA-SHA256), SAML 2.0 core, bindings and Web SSO profile (saml-core/bindings/profiles-2.0-os) and the Power Pages SAML 2.0 FAQ on Microsoft Learn (signed responses or assertions, persistent NameID, no encrypted assertions); canonical forms were cross-checked against lxml's exclusive C14N
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  childElements,
  envelopedSignature,
  parseXml,
  verifyEnvelopedSignature,
  XmlProblem,
} from '../lib/identity-xml.mjs';
import {
  CLAIM_TYPES,
  createReplayCache,
  identityProviderMetadata,
  logoutRequestXml,
  readIdentityProviderMetadata,
  SAML,
  signedAssertion,
  signedRedirectQuery,
  signedResponse,
  validateSamlResponse,
  validateWsFederationResult,
  verifyRedirectQuery,
  wsFederationResult,
} from '../lib/identity-federation.mjs';

const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const IDP = pair();
const OTHER = pair();
const NOW = Date.parse('2026-03-01T10:00:00.000Z');
const ACS = 'http://127.0.0.1:9/signin-saml';
const keysOf = (keyPair) =>
  readIdentityProviderMetadata(
    identityProviderMetadata({
      protocol: 'saml2',
      entityId: 'urn:invented:idp',
      jwk: keyPair.publicKey.export({ format: 'jwk' }),
      endpoint: 'http://127.0.0.1:9/idp/saml2',
      logoutEndpoint: 'http://127.0.0.1:9/idp/saml2/logout',
    }),
  ).keys;

function response({
  key = IDP.privateKey,
  issuer = 'urn:invented:idp',
  audience = 'urn:invented:sp',
  recipient = ACS,
  inResponseTo = '_request',
  now = NOW,
  signResponse = true,
} = {}) {
  const assertion = signedAssertion({
    issuer,
    subject: 'persistent-subject',
    audience,
    claims: { [CLAIM_TYPES.email]: 'ada@example.test', [CLAIM_TYPES.givenName]: 'Ada' },
    recipient,
    inResponseTo,
    sessionIndex: '_session',
    now,
    privateKey: key,
  });
  if (!signResponse)
    return `<samlp:Response xmlns:samlp="${SAML.protocol}" xmlns:saml="${SAML.assertion}" ID="_r" Version="2.0" IssueInstant="${new Date(now).toISOString()}" Destination="${ACS}" InResponseTo="${inResponseTo}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${SAML.success}"/></samlp:Status>${assertion}</samlp:Response>`;
  return signedResponse({ issuer, destination: ACS, inResponseTo, assertion, now, privateKey: key });
}
const options = (extra = {}) => ({
  issuer: 'urn:invented:idp',
  keys: keysOf(IDP),
  audiences: ['urn:invented:sp'],
  acs: ACS,
  requestId: '_request',
  now: NOW,
  replay: createReplayCache(),
  ...extra,
});
const stripSignatures = (xml) => xml.replace(/<ds:Signature [\s\S]*?<\/ds:Signature>/g, '');
const rejects = (work, code) =>
  assert.throws(work, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });

test('the signed digest is over the exclusive canonical form: visibly used namespaces, sorted attributes, escaped text', () => {
  const vectors = [
    [
      '<a:root xmlns:a="urn:a" xmlns:b="urn:b" xmlns="urn:d"><b:x ID="v1" z="2" a:y="1" b="3">t &amp; &lt; &gt; "q"</b:x><c/></a:root>',
      'v1',
      '<b:x xmlns:a="urn:a" xmlns:b="urn:b" ID="v1" b="3" z="2" a:y="1">t &amp; &lt; &gt; "q"</b:x>',
    ],
    [
      '<root xmlns="urn:d"><inner ID="v2" xmlns=""><leaf attr="tab&#9;nl&#10;cr&#13;&quot;"/></inner></root>',
      'v2',
      '<inner ID="v2"><leaf attr="tab&#x9;nl&#xA;cr&#xD;&quot;"></leaf></inner>',
    ],
    [
      '<p:e ID="v3" xmlns:p="urn:p" xmlns:q="urn:q"><p:k>  keep  </p:k><![CDATA[a<b]]></p:e>',
      'v3',
      '<p:e xmlns:p="urn:p" ID="v3"><p:k>  keep  </p:k>a&lt;b</p:e>',
    ],
    [
      '<r ID="v4" xmlns="urn:d" xmlns:u="urn:u"><i xmlns=""><u:j/></i></r>',
      'v4',
      '<r xmlns="urn:d" ID="v4"><i xmlns=""><u:j xmlns:u="urn:u"></u:j></i></r>',
    ],
  ];
  for (const [xml, id, canonical] of vectors) {
    const digest = /<ds:DigestValue>([^<]+)</.exec(envelopedSignature(xml, id, IDP.privateKey))[1];
    assert.equal(digest, createHash('sha256').update(canonical, 'utf8').digest('base64'), canonical);
  }
});

// @test-kind security: the reader refuses entity declarations (XXE), comments (NameID truncation), processing instructions, undeclared prefixes, duplicate attributes and oversized documents before any signature check
test('the strict reader refuses markup that can change what a signature covers', () => {
  for (const xml of [
    '<!DOCTYPE r [<!ENTITY x "y">]><r>&x;</r>',
    '<r>&x;</r>',
    '<r><n>user<!-- c -->@example.test</n></r>',
    '<r><?pi data?></r>',
    '<p:r/>',
    '<r a="1" a="2"/>',
    '<r xmlns:p="urn:p" xmlns:q="urn:p" p:a="1" q:a="2"/>',
    '<r>',
    '<r/><s/>',
    `<r>${'x'.repeat(600 * 1024)}</r>`,
  ])
    assert.throws(() => parseXml(xml), XmlProblem, xml.slice(0, 40));
});

// @test-kind security: an enveloped signature covers exactly its element, by a unique ID, with the caller's keys only
test('an enveloped signature verifies only the signed element with the issuer key', () => {
  const unsigned = `<x:doc xmlns:x="urn:x" ID="_d"><x:v>1</x:v></x:doc>`;
  const signature = envelopedSignature(unsigned, '_d', IDP.privateKey);
  const signed = unsigned.replace('<x:v>', `${signature}<x:v>`);
  const root = parseXml(signed);
  verifyEnvelopedSignature(root, root, [IDP.publicKey]);
  assert.throws(() => verifyEnvelopedSignature(root, root, [OTHER.publicKey]), /not valid for the issuer/);
  const altered = parseXml(signed.replace('<x:v>1', '<x:v>2'));
  assert.throws(() => verifyEnvelopedSignature(altered, altered, [IDP.publicKey]), /altered after signing/);
  const duplicated = parseXml(`<w xmlns:x="urn:x">${signed}<x:doc ID="_d"/></w>`);
  assert.throws(
    () => verifyEnvelopedSignature(duplicated, childElements(duplicated)[0], [IDP.publicKey]),
    /not unique/,
  );
});

test('a signed SAML response for this site and request yields its persistent subject and attributes', () => {
  const result = validateSamlResponse(response(), options());
  assert.deepEqual(result, {
    subject: 'persistent-subject',
    claims: { [CLAIM_TYPES.email]: 'ada@example.test', [CLAIM_TYPES.givenName]: 'Ada' },
    sessionIndex: '_session',
  });
  // An assertion signature alone is enough (the response itself unsigned).
  assert.equal(validateSamlResponse(response({ signResponse: false }), options()).subject, 'persistent-subject');
});

// @test-kind security: every Web SSO profile check of the SAML response fails closed with its own code
test('unsigned, altered, foreign-key, wrong audience, wrong issuer, expired, replayed and mismatched responses are refused', () => {
  rejects(() => validateSamlResponse(stripSignatures(response()), options()), 'FEDERATION_SIGNATURE_INVALID');
  rejects(
    () => validateSamlResponse(response().replace('ada@example.test', 'eve@example.test'), options()),
    'FEDERATION_SIGNATURE_INVALID',
  );
  rejects(() => validateSamlResponse(response({ key: OTHER.privateKey }), options()), 'FEDERATION_SIGNATURE_INVALID');
  rejects(() => validateSamlResponse(response({ audience: 'urn:other:sp' }), options()), 'FEDERATION_AUDIENCE_INVALID');
  rejects(() => validateSamlResponse(response({ issuer: 'urn:other:idp' }), options()), 'FEDERATION_ISSUER_INVALID');
  rejects(
    () => validateSamlResponse(response({ now: NOW - 2 * 60 * 60 * 1000 }), options()),
    'FEDERATION_ASSERTION_EXPIRED',
  );
  rejects(
    () => validateSamlResponse(response({ recipient: 'http://127.0.0.1:9/elsewhere' }), options()),
    'FEDERATION_SUBJECT_INVALID',
  );
  rejects(() => validateSamlResponse(response({ inResponseTo: '_other' }), options()), 'FEDERATION_REQUEST_MISMATCH');
  rejects(() => validateSamlResponse(response(), options({ requestId: null })), 'FEDERATION_REQUEST_MISMATCH');
  const replay = createReplayCache();
  const once = response();
  assert.equal(validateSamlResponse(once, options({ replay })).subject, 'persistent-subject');
  rejects(() => validateSamlResponse(once, options({ replay })), 'FEDERATION_REPLAY');
  // Learn (SAML 2.0 FAQ): encrypted assertions and transient identifiers are not supported.
  const encrypted = response({ signResponse: false }).replace(
    /<saml:Assertion [\s\S]*<\/saml:Assertion>/,
    '<saml:EncryptedAssertion/>',
  );
  rejects(() => validateSamlResponse(encrypted, options()), 'FEDERATION_ASSERTION_INVALID');
  const persistent = stripSignatures(
    signedAssertion({
      issuer: 'urn:invented:idp',
      subject: 'transient-subject',
      audience: 'urn:invented:sp',
      claims: {},
      recipient: ACS,
      inResponseTo: '_request',
      now: NOW,
      privateKey: IDP.privateKey,
    }),
  ).replace(SAML.persistent, SAML.transient);
  const id = /ID="([^"]+)"/.exec(persistent)[1];
  const transient = persistent.replace(
    '</saml:Issuer>',
    `</saml:Issuer>${envelopedSignature(persistent, id, IDP.privateKey)}`,
  );
  rejects(
    () =>
      validateSamlResponse(
        response({ signResponse: false }).replace(/<saml:Assertion [\s\S]*<\/saml:Assertion>/, transient),
        options(),
      ),
    'FEDERATION_SUBJECT_INVALID',
  );
  // A second, unsigned assertion next to the signed one in an unsigned response (signature wrapping) is refused.
  const wrapped = response({ signResponse: false }).replace(
    '</samlp:Response>',
    `<saml:Assertion ID="_evil" Version="2.0"><saml:Issuer>urn:invented:idp</saml:Issuer></saml:Assertion></samlp:Response>`,
  );
  rejects(() => validateSamlResponse(wrapped, options()), 'FEDERATION_ASSERTION_INVALID');
});

// @test-kind unproven: Power Pages ValidateAudience defaults are not evidenced; an explicit false is the documented switch to skip the audience check
test('ValidateAudience false skips only the audience check', () => {
  const result = validateSamlResponse(response({ audience: 'urn:other:sp' }), options({ validateAudience: false }));
  assert.equal(result.subject, 'persistent-subject');
});

// @test-kind security: WS-Federation tokens need a valid signature of the metadata key, the realm audience, a current lifetime and one use
test('a WS-Federation result is validated like the SAML token it carries', () => {
  const result = (extra = {}) =>
    wsFederationResult({
      assertion: signedAssertion({
        issuer: 'urn:invented:idp',
        subject: 'ws-subject',
        audience: 'urn:invented:realm',
        claims: {},
        now: NOW,
        privateKey: IDP.privateKey,
        ...extra,
      }),
      realm: 'urn:invented:realm',
      now: NOW,
    });
  const ws = (extra = {}) => ({
    issuer: 'urn:invented:idp',
    keys: keysOf(IDP),
    audiences: ['urn:invented:realm'],
    now: NOW,
    replay: createReplayCache(),
    ...extra,
  });
  assert.equal(validateWsFederationResult(result(), ws()).subject, 'ws-subject');
  rejects(() => validateWsFederationResult(stripSignatures(result()), ws()), 'FEDERATION_SIGNATURE_INVALID');
  rejects(() => validateWsFederationResult(result({ audience: 'urn:other' }), ws()), 'FEDERATION_AUDIENCE_INVALID');
  rejects(
    () => validateWsFederationResult(result({ privateKey: OTHER.privateKey }), ws()),
    'FEDERATION_SIGNATURE_INVALID',
  );
  rejects(
    () => validateWsFederationResult(result(), ws({ now: NOW + 2 * 60 * 60 * 1000 })),
    'FEDERATION_ASSERTION_EXPIRED',
  );
  const replay = createReplayCache();
  const once = result();
  validateWsFederationResult(once, ws({ replay }));
  rejects(() => validateWsFederationResult(once, ws({ replay })), 'FEDERATION_REPLAY');
});

// @test-kind security: the HTTP-Redirect binding signature covers the encoded message, RelayState and SigAlg as sent
test('a redirect-binding signature is verified over the received query and refuses tampering', () => {
  const query = signedRedirectQuery(
    'SAMLRequest',
    logoutRequestXml({ id: '_l', issuer: 'urn:invented:sp', destination: 'd', nameId: 'n', now: NOW }),
    'relay-1',
    IDP.privateKey,
  );
  assert.equal(verifyRedirectQuery(query, 'SAMLRequest', [IDP.publicKey]).relayState, 'relay-1');
  rejects(() => verifyRedirectQuery(query, 'SAMLRequest', [OTHER.publicKey]), 'FEDERATION_SIGNATURE_INVALID');
  rejects(
    () =>
      verifyRedirectQuery(query.replace('RelayState=relay-1', 'RelayState=relay-2'), 'SAMLRequest', [IDP.publicKey]),
    'FEDERATION_SIGNATURE_INVALID',
  );
  rejects(
    () => verifyRedirectQuery(query.replace(/&Signature=[^&]*/, ''), 'SAMLRequest', [IDP.publicKey]),
    'FEDERATION_SIGNATURE_INVALID',
  );
  rejects(
    () => verifyRedirectQuery(`${query}&RelayState=x`, 'SAMLRequest', [IDP.publicKey]),
    'FEDERATION_MESSAGE_INVALID',
  );
});

// @test-kind security: namespace declarations and attributes are bounded and scopes are shared, so a small document cannot exhaust memory or time
test('namespace and attribute bombs are refused, and elements that declare nothing share their parent scope', () => {
  const prefixes = (count, from = 0) =>
    Array.from({ length: count }, (_, index) => ` xmlns:p${from + index}="urn:p${from + index}"`).join('');
  const children = (count) => '<c/>'.repeat(count);
  // The reported bomb: thousands of prefixes on the root and about 20,000 elements.
  assert.throws(() => parseXml(`<r${prefixes(6000)}>${children(19_000)}</r>`), /too many (?:namespaces|attributes)/);
  assert.throws(() => parseXml(`<r${prefixes(100)}/>`), /An element declares too many namespaces/);
  // Within the per-element limit, but over the document's.
  const nested = Array.from({ length: 5 }, (_, index) => `<e${index}${prefixes(64, index * 64)}>`).join('');
  assert.throws(() => parseXml(`${nested}${'</e4></e3></e2></e1></e0>'}`), /document declares too many namespaces/);
  // The largest accepted declarations: every element that declares nothing reuses the root's scope object.
  const root = parseXml(`<r${prefixes(64)}>${children(19_000)}</r>`);
  const items = childElements(root);
  assert.equal(items.length, 19_000);
  assert.ok(items.every((item) => item.scope === root.scope));
  assert.equal(items[0].scope.get('p63'), 'urn:p63');
  // Attributes: a bounded count per element, and duplicates found in one pass.
  const attributes = (count) => Array.from({ length: count }, (_, index) => ` a${index}=""`).join('');
  assert.equal(parseXml(`<r${attributes(128)}/>`).attrs.length, 128);
  assert.throws(() => parseXml(`<r${attributes(40_000)}/>`), /too many attributes/);
  assert.throws(() => parseXml(`<r${attributes(100)} a5="x"/>`), /Duplicate attribute a5/);
});
