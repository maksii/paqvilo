import test from "node:test";
import assert from "node:assert/strict";
import { applyPortalOverrides, portalOverrideEntries, validatePortalOverrides } from "../lib/portal-overrides.mjs";
import { pageAccess } from "../lib/page-access.mjs";
import { pageAccessRules } from "../lib/page-resources.mjs";

const source = () => ({
  settings: {},
  snippets: {},
  pages: [
    { id: "home", name: "Home", url: "/", parentId: null },
    { id: "secure", name: "Secure", url: "/secure/", parentId: "home" },
  ],
  records: [
    { kind: "webrole", id: "member", name: "Member" },
    { kind: "webrole", id: "editor", name: "Editor" },
    { kind: "webpageaccesscontrolrule", id: "restrict", name: "Members only", _file: "C:/portal/webpagerule.yml", adx_webpageid: "secure", adx_right: 2, adx_scope: 1, adx_webpageaccesscontrolrule_webrole: ["member"] },
  ],
});
const member = { id: "c1", contactId: "c1", roleSource: "memberships", roles: ["Member"], roleIds: ["member"] };
const editor = { id: "c2", contactId: "c2", roleSource: "memberships", roles: ["Editor"], roleIds: ["editor"] };

test("local page access rule overrides change, add and remove effective rules without touching the export", () => {
  const exported = source();
  assert.equal(pageAccess(exported, "/secure/", member).allowed, true);
  assert.equal(pageAccess(exported, "/secure/", editor).allowed, false);
  const overrides = {
    accessRules: {
      restrict: { name: "Editors only", webPageId: "secure", right: 2, scope: 1, roleIds: ["editor"] },
      "local-grant": { name: "Members may change", webPageId: "home", right: 1, scope: 1, roleIds: ["member"] },
    },
  };
  const effective = applyPortalOverrides(exported, overrides);
  assert.equal(pageAccess(effective, "/secure/", editor).allowed, true);
  assert.equal(pageAccess(effective, "/secure/", member).allowed, true, "an inherited grant-change rule wins over restrict read");
  assert.equal(exported.records.find((record) => record.id === "restrict").adx_webpageaccesscontrolrule_webrole[0], "member", "the exported record is unchanged");
  const entries = portalOverrideEntries(exported, overrides, "accessRules");
  assert.deepEqual(entries.map((entry) => [entry.id, entry.overridden, entry.deleted]), [["local-grant", true, false], ["restrict", true, false]]);
  assert.deepEqual(entries.find((entry) => entry.id === "restrict").sourceValue, { name: "Members only", webPageId: "secure", right: 2, scope: 1, roleIds: ["member"] });
  assert.equal(entries.find((entry) => entry.id === "restrict").sourceFile, "C:/portal/webpagerule.yml");
  const rules = pageAccessRules(effective, effective.pages[1], editor, overrides);
  assert.deepEqual(rules.map((rule) => [rule.id, rule.inherited, rule.matches, rule.overridden, rule.rightLabel]), [
    ["restrict", false, true, true, "Restrict read"],
    ["local-grant", true, false, true, "Grant change"],
  ]);
  const removed = applyPortalOverrides(exported, { accessRules: { restrict: null } });
  assert.equal(pageAccess(removed, "/secure/", editor).allowed, true);
  assert.equal(portalOverrideEntries(exported, { accessRules: { restrict: null } }, "accessRules")[0].deleted, true);
});

test("page access rule overrides reject malformed rights, scopes, roles and fields", () => {
  for (const value of [
    { name: "x", webPageId: "secure", right: 3, roleIds: ["member"] },
    { name: "x", webPageId: "secure", right: 2, scope: 5, roleIds: ["member"] },
    { name: "x", webPageId: "secure", right: 2, roleIds: [] },
    { name: "x", right: 2, roleIds: ["member"] },
    { name: "x", webPageId: "secure", right: 2, roleIds: ["member"], extra: true },
    "restrict",
  ])
    assert.throws(() => validatePortalOverrides({ accessRules: { rule: value } }), /Page access rule/);
  assert.doesNotThrow(() => validatePortalOverrides({ accessRules: { rule: null } }));
});
