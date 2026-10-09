# Liquid conformance

`paqvilo mirage liquid-conformance --suite <golden_liquid.json> --markdown` evaluates a recorded golden suite and classifies differences using `lib/liquid-conformance-rules.json`. Cases distinguish platform-unsupported behavior, DotLiquid divergence and engine gaps.

Maintain the golden suite and captured outputs in your portal project, retaining the tested engine/version, reference origin context, capture date and source provenance. Do not infer a platform engine version from local output alone. Keep missing reference observations visible and do not replace them with invented expected values. Generic regressions should reduce a discovered issue to a synthetic test in `mirage/test/`.
