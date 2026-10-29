# Owned-browser target isolation receipt

Local verification on 2026-10-28: Windows, Node 24.22.1 x64, Playwright Core 1.64.1,
Microsoft Edge (`msedge`) in headless test mode. The browser and disposable
profile belong to the fixture. All pages and the independent WebSocket proxy use
loopback; network confinement rejects other destinations. No existing browser,
portal, credentials or business records participate.

Command from a toolkit source checkout:

```sh
node --test test-browser/dev-session-close-errors.test.mjs
```

Result: seven tests passed, zero failed or skipped. The wire-fault test passed in
25.7 s. It exercises `openBrowser` with `attached: false` and the development
session owner, rather than changing an attached browser's ownership flag.

The independent proxy drops three actual `Page.getFrameTree` requests: a cancelled
initializer, a newly opened tab, and a popup. The last two reach the real 10,000 ms
deadline. Each failed owned tab closes; two healthy tabs retain distinct unsaved
drafts. Agent session/events/pages requests still succeed, event truncation is
checked, and a watcher sees a saved source change. A fresh retry executes that
changed source. Disconnecting the shared transport then reaches the owner stop
path. Teardown drains watchers and removes the owned agent discovery file.

The executed test and isolation implementation were unchanged from
`adf1b72c14e3b7060bc656fe7c479be39923e909`. Git blob identities:

| File                                             | Git blob                                   |
| ------------------------------------------------ | ------------------------------------------ |
| `test-browser/dev-session-close-errors.test.mjs` | `a23dc1fcbe74aec9c4d52e4f710b29d8d7629ba6` |
| `lense/dev-sessions.mjs`                         | `5e9b9ae2370e9c2e32325f65ac194dab298f0aa9` |
| `lense/intercept.mjs`                            | `ce8a3c52702e6586d215fb4fe157e2369885a8da` |

This receipt ships under `docs/` in the npm package. The executable test and proxy
helper are available in the source checkout, not the installed package. It proves
the exercised disposable-browser branch, not native/live portal qualification or
hosted CI readiness. Never inject faults into a user-owned or native browser.
