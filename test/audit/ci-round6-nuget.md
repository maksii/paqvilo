# Round 6: ServiceClient dependency advisories

The Linux SDK log exposed 14 existing NuGet advisories: 13 high and one moderate. They affected the ServiceClient gate's transitive `System.Security.Cryptography.Pkcs` 8.0.1 and `System.Security.Cryptography.Xml` 8.0.2. The original `dotnet list ... --vulnerable --include-transitive --format json --no-restore` exited **zero** while reporting all 14 records. Its JSON is retained at `.paqvilo/audit/round1-mirage/nuget-serviceclient-before.json`.

These dependencies belong to the unshipped SDK compatibility gate, rather than Paqvilo's runtime package. That limits the exposed surface, but does not prove the indirect WCF/XML/CMS paths are unreachable. The advisories were fixed rather than suppressed or dismissed. The primary advisory records and affected-version ranges are retained in `.paqvilo/audit/round1-mirage/nuget-advisory-triage.json`.

## Fix and recurrence check

The gate now directly selects the same-series patched versions, Pkcs **8.0.2** and Xml **8.0.5**, with their new NuGet content hashes recorded in `packages.lock.json`. `Microsoft.PowerPlatform.Dataverse.Client` remains **1.2.27**, including its complete baseline lock entry. The target remains `net10.0`; the public WebAPI sample pin, SOAP/WebAPI program, assertions, and SDK lanes remain unchanged.

The SDK verification lane now audits immediately after the ServiceClient locked restore. It checks a full resolved inventory against the complete committed lock, then reads the direct and transitive vulnerability report. Missing frameworks or packages in the inventory, lock/version mismatches, diagnostics, malformed reports, command failures, advisories at any severity, and project/lock changes during the check fail verification. NuGet legitimately omits `frameworks` from a clean vulnerability report; that shape is accepted only after the separate complete inventory has been validated. No warning or advisory suppression was added.

## Observed verification

- Fresh locked restore succeeds. The actual resolved inventory contains **30 packages** matching the lock; the fresh vulnerability report contains **zero advisory records**, down from 14. Source and lock SHA256 values are in `.paqvilo/audit/round6-nuget-proof.json`.
- The original required ServiceClient gate passes **3/3**, zero skips, with both SOAP and WebAPI passes and every original assertion retained: `.paqvilo/audit/round6-serviceclient-gate.tap`.
- The preparation/audit contracts pass **20/20**, including zero-exit advisory reports, all four severities, incomplete inventories, unavailable audit data, wrong projects/frameworks, and source changes: `.paqvilo/audit/round6-nuget-audit-contracts-final.tap`.
- Independent source review accepted the dependency patches, mandatory SDK audit placement, complete inventory comparison, and fail-closed parser, including malformed lock graphs and audit sources. No remaining finding was reported.

These are local receipts. Fresh full validation and hosted CI/security qualification must cover the final pushed head; earlier green heads do not qualify this change.
