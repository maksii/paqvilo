# Model-driven Lense Actions

[Model-driven Lense](../mirage/docs/model-driven-customizations.md#preview-the-same-code-with-lense)
overlays selected Solution sources on a native model-driven app with the same panel, source rows,
Inspect view, X-ray picker and keyboard controls as Power Pages Lense, plus an **Actions** tab.

## Shared panel capabilities

| Feature                      | Model-driven behavior                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local / Online               | Local overlays exact declared resource mappings; Online passes native requests through. Switching reloads the owned app tab with GET. Nothing is deployed.                                                                                                                                                                                                                                                                                                          |
| Live reload                  | Sources are watched while reload is paused; enabling Live reloads the owned tab on later saves. `--no-reload` starts paused.                                                                                                                                                                                                                                                                                                                                        |
| Overrides, counts and search | Applied counts belong to the current source revision; unobserved and paused resources stay distinct. Explore searches declared resources, forms and command sources.                                                                                                                                                                                                                                                                                                |
| Diff, Git baseline and scope | Edited markers and changed scope use the pinned Git HEAD of each source root; Pin HEAD updates it. Diff reads only the selected native script or stylesheet through the signed-in owned frame and compares the original local bytes, without debugger maps.                                                                                                                                                                                                         |
| Native comparison limits     | Decoded native reads stop at 3 MiB (compressed responses included) and are abandoned after 30 seconds without an answer. Comparison bytes stay in memory within a 16 MiB session budget. Non-text resources and API, authentication and shell routes are refused. Equality is unknown until observed, and a navigation or source revision invalidates an in-flight result. The line diff normalizes BOM and newlines; raw-byte differences are reported separately. |
| Inspect and X-ray            | See [selection evidence](lense.md#selection-evidence). DOM `data-id`, table-only and duplicate command matches do not establish ownership. Passive inspection does not read record IDs or field values.                                                                                                                                                                                                                                                             |
| Issues and Activity          | Owned-page errors, failed requests, source diagnostics, saves and mode switches use the shared views. Clearing a list does not repair its cause.                                                                                                                                                                                                                                                                                                                    |
| Panel controls               | Shared drag, resize, theme, collapse, search and progress controls; **Alt+Shift+L** hides, **Alt+Shift+P** opens, **Alt+Shift+O** switches source mode.                                                                                                                                                                                                                                                                                                             |
| Portal-specific content      | Liquid, portal snippets, page languages and portal personas have no model-driven equivalent. Deployment requirements stay diagnostics; Lense does not upload or publish.                                                                                                                                                                                                                                                                                            |

Ownership in a native app: a documented native API association with a control's outer frame can
establish its owner; DOM `data-id` matches, navigation context and a sole exported form remain
candidates and do not identify the children of that frame. Mirage can establish exact ownership through
its own bindings to the rendered node. Local source is checked independently and updates when the
relevant metadata loads. PCF details separate exported configuration from an observed constructor and
mount; a loaded bundle proves neither. Configured mappings do not prove a resource executed.

### Targets and agent sessions

The environment selector offers only declared model-driven targets; selecting does not navigate, and
REAL DATA targets ask for confirmation. Switching to another target origin retires the previous agent
identity (its token is refused and its discovery file removed) and opens a new one with its own id,
token and printed discovery path. Baselines, mode, Live and panel preferences are kept per target;
native comparison bytes are released and equality becomes unknown again.

Authentication redirects are intermediate states and are never intercepted. Leaving the target origin
(for example for sign-in) suspends the agent session with its id, token and discovery file unchanged:
`agent status` reports `inspection.suspended: true` with no pages, page routes answer
`409 session_suspended`, and Stop still ends the session. Returning to the same origin resumes it and
records `page-entered-origin`; requests the page makes before the inspector reattaches are not listed.

Actions use the signed-in native environment. Results stay in the panel until cleared, the target
changes or the session ends. Favorites and recent action names contain no record values; agent status,
events and snapshots never include action results, command code or the selected request identity.

## Declared environments

Reuse project references for environment names and origins, then opt each model-driven target in:

```yaml
references:
  - id: development
    name: Example app
    environment: Development
    origin: https://development.example.invalid
    default: true
  - id: review
    name: Example app
    environment: Review
    origin: https://review.example.invalid
modelDriven:
  trustedExtensions: true
  targets:
    - reference: development
      startPath: /main.aspx
      resourceMap: ./mappings/development.json
    - reference: review
      startPath: /main.aspx
      resourceMap: ./mappings/review.json
      caution: true
```

```sh
paqvilo lense model-driven dev --project project.yml --env development
```

Without `--env` the default reference is selected. A reference is not a model-driven target unless
listed under `targets`. Each target's resource map (relative to the project file) binds only exact paths
on its own origin; no origin, app URL or native cache path is guessed. Only the selected target is
activated or observed. `--url` targets one explicitly supplied origin; `--path` and `--resource-map`
override only the initial target. HTTP references are accepted only for opted-in loopback fixtures.
These declarations authorize local overlays, not deployment or live record writes; after a switch,
confirm sign-in and the account (a login page is not application proof).

## Available actions

Actions that need a record form are listed last on list pages, with the reason they are unavailable.
Search, favorites and recent names help find the rest.

| Group     | Actions                                                                                                                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspect   | Logical names (clickable, removable), changed fields, choice values, record ID and URL, saved record fields, table processes (workflows, business rules, flows, actions, bound custom APIs), environment and user, identity and acting-as privilege |
| Open      | Record by ID, new record, table list, record Web API, form editor, security, solutions, solution history, system jobs, processes, mailboxes, app home, Advanced Find, legacy mobile client, Power Platform admin center                             |
| Workflows | Form overrides and restore, refresh subgrids, prepare clone, discard and refresh, autosave guard, pin to the native side pane, find native users                                                                                                    |
| Diagnose  | Forms monitor, command checker, performance center, disable form handlers, business rules or form libraries, native dark theme, reset diagnostics; each reloads and asks before discarding a dirty form                                             |
| Identity  | Act as another user for this tab's Web API requests ([request identity](#request-identity))                                                                                                                                                         |
| Custom    | Your own JavaScript commands ([custom commands](#custom-commands))                                                                                                                                                                                  |

Support and community links only open pages. Results are limited to 200 rows with bounded values;
native reads stream and cancel above 2 MiB, and server pagination may hold more records. External
maker/admin destinations use the environment ID from the native context; unsupported cloud endpoints
stay unavailable.

## Form workflows

**Form overrides** snapshots visible, disabled and required states before changing them; Restore
reverses this session's changes. Navigating to another record or form, or stopping Lense, removes owned
labels and save handlers and restores owned adjustments. Server permissions still apply.

**Prepare clone** checks create eligibility, copies supported scalar, choice, date and single-lookup
values from the draft (keeping zero and false, excluding primary IDs and system-managed values) and opens
an unsaved native create form. Native main forms give no opening-success callback, so Lense reports the
request and shows a late failure only while its result is current. The user saves through the app.

**Discard and refresh** asks before discarding a dirty draft and refreshes without Save. **Autosave
guard** blocks save mode 70 only; Save and Save & Close stay available.

## Request identity

Identity search reads enabled Dataverse users. Starting requires the user's Microsoft Entra object ID, a
fresh eligibility read and the signed-in user's `prvActOnBehalfOfAnotherUser` privilege (a role name
never substitutes). While the banner is active, later `/api/data/v<major>.<minor>/` requests from the
owned tab carry `CallerObjectId`; explicit caller headers are kept, and other tabs, origins, assets and
authentication requests are untouched. Full navigation, **Stop** or stopping Lense clears it for future
requests only; refresh native data to see the change.

This is Web API impersonation, not a sign-in: the native shell and cached UI keep the signed-in account,
and Dataverse enforces the intersection of both users' permissions
([Microsoft's impersonation contract](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/impersonate-another-user-web-api)).

## Custom commands

Commands are stored per origin in browser local storage as version 1 documents. Import validates the
whole document before replacing the list and never runs code. **Run** passes native `Xrm` and a
cooperative `signal`; a command may return a value or a Promise, and results stay in the panel.

Commands are trusted JavaScript in the live app and can write data. The wait limit stops Lense waiting
and signals abort; it cannot cancel page JavaScript or a request already sent. Reloading the document
retires remaining page code, and late output is suppressed.

## Implementation boundaries

A fixed registry validates actions and parameters. Dispatch checks the owned main frame, exact origin,
session token and request identifier and returns acknowledgements only. Record and form identity is
read in the browser after an explicit action, and asynchronous results are rejected when the target or
session changes. Passive inspection never calls attribute-value or record-ID getters.
