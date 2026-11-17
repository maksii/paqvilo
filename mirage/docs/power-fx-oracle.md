# Power Fx differential checks with PAC

An optional development tool that evaluates a fixed corpus of pure formulas with Microsoft's PAC console evaluator
(`pac power-fx`) and compares the results with Mirage's interpreter. It is not a runtime dependency and not part of CI;
its own unit tests use synthetic process results, so CI needs no PAC, credentials or Dataverse connection.

From a toolkit checkout with a Windows PAC installation:

```powershell
New-Item -ItemType Directory -Force .paqvilo | Out-Null
node scripts/power-fx-oracle.mjs --pac "<path-to>\pac.exe" > .paqvilo/power-fx-report.json
```

- Pass the actual `pac.exe`, not the `pac.cmd` launcher; omit `--pac` when `pac.exe` is on `PATH`. The only accepted
  argument is `--pac`: the runner takes no formulas or environment, and runs only its built-in corpus.
- It prints one JSON report and exits 1 for any difference, missing PAC, unrecognized output, unsafe authentication
  context, timeout or process error. A missing PAC is a failure, never a skip.
- Code: `mirage/test-support/power-fx-oracle.mjs` (corpus and runner) and `scripts/power-fx-oracle.mjs` (command).
  Neither ships as a runtime dependency.

## How the comparison works

- **Isolation.** PAC runs in a child process with fresh `LOCALAPPDATA`, `APPDATA` and `USERPROFILE` directories, and the
  runner evaluates nothing unless `pac auth list` confirms that no profile exists there. It never reads, copies,
  selects or clears your own profiles, and removes only its temporary directory. This is checked per run, not a
  documented PAC guarantee; offline execution is not enforced.
- **Output.** PAC exits 0 even when a formula errors, and its redirected output mixes a UTF-8 banner with UTF-16LE
  echoed formulas and results. The parser checks order, completeness and expression errors instead of trusting the
  exit code, and rejects output it does not recognize. Process time (45 s) and output size are bounded.
- **Values.** Large numbers are compared as formatted text, keeping every digit. Runtime errors are compared by Power
  Fx error kind, with messages kept as diagnostics; an unresolved error-kind probe fails. Host differences are listed
  separately in the report.
- **Corpus.** Text and numeric formatting, arithmetic, date-only values, table and record projections, errors and
  coercion. Culture-sensitive cases request `en-US` explicitly, because PAC's console language can differ from
  Mirage's `en-US` default, and date-only cases avoid time-zone-dependent instants.

Regression tests (`mirage/test/power-fx-oracle*.test.mjs`, `power-fx-text-oracle.test.mjs`) keep sanitized expected
values. Raw evidence stays under ignored `.paqvilo/`; no profiles or business data are fixtures.

## Scope

PAC is a console host. Canvas apps, Dataverse formula columns and other hosts enable different functions and context
rules, so a matching pure corpus is evidence for those formulas only, not Canvas, Dataverse or full Power Fx parity.
Known limits of the local interpreter that this check exposes: `IfError` coerces a replacement only when the failing
expression's type can be inferred (otherwise `POWER_FX_IFERROR_TYPE_UNKNOWN`), and numeric `Text` does not support
custom-format language markers, multiple format sections or culture-specific grouping beyond the tested cases. The
runner targets Windows PAC output; other platforms, PAC versions and localized console messages are not supported.

See the [PAC Power Fx command reference](https://learn.microsoft.com/power-platform/developer/cli/reference/power-fx)
and [IfError type compatibility](https://learn.microsoft.com/power-platform/power-fx/reference/function-iferror#type-compatibility).
