import { validateLocalOverrides, resolveLocalOverrides } from './local-overrides.mjs';

function validateAppearance(value) {
  for (const key of ['title', 'description'])
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 500))
      throw new Error(`mirage.identityProvider.${key} must be text of at most 500 characters`);
  if (value.accentColor !== undefined && !/^#[0-9a-f]{6}$/i.test(value.accentColor))
    throw new Error('mirage.identityProvider.accentColor must be a six-digit hex colour');
}

export function identityProviderSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('mirage.identityProvider must be an object');
  for (const key of Object.keys(value))
    if (
      ![
        'newUser',
        'presentation',
        'title',
        'description',
        'accentColor',
        'head',
        'privateSiteContactIds',
        'localAccounts',
        'pairedBrowserTokens',
      ].includes(key)
    )
      throw new Error(`Unknown mirage.identityProvider.${key}`);
  if (value.newUser !== undefined && !['auto', 'always', 'never'].includes(value.newUser))
    throw new Error('mirage.identityProvider.newUser must be auto, always or never');
  if (value.presentation !== undefined && !['page', 'dialog'].includes(value.presentation))
    throw new Error('mirage.identityProvider.presentation must be page or dialog');
  if (value.localAccounts !== undefined && typeof value.localAccounts !== 'boolean')
    throw new Error('mirage.identityProvider.localAccounts must be true or false');
  if (value.pairedBrowserTokens !== undefined && typeof value.pairedBrowserTokens !== 'boolean')
    throw new Error('mirage.identityProvider.pairedBrowserTokens must be true or false');
  validateAppearance(value);
  if (
    value.privateSiteContactIds !== undefined &&
    (!Array.isArray(value.privateSiteContactIds) ||
      value.privateSiteContactIds.some((id) => typeof id !== 'string' || !/^[a-z\d._-]{1,128}$/i.test(id)))
  )
    throw new Error('mirage.identityProvider.privateSiteContactIds must be an array of local contact IDs');
  validateLocalOverrides({ head: value.head ?? {} });
  return {
    newUser: 'auto',
    presentation: 'page',
    title: 'Choose a local persona',
    description: 'Choose the identity for this browser session. This is a local simulation; no credentials are used.',
    accentColor: '#315bd5',
    ...structuredClone(value),
  };
}

export function identityProviderAssets(settings, root) {
  return resolveLocalOverrides({ head: settings.head ?? {} }, root).assets.map((asset, index) => ({
    ...asset,
    url: `/_idp-local/${index}${asset.kind === 'scripts' ? '.js' : '.css'}`,
  }));
}

/** The site setting prefix of each provider type (lib/external-login.mjs). */
export const PROVIDER_PREFIXES = Object.freeze({
  openidconnect: 'Authentication/OpenIdConnect/',
  oauth2: 'Authentication/OpenAuth/',
  saml2: 'Authentication/SAML2/',
  wsfederation: 'Authentication/WsFederation/',
});

export function newUserPolicy(settings, authentication, provider, params = {}) {
  const disabled = [];
  if (authentication.registration === false) disabled.push('Authentication/Registration/Enabled');
  if (authentication.openRegistration === false && authentication.invitation === false)
    disabled.push('Authentication/Registration/OpenRegistrationEnabled and InvitationEnabled');
  if (provider.registration === false || provider.registrationEnabled === false)
    disabled.push(
      `${PROVIDER_PREFIXES[provider.type] ?? PROVIDER_PREFIXES.openidconnect}${provider.key}/RegistrationEnabled`,
    );
  const requested = String(params.prompt ?? '')
    .split(/\s+/)
    .includes('create');
  return {
    allowed: settings.newUser !== 'never' && (settings.newUser === 'always' || requested || !disabled.length),
    forced: disabled.length > 0 && (settings.newUser === 'always' || requested),
    disabled,
  };
}
