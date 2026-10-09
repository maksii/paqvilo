import test from "node:test";
import assert from "node:assert/strict";
import { registerShellConventions } from "../lib/extensions.mjs";
// A neutral footer logo container class (packs declare their own).
registerShellConventions("test", { footerLogoClass: "site-footer-logos" });
import {
  observedFooterLogos,
  observedFooterLayout,
  reconcileFooterLogos,
  validateFooterLogoMarkup,
} from "../lib/footer-capture.mjs";
const source =
  '<footer><span>{{year}}</span><section class="site-footer-logos"><svg><path d="M0 0"/></svg></section></footer>';
const observed =
  '<html><body><input value="SECRET"><section class="site-footer-logos"><svg viewBox="0 0 5 5"><defs><style>.a{fill:#fff}</style></defs><path class="a" d="M1 1"/></svg><img src="/logo.png" alt="Public logo"></section><script>SECRET</script></body></html>';
test("observed static footer graphics are source-bound and never capture surrounding identity or scripts", () => {
  const profile = observedFooterLogos(observed, {
    footerSource: source,
    origin: "https://portal.example",
    path: "/work/",
  });
  assert.doesNotMatch(profile.markup, /SECRET|input|script/);
  const result = reconcileFooterLogos(
    source.replace("{{year}}", "2026"),
    source,
    profile,
  );
  assert.match(result.html, /<span>2026<\/span>/);
  assert.match(result.html, /Public logo/);
  const changed = source + " ";
  assert.equal(
    reconcileFooterLogos(changed, changed, profile).diagnostic.code,
    "FOOTER_SOURCE_CHANGED",
  );
  assert.throws(
    () =>
      reconcileFooterLogos(source, source, {
        ...profile,
        markup: profile.markup + " ",
      }),
    /integrity/,
  );
});
test("footer capture rejects active elements, event attributes and external SVG/CSS references", () => {
  for (const unsafe of [
    "<svg><script>alert(1)</script></svg>",
    '<svg onload="alert(1)"></svg>',
    "<svg><foreignObject><input></foreignObject></svg>",
    '<svg><use href="https://evil.example"></use></svg>',
    "<svg><style>.a{fill:url(https://evil.example)}</style></svg>",
    '<img src="//evil.example/logo.png">',
    '<svg><style>@import "evil";</style></svg>',
  ])
    assert.throws(() => validateFooterLogoMarkup(unsafe));
  assert.match(
    validateFooterLogoMarkup(
      '<svg><defs><path id="p" d="M1 1"/></defs><use href="#p"/></svg>',
    ),
    /href="#p"/,
  );
});
test("observed intrinsic SVG sizing is source-bound to its exact mapped stylesheet", () => {
  const path = "/styles/theme.css",
    sourceCss = ".site-footer-logos svg {max-height:5rem}",
    observedCss = ".site-footer-logos svg { width:auto;max-height:5rem }";
  const layout = observedFooterLayout({ path, sourceCss, observedCss });
  const profile = observedFooterLogos(observed, {
    footerSource: source,
    origin: "https://portal.example",
    layout,
  });
  const active = reconcileFooterLogos(source, source, profile, {
    styleSources: { [path]: sourceCss },
  });
  assert.match(active.html, /style="width:auto"/);
  assert.equal(active.diagnostic, undefined);
  const edited = reconcileFooterLogos(source, source, profile, {
    styleSources: { [path]: sourceCss + " " },
  });
  assert.doesNotMatch(edited.html, /width:auto/);
  assert.equal(edited.diagnostic.code, "FOOTER_LAYOUT_SOURCE_CHANGED");
  assert.throws(
    () =>
      reconcileFooterLogos(
        source,
        source,
        { ...profile, layout: { ...layout, svgWidth: "42px" } },
        { styleSources: { [path]: sourceCss } },
      ),
    /integrity/,
  );
  assert.equal(
    observedFooterLayout({
      path,
      sourceCss,
      observedCss: ".other svg {width:auto}",
    }),
    undefined,
  );
  assert.equal(
    observedFooterLayout({
      path,
      sourceCss,
      observedCss:
        "@media(min-width:1000px){.other{color:red}.site-footer-logos svg {width:auto}}",
    }),
    undefined,
  );
});
