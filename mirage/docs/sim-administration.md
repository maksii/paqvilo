# Local simulation administration

`/_sim/` is the loopback administration workspace of a running Mirage runtime. It is served on its own port, printed as
`adminUrl`; `/_sim/` on the portal address redirects there. It manages local tables and records, portal and organization
identities, roles and permissions, presets and scenarios, settings and snippet overrides, the runtime environment,
providers, backend operations and what the runtime did. Every change affects only local state and rendering. `/_sim/`
and [`/_setup/`](../../docs/setup.md) share one shell with an **Areas** switch: `/_sim/` for daily work, `/_setup/` for
project configuration (applied on restart).

`/_sim` and `/__sim` are the same path family. The page calls `/__sim/api/...`; this guide writes `/_sim/api/...`.

## Sign-in and sessions

Portal requests start anonymous. Local sign-in selects an active synthetic contact (or an explicit role override) and
sets a per-runtime `paqvilo-mirage-auth-<port>` cookie. The portal sign-in page, `/_sim/` and Lense **Tweaks** all act
on the browser's own session: signing one browser in does not sign another in, and the saved simulator identity is not a
substitute for a request cookie. Sign-out clears only the local session. Persona selection, grouped pickers and isolated
setups are described in [persona catalogues](persona-catalog.md); `/_sim/#access` selects this browser's persona.

`simulator.identityScope` is `"sessions"` (the default) or `"configured"` (`"all-requests"` is an alias). With
`"configured"`, a portal request without a visitor cookie uses the saved configured identity, with its normal membership
or role-override resolution and permission checks; a valid visitor cookie, including the explicit anonymous cookie
sign-out issues, still wins. It creates no session. Use it only for offline tooling that cannot hold cookies.
Administration requests always use the configured identity. These are local simulation settings, not Power Pages
authentication settings.

A local browser sign-in has a server-side deadline from `Authentication/ApplicationCookie/ExpireTimeSpan`, a positive
whole-second TimeSpan (`hh:mm:ss` or `d.hh:mm:ss`). Without the setting, or with a value in another format, the
deadline is 24 hours. The deadline uses the runtime clock and survives a web-role override. With `SlidingExpiration`
`false` it is fixed and also applies to programmatic sign-in (`simulator.signIn`); otherwise a programmatic
Cookie-header session has none. The cookie itself stays a browser-session cookie unless a local account signs in with
**Remember me?**. Hosted session F4 observed the same default: without the settings, a remembered sign-in's cookie
expired 24 hours after it was issued.

`Authentication/ApplicationCookie/SlidingExpiration` is `true` unless the site sets it to `false`. A sliding session
is renewed after strictly more than half of its original window by a successful local portal document request,
`GET /_layout/tokenhtml`, or any local portal Web API (`/_api`) response, whatever its caching. In hosted session F4, a
background `/_api` read alone renewed the cookie, as a page load did. Renewal preserves the signed session identity,
including the owner of the browser's request token. HEAD, live forwarding and other requests do not renew a session.
Cookie-header tooling sessions and cookies issued without a sliding deadline are never renewed.

An application cookie whose `name=value` reaches 4,050 characters, for example a session with a long role override, is
sent the way the platform sends `.AspNet.ApplicationCookie`: `<name>=chunks:<n>`, then `<name>C1` to `<name>C<n>`
with the same attributes, each holding at most 4,050 characters minus the name, `=` and 3. A session is read only when
every chunk is present and the joined value verifies. Signed in, `/Account/Login/LogOff` returns to `/` (or the
validated `returnUrl`). Anonymous, it redirects to the sign-in path with the log-off path unencoded, as in
`/SignIn?ReturnUrl=/Account/Login/LogOff`.

Programmatic sign-in: `simulator.signIn(contactId)` returns a cookie header; Playwright tests use `signInContext`, and
HTTP tools `createPortalSession`, `connectRuntime().createSession` and `runSessionMatrix` from `paqvilo/mirage/testing`.
`connectRuntime().signIn(null, { configuredPersona: true })` needs a configured contact (`identity.contactId`, or legacy
`identity.id`) and otherwise fails with `MISSING_PERSONA_CONTACT` before any request. Visitors sharing a runtime share
its settings, sources and data, so give each its own write fixtures; run separate processes and state files for
different configuration. The helpers, the audit, diagnostics and log readers and their filters are documented in the
[public API](../../docs/public-api.md#connect-to-a-running-local-runtime) and
[test many visitors concurrently](../../docs/public-api.md#test-many-visitors-concurrently).

The local external identity provider simulates exported provider settings with a local route and explicit redirect
handling. It never copies live credentials or mints environment tokens; live-reference sign-in belongs to the intended
signed-in browser. Permission enforcement can be set to enforced or permissive for local experiments, and evidence
records the choice. Live create, update and delete need both `--allow-live-writes` and the `/_sim/` live writes switch;
neither authorizes a business operation.

For an OpenID Connect provider with explicit `Authentication/OpenIdConnect/<provider>/UseTokenLifetime=true`, the
local portal cookie uses the validated ID token's deadline in place of the site's application-cookie window. That
session ends at the token deadline even when site-wide sliding renewal is enabled. A pending external sign-in
must finish before the same deadline. The token itself stays outside the application cookie and user claims.
This covers the local provider flow. Hosted providers and the separate private-site admission cookie have their
own lifetimes.

A browser session carries a digest of its contact's security stamp (`adx_identity_securitystamp`) and the time it
was last validated: a persona chosen on the sign-in page, a persona launch (`POST /_sim/api/personas/launch`, the
sign-in page's persona picker or `/_sim/sign-in`) and an external sign-in. These sessions also follow the site's
application-cookie lifetime. Once `Authentication/ApplicationCookie/SecurityStampValidator/ValidateInterval`
(default 30 minutes; `0` validates every request) has passed, the session is anonymous when the contact's stamp has changed or the contact is gone. A contact
that is inactive or missing is already anonymous at once. A passed validation issues no cookie: a sliding renewal
carries the new validation time, and until then the session is validated on each request. Local account sessions keep
their own credential stamp, checked on every request. A programmatic session from `signIn()` and the testing session
helpers (`testing/session.mjs`) is a tool identity: it carries no stamp and no lifetime. With the option
`browserSession: true`, `signIn()` issues a browser session instead and returns its `Set-Cookie` header as `setCookie`.

### OAuth 2.0, SAML 2.0 and WS-Federation providers

Each exported provider signs in through the runtime's local identity provider with its own protocol. The local
identity provider answers under its local authority (`GET /_sim/api/session` lists it as
`identityProvider.providers[].localAuthority`), never at the exported `MetadataAddress` or online endpoints, and uses
invented local keys only.

- **OAuth 2.0** (`Authentication/OpenAuth/<Name>/ClientId`, `ConsumerKey` or `AppId`): the portal redirects to the
  authorize page with `response_type=code` and `Scope` (comma-separated in the setting, space-separated in the
  request). The code comes back on the query string of `CallbackPath` (default `/signin-<name>`, such as
  `/signin-google`). The portal redeems it with `ClientSecret` (`ConsumerSecret`, `AppSecret`) and reads the user
  profile with the access token. A missing secret reports `EXTERNAL_LOGIN_SETTING_INVALID` at start, and sign-in then
  fails with `EXTERNAL_LOGIN_TOKEN_REQUEST_FAILED`.
- **Twitter** (`Authentication/OpenAuth/Twitter/ConsumerKey` and `ConsumerSecret`, the client ID and secret of
  Learn's setup page) signs in with OAuth 1.0a, as the OWIN Twitter middleware does. The portal posts a signed
  request for a request token (`oauth/request_token` with `oauth_callback`), redirects to `oauth/authenticate` and,
  at `/signin-twitter`, exchanges `oauth_token` and `oauth_verifier` for the user ID and screen name with a request
  signed with the request token's secret. Every request is signed with HMAC-SHA1 in an `Authorization: OAuth`
  header. The local identity provider checks the consumer key and signature, a timestamp within five minutes, a
  nonce used once and the registered callback. Request tokens and verifiers are single-use. The claims are the name
  identifier and name (the screen name), `urn:twitter:userid` and `urn:twitter:screenname`, with no email.
- **SAML 2.0** (`Authentication/SAML2/<Name>/AuthenticationType`): `AuthenticationType` is the identity provider's
  entity ID, `ServiceProviderRealm` the portal's entity ID (the audience) and `AssertionConsumerServiceUrl` the reply
  URL. The portal sends an unsigned `AuthnRequest` with the HTTP-Redirect binding, asking for a persistent name ID and
  `PasswordProtectedTransport`. The identity provider posts a signed `Response` with a signed assertion. An
  identity-provider-initiated sign-in starts at `<localAuthority>saml2/idpinitiated?RelayState=ReturnUrl%3D<path>`.
  The local identity provider answers an `AuthnRequest` with `IsPassive="true"` without a page: this browser's
  provider session signs in, and without one (or with `ForceAuthn="true"` as well) the response has the status
  `Responder`/`NoPassive`, which the portal reports as `FEDERATION_STATUS`. `ForceAuthn="true"` alone shows the
  chooser with the request detail, and the earlier session never answers it.
- **WS-Federation** (`Authentication/WsFederation/<Name>/AuthenticationType`): the portal redirects with
  `wa=wsignin1.0`, `wtrealm` (`Wtrealm`), `wreply` (`Wreply`), `wctx` and `whr` (`Whr`). The answer is a posted
  `wresult` with a signed SAML 2.0 assertion.

The portal checks a SAML response or WS-Federation token before it signs anyone in. The XML signature (exclusive
canonicalization, RSA-SHA256) must verify with a signing key of the provider's metadata, on the response or on the
assertion. The issuer must be `AuthenticationType` and, for SAML, the destination and bearer recipient must be the
reply URL. The audience must be the realm or one of `ValidAudiences`, unless `ValidateAudience` is explicitly `false`.
The assertion must be within its lifetime, with five minutes of clock skew. SAML also needs a persistent name ID, an
authentication statement and exactly one unencrypted assertion. An answer completes only in the browser that started
the sign-in, at most 15 minutes later, and only once: a refused answer ends that pending sign-in, and an assertion ID
is never accepted twice. The reader refuses document type declarations, entities, comments and processing
instructions. Refusals render the sign-in page with a diagnostic such as `FEDERATION_SIGNATURE_INVALID`,
`FEDERATION_AUDIENCE_INVALID`, `FEDERATION_ISSUER_INVALID`, `FEDERATION_ASSERTION_EXPIRED`, `FEDERATION_REPLAY`,
`FEDERATION_REQUEST_MISMATCH` or `EXTERNAL_LOGIN_STATE_INVALID`. Return URLs, including a `RelayState` `ReturnUrl`,
stay on the site.

These providers issue claims with the `System.Security.Claims.ClaimTypes` names (for example
`http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`). Without `RegistrationClaimsMapping`,
registration fills the contact's first name, last name and email from the given name, surname and email claims.
`RegistrationClaimsMapping` and `LoginClaimsMapping` name these claim types, for example
`telephone1=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/mobilephone`. External identities record the
`AuthenticationType` and the name identifier.

Sign-out with a SAML 2.0 provider that has `ExternalLogoutCertThumbprint` sends a `LogoutRequest` with a query-string
signature. The local stand-in for the custom certificate signs it, and the identity provider accepts only that key.
The portal then accepts the signed `LogoutResponse` at the reply URL and returns to the return URL. Without the
thumbprint, sign-out is local and an exported `ExternalLogoutEnabled` reports `SAML_LOGOUT_NOT_SENT`. A
WS-Federation provider with `ExternalLogoutEnabled` signs out with `wa=wsignout1.0` and `wreply`, which is
`SignOutWreply` moved onto the portal's origin or the return URL.

These flows follow the Microsoft Learn setup pages and the SAML 2.0 FAQ. The platform's exact requests, claim types,
default for `ValidateAudience`, refusal pages and logout routing are not verified against a hosted site.

For a private-site fixture, set `observed.siteVisibility` to `private` with evidence and set
`identityProvider.privateSiteContactIds` to the approved local contact IDs. Browser navigation redirects through the
local Microsoft Entra provider. The admission session grants access to portal routes, where portal contact sign-in and
web roles still apply independently. An empty list refuses all fixture identities. A private visibility observation
without the fixture list renders the private banner and reports `PRIVATE_SITE_ADMISSION_UNCONFIGURED`. Admission is
a browser-session cookie of its own (`<auth cookie>-site-access`, `HttpOnly`, `SameSite=Lax`). It does not sign the
browser in to the portal, and LogOff keeps it. It ends at a fixed deadline, the
`Authentication/ApplicationCookie/ExpireTimeSpan` after admission (24 hours without the setting), and is never renewed.
After it, portal routes answer 401 `PRIVATE_SITE_ACCESS_REQUIRED` and a navigation starts admission again. Hosted
session F4 observed only a lower bound: an admission stayed valid through LogOff and for at least 59 minutes with a
6-minute application cookie lifetime, without being issued again. A deadline shorter than 24 hours reports the warning
`PRIVATE_SITE_ADMISSION_HOSTED_LIFETIME`; `observed.privateSiteAdmissionLifetime: fixed-day`, with evidence, keeps
admission 24 hours whatever the cookie lifetime. Those 24 hours are inferred, not observed.

A stored contact web-role intersection supplies effective memberships in its corresponding standard or enhanced data
model, including an explicitly empty table. Other portal fixtures use the configured simulator memberships.

Set `identityProvider.localAccounts` to `true` to exercise local accounts as Power Pages serves them (hosted session
F4): registration, sign-in, email confirmation, lockout, address throttling, password recovery and change, email
two-factor sign-in and invitation codes. Persona sign-in remains available. The account forms use synthetic
credentials.

A deliberate difference: a hosted site renders the local sign-in form on `/SignIn` itself. Mirage keeps password fields
off the shared sign-in page, which runs the site's scripts; it links to the local form on `/Account/Login/Login`, a page
with a strict content security policy that allows no scripts, and accepts the hosted post of that form to `/SignIn`.

| Page                                    | Fields and answer                                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Account/Login/Login`                  | The local sign-in form. It posts `Username`, `PasswordValue` and `RememberMe` to the site's sign-in path (`/SignIn`), `ReturnUrl` in the query.                                                     |
| `/Account/Login/Register`               | The WebForms controls `ctl00$ctl00$ContentContainer$MainContent$MainContent$EmailTextBox`, `…UserNameTextBox`, `…PasswordTextBox` and `…ConfirmPasswordTextBox`.                                    |
| `/Account/Login/ForgotPassword`         | `Email`. Known and unknown addresses get the same answer.                                                                                                                                           |
| `/Account/Login/ResetPassword`          | `UserId`, `Code`, `Password`, `ConfirmPassword`; success redirects to `/Account/Login/ResetPasswordConfirmation`.                                                                                   |
| `/Account/Login/SendCode`, `VerifyCode` | The second factor: `Code` and `RememberBrowser`. Without a pending sign-in both answer 500, as hosted.                                                                                              |
| `/Account/Manage/ChangePassword`        | `Username` (read only), `OldPassword`, `NewPassword`, `ConfirmPassword`; success redirects to the profile page with `?Message=ChangePasswordSuccess`.                                               |
| `/Account/Manage/ChangeTwoFactor`       | Posts the form token to `/Account/Manage/EnableTFA` (or `DisableTFA`); needs `TwoFactorEnabled` and a confirmed address.                                                                            |
| `/Account/Manage/ConfirmEmailRequest`   | Shows "Check your email for confirmation instructions." and sends nothing. `POST /Account/Manage/PostConfirmEmailRequest` with the token in the `__RequestVerificationToken` header sends the link. |

An anonymous request to an `/Account/Manage/` page redirects to the sign-in path with `ReturnUrl`. The platform's
messages come back on the page with 200: "Invalid sign-in attempt.", "The user account is currently locked. Please try
again later.", "The password and confirmation password do not match.", the password policy messages, "The Email field
doesn’t contain a valid email address.", "Please check your email to reset your password.", "Invalid token.", "Invalid
code." and "Invalid invitation code.". "Too many sign-in attempts. Please wait awhile and then try again." answers 409
(the status is in the raw lockout captures of hosted session F4, `accounts-a-cookies+lockout-*` and
`accounts-b-lockout-*`).
A hosted site answers a registration with a taken user name or address with `The username "<name>" is already taken.`
or `The email "<address>" is already taken.`, which reveals which accounts exist. Mirage answers 409 "These details
cannot be used for local registration." for both, naming neither, and reports the warning
`LOCAL_ACCOUNT_DUPLICATE_HOSTED_MESSAGES`; `observed.registrationDuplicateMessages: named`, with evidence, answers the
hosted messages with 200.

These answers are local choices that hosted session F4 did not capture:

- A wrong current password on **Change password** answers ASP.NET Identity's "Incorrect password." on the page.
- `DisableTFA`, the counterpart of the captured `EnableTFA`, turns two-factor sign-in off with the form token alone.
- A group invitation code is refused on the "I have an existing account" sign-in as at local registration.
- With `RequiresConfirmation`, registration sends the confirmation link and sign-in answers "Confirm your email before
  signing in." until the address is confirmed.
- A password reset or change keeps the account's lockout and failure count; the new password signs in once the lockout
  has passed.
- When the invited contact of an invitation already has a local account, local registration with the code answers
  "Invalid invitation code." and keeps that account; its owner redeems the code through "I have an existing account".
- A pending email code ends after five wrong codes, also when the lockout is off.
- Throttling expiry: failures older than `MaxAttemptsTimeLimitTimeSpan` stop counting and an address is admitted again
  after `IpAddressTimeoutTimeSpan`. Every attempt is counted before its password is checked, so attempts sent at once
  cannot pass the limit together; a valid attempt is taken back.

Registration signs in at once and sends no email. It and a sign-in without a return URL open the site's **Profile**
page (`Authentication/Registration/ProfileRedirectEnabled`, on by default), with `?ReturnUrl=` when one was given.
When `CaptchaEnabled` is absent, registration needs a CAPTCHA, as on a new hosted site: set
`CaptchaEnabled=false` or supply the local CAPTCHA fixture. `RememberMeEnabled` and `RememberBrowserEnabled` are on
when absent.

A local account is its contact row. The credentials are its ASP.NET Identity columns: `adx_identity_username`, the
password hash in `adx_identity_passwordhash`, a GUID
`adx_identity_securitystamp`, `adx_identity_emailaddress1confirmed`, `adx_identity_twofactorenabled`,
`adx_identity_lockoutenabled`, `adx_identity_lockoutenddate`, `adx_identity_accessfailedcount` and
`adx_identity_logonenabled`, which Mirage writes and, as hosted, never reads. The plain password is never stored or
logged. Mirage writes the ASP.NET Identity version 3 format (PBKDF2-HMAC-SHA256, 100,000 rounds); a hosted site
writes the version 2 format (PBKDF2-HMAC-SHA1, 1,000 rounds, 68 characters), and both verify, so imported contacts sign
in with their passwords. A version 2 hash is replaced by a version 3 one at its next successful sign-in, without
changing the security stamp. Every password check costs one version 3 and one version 2 derivation, whether the
account stores either format or the name is unknown. A hosted site may not read the version 3 hashes Mirage writes. These columns follow the
runtime's data persistence settings, so an account survives a restart when the data
does; one-time challenges, the mailbox and the address throttle stay in memory and clear on data reset or restart.

The fixture mailbox is `GET /_sim/api/local-accounts/messages` on the administration origin with the `x-sim-csrf`
token. Each item has `to`, `kind` (`confirm`, `reset` or `mfa`), the platform's `subject` ("Confirm your account",
"Password Reset", "Security Code"), an HTML `body`, and `url` or `code`. The links are
`/Account/Manage/ConfirmEmail?userId=<contactid>&code=<code>` and `/Account/Login/ResetPassword?userId=<contactid>&code=<code>`.
A confirmation link redirects to the profile page with `?Message=ConfirmEmailSuccess` and is used once: a second use
answers 403 "Invalid token." and reports the warning `LOCAL_ACCOUNT_CONFIRMATION_HOSTED_REUSE`. A hosted site lets the
link be used again until the account's stamp or address changes (hosted session F4);
`observed.confirmationLinkReuse: reusable`, with evidence, reproduces that. A reset link is used once.

Five wrong passwords (`MaxFailedAccessAttemptsBeforeLockout`) lock the account for a day
(`DefaultAccountLockoutTimeSpan`), and wrong two-factor codes count toward the same lockout. With
`Authentication/LoginThrottling/MaxInvaildAttemptsFromIPAddress` (the setting name as a new site ships it), an address
that made that many invalid sign-in attempts within `MaxAttemptsTimeLimitTimeSpan` (default 00:05:00) gets 409 for
`IpAddressTimeoutTimeSpan` (default 00:15:00), for any account and even with a correct password; clearing an account's
lockout does not lift it. A new hosted site ships 5, 00:05:00 and 00:15:00. Without the attempt setting no address is
throttled.

Two-factor sign-in redirects to `/Account/Login/SendCode?RememberMe=False`, which sends the six-digit code and
redirects to `/Account/Login/VerifyCode?Provider=EmailCode&RememberMe=False`.

An invitation's `/register/?returnurl=/&invitation=<code>` link opens the redemption form with the code. Codes match
without regard to case. A valid code redirects to `/Account/Login/Register?returnUrl=/&invitationCode=<code>`, which
shows "Redeeming code: <code>" with the invited contact's address; registering there makes the invited contact the
account (no contact is created), redeems the invitation and records an `adx_inviteredemption` activity regarding the
invitation with the user name as its subject. With **I have an existing account** (`RedeemByLogin`), the local sign-in
form posts to `/SignIn?InvitationCode=<code>` and redeems the invitation for the contact who signs in. A used, expired,
deactivated or unknown code answers "Invalid invitation code."; a group invitation passes the code step and is refused
with the same message at local registration without changing the invitation. An invitation's redemption workflow starts after
the redemption has committed, as the local portal application user; see
[project extensions](../../docs/project-extensions.md#classic-workflow-handlers).

With the Dataverse API on and an `adx_invitation` table, Mirage provides the Power Pages invitation processes the
Solution does not export, under the ids the platform's solution gives them (hosted session F4):

- **UpdateInvitationCode** runs in real time when an invitation is created and gives it a 172-character code when it has
  none.
- **Send Invitation** is an on-demand background process: `ExecuteWorkflow` on it starts a system job owned by the
  caller and created by SYSTEM. The job writes one email activity regarding the invitation, from the caller to the
  invited contact, Pending Send, its subject empty apart from the tracking token (` CRM:0000001`), its body the hosted
  text with the link `<origin>/register/?returnurl=/&invitation=<code>`, and sets the invitation to Sent (756150000),
  which stays redeemable. The hosted email links to `http://localhost:7500` whatever the site's address; Mirage links to
  its own origin (and to the hosted address only when it has none), and encodes the code in the link.

A trusted pack handler registered for one of these ids replaces the built-in process.

A sign-in session ends at its next request when the account's password, two-factor setting or security stamp changes,
when its contact is deactivated or deleted, and when its `emailaddress1` changes. A hosted site lets such a session run
for up to about 8 minutes and refuses a deactivated contact's sign-in for a while after it is reactivated (hosted session
F4); Mirage checks on every request. An edit of the contact's `emailaddress1` keeps the account and its password but
marks the address unconfirmed at the account's next request, and pending messages for the old address end. With
`RequiresConfirmation`, sign-in then waits for a confirmation of the new address. Email sign-in (`LocalLoginByEmail`)
and password recovery use the current address, and an address that several accounts share matches none of them. A
sign-in that completes, including one from a remembered browser, clears the failure count.

With `Authentication/Registration/RememberMeEnabled` on, the local password form offers an unchecked **Remember me?**
choice. Select it during sign-in to set the browser cookie's expiry to
the signed application deadline. The browser-bound MFA challenge carries the original choice, and sliding renewal
advances the signed deadline and the browser expiry together. Sign-out replaces the cookie with the usual anonymous
session marker. Other sign-in methods and unchecked local sign-ins keep session-only cookies. In hosted session F4,
without lifetime settings, a remembered sign-in set one persistent cookie expiring 24 hours later.

With `Authentication/Registration/RememberBrowserEnabled` on, the verification form also offers an unchecked
**Remember this browser?** choice. Selecting it after a correct code issues a separate marker for that account and its
credentials, and the next sign-in in that browser skips the code (hosted session F4). A later sign-in still requires the
correct password. The marker lasts 24 hours on the local runtime clock, and ordinary logoff leaves it in the browser.
Password or two-factor changes, data reset and restart invalidate it. The marker never grants portal access by itself
or extends the application session.

### Publishing preview toggle

`GET /_sim/api/session/preview` reports this browser's classic `adxPreviewUnpublishedEntities` cookie, whether the
signed-in contact holds the **Preview Unpublished Entities** website access permission through a web role, and whether
preview applies. `POST /_sim/api/session/preview` with `x-sim-csrf` and `{ "enabled": true }`, `false` or `null` sets
the cookie to `true` or `false` (`Path=/`, readable by scripts, as classic `PreviewPermission` sets it), or clears it.
Without the cookie, preview is on for an eligible contact. An anonymous browser answers 409 `SESSION_NOT_SIGNED_IN`, and
a contact without the permission answers 403 `PREVIEW_NOT_PERMITTED`; neither gets a cookie. A cookie set by hand gives
such a contact no preview. The cookie is the platform's name, so every runtime on the same host name reads it.
In `/_sim/`, **Identity & permissions** shows a **Publishing preview** panel to an eligible signed-in contact, with
**Turn preview off** or **Turn preview on** and, once the cookie is set, **Use the default**. In Lense, **Tweaks** shows a
**Publishing preview** On/Off switch below the browser session for the same contact; switching reloads the page.
Neither appears for an anonymous browser or a contact without the permission.
[Website access permissions](https://learn.microsoft.com/power-pages/security/website-access-permission) ·
[classic preview permission](https://github.com/Adoxio/xRM-Portals-Community-Edition/blob/868decd55a6f/Framework/Adxstudio.Xrm/Web/Security/PreviewPermission.cs#L35-L94).

### Implicit grant tokens

`POST /_services/auth/token` and `GET /_services/auth/publickey` follow the
[implicit grant flow](https://learn.microsoft.com/power-pages/security/oauth-implicit-grant-flow). A refusal is 400
with `{ ErrorId, ErrorMessage, Timestamp, CorrelationId }` and the hosted texts of session F4, checked in this order:

| Check                                                               | `ErrorId`       |
| ------------------------------------------------------------------- | --------------- |
| `state` longer than 20 characters                                   | `PortalSTS0005` |
| `nonce` longer than 20 characters                                   | `PortalSTS0006` |
| `client_id` longer than 36 characters                               | `PortalSTS0010` |
| `client_id` not registered, or not only letters, digits and hyphens | `PortalSTS0001` |
| `response_type` other than `token`                                  | `PortalSTS0007` |
| `state` with a control character                                    | `PortalSTS0018` |

A missing `client_id` or `response_type` passes. The hosted site, which had no implicit grant certificate, answered
every request that passed these checks with `PortalSTS0018` ("The Implicit Grant certificate was not found. …"). That
includes a `state` with control characters or spaces. Mirage signs with its key instead, except for a `state` with a
control character, which cannot be returned as the `state` header and is refused with `PortalSTS0018`. A `state` with
spaces is returned. A body over 64 KiB is refused with 413 `PortalSTS0003`. Every answer is `Cache-Control: no-cache,
no-store, must-revalidate`, and `Timestamp` is written as `11/27/2026 5:59:29 AM` (UTC). `GET /_services/auth/token`
answers 404 without a body, and `/_services/auth/authorize` is the site's 404 page. Anonymous, a POST is redirected to
sign-in. An `X-Requested-With: XMLHttpRequest` call gets 200 without a body and `X-Responded-JSON:
{"status":401,"headers":{"location":"…"}}` with `/` written as `\/`.

Without a configured key, each runtime process signs with a key pair it generates. On the platform, an uploaded custom
certificate signs when `CustomCertificates/ImplicitGrantflow` names its thumbprint. To get stable tokens locally, list
PEM RSA private key files (unencrypted, at least 2048 bits) in the project file:

```yaml
implicitGrant:
  signingKeys:
    - privateKeyFile: ../keys/invented-default.pem
    - privateKeyFile: ../keys/invented-custom.pem
      thumbprint: 0123456789ABCDEF0123456789ABCDEF01234567
```

Paths resolve against the project file's folder. An entry with a thumbprint signs when the site setting names that
thumbprint; otherwise the entry without a thumbprint signs, and otherwise the per-process key. The public key endpoint
serves the public key of the signing key. Project load refuses a key file that is missing, unreadable, encrypted, not
RSA, shorter than 2048 bits or inside a portal export or Solution folder, with `IMPLICIT_GRANT_SIGNING_KEY_INVALID`
naming the file and the reason. A key file that becomes unusable while the runtime runs answers 400 `PortalSTS0018` and is
reported in `/_sim/api/diagnostics`. The key content never appears in settings, state, responses or logs. A replaced
file is read again on the next request.

### Verification witness

`runtime.witness({ tables: ['fixture'] })` and `visitor.witness({ tables: ['fixture'] })` (from `connectRuntime` and
`createPortalSession`) read `GET /_sim/api/verification-witness?tables=<a,b>`: a read-only hash of one to 32 distinct,
existing logical tables, taken in one atomic `DataStore.readOperation`. It hashes effective permissions, mappings,
settings, operation mode, source and runtime fingerprints, actor fields and every stored column of the selected tables,
without calling SDK or plug-in retrieval, and returns hashes and counts, never row bodies, setting values or
credentials. A visitor's witness uses its own cookie, so it resolves the same portal identity as its requests.
`compareVerificationWitnesses(before, after)` reports the changed hash categories; runtime instance and revision changes
are reported separately, so a write to an unselected table is not mistaken for fixture drift. Unselected tables get no
coverage. Keep the state file outside the export (the source fingerprint observes files in the export), and verify
external plug-in DLL bytes separately: a definition hash does not cover them. A witness is a local comparison boundary,
not native parity.

## Routes

`GET /_sim/api/status` lists the prefixes a host answers in `routes`; anything else under `/_sim/api` answers 404
`Admin endpoint not found.`. Writes (any method other than GET, HEAD and OPTIONS) need the administration token in
`x-sim-csrf` ([tokens](#tokens)); without it they answer 403 `Missing simulator CSRF token.`. Both hosts answer HEAD on
every GET route like the GET, without a body and without side effects: a HEAD never reveals or spends the one-time
managed identity header of `GET /_sim/api/dataverse`.

Errors are `{ "error": { "code", "message", "parameter"? } }`. An administration 400 for a refused query parameter or
body field names it in `parameter` (for example `/logs`, `/audit`, `/render-sources`, `/activity/export`,
`/verification-witness` without `tables`, and a non-boolean `applyConfiguration` of a preset apply). The boolean query
parameters `?strict` (`/preflight`) and `?summary` (`/state`) take `true` or `1` and `false` or `0` (empty or absent is
false); any other value answers 400 `InvalidQueryParameter`. On the portal address, refusals of `/__sim/api`, native
form posts, pack endpoints and any request whose `Accept` names JSON but not HTML use this envelope; a missing
`/_sim/<asset>` answers plain text, and other portal paths an HTML page.

| Prefix                                                                          | Host        | Purpose                                                                                                              |
| ------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `/status`                                                                       | both        | [Status payload](#status-payload)                                                                                    |
| `/state`, `/simulation`, `/diagnostics`                                         | both        | Runtime state; [simulation level](simulation-levels.md#inspect-and-change-a-level) report; findings                  |
| `/config`                                                                       | both        | Power Pages: `PATCH` only. Standalone: `GET`, and `PATCH` of `operations` (else 409 `RuntimeRestartRequired`)        |
| `/platform-settings`                                                            | both        | Platform rules: `GET`, `PATCH`, `DELETE /platform-settings/<key>` ([experiments](configuration-experiments.md))      |
| `/dataverse`                                                                    | both        | Organization identity and API, one shape on both hosts ([Dataverse API](dataverse-api.md#administration))            |
| `/records/<table>[/<id>]`                                                       | both        | Local record administration                                                                                          |
| `/preflight`                                                                    | both        | [Capabilities and preflight](#capabilities-and-preflight)                                                            |
| `/operations`                                                                   | both        | Backend operation inventory ([operations](operations.md))                                                            |
| `/model-driven/offline`                                                         | both        | Mobile offline summary of every staff session                                                                        |
| `/dashboard`                                                                    | both        | [Health feed](#health-feed)                                                                                          |
| `/packs`                                                                        | both        | [Pack inventory](#pack-inventory)                                                                                    |
| `/environment`                                                                  | both        | [Environment administration](#environment-administration-on-both-hosts)                                              |
| `/messages`, `/outbox`                                                          | both        | [Messages and outbox](#messages-and-outbox)                                                                          |
| `/flow-runs`, `/flow-waits`, `/flow-triggers`, `/connections`                   | both        | [Flow runs and waits](#flow-runs-and-waits); connection sign-in (`/connections/<id>/authorize`, `/authorization`)    |
| `/trace`                                                                        | both        | [Request tracing API](tracing.md#api)                                                                                |
| `/activity`                                                                     | both        | `/activity/export`, the [activity bundle](tracing.md#activity-bundle)                                                |
| `/session`                                                                      | Power Pages | `GET /session`; `POST /session/sign-in`, `/sign-out`, `/roles`, `/portal-ticket` ([ticket sign-in](#ticket-sign-in)) |
| `/personas`, `/persona-catalog`, `/persona-runtimes`, `/scenarios`              | Power Pages | [Persona catalogues](persona-catalog.md#api-and-testing) and scenarios                                               |
| `/presets`, `/experiments`                                                      | Power Pages | [Data presets](#data-presets) and [configuration presets](configuration-experiments.md#automation)                   |
| `/portal-settings`, `/portal-snippets`, `/portal-roles`, `/portal-access-rules` | Power Pages | Portal configuration and overrides                                                                                   |
| `/mappings`, `/plugins`, `/permissions`, `/endpoints`                           | Power Pages | Entity mappings, declarative plug-in rules, permissions, pack endpoints                                              |
| `/page-resources`, `/page-provenance`, `/verification-witness`                  | Power Pages | Source inspection and the [verification witness](#verification-witness)                                              |
| `/audit`, `/logs`, `/render-sources`                                            | Power Pages | [Activity reads](#activity-and-trace-routes)                                                                         |
| `/reference`, `/assets`, `/live`                                                | Power Pages | Reference enrichment, asset capture, live connection (`/live/connect`, `/live/disconnect`)                           |
| `/reset`, `/reload`                                                             | Power Pages | `POST`: reset state, reload sources                                                                                  |
| `/shutdown`                                                                     | both        | `POST`: stop the runtime (202)                                                                                       |

Configuration changes and background writes: `PATCH /config` and `PATCH`/`DELETE /operations/<key>` apply their
change to the state as it is when they commit, in the queue that asynchronous plug-in jobs and SDK writes commit
through. A job that commits while the change prepares keeps its rows, and the change answers 200. A replacement of the
whole state from a snapshot answers 409 `StateConflict` (`Local state changed before replacement; no imported state
was applied`) when another write committed after that snapshot, and applies nothing; wait for pending jobs
(`backend.settle()`, see [asynchronous steps](dataverse-plugins.md)) and send it again.

Outside `/_sim/api`: `/_sim/events` (server-sent `logs` and `trace` channels), `/__sim/sign-in`,
`/__sim/session-token/<ticket>` and the other portal paths in the [allow-list](#portal-address-allow-list).

### Data presets

`GET /_sim/api/presets` lists the runtime's data presets (built-in, pack and saved); `GET /presets/<id>` answers one,
`POST`, `PATCH` and `DELETE` manage saved ones. `POST /presets/<id>/apply` takes `{ "applyConfiguration": true }`
(optional boolean; also apply the preset's linked [configuration preset](configuration-experiments.md)) and answers the
runtime state. An apply of an unknown id answers 404
`Preset '<id>' not found; GET /_sim/api/presets lists this runtime's presets and paqvilo mirage --help the registry presets.`;
`GET`, `PATCH` and `DELETE` of an unknown id answer 404 `Configuration item not found.`.

A preset replaces each business section it carries (`mappings`, `tables`, `permissions`, `plugins`, `settings`) and
keeps the rest. Its table mappings are declared schema and are accepted at every
[simulation level](simulation-levels.md#private-runtime-and-identity-state); any other schema it carries (custom API
definitions, request parameters, response properties) is refused below `deep` (403 `SimulationSchemaDisabled`, nothing
applied). `POST /_sim/api/mappings` at `dry-run` or `simulation` is still a schema change (403
`SimulationSchemaDisabled`). Its rows follow the level:

- `dry-run`: the rows replace memory only; no file is written.
- `simulation` and `deep`: an apply through `/_sim/` writes the preset's rows to the pack DATA files. Every business
  table the preset writes needs a DATA owner; otherwise the apply answers 409 `SimulationDataTargetRequired` (naming the
  first table without an owner) and nothing changes.
- A startup preset (`--preset`, `mirage.preset`) keeps the rows of every table a pack DATA file owns, in `bootstrap` and
  `always` mode and when the private checkpoint was removed; tables without an owner take the preset's rows.

## Administration origin

The Power Pages host has three loopback listeners on one host literal, each on its own port: the portal (`url`), the
administration (`adminOrigin`, an ephemeral port) and the apps (`appsOrigin`, an ephemeral port, Power Pages host only).
The standalone host has a main listener, which serves its apps and API and has no portal, and the administration
listener. Every listener refuses a `Host` header that is not its own address.

| Listener                                | Serves                                                                                                                                                                               | Token         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Portal (`url`)                          | The portal. Browsers reach administration and apps paths only through the [allow-list](#portal-address-allow-list) or a redirect; programmatic clients reach all of `/_sim/api` here | `portalToken` |
| Administration (`adminUrl`, `setupUrl`) | `/_sim/` (page, assets, `/_sim/api`, `/_sim/events`, evidence) and `/_setup/`                                                                                                        | `csrf`        |
| Apps (`appsUrl`, Power Pages host only) | `/main.aspx`, `/_apps` and `/_apps/*` except `/_apps/portal-documents/*`, `/api/data/v9.*`, and `/__sim/api/dataverse/session`                                                       | `appsToken`   |

On the standalone host the main listener carries `appsToken`, which is also its page token, and the administration
listener carries `csrf`. The standalone host has no `portalToken`.

### Browser and programmatic requests

A browser request carries `Sec-Fetch-Site` or `Origin`. Scripts cannot remove either header, and a script cannot forge
`Origin`. A request with neither header is programmatic: Node `fetch`, Playwright `context.request`, the CLI, curl and
the Lense node process. Only browser requests are gated. Programmatic requests get the complete behaviour of the portal
address: all of `/_sim/api`, `csrf` in status and state, writes with the administration token, and the apps paths.

### Portal address

- A top-level navigation (GET or HEAD with `Sec-Fetch-Mode: navigate`) to an administration path is answered with a 302
  to the administration origin, with the same path and query; the browser keeps the fragment. A navigation to an apps
  path is answered with a 302 to the apps origin.
- Any other browser request to an administration path is answered 403 `AdminOriginRequired`, and to an apps path 403
  `AppsOriginRequired`, unless it is on the allow-list.
- Paths outside both families are served to browsers on the portal address.

### Administration and apps addresses

- A `Host` header that is not the listener's address is answered 403 `Invalid Host header.`.
- An `Origin` other than the listener's own is answered 403 `CrossOriginAdminRequest` (`CrossOriginAppsRequest` on the
  apps address).
- A `Sec-Fetch-Site` other than `same-origin` or `none` is answered 403 `CrossSiteAdminRequest`
  (`CrossSiteAppsRequest`), unless the request is a navigation.
- A write (any method other than GET, HEAD or OPTIONS) that carries `Sec-Fetch-Site` but no `Origin` is answered 403
  `CrossOriginAdminRequest` (`CrossOriginAppsRequest`).
- A navigation to a served document is served from any site. The administration page keeps `frame-ancestors 'none'`;
  Canvas and Code Apps pages send `x-frame-options: SAMEORIGIN`.
- A GET or HEAD for a path the listener does not serve is redirected to the portal address with the same path and query.
  Any other method is answered 404 `PortalOriginRequired`.

### Portal address allow-list

Browser requests to these paths are served on the portal address, with any `Sec-Fetch-Site`. Every other administration
and apps path is refused to browsers as described above.

| Method          | Path                                                                                                                    | Purpose                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET, HEAD       | `/__sim/events`, unless `channels` names `logs` or `trace`                                                              | The reload stream; it carries revision numbers only                                                                                                       |
| POST            | `/__sim/forms/(entityform\|webform)/<id>/submit`                                                                        | Native form submission; needs the portal token and the visitor's identity                                                                                 |
| GET, HEAD, POST | `/__sim/sign-in`                                                                                                        | `GET ?persona=<key>` shows one catalogue persona (400 without it); POST needs the portal token and sets only this browser's session                       |
| GET, HEAD, POST | `/__sim/frame-ready/<id>`                                                                                               | Frame ordering: the image is held until the page's POST reports that the DOM or jQuery is ready                                                           |
| GET, HEAD       | `/__sim/persona-picker.css`, `/__sim/persona-picker.mjs`, `/__sim/persona-search.mjs`, `/__sim/persona-picker-view.mjs` | Static code of the sign-in page's picker                                                                                                                  |
| GET, HEAD       | `/__sim/api/personas` (exact path)                                                                                      | The persona catalogue the sign-in page shows; the writes of this catalogue are administration-only                                                        |
| any             | `/__sim/api/flow-triggers/<id>/triggers/<name>/paths/invoke`                                                            | Authenticated by the signed callback URL, as on the platform                                                                                              |
| any             | Registered pack endpoint paths                                                                                          | Trusted pack routes for visitors; the handler requires sign-in and the portal token for writes                                                            |
| GET, HEAD       | `/__sim/session-token/<ticket>`                                                                                         | Ticket consumption; a browser GET that is not a navigation is refused with `TicketInvalid` and a HEAD answers 405 `Allow: GET`; neither spends the ticket |

The table is the `PORTAL_ROUTES` list of `mirage/lib/admin-origin.mjs`, with the pack endpoints checked by the runtime.
Two administration paths are not on the list: `/__sim/api/dataverse/session` is served on the apps and administration
addresses, and `/__sim/api/session/portal-ticket` is answered on the administration address to browsers, while
programmatic clients on the portal address reach it with the administration token.

### Ticket sign-in

The administration signs a browser in through the portal with a single-use ticket. The console calls
`POST /_sim/api/session/portal-ticket` with `{ action: 'sign-in' | 'sign-out', contactId?, provider?, returnHash? }` and
the administration token. The answer is `{ url, expiresAt }`, where `url` is `<portal>/__sim/session-token/<ticket>`,
and it sets the binding cookie `paqvilo-mirage-ticket-<portal port>` (`HttpOnly`, `SameSite=Strict`,
`Path=/__sim/session-token`, `Max-Age=60`). The console then navigates the tab to `url`.

- The ticket is 256 random bits. The server keeps its SHA-256 digest and the binding's digest in memory only, at most 16
  tickets, and drops the oldest when a seventeenth is minted.
- A ticket is valid for 60 seconds on the store clock.
- The first navigation (or programmatic GET) that presents a ticket deletes it. A HEAD answers 405 `Allow: GET` and a
  browser request that is not a navigation answers `TicketInvalid`; neither spends it. Any further attempt, an expired
  ticket, or a ticket presented without the matching binding cookie is refused with the same 403 `TicketInvalid` answer,
  so no answer tells a guessed value from a spent one.
- A navigation that spends a valid ticket is answered with a redirect into the administration. A local persona sets the
  portal session cookie and returns to `/_sim/<returnHash>` (default `#access`). A provider starts external sign-in with
  the contact as login hint. A sign-out ends a signed-in session through the portal's log-off, and otherwise returns to
  the administration.
- Minting refuses an inactive or unknown contact (404 `PERSONA_CONTACT_UNAVAILABLE`), an unknown `action` or provider or
  a malformed `returnHash` (400 `InvalidTicketRequest`), and local sign-in while it is turned off and providers exist
  (409 `LocalSignInDisabled`). A mint with the portal token (403 `Missing simulator CSRF token.`), or a browser-shaped
  mint from the portal address (403 `AdminOriginRequired`), is refused.
- The ticket and its binding are not logged or traced.

### Tokens

The three tooling tokens are 32 random bytes each, fixed for the life of the runtime.

- `csrf`, the administration token: on the handle, and in `csrf` of status and state. It is accepted in `x-sim-csrf` on
  the administration writes under `/_sim/api`, and in the body-token fields of the sign-in and persona forms.
  Portal and apps handlers also accept it on supported writes; portal requests check it separately from the browser's
  request token, and apps requests use the apps token after normalization. No page carries it.
- `portalToken`, the programmatic portal anti-forgery token, for requests without Fetch Metadata (tools and tests).
  A browser's portal markup and `/_layout/tokenhtml` carry that browser's own request token instead (below). Local
  form posts, pack endpoint writes and native view state check the request's current verification token.
- `appsToken`, the apps token: on the handle (on the standalone host it is the page token). The app pages send it: the
  model-driven shell in `meta[name="mirage-csrf"]`, the Canvas player in `data-csrf` and the `_csrf` field of its form
  posts, and the Code Apps `GET context` response in `x-sim-csrf`. It is accepted in `x-sim-csrf` by the apps Web API,
  the Canvas actions, the Code Apps routes and `/__sim/api/dataverse/session`.

Browser request tokens belong to one browser and its current portal sign-in, as on the hosted site (session F4). The
browser receives a signed, runtime-scoped binding cookie (`<auth cookie>-request-binding-<slot>`, a browser-session
cookie, `HttpOnly`, `SameSite=Lax`) when it first reads a portal document, account form or token fragment, and every
token its pages carry names that binding and that sign-in. A token is reusable while both stay the same. Another
browser's token, a token from before sign-in or LogOff, and `simulator.portalToken` sent from a browser are refused;
reload open forms or refresh the token after changing sign-in. A portal Web API write answers each refusal with 401
`90040107` and the hosted text after `Request validation failed : `
([token failures](dataverse-parity.md#token-failures)). Reads ignore the token. The `__RequestVerificationToken`
cookie that the token fragment sets is a `SameSite=Lax` session cookie. Existing form, WebForms and Web API transport
shapes apply. Programmatic callers still use `simulator.portalToken`, and the administration token keeps its
supported uses. Set `identityProvider.pairedBrowserTokens` to `false` to give every browser the shared runtime token
instead.

A runtime has four cookie slots for overlapping first loads. Each signed binding expires after 24 hours, and requests
with a valid binding reuse it. More than four overlapping first issuances can reuse a slot. If a tab's binding expires
or its slot is replaced, open the form with a fresh GET before submitting again.

### Residual

Isolation relies on the Fetch Metadata request headers browsers send: Chromium 76+, Firefox 90+, Safari 16.4+. A request
without `Sec-Fetch-Site` and `Origin` is served as a programmatic client, so page scripts in an older browser are not
isolated.

## Views and host awareness

A view is shown only when its host serves the route it needs. The page reads `status.routes` and `status.eventChannels`
(see [Status payload](#status-payload)); without them it probes each required route once per session, and only a 404
hides the view. Views of the portal source need `page-resources`, which only the Power Pages host serves, so a
[standalone profile](standalone-organization.md) has no portal personas, live bridge or rendering controls. An empty
hash opens `#health`, an unknown one `#home`; `#<view>?panel=<key>` scrolls to a panel. `/_sim/` follows the browser's
colour scheme; `/_setup/` stays light.

| View (hash)                                                    | Hosts       | Purpose                                                                                                                                                                               |
| -------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#home`, `#health`, `#activity`                                | both        | [Monitor](#monitor)                                                                                                                                                                   |
| `#records`                                                     | both        | Local records, paged and sorted on the runtime; each row links to `#activity?table=<logical name>&recordId=<id>`                                                                      |
| `#packs`                                                       | both        | [Pack inventory](#pack-inventory); add packs in [`/_setup/#packs`](../../docs/setup.md#journey) and restart                                                                           |
| `#plugins`, `#mappings`, `#endpoints`, `#portal`, `#overrides` | Power Pages | Declarative plug-in rules and presets, entity mappings, pack endpoints, portal configuration, settings and snippet overrides ([experiments](configuration-experiments.md))            |
| `#services`                                                    | both        | Storage, messaging, outbox, connectors and connections, secret references (names only), local services with **Probe now**, service fixtures, Power Fx, app inventories, SharePoint    |
| `#flows`                                                       | both        | Flow runs and their journal, waits and approvals, durable jobs, scheduler, asyncoperation rows, poisoned rows, web hook outcomes ([routes](#flow-runs-and-waits))                     |
| `#capabilities`                                                | both        | Capability report and preflight ([below](#capabilities-and-preflight)); on Power Pages, **Preflight this scenario** per saved scenario                                                |
| `#operations`                                                  | both        | Backend operation modes ([operations](operations.md#choose-local-behaviour)), each row linking to its recent activity                                                                 |
| `#environment`, `#platform`                                    | both        | [Environment administration](#environment-administration-on-both-hosts); platform rules such as the link-entity budget                                                                |
| `#access`, `#scenarios`                                        | Power Pages | This browser's persona ([persona catalogues](persona-catalog.md)), linking to `#activity?who=<contact id>`; scenarios                                                                 |
| `#dataverse`                                                   | both        | Organization identity: staff users and roles, application registrations, secrets (shown once), certificates, federated credentials ([Dataverse API](dataverse-api.md#administration)) |
| `#runtime`; `#connection`                                      | both; PP    | Surface, simulation level, persistence, workspace export and import, fingerprints; the live connection                                                                                |

The `/_sim/` record editor is explicit local administration; model-driven requests use the selected staff principal with
its row and field security. Backend operation rows link to
`#activity?kind=plugin-step&actorKind=plugin&actorId=<step id>`,
`#activity?kind=flow-run&actorKind=flow&actorId=<process id>`, `#activity?kind=server-logic&q=<name>` or
`#activity?kind=workflow&q=<name>`.

## Monitor

**Health** answers whether the runtime is wired and up, **Activity** what it did. **Home** (`#home`) holds a **First
run** checklist derived from runtime facts (a standalone runtime shows **Start working** with its app links). Times show
as local `HH:MM:SS.mmm`, with date and UTC on hover. A **Who** value reads like `Ada Member · contact:1a2b3c4d` or
`Visitor accb980f`; a **plug-in step** is an exported Dataverse plug-in step, a **plugin rule** a declarative rule of
Plugins & presets.

### Health

`#health` renders [`GET /_sim/api/dashboard`](#health-feed) every 5 seconds while visible: a banner with a readiness
pill (`OK`; `DEGRADED` when a component reports an error or is missing; `BLOCKED` when preflight reports blocking
requirements), key-number tiles with an **Expand** timeline (from `GET /_sim/api/trace/stats?from=<runtime.startedAt>`;
Findings from `/diagnostics`), the system map of `nodes` and `edges`, an on-demand preflight and the configuration.
Health counts everything since start and works with tracing off; Activity's Stats counts only the kept, filtered
activities, so either can be higher.

Each tile links into Activity: **Portal requests** (pages and the portal's `/_api`) `#activity?host=power-pages`,
**Dataverse Web API** (the organization listener, not the portal's `/_api`) `#activity?host=dataverse-api`, **Plug-in
step runs** `#activity?kind=plugin-step`, **Flow runs** `#activity?kind=flow-run`, **Jobs pending**
`#activity?kind=job`, **Failed** `#activity?hasErrors=true` and **Findings** `#activity?tab=findings`; a tile's **N
failed** adds `&status=error`. Messages, Outbox and Storage writes are levels or provider counters and open their
Providers & services panel.

### Activity

`#activity` lists every activity (trace) with its request audit entry, log lines and findings. Results, failed
activities, browser probes and what joins a trace are defined in [request tracing](tracing.md#reading-a-trace). The
address is the whole view state, so a view is a shareable link:

```text
#activity?range=15m&result=error,denied&who=contact:<id>&table=contact&recordId=<id>&host=power-pages&q=<text>&live=1
```

- **Filters:** `range` (`5m`, `15m`, `1h`, `24h`; or `from` and `to`), `result` (comma list), `who` (`anonymous`,
  `visitor:<id>`, `<kind>:<id>` or a bare id), `table` (logical or entity set name), `recordId`, `host` (any letter
  case), `q`; under
  **More filters** the [trace filters](tracing.md#filters) `kind`, `module`, `operation`, `status`, `hasErrors`,
  `minDurationMs`, `session`, `portal`, `auditId`, and the request audit keys `path`, `provider`, `auditKind`,
  `httpStatus`. Ids accept a prefix of at least 8 hexadecimal characters; an ambiguous prefix matches every candidate. A
  `whoName` label is shown on the chip and never sent to the runtime.
- **State keys:** `tab=log|findings|pages|stats`, `type` (log type), `reads=1`, `sort`, `order`,
  `#activity/<traceId>[/<spanId>]`, `detail`, `steps=tree`, `spanSearch`, `errorsOnly`, `compare=<id1>,<id2>`. The older
  keys `entity`, `search`, `sessionKey`, `actorKind`, `actorId` and `visitorId` are read as `table`, `q`, `session` and
  `who`.
- **Tabs:** Activities (Liquid and FetchXML reads made during a render fold into the page; **Show reads** lists them),
  Log stream (retained server-side, `mirage.logs.retain`), Findings (one row per code), Pages & render (route, render
  time, template files and lines, rendering evidence) and Stats. Each tab is shown only when the host serves its route
  or channel.
- **Live** follows `/_sim/events?channels=trace&events=trace-end`, or the audit through the `logs` channel when tracing
  is off. **⚙ Settings** changes the trace level, persistence and retention without a restart and has **Clear
  activities** (audit, log lines and findings stay). **Export** (current filters, at most 200 activities) downloads the
  [activity bundle](tracing.md#activity-bundle), optionally with `traces=otlp`, or the activities alone from
  `/trace/export`.
- **Tracing off:** the request audit keeps recording and Activities lists it; any audit key (`path`, `provider`,
  `auditKind`, `httpStatus`) also lists the audit. A standalone host has no request audit, log stream or portal: no Log
  stream or Pages & render tab, and Export offers activities only.

The request audit stays its own ledger: it records at level `off`, keeps its sequence windows and backs
`connectRuntime().audit`; each entry names its activity by `traceId`.

### Old addresses

Earlier hashes are replaced in place (`history.replaceState`), so bookmarks and Lense links still land:

| Old address                  | Opens                                                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#dashboard[?…]`             | `#health[?…]`; a `panel` key gets the `dashboard-` prefix.                                                                                                                                                            |
| `#overview[?…]`              | `#home[?…]`.                                                                                                                                                                                                          |
| `#identity[?…]`              | `#access[?…]`.                                                                                                                                                                                                        |
| `#logs`, `#logs?type=<type>` | `#activity?tab=log`, `#activity?tab=log&type=<type>`.                                                                                                                                                                 |
| `#audit?<filters>`           | `#activity?<filters>` with `outcome` as `result` (`success` as `ok`, `pending` as `running`), `entity` as `table`, `search` as `q`, `kind` as `auditKind`, `status` as `httpStatus` and `correlationId` as `auditId`. |
| `#trace?<filters>`           | `#activity?<filters>`; with `traceId` (and `spanId`), `#activity/<traceId>[/<spanId>]?<other filters>`.                                                                                                               |
| `#evidence[?…]`              | `#activity?tab=pages`.                                                                                                                                                                                                |

## Status payload

`GET /_sim/api/status` on both hosts carries, among the runtime facts:

- `routes`: the `/_sim/api` prefixes this host answers (see [Routes](#routes)); anything else answers 404, and a
  standalone runtime never lists a portal prefix. `/_sim/events` is outside `/_sim/api` and is not listed.
- `eventChannels`: the `/_sim/events` channels this host serves (`logs` and `trace` on Power Pages, `trace` on the
  standalone host).
- `adminAdjacentRoutes`: model-driven routes outside `/_sim/api` that act with administration rights
  (`/_apps/api/webapi` and `/_apps/api/offline`; see [model-driven apps](model-driven-apps.md#routes)), listed only when
  the model-driven surface is enabled (empty on an API-only runtime).
- `traceHosts`: the values the trace `host` filter accepts; the Activity view's host filter lists them.
- `links`: `administration`, `setup`, and the `modelDriven`, `canvas`, `powerPages`, `dataverseApi` and
  `dataverseAuthority` addresses, each `null` when the runtime does not serve it.
- `modelDrivenApps`: the imported model-driven apps as `{ id, uniqueName, name }`.
- `docs`: documentation keys mapped to `{ href, path, label }`; `href` points at the release tag of the installed
  version (`main` for a prerelease). The Power Pages `GET /_sim/api/state` carries it too.
- `csrf` (see [tokens](#tokens)), `adminUrl` (`<adminOrigin>/_sim/`) and, on the Power Pages host only, `appsUrl`.

## Capabilities and preflight

The runtime state (`GET /_sim/api/state`, `simulator.state()`, standalone `status()`) carries `capabilities` and
`capabilityReport`; `GET /_sim/api/preflight` (`?requires=<id or glob>` repeatable, `?strict=true`) and
`simulator.preflight({ scenario, strict })` answer the live preflight report with the operation modes saved in `/_sim/`.
Both are described in [capabilities and preflight](capabilities-and-preflight.md).

## Messages and outbox

`GET /_sim/api/messages`, `DELETE /_sim/api/messages/<entity>` and the read-only `GET /_sim/api/outbox` are described in
[messaging and outbox](messaging-and-outbox.md). Credential-named values are redacted in every answer.

## Flow runs and waits

Both hosts serve `/_sim/api/flow-runs`, `/flow-waits` and `/flow-triggers`; without a flow run store they answer 501
`FlowRunsNotConfigured`. Routes, approval outcomes and resume errors are in
[flow runs, waits and approvals](operations.md#flow-runs-waits-and-approvals); a wait that was already answered is no
longer listed and answers 404 `FlowWaitNotFound`. Flow payloads get the same credential-name redaction, a run's trigger
input and secure outputs are never returned, and the run-starting requests are `http` trace roots that join the caller's
headers ([request tracing](tracing.md#flows-and-connectors)).

## Activity and trace routes

The trace routes (`/_sim/api/trace...`), the `/_sim/events?channels=trace` channel and the activity bundle are
documented in [request tracing](tracing.md#api); without a trace store they answer 501 `TraceNotConfigured`. A
`/_sim/api` write other than the trace routes and the run-starting flow routes is traced as an `http` root on host `sim`
acting as the system actor `simulator`; administration reads open no trace.

The Power Pages host also serves the reads that join other facts to an activity. The standalone host serves none of
`/logs`, `/render-sources` and `/audit`; its `/activity/export` answers the bundle without audit or log documents.
`GET /_sim/api/diagnostics` answers on both hosts.

- `GET /_sim/api/logs?since=<sequence>&limit=<n>&type=<type,…>&traceId=<id>` answers the retained lines of the runtime
  log stream (`mirage.logs.retain`, default 2000) as
  `{ items, latestSequence, oldestSequence, retained, dropped, retain, more }`, oldest first. With `since`, the lines
  after that sequence; without it, the newest `limit` lines (default 500, 1 to 50000). A line is
  `{ sequence, type, time, level, traceId, spanId, … }`, with `traceId` and `spanId` `null` outside any activity; its
  `type` is `startup` (one per startup step, with `phase`, `elapsedMs` and `message`), `request`, `liquid` or `data`
  (the finished audit `entry`), `plugin` (one declarative plug-in rule evaluated: `entity`, `operation`, `rule`,
  `result`, `changes`), `diagnostic` (the finding) or `reload` (`revision`, `message`). A malformed `since`, `limit`
  outside 1 to 50000, or a `type` other than these seven answers 400 `InvalidLogFilter` with `parameter`
  (`type must be one of startup, request, liquid, data, plugin, diagnostic, reload (got "bogus").`). The
  `/_sim/events?channels=logs` stream carries the same lines; its `connected` frame names the latest retained sequence.
- `GET /_sim/api/diagnostics?traceId=<id>` narrows the findings and the portal request ring to one activity. A finding
  raised during a request carries `traceId` and `spanId`; one raised while loading sources carries neither. Plug-in step
  and flow trigger completions (`PLUGIN_ASYNC_COMPLETED`, `PLUGIN_ASYNC_FAILED`, `FLOW_TRIGGER_COMPLETED`,
  `FLOW_TRIGGER_SKIPPED`), connector calls (`CONNECTOR_INVOKE`) and flow actions (`FLOW_ACTION`) also carry `name`,
  `entity` (when there is one) and, for plug-in steps, `message`.
- `GET /_sim/api/audit?traceId=<id>[,<id>…]` and `/audit/export` select the audit entries of up to 200 activities (more
  answers 400 `InvalidAuditFilter`).
- `GET /_sim/api/render-sources?refs=<id>[,<id>…]` resolves the `sourceRefId` of up to 100 render template steps to
  `{ sourceDir, items: [{ id, path, file, line, column, kind, name, recordId, field, languageId }], missing }`; `line`
  and `column` are `null` when the file no longer holds the loaded text; unresolved ids are listed in `missing`. Without
  refs or with more than 100 it answers 400 `InvalidRenderSourceRefs`.

## Health feed

Both hosts (Power Pages and standalone model-driven or Dataverse API runtimes) answer `GET /_sim/api/dashboard` with one
read-only JSON document. It is `no-store` and never carries the administration CSRF token. Every part except `activity`
passes through the same credential redaction as `/_sim/api/messages`; `activity` holds numbers only (plus request `at`,
`method`, `path`, `traceId` and `spanId`, storage provider `id` and `lastReloadAt`), so a diagnostic code or counter
whose name looks like a credential keeps its count. `HEAD` answers like `GET` without a body; any other method answers
405 with `Allow: GET, HEAD`. The route answers 503 `{ "status": "starting" }` only for a host that has not created its
organization; both hosts create it before their listener opens, so a running runtime does not answer 503.

Top-level keys:

- `generatedAt`: ISO time from the runtime clock (a fixed clock shows simulated time).
- `runtime`: `startedAt` (ISO time the runtime started, on its clock) and `uptimeMs` (read fresh on every answer),
  `product`, `kind`, `simulationLevel`, `clock` (`system` or `fixed`), `revision` (the source reload revision on Power
  Pages, `null` on the standalone host), `storeRevision`, `reloading`, `localOrigin`, `stateFile` (relative to the
  project root, `null` for dry-run), `projectRoot` (`.`). Power Pages adds `deploymentProfile`.
- `nodes`: `{ id, kind, label, status, level?, detail, link? }`. Ids follow one scheme on both hosts: `client:*`,
  `host:*`, `org:store`, `org:security` (role, user and team counts), `org:plugins`, `org:workflows`, `org:flows`,
  `org:jobs`, `org:trace` (the trace store: `level`, `persist` and `persistError`, linking to `#activity`; the map shows
  it as **Activity** in its **Monitor** group), `org:<module>` for every installed organization module,
  `provider:storage`, `provider:storage-route:<route>`, `provider:messaging`, `provider:messaging-endpoint:<entity>`,
  `provider:outbox`, `provider:connectors`, `connection:<id>`, `provider:secrets`, `provider:local-service:<id>`,
  `provider:service-fixture:<service>`, `provider:powerfx`, `app:canvas`, `app:code`, `external:azurite`,
  `external:servicebus-emulator`, `external:keyvault`, and one `external:webhook:<hostname>` per web hook target host
  (`listening` when the delivery rule contacts it: `http` or `https` to `localhost`, `*.localhost`, `127.0.0.0/8` or
  `[::1]`; `declared` otherwise; its `detail` carries `endpoints` and the same `loopback` flag). Power Pages adds
  `host:portal` (linking to `#home`), `host:identity-provider`, `app:pcf`, `bridge:live` and one `persona-runtime:<id>`
  per running persona runtime. Status is one of `listening`, `ready`, `declared`, `disabled`, `placeholder`, `missing`,
  `error`, `planned`. `link` names the `/_sim/` view that owns the node.
- `edges`: `{ from, to, kind, status, label }` with kind `http`, `bus`, `storage`, `webhook`, `process` or `reads`. Each
  web hook target node gets a `webhook` edge from `org:plugins`. Edges are the calls the runtime really makes: save
  hooks hang off `org:store`, Web API messages off `host:dataverse-api` (off `host:model-driven` when the listener is
  switched off, since its in-app Web API runs the same messages), background work off `org:jobs`. An edge is sent only
  when both ends are on the runtime; an edge touching a `disabled` node is `disabled` and listed on the card instead of
  drawn. A node that nothing calls says why in `detail.note`.
- `activity`: Dataverse API requests (`total` and `failed`: data-plane Web API requests under `/api/data/v*` since
  start, `$metadata` excluded; `other`: token, discovery, metadata document, SOAP and every other request on the
  Dataverse listener; TDS has its own listener and is not counted; the last 20 requests of any kind as `at`, `method`,
  `path`, `status`, `ms`, `traceId` and `spanId`), plug-in executions and failures, flow runs by status and overdue
  waits, durable jobs (pending, scheduled, running, recent failures, poisoned rows), asyncoperation rows by state, bus
  messages by state, outbox rows by state and pending byte deletes, web hook outcomes (`delivered`, `failed`,
  `notContacted`), storage operations per provider (`byProvider: [{ id, writes, deletes, bytesWritten }]`), diagnostics
  (`total`, `byCode`), the trace store (`trace`: `retained` traces, `spans`, `running`, `dropped`, `droppedSpans` and
  `latestSequence`; the `org:trace` drawer shows them with the node) and the raw counters. Power Pages adds the portal
  requests (`total` since start, `retained` ring length, at most 300; `recent` is the last 20, each with its `traceId`),
  `audit` (`retained`, `sequence`, `dropped`) and `reloads` (`revision`, `lastReloadAt`). Standalone adds `inFlight`
  (requests in progress other than this one) and reports `reloads: null`.
- `configuration`: pack ids with their module directory relative to the project root, Solution layers (`solution`,
  `version`, `type`), `settingsKeys` (names of the registered settings authored in the catalogue site, project file or
  project portal that the CLI or `createMirageContext` started from, never values; `null` for a runtime embedded through
  `createSimulator`, whose configuration source is not known) and `ports` (`portal`, `dataverseApi`, `dataverseTls`,
  `tds`, `identityProvider`, each a number or `null`).
- `docs`: the documentation link map (see `status.docs`).

Counters count activity since the organization runtime started; they are not persisted. Storage counters count
operations through the storage router, not what the store holds: `writes` (an overwrite is a write), `deletes` and
`bytesWritten` only grow. The shared part is rebuilt after a store write, a counter change, or at most every 5 seconds
so that message lock and schedule states and overdue waits follow the clock; two reads in the same 5-second window
without activity return identical `nodes`. `activity.trace` is read on every request, because each traced request moves
it without a store write; `nodes` carry configuration and topology only, so portal requests alone never change them.
Safe facts only: service endpoint URLs appear as a hostname, connections as id, provider and principal kind (never
`settings`), secrets as a key count. The feed never reads `GET /_sim/api/dataverse`, which shows the managed identity
header once. Preflight is not part of the feed; call `GET /_sim/api/preflight` when you need it.

## Pack inventory

Both hosts answer `GET /_sim/api/packs` with every registered pack (project `dataPacks`, explicit catalogue or
`--pack-module` entries, and module paths supplied to the API). Each pack carries `id`, `name`, `description`, `module`
(relative to the project root), `registration` (`source`: `project` for a pack listed in the project file, `explicit`
for a catalogue `mirage.dataPacks` entry or a `--pack-module` path, `api` for a pack passed to
`createSimulator({ packs })`; `setupLink`: `/_setup/#packs`), `matched` and `matchReason`, `exports` (count per
recognized export), `presets` (`id`, `name`), `configurationPresets`, `personas`, `personaCatalog` counts (`groups`,
`personas`, `contexts`, `scenarios`), `dataFiles` (`file`, `tables`, `writable` when the current simulation writes it,
`ownedTables`) and its export `diagnostics`. On Power Pages `matched` is the pack's `matches({ portal })` result for the
current portal, so packs the portal filtered out are listed with `matched: false`; the standalone host has no portal and
reports `matched: null` with `matchReason: "no portal context"`. `library` lists every data preset with its `pack` (or
`null`) and `source`; `failed` lists modules that did not load. The route is read-only: `HEAD` answers like `GET`
without a body, other methods answer 405 with `Allow: GET, HEAD`. Register or change packs in `/_setup/` and restart.

## Environment administration on both hosts

`GET /_sim/api/environment`, `PUT /_sim/api/environment/variables/<schemaName>` (`{ "value": "text" }`, or `null` to
remove the local value) and `DELETE /_sim/api/environment/variables/<schemaName>` are served by both hosts. Writes need
the administration token in `x-sim-csrf` (`csrf` of `/_sim/api/status`, or `simulator.csrf`). A local value is kept as
an override, so a Solution reload keeps it. A Secret definition accepts a Key Vault secret reference only and never
shows a value. `PUT /_sim/api/environment/profiles` selects a deployment profile on the Power Pages host. The standalone
host loads `deploymentProfiles` too (see [standalone organization](standalone-organization.md#shared-composition)): its
`profileSelection` summarizes the active profile, or answers `{ "supported": false, "reason": "…" }` when none is
configured; its `PUT /environment/profiles` answers 501 `{ "supported": false, "reason": "…" }`. With profiles
configured the reason names where to set the default profile (the catalogue site's `mirage.deploymentProfiles.default`,
or the project file's `deploymentProfiles.default`) before a restart; without them it is
`No deploymentProfiles are configured for this runtime.`. Its `live` field says the live bridge belongs to the Power
Pages host. The standalone `GET /_sim/api/diagnostics` and `status.diagnostics` carry `byCode`.

## Security headers

Both hosts serve `/_sim/` with
`Content-Security-Policy: default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
and `X-Content-Type-Options: nosniff`. Admin assets are served by pattern: `/_sim/<name>.mjs`, `.js` or `.css` where
`<name>` matches `^[a-z0-9-]+$` and the file exists in `mirage/admin/`, plus the shared modules `persona-search.mjs` and
`persona-picker-view.mjs` from `mirage/lib/`. The page itself answers only at `/_sim` and `/_sim/`. The administration
page is served by the administration listener to browsers: a navigation to `/_sim/` on the portal address redirects
there (see [Administration origin](#administration-origin)). A programmatic request without `Sec-Fetch-Site` or `Origin`
is still answered on the portal address. Modules are `text/javascript`, every asset carries `nosniff`, and any other
path answers 404 on both hosts, including `/_sim/index.html`, `..` and encoded separators, backslashes, upper-case
names, nested paths, server-side library modules and Windows device names such as `con.mjs`. The page allows no inline
script or inline style.
