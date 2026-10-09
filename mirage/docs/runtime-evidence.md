# What runtime evidence proves

Offline unit tests establish reusable semantics on invented input. Loopback browser tests establish that local adapters, forms, scripts and sessions work in the tested browser. Source inventories establish discoverable configuration and code coverage. Project acceptance tests establish a particular simulated business scenario. Recorded reference comparisons establish parity only for their observed cases and identities.

Some adapters were informed by historical reference comparisons. Their original captures remain with the owning private portal project; the public distribution contains the reusable implementation and synthetic regressions. A reference to this guide explains the evidence policy and does not supply a recorded comparison for your portal.

Always report coverage and skipped/incomplete cases alongside passes. Capture runtime errors, failed requests, unmatched source patches and unsupported diagnostics. Keep source baseline, local scenario, permission mode and implementation fingerprint visible. Do not extrapolate a local result to every portal, persona or deployment.

Store business screenshots, logs, state and reference captures under the project's ignored `.paqvilo/`. Public CI may retain only synthetic evidence selected by `scripts/collect-evidence.mjs`; it must not upload full browser storage or agent discoveries.
