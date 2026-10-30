# Power Fx differential checks with PAC

This optional development tool compares a fixed corpus of pure formulas with Microsoft's PAC console evaluator. It is not a runtime dependency and is not part of the default CI commands. Its unit tests use synthetic process results, so CI does not require PAC, credentials or a Dataverse connection.

Run from a prepared toolkit checkout with a Windows PAC executable:

```powershell
New-Item -ItemType Directory -Force .paqvilo | Out-Null
node scripts/power-fx-oracle.mjs --pac "$env:LOCALAPPDATA\Microsoft\PowerAppsCLI\Microsoft.PowerApps.CLI.2.13.1\tools\pac.exe" > .paqvilo/power-fx-report.json
```

Use the actual `pac.exe` for your installation, rather than its `pac.cmd` launcher. `--pac` can be omitted when `pac.exe` is on PATH. The runner produces one JSON report and exits nonzero for differences, unavailable PAC, an unrecognized output format, unsafe authentication context, timeouts or process errors. There is no successful skip when PAC is absent. It accepts no external formulas or environment argument: only the built-in pure corpus is executed.

The development implementation is in `mirage/test-support/power-fx-oracle.mjs`; the command is `scripts/power-fx-oracle.mjs`. Neither is shipped as a runtime dependency. The corpus covers text, arithmetic, date-only values with explicit culture, table and record projections, errors and coercion. Large numeric values are compared as formatted text, preserving every digit. Runtime errors are compared by Power Fx error kind, with messages retained as diagnostic information. Unresolved error-kind probes fail the comparison. Host differences are listed separately and remain in the report.

## What was observed

On October 26, 2026, PAC `2.13.1+g251dee1` on Windows evaluated the pure corpus without an authentication profile. A child process received fresh `LOCALAPPDATA`, `APPDATA` and `USERPROFILE` directories; `pac auth list` confirmed that no profiles existed before evaluation. This is an empirically checked isolation mechanism for the tested installation, not a documented cross-version guarantee. The runner refuses to evaluate formulas unless that empty-profile check succeeds. It never reads, copies, selects or clears the user's existing profile files.

PAC returned process exit code zero even when a formula produced an error. Redirected output combined a UTF-8 banner with UTF-16LE echoed formulas and results. The parser checks ordering, completeness and expression errors rather than treating exit code zero as a pass. It rejects unrecognized output instead of guessing. Process time and output size are bounded, and each run removes only its own temporary profile directory.

The observed PAC language was `en-150`; Mirage's default was `en-US`. Culture-sensitive corpus cases explicitly request `en-US`, and date-only cases avoid time-zone-dependent instants. These checks do not establish date/time parity for every host or locale. A rejecting-proxy experiment succeeded, but proxy settings can be bypassed: unrestricted offline execution has **not** been proven.

## Corrections established by the comparison

- `IfError(1/0,"x")` produces a number-conversion error. `IfError(Text(1/0),"x")` returns text. Mirage now coerces a selected replacement when the failing expression's type can be inferred without evaluating unselected branches. Numeric replacements retain exact decimal precision and Float identity. Dynamic types that cannot be inferred retain their previous behavior and report `POWER_FX_IFERROR_TYPE_UNKNOWN`; a complete native type checker remains outside this implementation.
- Numeric `Text` formatting preserves large exact decimals instead of first converting them to a JavaScript double. Regression cases also cover the observed Float presentation, rounding, grouping, percentages and literals. This does not claim complete native custom-format support.
- Numeric placeholders retain intervening literals, distinguish literal percent signs from scaling placeholders, and apply repeated percentages, trailing comma scaling and positional zero padding. These cases were checked against isolated PAC 2.13.1 on October 27, 2026. Custom-format language markers and multiple format sections remain outside this baseline; the PAC console rejects some formats documented for Canvas apps.

The checked-in regressions use sanitized expected values established by PAC. Machine-specific commands and raw research evidence stay under ignored `.paqvilo/`; no auth profiles or business data are fixtures.

A subsequent review added exact numeric scalar comparisons, scientific notation, `Blank()` and numeric locale-separator cases. The parser preserves significant digits instead of first rounding both sides to JavaScript numbers. Numeric `Text` uses the requested locale's decimal/group separators and reports invalid language tags; culture-specific grouping patterns beyond the tested cases remain a gap.

## Scope

PAC is a console host. Canvas apps, Dataverse formula columns and other Power Fx hosts enable different functions and apply different context rules. A matching pure corpus is evidence for those cases, not proof of complete Canvas, Dataverse or Power Fx parity. The current runner targets the tested Windows PAC output; Linux, macOS, other PAC versions and localized console messages have not been validated.

See Microsoft's [PAC Power Fx command reference](https://learn.microsoft.com/power-platform/developer/cli/reference/power-fx) and [IfError type-compatibility rules](https://learn.microsoft.com/power-platform/power-fx/reference/function-iferror#type-compatibility).
