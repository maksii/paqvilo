# Feedback follow-up evidence audit

This review covers the isolated follow-up for feedback 63–64, 66 and 68–72 and its
operator/demo audit. Completion means the stated contract has the evidence below.
It does not establish complete hosted Power Pages compatibility or certify unrelated
changes on the shared parity branch.

| Area | Evidence and practical limit |
| --- | --- |
| 63: acceptance settling | Actual loopback browser navigation, late requests, document replacement and bounded settling tests. This tests the acceptance runner's lifecycle contract. |
| 64: date writes | The original parser-only live check was insufficient and closure was premature. Superseding native POST/PATCH/readback comparisons cover 170 cases over five behavior/format combinations, with 340 independent backend checks. Native form controls, other cultures, Liquid/query date calendars and full error text/stacks remain outside that comparison. |
| 66/69: Windows persistence | Actual Windows volume run: 600,000 rows, streamed save/reload/digest, 20 HTTP PATCHes over 300,000 rows, restart, concurrent clients and external-change conflicts. Performance numbers describe that machine/run. Arbitrary trusted plugins can still require full transaction snapshots. |
| 68: configuration presets | Synthetic pack/runtime regressions for binding, validation, explicit application, read-only catalogues and status/audit provenance. These are toolkit configuration contracts. |
| 70: persona chooser | Actual loopback browser and no-JavaScript tests for registration, selection, grouped search, bounded paging, facets, project presentation, narrow layouts and Escape. Styling/customization is a local toolkit feature. |
| 71: Lense scenarios | Loopback browser/catalogue tests for portal sign-in and isolated scenarios. They do not establish that every native identity provider accepts a synthetic persona. |
| 72: persona validation/search | Synthetic missing-group/return-URL checks and transliterated search. These are toolkit input/search contracts. |
| Operator sessions/demo | Loopback demo browser verifies simulated Entra callback, reader/editor roles, sign-out, parent-session isolation and owned-runtime cleanup. This exercises the simulated provider; it does not authenticate against real Entra. |
| Scaffold | Installed-package and focused scaffold checks exercise the generated project workflow. They do not deploy a starter to a live tenant. |

The date audit exposed assumptions in existing local regressions: true DateOnly was
treated as timestamp truncation and given the instant reader's invalid-date error code.
Those expectations were replaced using actual native observations. The implementation
now distinguishes storage behavior from display format, truncates fractions without a
second rollover, preserves independent clocks, and accepts the observed month-first
instant inputs. Seasonal formatted annotations require explicit project-owned rules.
See [date contract and limits](../mirage/docs/dataverse-parity.md#observed-portal-culture-parsed-dates).

The same native fixture exposed a provisioning read-after-create visibility delay and
missing explicit datetime display-format support. Required metadata reads now retry
bounded 404s; mutations are never repeated. Manifest format validation and drift tests
cover the metadata distinction. Native evidence, fixture metadata and cleanup receipts
remain in the private project, with no customer data or environment identity in core.

Native comparison, synthetic regression coverage and release validation are separate
results. A passing local test is not a native observation, and a blocked native save is
not a completed persistence comparison.
