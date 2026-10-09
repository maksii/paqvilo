import test from "node:test";
import assert from "node:assert/strict";
import { mergeShellProfile } from "../lib/shell-profile.mjs";

test("shell recapture preserves independent observations and replaces only the requested page layout", () => {
  const previous = {
    headScripts: ["/old.js"],
    pageCopyLayouts: [
      { pageId: "owned", path: "/owned/", layout: 1 },
      { pageId: "another", path: "/another/", layout: 2 },
    ],
    observedStylesheets: [
      { path: "/theme.css", sourceSha256: "old" },
      { path: "/other.css" },
    ],
    snippetCompositions: [{ parentName: "Empty", childName: "Action" }],
    richTextConfigurations: [
      { url: "/editor.json", sourceSha256: "rte" },
      { url: "/editor2.json", sourceSha256: "other-rte" },
    ],
    managedControls: { rte: { kind: "native" } },
    footerLogos: { sourceSha256: "footer" },
  };
  const original = structuredClone(previous);
  const updated = mergeShellProfile(
    previous,
    {
      headScripts: ["/new.js"],
      pageCopyLayouts: [{ pageId: "owned", path: "/owned/", layout: 3 }],
      observedStylesheets: [{ path: "/theme.css", sourceSha256: "new" }],
    },
    { pagePath: "/owned/" },
  );
  assert.deepEqual(updated.headScripts, ["/new.js"]);
  assert.deepEqual(
    updated.pageCopyLayouts.map((x) => x.layout),
    [2, 3],
  );
  assert.deepEqual(
    updated.observedStylesheets.map((x) => x.sourceSha256),
    ["new", undefined],
  );
  assert.deepEqual(updated.snippetCompositions, previous.snippetCompositions);
  assert.deepEqual(
    updated.richTextConfigurations,
    previous.richTextConfigurations,
  );
  assert.deepEqual(updated.managedControls, previous.managedControls);
  assert.deepEqual(updated.footerLogos, previous.footerLogos);
  assert.deepEqual(previous, original);
  const absent = mergeShellProfile(
    updated,
    { headScripts: [] },
    { pagePath: "/owned" },
  );
  assert.deepEqual(
    absent.pageCopyLayouts.map((x) => x.pageId),
    ["another"],
  );
  assert.deepEqual(absent.snippetCompositions, previous.snippetCompositions);
});
