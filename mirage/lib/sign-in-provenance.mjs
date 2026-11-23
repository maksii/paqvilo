// Render provenance of the platform account pages' content (sign-in, invitation redemption, persona shortcut):
// every element of the content is a part of the sign-in page (platform-shell:sign-in#<part>), named with the site
// settings that configure that part, as lib/external-login.mjs reads them:
// - a provider tile (the external sign-in form's provider button): the provider's own settings
//   (Authentication/OpenIdConnect/<name>/*, Authentication/OpenAuth/<name>/*, Authentication/SAML2/<name>/*,
//   Authentication/WsFederation/<name>/*), Registration/ExternalLoginEnabled and, for the built-in Microsoft Entra
//   provider, Registration/AzureADLoginEnabled (externalProviders);
// - the external sign-in form around the tiles: Registration/ExternalLoginEnabled;
// - the local sign-in (local personas, the persona picker): Registration/LocalLoginEnabled;
// - the Register tab: Registration/Enabled, OpenRegistrationEnabled, RequiresInvitation, RequiresConfirmation
//   (authenticationSettings registration and openRegistration);
// - the Redeem invitation tab, link and page: Registration/Enabled, InvitationEnabled, RequiresInvitation
//   (authenticationSettings registration and invitation);
// - the rest (the account layout's container, tabs list, scripts, page copy wrapper): the page itself, no setting.
// The markup is never changed. Links and scripts of exported web files stay the web file's (liquid.mjs shellTags).
import { parseFragment } from 'parse5';
import { shellTags, shellComponent } from './liquid.mjs';

const REGISTRATION = 'Authentication/Registration/';
const PROVIDER_PREFIXES = {
  openidconnect: 'Authentication/OpenIdConnect/',
  oauth2: 'Authentication/OpenAuth/',
  saml2: 'Authentication/SAML2/',
  wsfederation: 'Authentication/WsFederation/',
};
const PART_SETTINGS = {
  'external-login': ['ExternalLoginEnabled'],
  'local-sign-in': ['LocalLoginEnabled'],
  registration: ['Enabled', 'OpenRegistrationEnabled', 'RequiresInvitation', 'RequiresConfirmation'],
  invitation: ['Enabled', 'InvitationEnabled', 'RequiresInvitation'],
};
const PART_NAMES = {
  'external-login': 'external sign-in',
  'local-sign-in': 'local sign-in',
  registration: 'registration',
  invitation: 'invitation redemption',
};

const attribute = (node, name) => node.attrs?.find((item) => item.name === name)?.value;
const classes = (node) =>
  new Set(
    String(attribute(node, 'class') ?? '')
      .split(/\s+/)
      .filter(Boolean),
  );
const elements = (node) => (node.childNodes ?? []).filter((child) => child.tagName);

/** The part a provider button or an account form is, by its name, value and action. */
function formPart(element, providers) {
  const action = attribute(element, 'action') ?? '';
  if (element.tagName === 'button' && attribute(element, 'name') === 'provider') {
    const provider = providers.find((item) => item.id === attribute(element, 'value'));
    if (provider) return { part: 'provider', provider };
  }
  if (element.tagName === 'form' && /^\/Account\/Login\/ExternalLogin\b/i.test(action))
    return { part: 'external-login' };
  if (element.tagName === 'form' && /^\/Account\/Login\/RedeemInvitation\b/i.test(action))
    return { part: 'invitation' };
  if (element.tagName === 'form' && /^\/(?:SignIn|_sim\/sign-in)\b/i.test(action)) return { part: 'local-sign-in' };
  return null;
}

/** The part a marker class, a persona-picker resource or a registration link is. */
function markerPart(element) {
  const name = classes(element);
  const href = attribute(element, 'href') ?? '';
  const src = attribute(element, 'src') ?? '';
  if (name.has('paqvilo-mirage-local-accounts') || name.has('paqvilo-mirage-sign-in')) return { part: 'local-sign-in' };
  if (/^\/__sim\/persona-picker\./.test(href || src)) return { part: 'local-sign-in' };
  if (name.has('paqvilo-mirage-redeem-invitation')) return { part: 'invitation' };
  if (element.tagName === 'a' && /^\/Account\/Login\/Register\b/i.test(href)) return { part: 'registration' };
  if (element.tagName === 'a' && /^\/Register\b/i.test(href)) return { part: 'invitation' };
  return null;
}

/** The part an element itself is (its own markup, or its only child's: a tab's list item, a link's paragraph). */
function ownPart(node, providers) {
  const own = (element) => formPart(element, providers) ?? markerPart(element);
  const found = own(node);
  if (found) return found;
  const children = elements(node);
  return ['li', 'p'].includes(node.tagName) && children.length === 1 ? own(children[0]) : null;
}

/** Start-tag offset of every element of `markup` -> its part, inherited from the nearest element that is a part. */
function partsOf(markup, providers) {
  const parts = new Map();
  const walk = (node, inherited) => {
    for (const child of elements(node)) {
      const part = ownPart(child, providers) ?? inherited;
      if (child.sourceCodeLocation?.startTag) parts.set(child.sourceCodeLocation.startTag.startOffset, part);
      walk(child, part);
      if (child.content) walk(child.content, part);
    }
  };
  walk(parseFragment(markup, { sourceCodeLocationInfo: true }), null);
  return parts;
}

/**
 * The platform descriptors of the account content's elements (lib/liquid.mjs accountPageEdits contentPlatform):
 * `(tag, markup)` -> { component, sourceRefIds }. `providers` are the sign-in page's external providers
 * (lib/external-login.mjs externalProviders).
 */
export function signInPartTags({ portal, index = null, providers = [] }) {
  const settings = (portal.records ?? []).filter((record) => record.kind === 'sitesetting');
  const refs = (predicate) =>
    settings
      .filter((record) => predicate(String(record.name ?? '').toLowerCase()))
      .map((record) => index?.source(record, '$record')?.id)
      .filter(Boolean);
  const named = (names) => {
    const wanted = new Set(names.map((name) => (REGISTRATION + name).toLowerCase()));
    return refs((name) => wanted.has(name));
  };
  const providerRefs = (provider) => {
    const prefix = `${PROVIDER_PREFIXES[provider.type] ?? ''}${provider.key}/`.toLowerCase();
    return [
      ...refs((name) => name.startsWith(prefix)),
      ...named(['ExternalLoginEnabled', ...(provider.builtIn ? ['AzureADLoginEnabled'] : [])]),
    ];
  };
  const shell = shellTags(portal, index, 'sign-in');
  let cached = null;
  return (tag, markup = '') => {
    const base = shell(tag);
    if (base?.component?.key !== shellComponent('sign-in').key) return base;
    if (cached?.markup !== markup) cached = { markup, parts: partsOf(markup, providers) };
    const found = cached.parts.get(tag.start);
    if (!found) return base;
    if (found.part === 'provider')
      return {
        component: {
          ...shellComponent('sign-in'),
          key: `platform-shell:sign-in#provider:${found.provider.slug}`,
          name: `Sign-in page: ${found.provider.caption ?? found.provider.key} provider`,
          provider: found.provider.key,
        },
        sourceRefIds: providerRefs(found.provider),
      };
    return {
      component: {
        ...shellComponent('sign-in'),
        key: `platform-shell:sign-in#${found.part}`,
        name: `Sign-in page: ${PART_NAMES[found.part]}`,
      },
      sourceRefIds: named(PART_SETTINGS[found.part]),
    };
  };
}
