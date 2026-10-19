# Project workflows

Run from the project folder. This is the initial inventory; `package.json` remains
authoritative after customization. Editor refresh proposes script reconciliation;
it preserves project-authored scripts and edited editor files.

| Workflow | Effects and boundary |
| --- | --- |
| init | Files only; no install, browser or portal |
| setup / first install / ci | Registry/cache and tools; no portal, PAC, capture, sync or deployment |
| check:scaffold | Read-only completion; no pack execution |
| check:project | Offline all-site completion/adoption, paths, Sources and Mirage readiness; may probe ignored state/cache and loopback port availability |
| configure | Local server/browser; writes the selected configuration layer |
| editor:refresh when enabled | Updates untouched generated files, preserves edits with alternatives, proposes npm reconciliation |
| validate | Starter unit/smoke tests; skipped cases prove no acceptance coverage |
| validate:configured | Readiness plus successful declared acceptance cases for every configured site |
| mirage development / acceptance | Local runtime; authored assets can still request external hosts |
| Lense / mirage:capture / reference tools | Explicit authorized live/reference workflows; browser actions can change live data |

Settings saves affect the next preview start. Stop only your preview, refresh editor
files, reconcile proposals and restart. For hermetic CI block unexpected non-loopback
requests. `confinePortalPages` has asset/appearance tradeoffs and alone is not browser
network isolation. Mark real-data environments `caution: true`; let the user handle
credentials/MFA. Never copy discovery tokens into fixtures. See
[configuration](configuration.md), [data lifecycle](data-lifecycle.md) and
[acceptance](acceptance.md).

| npm script | Initial command |
| --- | --- |
{{commands}}
