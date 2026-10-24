# What runtime evidence proves

Each kind of check proves something different. Report them separately, and never present one as another.

| Check                                                                                          | What it proves                                                                                   | What it does not prove                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Source inventory (`liquid-inventory`, `webapi-inventory`, `bootstrap-report`, `/_sim/` counts) | Which configuration and code the export contains and Mirage can read                             | That a page renders or behaves like the live portal |
| Local render or browser run (`render-sweep`, `portal-matrix`, your browser tests)              | That the local runtime renders and runs those pages for the tested persona, data and window size | That the hosted site does the same                  |
| Project acceptance test                                                                        | That one simulated business scenario works end to end locally                                    | Behaviour for other personas, data or deployments   |
| Recorded reference comparison (`parity-suite`, `baseline-suite`)                               | Parity for the compared routes, identities and data only                                         | Parity for anything not compared                    |

A sign-in page, an HTTP 200 or an inventory match is not a passing page. Always report coverage and skipped or incomplete cases alongside passes, and keep runtime errors, failed requests, unmatched source patches and unsupported diagnostics with the result. Record the source baseline, local scenario, permission mode and toolkit version so a result can be reproduced.

Store business screenshots, logs, state and reference captures under the project's ignored `.paqvilo/`. To compare with a live reference, see [reference parity evidence](parity-evidence.md).
