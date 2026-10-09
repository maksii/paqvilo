import test from "node:test";
import assert from "node:assert/strict";
import {
  observedPageCopyLayout,
  resolveObservedPageCopy,
} from "../lib/observed-pagecopy-layout.mjs";
const portal = {
  pages: [
    {
      id: "page",
      url: "/owned/",
      html: '{% comment %}<link href="/old.css">{% endcomment %}<script defer src="/file.js"></script>',
    },
  ],
};
const html =
  '<div class="page-copy"><div class="xrm-editable-html xrm-attribute"><div class="xrm-attribute-value"><script defer src="/file.js"></script><div class="row sectionBlockLayout text-left" style="display: flex; flex-wrap: wrap; margin: 0px; min-height: auto; padding: 8px;"><div class="container" style="padding: 0px; display: flex; flex-wrap: wrap;"><div class="col-md-12 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"></div></div></div></div></div></div>';
const options = {
  pageId: "page",
  path: "/owned/",
  origin: "https://portal.example",
};
test("observed empty Studio structure is page/source/origin bound and contains no record or executable content", () => {
  const profile = observedPageCopyLayout(html, {
    portal,
    path: "/owned/",
    origin: options.origin,
  });
  assert.equal(profile.pageId, "page");
  assert.doesNotMatch(JSON.stringify(profile.layout), /script|file.js/);
  const result = resolveObservedPageCopy(portal.pages[0].html, {
    ...options,
    profiles: [profile],
  });
  assert.match(result.source, /class="page-copy"/);
  assert.match(result.source, /columnBlockLayout/);
  assert.equal(
    resolveObservedPageCopy("Edited", { ...options, profiles: [profile] })
      .diagnostic.code,
    "PAGE_COPY_LAYOUT_SOURCE_CHANGED",
  );
  assert.equal(
    resolveObservedPageCopy(portal.pages[0].html, {
      ...options,
      origin: "https://other.example",
      profiles: [profile],
    }).diagnostic.code,
    "PAGE_COPY_LAYOUT_ORIGIN_CHANGED",
  );
  assert.equal(
    resolveObservedPageCopy("Edited", {
      ...options,
      pageId: "other",
      profiles: [profile],
    }).source,
    "Edited",
  );
  assert.throws(
    () =>
      resolveObservedPageCopy(portal.pages[0].html, {
        ...options,
        profiles: [{ ...profile, layoutSha256: "bad" }],
      }),
    /integrity/,
  );
});
test("unexpected copy changes are never recorded and nonempty/active Studio sections fail closed", () => {
  assert.equal(
    observedPageCopyLayout(html.replace("/file.js", "/other.js"), {
      portal,
      path: "/owned/",
      origin: options.origin,
    }),
    undefined,
  );
  for (const changed of [
    html.replace("min-width: 250px;", "background:url(https://evil.example);"),
    html.replace('class="col-md-12 columnBlockLayout"', 'onclick="save()"'),
    html.replace(
      "</div></div></div></div></div></div>",
      "PRIVATE</div></div></div></div></div></div>",
    ),
  ])
    assert.throws(
      () =>
        observedPageCopyLayout(changed, {
          portal,
          path: "/owned/",
          origin: options.origin,
        }),
      /unsupported|empty div/,
    );
});
