# Persona catalogues and isolated setups

Catalogues describe **which contact to test and why**. Contacts, parent accounts and
exported web-role memberships remain the identity source. Metadata never creates
records or grants permissions. Legacy pack `personas` keeps its existing meaning.
Additive datasets may separately opt in to materializing explicit `personaRoles`
descriptors; see [data generation](data-packs.md). Catalogue metadata is never an
input to that operation. Applying a portal data preset can separately replace local
contact memberships using `personaRoles`; see the [preset contract](data-packs.md).

## Version 1 contract

`personaCatalog` is a data property on a registered pack, a preset body, or a
`dataset()` fragment. All use the same schema. `validatePersonaCatalog(value,
'Data pack my-pack')` from `paqvilo/mirage/packs` returns a detached value or throws
`InvalidPersonaCatalog`, naming the source and field. Version 1 and the public
helpers follow the [semver policy](../../docs/public-api.md).

```js
const personaCatalog = {
  version: 1,
  groups: [{ id: 'review', label: 'Review', order: 10, subgroups: [{ id: 'own', label: 'Own records' }] }],
  personas: [
    {
      key: 'reviewer-own',
      contactId: '11111111-1111-4111-8111-111111111111',
      label: 'Reviewer with own records',
      group: 'review',
      subgroup: 'own',
      tags: ['reviewer', 'own'],
      description: 'Reviews own synthetic records.',
      order: 10,
      startPath: '/reviews/',
      context: 'alternate',
      extensions: { 'my-pack:fixture': { revision: 2 } },
    },
  ],
  contexts: [
    {
      id: 'alternate',
      label: 'Alternate configuration',
      deploymentProfile: { profile: 'test', enabled: { pages: true } },
      environmentVariables: { sample_Enabled: true },
      portalOverrides: { snippets: { 'Home/Welcome': 'Local fixture' }, settings: { 'Feature/Preview': 'true' } },
      browser: {
        locale: 'en-GB',
        timezoneId: 'Europe/London',
        viewport: { width: 1280, height: 800 },
        colorScheme: 'light',
      },
    },
  ],
  scenarios: [
    {
      id: 'review-own',
      label: 'Review own records',
      group: 'review',
      persona: 'reviewer-own',
      context: 'alternate',
      startPath: '/reviews/',
    },
  ],
};
export default {
  id: 'my-pack',
  name: 'Synthetic fixtures',
  description: 'Project fixtures',
  matches: ({ portal }) => portal?.website?.name === 'Synthetic site',
  personaCatalog,
  presets: () => ({}),
};
```

| Field              | Rules                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top level          | `version: 1`, required `groups`, `personas` arrays; optional `contexts`, `scenarios`. Empty arrays are valid. Unknown fields fail.                                                                                  |
| IDs and keys       | Lowercase letters, digits, dots, underscores, hyphens; start with a letter/digit. Unique within each collection; subgroup IDs unique within a group.                                                                |
| Groups             | Required `id`, `label` (1–60 characters); optional integer `order`, `subgroups`. Subgroups accept `id`, `label`, `order` only. Two levels maximum.                                                                  |
| Personas           | Required `key`, GUID `contactId`, declared `group`; optional `label` (1–80), declared `subgroup`, `tags`, `description`, `order`, `startPath`, declared `context`, `extensions`. GUID matching ignores case/braces. |
| Tags / description | Up to 20 lowercase alphanumeric/hyphen tags, each 1–40 characters. Plain-text description up to 500; card shows its first line. HTML is escaped.                                                                    |
| Ordering           | Integer `order`, default 1000; then label and stable ID/key. Other contacts follow catalogue groups.                                                                                                                |
| Navigation         | `startPath` starts with `/`; external URLs, protocol-relative paths, backslashes, encoded path escapes and control characters fail. Query/fragment supported.                                                       |
| Scenarios          | Required `id`, `label`, declared `group`, `persona`; optional `description`, `order`, declared `subgroup`, `context`, `preset`, `startPath`.                                                                        |
| Extensions         | Personas/contexts accept namespaced keys (`my-pack:fixture`) containing finite, acyclic JSON up to 32 levels deep. Mirage returns this metadata without executing it.                                               |

Contexts accept `id`, `label`, `description`, `order`, `deploymentProfile`,
`environmentVariables`, `portalOverrides`, `preset`, `startPath`, `browser`,
`extensions`. Profile selection references an **already configured** profile ID,
with optional boolean `pages`, `environmentVariables`, `connectionReferences`
flags under `enabled`. Omit it to inherit; `{profile:null}` disables selection,
subject to required sections. It cannot supply arbitrary file paths.

Variables map names to typed JSON. Snippet/settings overrides map names to strings
or `null` (remove). Contexts cannot override roles/access rules. Browser options
accept valid locale/time zone, viewport width/height 1–16384, and `light`, `dark`,
`no-preference` colour scheme. The browser testing helper applies these options;
ordinary tab navigation cannot change browser locale or viewport.

## Storage and precedence

- A preset supplying a catalogue replaces state metadata; one without it preserves
  the existing catalogue. Dataset fragments add entries by key/ID; existing state
  wins. Group subgroups merge by ID.
- Matching pack catalogues apply to every state. State entries win; among packs,
  the first registered definition wins. Conflicting contact IDs for a pack key
  produce `PERSONA_CATALOG_KEY_CONFLICT`.
- Missing pack contacts increment `skipped` silently. Each missing/inactive state
  contact produces `PERSONA_CATALOG_CONTACT_MISSING`.
- Active uncatalogued contacts appear under **Other contacts**. One contact may
  have several keys for different configurations/scenarios.

Each authored catalogue declares its referenced groups/personas/contexts.
`mergePersonaCatalogs(primary, fallback)` merges without mutating inputs. State
catalogues survive restart and state export.

## Picking and management

Sign-in renders groups/subgroups and submit buttons on the server and works without
JavaScript. With a catalogue, `/_sim/#access` uses the same picker for browser
identity and a chooser dialog for **Contact personas**. Without one, the existing
list/select UI remains.

Search ignores accents/case and AND-matches terms across label, contact name, key,
email, account, roles, group/subgroup labels, tags and full description. Facet values
combine with OR within a facet and AND between facets. Counts exclude duplicated
Default/Pinned/Recent cards. **Has web roles** hides entries without effective
roles. Share filters as `#identity?q=reviewer&tag=own&role=Reviewer`.

Pin cards with the star. Five recent choices are remembered per browser/source.
The configured default appears first in a Default row and in its own group.
Selecting a browser persona does not change another visitor's session.

Expand **Persona catalogue & local runtimes** to edit personas, groups/subgroups,
contexts and scenarios. Editors offer profiles, typed variable maps, snippet/setting
maps and browser options. Customizing pack metadata copies the entry and required
references into state. Removing an override reveals the pack entry beneath it.
Invalid references fail validation. Import replaces state metadata; Export writes
the effective catalogue. Reset removes only state metadata. Saves use a catalogue
digest; concurrent edits require a reload before saving.

`/_sim/sign-in?persona=reviewer-own&returnUrl=/reviews/` presents one persona and a
CSRF-protected button. GET never establishes a session. Unknown keys return 404
with nearby keys. This explicit simulator shortcut is available even when the
source site disables native local login.

## Isolated contexts and scenarios

A context, or a scenario with a preset, starts a local runtime from a consistent
snapshot of the parent and applies preset, profile and overrides to that copy. It
has its own cookie, state and loopback origin; live forwarding/writes are disabled
on launch. Parent state/source files stay intact. If the preset removes the selected
contact, launch fails and the new copy is disposed.

The same context definition and `instanceKey` reuse a runtime and its edits, even
when the persona or scenario start page differs. Scenarios without a context keep
their own copies. Different keys/setups use separate copies. Definition edits
produce a new copy on next launch.
Use unique keys for independent tests; share a setup among cookie-isolated visitors.
Context resolves scenario → persona; preset resolves scenario → context; start page
resolves explicit return URL → scenario → persona → context → `/`.

The default maximum is four copies. Configure
`sites.<id>.mirage.personaContexts: {maxInstances:2}` (also under defaults), or
`createSimulator({personaContexts:{maxInstances:2}})`. Range 0–32; zero disables
launches. **Stop and discard** resets a copy; relaunch snapshots the current parent.
Children cannot start nested copies. Return to the parent to switch setup. Parent
shutdown removes owned copies. Temporary copies do not survive parent restart.
If stopping a child fails, its status remains `stopping`; retry Stop to finish cleanup.
It cannot be reused while stopping. Other owned children still close if one fails.
Their files stay under the project's ignored `.paqvilo/persona-runtimes/` folder.
Children follow the parent's source-watch setting; source refreshes preserve each
copy's local data and configuration overrides.

Copies share the Node process: configuration/data are isolated, CPU/heap are shared.
Startup scales with dataset size and each copy retains its own decoded data. For
millions of rows, share setups, keep the instance limit low, and run separate Mirage
processes/state files for independent CPU workers. Ordinary visitor sessions do not
copy data. Snapshot writing streams without one whole-state JSON string.

## API and testing

`GET /__sim/api/personas` preserves identity/permission/web-role/membership fields.
With a catalogue it adds version/enabled, joined personas, groups/subgroup counts,
other/total/skipped/diagnostics, contexts/scenarios, effective `catalog`,
`stateCatalog`, `catalogDigest`, source `scope`, session and owned runtimes. Without
one, `personas` keeps the legacy shape. Catalogue values are local admin data; do
not put secrets in fixture catalogues.

| API                                       | Operation                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /__sim/api/persona-catalog`          | `{catalog,expectedDigest}` validates/saves state metadata.                                                                                          |
| `DELETE /__sim/api/persona-catalog`       | `{expectedDigest}` resets state metadata.                                                                                                           |
| `POST /__sim/api/personas/launch`         | `{personaKey}` or `{scenario}`, optional `instanceKey`, `returnUrl`; returns actual origin/path/identity/browser options and sets the local cookie. |
| `GET /__sim/api/persona-runtimes`         | Lists owned copies and the limit.                                                                                                                   |
| `DELETE /__sim/api/persona-runtimes/<id>` | Stops/discards an owned copy.                                                                                                                       |

Writes require `x-sim-csrf`; `connectRuntime` handles it:

```js
import { connectRuntime, createPersonaSession, createPersonaBrowserContext } from 'paqvilo/mirage/testing';
const sim = await connectRuntime({ config: './paqvilo.config.yml', site: 'demo' });
const report = await sim.personas();
// sim.savePersonaCatalog(catalog, {expectedDigest:report.catalogDigest});
const visitor = await sim.createSession({ personaKey: 'reviewer-own', instanceKey: 'run-42' });
try {
  await visitor.request(visitor.persona.path);
} finally {
  await visitor.close();
}

const opened = await createPersonaBrowserContext(browser, {
  origin: sim.origin,
  scenario: 'review-own',
  instanceKey: 'browser-run-42',
});
try {
  const page = await opened.context.newPage();
  await page.goto(opened.url);
} finally {
  await opened.context.close();
}
```

`createPersonaSession` accepts `{config,site}` or `{origin}` directly. Management
methods include `launchPersona`, `personaRuntimes`, `stopPersonaRuntime`,
`savePersonaCatalog`, `resetPersonaCatalog`. Closing a visitor/browser context
leaves shared copies running; stop owned test instances through the parent or close
the parent. Testing descriptions exclude identity cookies and expose persona
extensions as `visitor.persona.extensions` for project automation.

## Identity-provider and Lense pickers

The local external identity provider reads the owning runtime's effective catalogue. It
shows labels, contact names, descriptions, role/tag/account facets, ordered groups/subgroups,
Default, Other contacts, and browser-local pinned/recent choices. GET search works without
JavaScript; JavaScript updates results and the URL while preserving the search input. Search
is case/accent insensitive, folds ø/æ/œ/ß/đ/ł, and ANDs terms and facets while ORing values
inside one facet. Supported parameters: `q`, `group`, `subgroup`, `role`, `tag`,
`account`, `hasRoles`; repeated values select multiple options.

Responses show 50 matching personas per page (hard cap 200); Show more/Previous preserve
filters and the authorization request. Filter menus start collapsed, and GET responses with
active facets expand them. Groups above 25 matches start collapsed. One POST
form owns existing-persona buttons; a separate form owns registration so Enter creates the
entered identity. Protocol fields are never repeated per persona. Each identity
card explains the session effect. Contexts remain explicit isolated setups in the full picker;
selecting an identity at the provider does not silently apply its configuration.

New user follows the site's registration and provider switches. `prompt=create` exposes
a forced registration test; `newUser: never` still suppresses it. Forced choices name the
settings that may reject the callback. Forged creation POSTs are checked server-side.

Configure the local chooser in site/default Mirage settings:

```yaml
mirage:
  identityProvider:
    newUser: auto # auto | always | never
    presentation: dialog # page | dialog (same-origin presentation)
    title: Choose a test operator
    description: Select the identity for this browser session.
    accentColor: '#315bd5'
    head:
      stylesheets: [./local/identity.css]
      scripts: [./local/identity.js]
```

Head assets resolve relative to the catalogue/project root, must remain inside it even
through symlinks, and are served on the local provider under reserved paths. CSS custom
properties `--persona-accent`, `--persona-surface`, `--persona-border`,
`--persona-muted` and stable `chooser-*` classes support branding and layout. Scripts
are explicitly trusted project code. These settings/assets stay local and never change
exports or a connected provider. Dialog presentation retains the provider's separate origin
and frame protection. The display button switches between a bounded dialog layout and a
full page. Credential/MFA simulation is outside this chooser.

Lense Tweaks uses the same catalogue and indexed search rules, renders 50 results at a
time, retains pinned/recent choices per browser, and links to the full management picker.
Catalogue scenario choices name the persona, start page and isolated-setup effect. Opening
one prepares the local setup and completes the portal's own sign-in flow before the start
page. Uncatalogued contacts retain a searchable fallback.
