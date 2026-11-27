import { createPublicKey, randomBytes, sign, verify, X509Certificate } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  attribute,
  child,
  childElements,
  descendants,
  envelopedSignature,
  NS as XML_NS,
  parseXml,
  signatureOf,
  textOf,
  verifyEnvelopedSignature,
  xmlEscape as escape,
  XmlProblem,
} from './identity-xml.mjs';

/**
 * SAML 2.0 and WS-Federation messages of the local identity flows: the identity provider's metadata, signed
 * responses and logout responses, the portal's authentication and logout requests, and the portal's validation of
 * what comes back. The bindings are SAML 2.0 HTTP-Redirect (deflated, with a query-string signature for logout) and
 * HTTP-POST, and the WS-Federation passive requestor profile with a SAML 2.0 token in its
 * RequestSecurityTokenResponse.
 *
 * Validation (validateSamlResponse, validateWsFederationResult) follows the SAML 2.0 Web Browser SSO profile
 * (saml-profiles-2.0-os 4.1.4.3) and what Learn states about Power Pages: the response or its assertion carries a
 * valid signature of the issuer's metadata keys, encrypted assertions are refused, and the name identifier is
 * persistent (SAML 2.0 FAQ). A problem is a FederationProblem with a code.
 */

export const SAML = Object.freeze({
  protocol: 'urn:oasis:names:tc:SAML:2.0:protocol',
  assertion: 'urn:oasis:names:tc:SAML:2.0:assertion',
  metadata: 'urn:oasis:names:tc:SAML:2.0:metadata',
  redirect: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
  post: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  bearer: 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
  success: 'urn:oasis:names:tc:SAML:2.0:status:Success',
  requester: 'urn:oasis:names:tc:SAML:2.0:status:Requester',
  responder: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
  noPassive: 'urn:oasis:names:tc:SAML:2.0:status:NoPassive',
  passwordProtectedTransport: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
});
const WSFED = Object.freeze({
  trust: 'http://schemas.xmlsoap.org/ws/2005/02/trust',
  trust13: 'http://docs.oasis-open.org/ws-sx/ws-trust/200512',
  federation: 'http://docs.oasis-open.org/wsfed/federation/200706',
  addressing: 'http://www.w3.org/2005/08/addressing',
  policy: 'http://schemas.xmlsoap.org/ws/2004/09/policy',
  utility: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  saml2TokenType: 'urn:oasis:names:tc:SAML:2.0:assertion',
});
/** The claim types (System.Security.Claims.ClaimTypes) the local providers issue and the portal maps by default. */
export const CLAIM_TYPES = Object.freeze({
  nameIdentifier: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier',
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  givenName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
  surname: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
  name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  upn: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
  mobilePhone: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/mobilephone',
});
const SIGNATURE_ALGORITHM = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
/** The clock skew tolerated on assertion lifetimes (the .NET token handlers' default of five minutes). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const ASSERTION_LIFETIME_MS = 60 * 60 * 1000;
const CONFIRMATION_LIFETIME_MS = 5 * 60 * 1000;
const MAX_ENCODED = 96 * 1024;
const MAX_ATTRIBUTES = 30;

export class FederationProblem extends Error {
  constructor(message, code = 'FEDERATION_MESSAGE_INVALID') {
    super(message);
    this.code = code;
  }
}
const fault = (message, code) => new FederationProblem(message, code);

export const messageId = () => `_${randomBytes(16).toString('hex')}`;
const instant = (ms) => new Date(ms).toISOString();
function timeOf(value, name) {
  if (value == null) return null;
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw fault(`${name} is not a UTC date and time.`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw fault(`${name} is not a date and time.`);
  return ms;
}

/** Reads a document, turning reader refusals into FederationProblems. */
function read(xml) {
  try {
    return parseXml(xml);
  } catch (error) {
    if (error instanceof XmlProblem) throw fault(`The message is not acceptable XML: ${error.message}`);
    throw error;
  }
}
function guarded(work, code = 'FEDERATION_MESSAGE_INVALID') {
  try {
    return work();
  } catch (error) {
    if (error instanceof XmlProblem) throw fault(error.message, code);
    throw error;
  }
}
const verified = (root, node, keys) =>
  guarded(() => verifyEnvelopedSignature(root, node, keys), 'FEDERATION_SIGNATURE_INVALID');

// ---- bindings ----
/** The HTTP-Redirect binding's encoding of a message: DEFLATE, then base64. */
export const deflateMessage = (xml) => deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64');
export function inflateMessage(value) {
  const compact = String(value ?? '');
  if (!compact || compact.length > MAX_ENCODED || !/^[A-Za-z\d+/]+={0,2}$/.test(compact))
    throw fault('The redirect message is missing or not base64.');
  try {
    return inflateRawSync(Buffer.from(compact, 'base64'), { maxOutputLength: 256 * 1024 }).toString('utf8');
  } catch {
    throw fault('The redirect message is not DEFLATE-encoded.');
  }
}
/** The HTTP-POST binding's encoding: base64 of the message. */
export const postMessage = (xml) => Buffer.from(xml, 'utf8').toString('base64');
export function readPostMessage(value) {
  const compact = String(value ?? '').replace(/\s+/g, '');
  if (!compact || compact.length > MAX_ENCODED * 4 || !/^[A-Za-z\d+/]+={0,2}$/.test(compact))
    throw fault('The posted message is missing or not base64.');
  return Buffer.from(compact, 'base64').toString('utf8');
}

/**
 * A query string with the HTTP-Redirect binding's signature (saml-bindings-2.0-os 3.4.4.1): the signed octets are
 * `<SAMLRequest|SAMLResponse>=<v>[&RelayState=<v>]&SigAlg=<v>` as they appear in the query.
 */
export function signedRedirectQuery(kind, message, relayState, privateKey) {
  const parts = [`${kind}=${encodeURIComponent(deflateMessage(message))}`];
  if (relayState) parts.push(`RelayState=${encodeURIComponent(relayState)}`);
  parts.push(`SigAlg=${encodeURIComponent(SIGNATURE_ALGORITHM)}`);
  const signature = sign('sha256', Buffer.from(parts.join('&'), 'utf8'), privateKey).toString('base64');
  return `${parts.join('&')}&Signature=${encodeURIComponent(signature)}`;
}
/** Verifies an HTTP-Redirect query signature with `publicKeys`; returns { message, relayState }. */
export function verifyRedirectQuery(rawQuery, kind, publicKeys) {
  const raw = new Map();
  for (const part of String(rawQuery ?? '').split('&')) {
    const index = part.indexOf('=');
    const name = index < 0 ? part : part.slice(0, index);
    if (!['SAMLRequest', 'SAMLResponse', 'RelayState', 'SigAlg', 'Signature'].includes(name)) continue;
    if (raw.has(name)) throw fault(`The redirect repeats ${name}.`);
    raw.set(name, index < 0 ? '' : part.slice(index + 1));
  }
  const decode = (name) => {
    try {
      return decodeURIComponent((raw.get(name) ?? '').replaceAll('+', ' '));
    } catch {
      throw fault(`The redirect's ${name} is not URL-encoded.`);
    }
  };
  if (!raw.has(kind)) throw fault(`The redirect has no ${kind}.`);
  if (!raw.has('Signature') || decode('SigAlg') !== SIGNATURE_ALGORITHM)
    throw fault('The redirect is not signed with RSA-SHA256.', 'FEDERATION_SIGNATURE_INVALID');
  const octets = [`${kind}=${raw.get(kind)}`];
  if (raw.has('RelayState')) octets.push(`RelayState=${raw.get('RelayState')}`);
  octets.push(`SigAlg=${raw.get('SigAlg')}`);
  const signature = Buffer.from(decode('Signature'), 'base64');
  const bytes = Buffer.from(octets.join('&'), 'utf8');
  const valid = publicKeys.some((key) => {
    try {
      return verify('sha256', bytes, key, signature);
    } catch {
      return false;
    }
  });
  if (!valid)
    throw fault("The redirect's signature is not valid for the sender's keys.", 'FEDERATION_SIGNATURE_INVALID');
  return { message: inflateMessage(decode(kind)), relayState: raw.has('RelayState') ? decode('RelayState') : null };
}

// ---- metadata ----
const keyInfoXml = (jwk) => {
  const b64 = (value) => Buffer.from(value, 'base64url').toString('base64');
  return `<ds:KeyInfo xmlns:ds="${XML_NS.ds}"><ds:KeyValue><ds:RSAKeyValue><ds:Modulus>${b64(jwk.n)}</ds:Modulus><ds:Exponent>${b64(jwk.e)}</ds:Exponent></ds:RSAKeyValue></ds:KeyValue></ds:KeyInfo>`;
};

/** The identity provider's metadata: an IDPSSODescriptor (saml2) or a security token service RoleDescriptor (wsfederation). */
export function identityProviderMetadata({ protocol, entityId, jwk, endpoint, logoutEndpoint }) {
  const key = `<md:KeyDescriptor use="signing">${keyInfoXml(jwk)}</md:KeyDescriptor>`;
  const role =
    protocol === 'saml2'
      ? `<md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="${SAML.protocol}">${key}` +
        `<md:SingleLogoutService Binding="${SAML.redirect}" Location="${escape(logoutEndpoint)}"/>` +
        `<md:NameIDFormat>${SAML.persistent}</md:NameIDFormat>` +
        `<md:SingleSignOnService Binding="${SAML.redirect}" Location="${escape(endpoint)}"/>` +
        `<md:SingleSignOnService Binding="${SAML.post}" Location="${escape(endpoint)}"/></md:IDPSSODescriptor>`
      : `<md:RoleDescriptor xmlns:xsi="${WSFED.xsi}" xmlns:fed="${WSFED.federation}" xsi:type="fed:SecurityTokenServiceType" protocolSupportEnumeration="${WSFED.federation}">${key}` +
        `<fed:PassiveRequestorEndpoint><wsa:EndpointReference xmlns:wsa="${WSFED.addressing}"><wsa:Address>${escape(endpoint)}</wsa:Address></wsa:EndpointReference></fed:PassiveRequestorEndpoint></md:RoleDescriptor>`;
  return `<?xml version="1.0" encoding="utf-8"?><md:EntityDescriptor xmlns:md="${SAML.metadata}" ID="${messageId()}" entityID="${escape(entityId)}">${role}</md:EntityDescriptor>`;
}

function publicKeyOf(keyInfo) {
  const rsa = child(child(keyInfo, XML_NS.ds, 'KeyValue'), XML_NS.ds, 'RSAKeyValue');
  if (rsa) {
    const url = (name) => Buffer.from(textOf(child(rsa, XML_NS.ds, name)) ?? '', 'base64').toString('base64url');
    return createPublicKey({ key: { kty: 'RSA', n: url('Modulus'), e: url('Exponent') }, format: 'jwk' });
  }
  const certificate = child(child(keyInfo, XML_NS.ds, 'X509Data'), XML_NS.ds, 'X509Certificate');
  if (certificate) return new X509Certificate(Buffer.from(textOf(certificate).replace(/\s+/g, ''), 'base64')).publicKey;
  return null;
}

/** The entity ID, signing keys and endpoints of an identity provider's metadata. */
export function readIdentityProviderMetadata(xml) {
  return guarded(() => metadataOf(read(xml)));
}
function metadataOf(root) {
  if (root.ns !== SAML.metadata || root.local !== 'EntityDescriptor')
    throw fault('The metadata is not an EntityDescriptor.');
  const roles = [
    ...childElements(root, SAML.metadata, 'IDPSSODescriptor'),
    ...childElements(root, SAML.metadata, 'RoleDescriptor'),
  ];
  const keys = [];
  const endpoint = (role, name, binding) =>
    attribute(
      childElements(role, SAML.metadata, name).find((item) => attribute(item, 'Binding') === binding),
      'Location',
    );
  let sso = null;
  let slo = null;
  let passive = null;
  for (const role of roles) {
    for (const descriptor of childElements(role, SAML.metadata, 'KeyDescriptor')) {
      if (!['signing', null].includes(attribute(descriptor, 'use'))) continue;
      const key = publicKeyOf(child(descriptor, XML_NS.ds, 'KeyInfo'));
      if (key) keys.push(key);
    }
    sso ??= endpoint(role, 'SingleSignOnService', SAML.redirect);
    slo ??= endpoint(role, 'SingleLogoutService', SAML.redirect);
    const address = child(
      child(child(role, WSFED.federation, 'PassiveRequestorEndpoint'), WSFED.addressing, 'EndpointReference'),
      WSFED.addressing,
      'Address',
    );
    passive ??= address ? textOf(address).trim() : null;
  }
  return { entityId: attribute(root, 'entityID'), keys, sso, slo, passive };
}

// ---- requests (the portal) ----
const PROTOCOL_NAMESPACES = `xmlns:samlp="${SAML.protocol}" xmlns:saml="${SAML.assertion}"`;

/** An unsigned AuthnRequest for the HTTP-Redirect binding, asking for PasswordProtectedTransport and a persistent ID. */
export function authnRequestXml({ id, issuer, destination, acs, now }) {
  return (
    `<samlp:AuthnRequest ${PROTOCOL_NAMESPACES} ID="${id}" Version="2.0" IssueInstant="${instant(now)}" Destination="${escape(destination)}" AssertionConsumerServiceURL="${escape(acs)}" ProtocolBinding="${SAML.post}">` +
    `<saml:Issuer>${escape(issuer)}</saml:Issuer><samlp:NameIDPolicy Format="${SAML.persistent}" AllowCreate="true"/>` +
    `<samlp:RequestedAuthnContext Comparison="exact"><saml:AuthnContextClassRef>${SAML.passwordProtectedTransport}</saml:AuthnContextClassRef></samlp:RequestedAuthnContext></samlp:AuthnRequest>`
  );
}
/** A LogoutRequest for the signed HTTP-Redirect binding. */
export function logoutRequestXml({ id, issuer, destination, nameId, sessionIndex, now }) {
  return (
    `<samlp:LogoutRequest ${PROTOCOL_NAMESPACES} ID="${id}" Version="2.0" IssueInstant="${instant(now)}" Destination="${escape(destination)}">` +
    `<saml:Issuer>${escape(issuer)}</saml:Issuer><saml:NameID Format="${SAML.persistent}">${escape(nameId)}</saml:NameID>` +
    (sessionIndex ? `<samlp:SessionIndex>${escape(sessionIndex)}</samlp:SessionIndex>` : '') +
    `</samlp:LogoutRequest>`
  );
}

function protocolMessage(xml, local) {
  const root = read(xml);
  if (root.ns !== SAML.protocol || root.local !== local) throw fault(`The message is not a ${local}.`);
  if (attribute(root, 'Version') !== '2.0') throw fault(`The ${local} is not SAML 2.0.`);
  const id = attribute(root, 'ID');
  if (!id) throw fault(`The ${local} has no ID.`);
  const issuer = child(root, SAML.assertion, 'Issuer');
  return { root, id, issuer: issuer ? textOf(issuer).trim() : null, destination: attribute(root, 'Destination') };
}

/** The fields of an AuthnRequest the identity provider checks. */
export function readAuthnRequest(xml) {
  const message = guarded(() => protocolMessage(xml, 'AuthnRequest'));
  const policy = child(message.root, SAML.protocol, 'NameIDPolicy');
  return {
    ...message,
    acs: attribute(message.root, 'AssertionConsumerServiceURL'),
    binding: attribute(message.root, 'ProtocolBinding'),
    forceAuthn: attribute(message.root, 'ForceAuthn') === 'true',
    passive: attribute(message.root, 'IsPassive') === 'true',
    nameIdFormat: policy ? attribute(policy, 'Format') : null,
  };
}
export function readLogoutRequest(xml) {
  const message = guarded(() => protocolMessage(xml, 'LogoutRequest'));
  const nameId = child(message.root, SAML.assertion, 'NameID');
  return { ...message, nameId: nameId ? textOf(nameId).trim() : null };
}

// ---- responses (the identity provider) ----
const optionalAttribute = (name, value) => (value ? ' ' + name + '="' + escape(value) + '"' : '');
function attributeStatement(claims) {
  const items = Object.entries(claims)
    .filter(([, value]) => typeof value === 'string' && value)
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${escape(name)}"><saml:AttributeValue>${escape(value)}</saml:AttributeValue></saml:Attribute>`,
    );
  return items.length ? `<saml:AttributeStatement>${items.join('')}</saml:AttributeStatement>` : '';
}

/**
 * A signed SAML 2.0 assertion: `issuer` (the entity ID), `subject` (persistent NameID), `audience`, `claims`
 * (attribute name: text), and for the Web SSO profile `recipient`, `inResponseTo` and `sessionIndex`.
 */
export function signedAssertion({
  issuer,
  subject,
  audience,
  claims,
  recipient,
  inResponseTo,
  sessionIndex,
  now,
  privateKey,
}) {
  const id = messageId();
  const data = [
    ...(inResponseTo ? [`InResponseTo="${escape(inResponseTo)}"`] : []),
    `NotOnOrAfter="${instant(now + CONFIRMATION_LIFETIME_MS)}"`,
    ...(recipient ? [`Recipient="${escape(recipient)}"`] : []),
  ].join(' ');
  const issuerXml = `<saml:Issuer>${escape(issuer)}</saml:Issuer>`;
  const body =
    `<saml:Subject><saml:NameID Format="${SAML.persistent}">${escape(subject)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="${SAML.bearer}"><saml:SubjectConfirmationData ${data}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${instant(now)}" NotOnOrAfter="${instant(now + ASSERTION_LIFETIME_MS)}"><saml:AudienceRestriction><saml:Audience>${escape(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${instant(now)}"${optionalAttribute('SessionIndex', sessionIndex)}><saml:AuthnContext><saml:AuthnContextClassRef>${SAML.passwordProtectedTransport}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    attributeStatement(claims);
  const open = `<saml:Assertion xmlns:saml="${SAML.assertion}" ID="${id}" Version="2.0" IssueInstant="${instant(now)}">`;
  const unsigned = `${open}${issuerXml}${body}</saml:Assertion>`;
  return `${open}${issuerXml}${envelopedSignature(unsigned, id, privateKey)}${body}</saml:Assertion>`;
}

/** A signed SAML Response around a signed assertion (or, with `status`, an unsuccessful one without assertion). */
export function signedResponse({
  issuer,
  destination,
  inResponseTo,
  assertion = '',
  status = SAML.success,
  subStatus = null,
  now,
  privateKey,
}) {
  const id = messageId();
  const open = `<samlp:Response ${PROTOCOL_NAMESPACES} ID="${id}" Version="2.0" IssueInstant="${instant(now)}" Destination="${escape(destination)}"${optionalAttribute('InResponseTo', inResponseTo)}>`;
  const issuerXml = `<saml:Issuer>${escape(issuer)}</saml:Issuer>`;
  const code = subStatus
    ? '<samlp:StatusCode Value="' + status + '"><samlp:StatusCode Value="' + subStatus + '"/></samlp:StatusCode>'
    : '<samlp:StatusCode Value="' + status + '"/>';
  const body = `<samlp:Status>${code}</samlp:Status>${assertion}`;
  const unsigned = `${open}${issuerXml}${body}</samlp:Response>`;
  return `${open}${issuerXml}${envelopedSignature(unsigned, id, privateKey)}${body}</samlp:Response>`;
}
/** A LogoutResponse for the signed HTTP-Redirect binding. */
export function logoutResponseXml({ issuer, destination, inResponseTo, status = SAML.success, now }) {
  return (
    `<samlp:LogoutResponse ${PROTOCOL_NAMESPACES} ID="${messageId()}" Version="2.0" IssueInstant="${instant(now)}" Destination="${escape(destination)}" InResponseTo="${escape(inResponseTo)}">` +
    `<saml:Issuer>${escape(issuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${status}"/></samlp:Status></samlp:LogoutResponse>`
  );
}
export function readLogoutResponse(xml) {
  const message = guarded(() => protocolMessage(xml, 'LogoutResponse'));
  const code = child(child(message.root, SAML.protocol, 'Status'), SAML.protocol, 'StatusCode');
  return {
    ...message,
    inResponseTo: attribute(message.root, 'InResponseTo'),
    status: code ? attribute(code, 'Value') : null,
  };
}

/** The WS-Federation sign-in response (wresult): a RequestSecurityTokenResponse with a signed SAML 2.0 assertion. */
export function wsFederationResult({ assertion, realm, now }) {
  return (
    `<t:RequestSecurityTokenResponse xmlns:t="${WSFED.trust}"><t:Lifetime><wsu:Created xmlns:wsu="${WSFED.utility}">${instant(now)}</wsu:Created>` +
    `<wsu:Expires xmlns:wsu="${WSFED.utility}">${instant(now + ASSERTION_LIFETIME_MS)}</wsu:Expires></t:Lifetime>` +
    `<wsp:AppliesTo xmlns:wsp="${WSFED.policy}"><wsa:EndpointReference xmlns:wsa="${WSFED.addressing}"><wsa:Address>${escape(realm)}</wsa:Address></wsa:EndpointReference></wsp:AppliesTo>` +
    `<t:RequestedSecurityToken>${assertion}</t:RequestedSecurityToken><t:TokenType>${WSFED.saml2TokenType}</t:TokenType>` +
    `<t:RequestType>http://schemas.xmlsoap.org/ws/2005/02/trust/Issue</t:RequestType><t:KeyType>http://schemas.xmlsoap.org/ws/2005/05/identity/NoProofKey</t:KeyType></t:RequestSecurityTokenResponse>`
  );
}

// ---- validation (the portal) ----
/** The Issuer of a SAML Response (else of its assertion), unvalidated: it only selects the provider's configuration. */
export function responseIssuer(xml) {
  return guarded(() => {
    const root = read(xml);
    const own = child(root, SAML.assertion, 'Issuer');
    const issuer = own ?? child(child(root, SAML.assertion, 'Assertion'), SAML.assertion, 'Issuer');
    return issuer ? textOf(issuer).trim() : null;
  });
}
/**
 * A bounded replay cache of assertion IDs (saml-profiles-2.0-os 4.1.4.5): an ID is kept until its assertion's
 * lifetime and the clock skew have passed.
 */
export function createReplayCache(limit = 5000) {
  const seen = new Map();
  return {
    claim(key, until, now) {
      for (const [entry, expiry] of seen) if (expiry <= now) seen.delete(entry);
      if (seen.has(key)) return false;
      seen.set(key, until);
      if (seen.size > limit) seen.delete(seen.keys().next().value);
      return true;
    },
  };
}

function checkLifetime(notBefore, notOnOrAfter, now, what) {
  if (notBefore !== null && notBefore > now + CLOCK_SKEW_MS)
    throw fault(`The ${what} is not valid yet.`, 'FEDERATION_ASSERTION_EXPIRED');
  if (notOnOrAfter !== null && notOnOrAfter <= now - CLOCK_SKEW_MS)
    throw fault(`The ${what} has expired.`, 'FEDERATION_ASSERTION_EXPIRED');
}

function audiencesOf(conditions) {
  return childElements(conditions, SAML.assertion, 'AudienceRestriction').map((restriction) =>
    childElements(restriction, SAML.assertion, 'Audience').map((item) => textOf(item).trim()),
  );
}

function subjectOf(assertion, { requireRecipient, recipient, requestId, now, persistent }) {
  const subject = child(assertion, SAML.assertion, 'Subject');
  const nameId = child(subject, SAML.assertion, 'NameID');
  if (!nameId) throw fault('The assertion has no NameID.', 'FEDERATION_SUBJECT_INVALID');
  const format = attribute(nameId, 'Format');
  if (format === SAML.transient || (persistent && format !== SAML.persistent))
    throw fault('The NameID is not a persistent identifier.', 'FEDERATION_SUBJECT_INVALID');
  const value = textOf(nameId).trim();
  if (!value || value.length > 256) throw fault('The NameID is empty or too long.', 'FEDERATION_SUBJECT_INVALID');
  const confirmed = childElements(subject, SAML.assertion, 'SubjectConfirmation').some((confirmation) => {
    if (attribute(confirmation, 'Method') !== SAML.bearer) return false;
    const data = child(confirmation, SAML.assertion, 'SubjectConfirmationData');
    const until = timeOf(attribute(data, 'NotOnOrAfter'), 'SubjectConfirmationData NotOnOrAfter');
    if (until === null || until <= now - CLOCK_SKEW_MS) return false;
    if (requireRecipient && attribute(data, 'Recipient') !== recipient) return false;
    return (attribute(data, 'InResponseTo') ?? null) === requestId;
  });
  if (!confirmed)
    throw fault(
      'The assertion has no current bearer confirmation for this reply URL and request.',
      'FEDERATION_SUBJECT_INVALID',
    );
  return value;
}

function claimsOf(assertion) {
  const claims = {};
  for (const statement of childElements(assertion, SAML.assertion, 'AttributeStatement'))
    for (const item of childElements(statement, SAML.assertion, 'Attribute')) {
      const name = attribute(item, 'Name');
      const first = childElements(item, SAML.assertion, 'AttributeValue')[0];
      const value = first ? textOf(first).trim() : '';
      if (name && value && value.length <= 256 && !(name in claims) && Object.keys(claims).length < MAX_ATTRIBUTES)
        claims[name] = value;
    }
  return claims;
}

/**
 * Validates one SAML 2.0 assertion of `root`: issuer, signature (unless `signed` by its response), lifetime,
 * audience, subject confirmation and replay. Returns { subject, claims, sessionIndex }.
 */
function validateAssertion(root, assertion, options) {
  const { issuer, keys, audiences, validateAudience, now, replay, signed } = options;
  if (attribute(assertion, 'Version') !== '2.0' || !attribute(assertion, 'ID'))
    throw fault('The assertion is not a SAML 2.0 assertion with an ID.');
  const issued = child(assertion, SAML.assertion, 'Issuer');
  if (!issued || textOf(issued).trim() !== issuer)
    throw fault('The assertion is not issued by the configured identity provider.', 'FEDERATION_ISSUER_INVALID');
  if (signatureOf(assertion)) verified(root, assertion, keys);
  else if (!signed) throw fault('The assertion is not signed.', 'FEDERATION_SIGNATURE_INVALID');
  const conditions = child(assertion, SAML.assertion, 'Conditions');
  const notOnOrAfter = timeOf(attribute(conditions, 'NotOnOrAfter'), 'Conditions NotOnOrAfter');
  checkLifetime(timeOf(attribute(conditions, 'NotBefore'), 'Conditions NotBefore'), notOnOrAfter, now, 'assertion');
  if (validateAudience) {
    const restrictions = audiencesOf(conditions);
    if (!restrictions.length || restrictions.some((list) => !list.some((item) => audiences.includes(item))))
      throw fault('The assertion is not issued for this site (audience).', 'FEDERATION_AUDIENCE_INVALID');
  }
  const subject = subjectOf(assertion, options);
  const statement = child(assertion, SAML.assertion, 'AuthnStatement');
  if (options.requireAuthnStatement && !statement)
    throw fault('The assertion has no authentication statement.', 'FEDERATION_ASSERTION_INVALID');
  const until = (notOnOrAfter ?? now + ASSERTION_LIFETIME_MS) + CLOCK_SKEW_MS;
  if (!replay.claim(`${issuer}|${attribute(assertion, 'ID')}`, until, now))
    throw fault('The assertion was already used (replay).', 'FEDERATION_REPLAY');
  return {
    subject,
    claims: claimsOf(assertion),
    sessionIndex: statement ? attribute(statement, 'SessionIndex') : null,
  };
}

function onlyAssertion(root) {
  const all = [root, ...descendants(root)];
  if (all.some((item) => item.ns === SAML.assertion && item.local === 'EncryptedAssertion'))
    throw fault('Encrypted assertions are not supported.', 'FEDERATION_ASSERTION_INVALID');
  const assertions = all.filter((item) => item.ns === SAML.assertion && item.local === 'Assertion');
  if (assertions.length !== 1)
    throw fault('The message must carry exactly one assertion.', 'FEDERATION_ASSERTION_INVALID');
  return assertions[0];
}

/**
 * The portal's checks of a SAML Response posted to its assertion consumer service URL `acs`: `requestId` is the
 * AuthnRequest ID this browser started (null for an identity-provider-initiated response).
 */
export function validateSamlResponse(xml, options) {
  return guarded(() => samlResponseOf(read(xml), options));
}
function samlResponseOf(root, { issuer, keys, audiences, validateAudience = true, acs, requestId, now, replay }) {
  if (
    root.ns !== SAML.protocol ||
    root.local !== 'Response' ||
    attribute(root, 'Version') !== '2.0' ||
    !attribute(root, 'ID')
  )
    throw fault('The message is not a SAML 2.0 Response.');
  if (attribute(root, 'Destination') !== acs)
    throw fault("The response's Destination is not this site's reply URL.", 'FEDERATION_DESTINATION_INVALID');
  if ((attribute(root, 'InResponseTo') ?? null) !== requestId)
    throw fault('The response does not answer the sign-in this browser started.', 'FEDERATION_REQUEST_MISMATCH');
  const issued = child(root, SAML.assertion, 'Issuer');
  if (issued && textOf(issued).trim() !== issuer)
    throw fault('The response is not issued by the configured identity provider.', 'FEDERATION_ISSUER_INVALID');
  const signed = Boolean(signatureOf(root));
  if (signed) verified(root, root, keys);
  const code = child(child(root, SAML.protocol, 'Status'), SAML.protocol, 'StatusCode');
  const status = code ? attribute(code, 'Value') : null;
  const detail = attribute(child(code, SAML.protocol, 'StatusCode'), 'Value');
  if (status !== SAML.success)
    throw fault(
      `The identity provider answered the status ${status ?? '(none)'}${detail ? ' (' + detail + ')' : ''}.`,
      'FEDERATION_STATUS',
    );
  const assertion = onlyAssertion(root);
  if (assertion.parent !== root)
    throw fault('The assertion is not a child of the response.', 'FEDERATION_ASSERTION_INVALID');
  return validateAssertion(root, assertion, {
    issuer,
    keys,
    audiences,
    validateAudience,
    now,
    replay,
    signed,
    requireRecipient: true,
    recipient: acs,
    requestId,
    persistent: true,
    requireAuthnStatement: true,
  });
}

/** The portal's checks of a WS-Federation wresult: one RequestSecurityTokenResponse with one signed SAML 2.0 assertion. */
export function validateWsFederationResult(xml, options) {
  return guarded(() => wsFederationResultOf(read(xml), options));
}
function wsFederationResultOf(root, { issuer, keys, audiences, validateAudience = true, now, replay }) {
  let response = root;
  if (root.local === 'RequestSecurityTokenResponseCollection' && root.ns === WSFED.trust13) {
    const items = childElements(root, WSFED.trust13, 'RequestSecurityTokenResponse');
    if (items.length !== 1) throw fault('The wresult must carry exactly one token response.');
    response = items[0];
  }
  const trust = [WSFED.trust, WSFED.trust13].find(
    (ns) => response.ns === ns && response.local === 'RequestSecurityTokenResponse',
  );
  if (!trust) throw fault('The wresult is not a RequestSecurityTokenResponse.');
  const token = child(response, trust, 'RequestedSecurityToken');
  const assertion = onlyAssertion(root);
  if (!token || assertion.parent !== token)
    throw fault('The token response does not carry a SAML 2.0 assertion.', 'FEDERATION_ASSERTION_INVALID');
  return validateAssertion(root, assertion, {
    issuer,
    keys,
    audiences,
    validateAudience,
    now,
    replay,
    signed: false,
    requireRecipient: false,
    requestId: null,
    persistent: false,
    requireAuthnStatement: false,
  });
}
