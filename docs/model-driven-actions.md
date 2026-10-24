# Model-driven Lense Actions

Start [model-driven Lense](../mirage/docs/model-driven-customizations.md#preview-the-same-code-with-lense) with selected Solution sources and trusted local extensions. Model-driven apps and Power Pages use the same Lense panel, source rows, Inspect view, X-ray picker, loading/error feedback and keyboard controls. Model-driven apps add an **Actions** tab. Its tools render inside the panel and follow the same theme, size and position.

## Shared panel capabilities

| Power Pages feature | Model-driven behavior |
| --- | --- |
| Local / Online | Local overlays exact declared resource mappings. Online passes native requests through. Switching reloads the owned app tab with GET. This does not deploy sources. |
| Live reload | Source watching continues while reload is paused. Saving imports the new local revision; enabling Live reloads the owned app tab on later saves. `--no-reload` starts paused. |
| Overrides, source counts and search | Applied counts belong to the current source revision. Unobserved and paused resources remain distinct. Explore searches declared resources, forms and command sources; Open and Copy use the selected source paths. |
| Diff, Git baseline and scope | Edited markers and changed scope use pinned Git HEAD for each selected source root. Pin HEAD updates that baseline. Diff explicitly reads only the exact selected native script/stylesheet through the signed-in owned frame, then compares original local bytes without added debugger maps. |
| Native comparison limits | Decoded native reads stop at 3MiB, including compressed responses. Native comparison bytes remain memory-only, with a 16MiB session budget and eviction. Unknown native equality remains unknown until observed. A navigation or source revision change invalidates an in-flight result. Non-text resources and API/authentication/shell routes are refused. The shared line diff normalizes BOM/newlines; a raw-byte difference is reported separately. |
| Inspect and X-ray | The same picker, layers, selection guard, ancestry and source-opening controls match native `data-id` identifiers to the current exported form, field, PCF and ribbon command. Table-only matches are candidates; duplicate command matches never establish ownership. Passive inspection does not read record IDs or field values. |
| Issues and Activity | Owned-page errors, failed requests, source diagnostics, saves and mode switches use the shared views and filters. Clearing a list does not repair its cause. |
| Panel controls | The same drag, resize, theme, collapse, hide, search, keyboard and progress controls apply. `Alt+Shift+L` hides, `Alt+Shift+P` opens and `Alt+Shift+O` switches source mode. |
| Session and target ownership | Agent status, debugger access and Stop retain the existing origin/tab ownership rules. The shared environment selector offers only explicitly declared model-driven targets. Selecting alone does not navigate; REAL DATA targets require confirmation. Switching retires the previous identity, action transport and agent before activating the next target. Source baselines, mode, Live and panel preferences remain per target. Native comparison bytes are released on retirement; equality is unknown again until reobserved. Authentication redirects are intermediate states; their origins are never intercepted. |
| Portal-specific content | Liquid execution, portal snippets, page languages and portal persona setup have no native model-driven equivalent. Source deployment requirements remain diagnostics; Lense does not upload or publish. |

Configured mappings and source coverage do not prove a resource executed. Inspect the current revision's applications, unmatched requests, diagnostics, actual native behavior and screenshots.

Actions use the signed-in native environment. Each action describes its effect and explains missing native API support. Inspection results stay in the browser panel until cleared, the native target changes, or the Lense session ends. Favorites and recent action names contain no record values. Browser agent status, events and inspection snapshots do not include action results, command code, or the selected request identity.

## Declared environments

Reuse project references for environment names and origins, then opt each model-driven target in explicitly:

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

Start with `paqvilo lense model-driven dev --project project.yml --env development`.
Without `--env`, the declared default reference is selected. General references are not automatically model-driven targets. Each target's map binds only exact paths on its own origin; no origin, app URL or native cache path is guessed. Maps resolve relative to the project file. Only the selected target is activated or observed; showing a selector does not probe other environments. `--url` remains available for one explicitly supplied origin, while `--path` and `--resource-map` override only the initially selected target. Model-driven HTTP references are permitted only for explicitly opted-in loopback fixtures.

These declarations authorize local source overlays, not deployment or live record writes. Browser actions still use the selected native environment. Confirm sign-in and the intended account after a switch; a login document is not application proof.

## Available actions

Actions that need a record form (field, draft and form tools) are listed last on list pages, with the reason they are
unavailable there. Search, favorites and recent action names help find the rest.

| Group | Actions |
| --- | --- |
| Inspect | Logical names (clickable, removable), changed fields, choice values, record ID and URL, all saved fields of the record, table processes (workflows, business rules, flows, actions and bound custom APIs), environment and signed-in user |
| Open | Record by ID, table list, record Web API, form editor, security, solutions, solution history, system jobs, processes, mailboxes, app home, Advanced Find, legacy mobile client, Power Platform admin center |
| Workflows | Form overrides and restore, refresh subgrids, prepare clone, discard and refresh, autosave guard, new record, pin to the native side pane, find users |
| Diagnose | Forms monitor, command checker, performance center, disable form handlers, business rules or form libraries, native dark theme, reset diagnostics; each reloads and asks before discarding a dirty form |
| Identity | Act as another user for Web API requests of this tab (see [Request identity](#request-identity)) |
| Custom | Your own JavaScript commands (see [Custom commands](#custom-commands)) |

Support and community links only open pages; Lense never posts or submits anything.

## Form workflows

**Form overrides** snapshots the current visible, disabled and required states before changing them. Restore reverses this session's changes. Navigating to another record/form or stopping Lense removes owned labels and save handlers and restores owned form adjustments. Server permissions continue to apply.

**Prepare clone** reads actual create eligibility and copies supported scalar, choice, date and single-lookup values from the form draft. It preserves zero and false, excludes primary IDs and system-managed values, and requests an unsaved native create form. Native main forms do not expose an opening-success callback; Lense reports the request and shows a late failure only while its browser result is still current. The user saves the draft through the app.

**Discard and refresh** asks before discarding a dirty draft and calls native refresh without Save. **Autosave guard** separately blocks save mode 70. Ordinary Save and Save & Close remain available. Diagnostic reloads also ask before discarding a dirty draft.

Results are limited to 200 rows and individual displayed values are bounded. Native action reads stream decoded bytes and cancel above 2MiB; a response without a bounded stream is unavailable. Server pagination may contain further records. Legacy navigation and diagnostic flags remain subject to the native environment's support. External maker/admin destinations use the environment ID supplied by the native context; unsupported cloud endpoints remain unavailable rather than being guessed.

## Request identity

Identity search reads enabled Dataverse users. Start requires an actual Microsoft Entra object ID, a fresh eligible-user read, and the signed-in user's native `prvActOnBehalfOfAnotherUser` privilege. A role's display name never substitutes for the privilege.

The active banner names the selected user and provides **Stop**. Future `/api/data/v<major>.<minor>/` requests in the owned tab receive `CallerObjectId`. Existing explicit caller headers are preserved. Other tabs, origins, assets and authentication requests retain their existing behavior. Full document navigation and stopping Lense clear the identity. Stop affects future requests; it cannot recall requests already sent. Refresh native data to observe the new visibility; already loaded rows do not change retroactively.

This is Web API request impersonation, not account sign-in or a complete alternate-user native UI session. The native shell and cached role-dependent UI continue to use the signed-in account. Dataverse enforces the intersection of both users' permissions. See [Microsoft's impersonation contract](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/impersonate-another-user-web-api).

## Custom commands

Commands are stored per origin in browser local storage as version 1 documents. Import validates the whole document before replacing the command list; importing never runs code. Review the editor, then select **Run**. A command receives native `Xrm` and a cooperative `signal`, and can return a value or await a Promise. Results and failures remain in the browser panel.

Custom commands are trusted JavaScript in the live app and can perform native operations, including writes. The wait limit stops Lense waiting and signals abort; it cannot forcibly cancel arbitrary page JavaScript or a request already sent. Commands that ignore the signal may continue. Reloading the document retires its remaining page code. The inspector removes its owned timers and suppresses late output when retired.

## Implementation boundaries

The fixed action registry validates allowed actions and parameters. The dispatch binding checks the owned main frame, exact origin, session token and request identifier. It returns acknowledgements only. Native record/form identity is captured in the browser after an explicit action, and asynchronous results are rejected if the target or session changes. Passive inspection does not call attribute-value or record-ID getters.
