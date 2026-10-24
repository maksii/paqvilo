# Liquid conformance

`paqvilo mirage liquid-conformance` runs a [golden-liquid](https://github.com/jg-rp/golden-liquid) suite file through the Mirage renderer and classifies every case that differs from the Shopify Liquid expectation. The suite is not bundled; download the version pinned in `mirage/lib/liquid-conformance-rules.json`.

```sh
paqvilo mirage liquid-conformance --suite <golden_liquid.json> --markdown --out .paqvilo/liquid-conformance.md
```

Options: `--rules FILE` (default `mirage/lib/liquid-conformance-rules.json`), `--json` or `--markdown`, `--out FILE`, `--timeout MS`. The report is informational and does not fail a build.

Each differing case falls into one category:

| Category               | Meaning                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `platform-unsupported` | A tag, filter or syntax that DotLiquid and Power Pages do not provide.                                                  |
| `dotliquid-divergence` | Mirage renders what DotLiquid (or the filter Power Pages registers over it) renders, which differs from Shopify Liquid. |
| `engine-gap`           | Mirage differs from DotLiquid. A differing case without a rule is reported here too.                                    |

Rules for cases that now pass are listed as stale.

The default rules compare the public Shopify suite with DotLiquid; they are not observations of a live Power Pages site. The runner supplies each case's data and partial templates with empty portal settings and objects, and an invalid case passes when any Liquid error occurs. For portal context or exact error text, use a project renderer test or a [reference comparison](parity-evidence.md). Reduce a discovered engine issue to a synthetic test in `mirage/test/`.
