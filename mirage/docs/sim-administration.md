# Local simulation administration

`/_sim/` is the loopback administration workspace. It exposes local tables/records, identity, roles, permissions, presets/scenarios, settings/snippets, runtime environment, source inspection, providers, platform resources, diagnostics and evidence. Changes here affect local state and rendering. Provider controls distinguish local configuration, optional reference reads and cached platform assets.

**Operations** lists exported server logic and cloud flows, including unlinked Solution workflows. Select a JSON response mock, keep an unsupported placeholder, explicitly enable trusted exported code or use a registered project handler. **Use source default** removes a local override. Exported role grants still apply; unlinked workflows receive no invented route or grants. See [operation modes and limits](operations.md).

Portal requests start anonymously. Local sign-in selects an active synthetic contact or explicit role override and stores a per-runtime `paqvilo-mirage-auth-<port>` cookie. The portal sign-in page, `_sim` and Lense Tweaks all operate on the browser session. Signing one browser in does not sign another browser in. The saved simulator identity is not a substitute for a request cookie.

Embedded tools call `simulator.signIn(contactId)` and send the returned cookie header. Playwright tests use `signInContext` from `paqvilo/mirage/testing/session.mjs`. Local session administration uses CSRF protection. Sign-out clears only the local session.

External identity-provider flows are local simulations for exported provider settings, with a local provider route and explicit redirect handling. They do not copy live credentials or mint genuine environment tokens. Actual live-reference sign-in belongs to the intended signed-in browser and its own identity.

Permission enforcement can be set to strict or permissive for local experiments; this choice is visible in evidence. Live create/update/delete cannot leave the runtime without `--allow-live-writes`, and still require the separate administration switch. Task authorization is required independently of either switch.
