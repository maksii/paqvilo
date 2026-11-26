# Native Power Pages portal Web API evidence

Two pairs of signed-in browser runs on the demo site (the demo portal `examples/project/portal` with the baseline
fixture site over it) sent portal Web API requests from a page of the site, recorded on 2026-11-08. Each run created
its own owned account, contact and note rows first, then ran the same plan of cases against them and against new rows,
and read each result back. The hosted build was not recorded.

| Suite                      | Capture IDs                                                    | Cases |
| -------------------------- | -------------------------------------------------------------- | ----- |
| `demo-writes-20261108`     | `portal-batched-1794140041144`, `portal-batched-1794142100102` | 288   |
| `demo-raw-bodies-20261108` | `portal-batched-1794144140507`, `portal-batched-1794144234893` | 20    |

`demo-writes` covers string values at each column's limits (special characters, markup, Unicode, encoded text, line
breaks, null, empty, maximum and over-long), typed values of number, money, decimal, float, choice, yes/no, date-only and
date-time columns, malformed and raw bodies, an omitted and an invalid request verification token, content types,
lookup binds and filtered queries. `demo-raw-bodies` sends raw JSON roots as PATCH bodies.

The converter (`capture-portal-webapi.mjs`) reads each run's plan and results. A case names its owned row by
placeholder (`{account}`, `__ID__`) and the run marker becomes `webapi-fixture`, so live record ids and run names never
enter a case. Each case carries the values its owned row held before it (`before`), from the run's bootstrap and the
earlier cases' read-backs, so a case replays on its own. A case enters a suite only when both runs gave it the same
input. The output keeps the status, the error's code and message and the read-back; inner error texts are not kept.
Where the two runs differ only in a value derived from the run marker (an account's ticker symbol, which a demo plug-in
derives from the name), the build records the pointer as volatile.

`lexer.string-17` is left out: it sends an encoded object naming a column the account table does not have. The
platform knows every column of the system table; the demo export describes only the columns it uses, so the local
runtime cannot tell an absent column from one that is not enabled for the Web API.

The adapter (`adapters/portal-webapi.mjs`) serves the demo site with its plug-in models and the site's observed Web API
settings, the choices that site's own captures established (the CDS error message, the anti-forgery answer, reference
errors, inner errors, invalid dates and the classic request body decoding).

To regenerate, run the converter for each pair of run folders, then build each suite:

```sh
node mirage/test/parity/capture-portal-webapi.mjs FIRST_RUN SECOND_RUN FIRST_CAPTURE SECOND_CAPTURE
node scripts/parity-cases.mjs build --surface portal-webapi --suite demo-writes-20261108 \
  --capture FIRST_CAPTURE --capture SECOND_CAPTURE
```

The existing suite supplies the oracle description when regenerating its case file.
