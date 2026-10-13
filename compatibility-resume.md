# Historical compatibility handoff — 2026-10-11

This dated handoff describes the state before the Company Operations work. It is not a current action list or live-state inventory. Use [the implementation specifications](docs/design/company-operations-demo.md), [the regression project](examples/company-operations/README.md) and private current installation evidence for continuation. Reconcile the intended environment before any live change.

Previous generated lab scripts, packages, captures and reports were removed at the user's request on 2026-10-11. Do not treat previous completion claims as proof of compatibility.

1. Build a small, usable recording solution: four permission hierarchies eight levels deep, read/edit role variants, simple Liquid FetchXML pages showing authored and effective XML, and a RetrieveMultiple plugin recording the actual incoming query. Provide a run button and browsable history.
2. Add representative forms and an update plugin chain recording call order, depth, ParentContext, SharedVariables, images and related updates. Prove one complete recorded run before expanding coverage.
3. Compare online behavior with Mirage for Liquid, form/Web API input and search, Microsoft default templates, and all Power Pages configuration types including roles and permissions. Fix only measured differences; support corresponding Lense editing/debugging.
4. Complete and verify PCF support, configurable original-plugin execution/mocks and per-step administration, and supported Power Automate import/execution. Do not add FakeXrmEasy.
5. Finish one task at a time using focused implementation subagents; the lead validates outcomes. Keep fixtures outside toolkit source, run relevant regressions and npm run validate, then commit, push and produce a green PR.

## Online state needs review

Local cleanup does not remove online fixtures. The PaqviloRecordingLab solution, pqvd recording tables/data, forms and plugin assembly remain. The last PAC upload succeeded and its follow-up reported 35 roles and 201 permissions, but the complete installation audit failed; rendered behavior was not verified. Two recorder steps were last verified disabled: 63a3bd3c-a37a-5a50-bf2f-5c8ed7ccd16b and 42446ce4-db68-52ae-816c-8c03af137161. The test contact's original parent account was null and still needs restoration after reviewing its current value. Inventory live state before changing or recreating anything.
