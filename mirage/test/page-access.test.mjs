import test from "node:test";
import assert from "node:assert/strict";
import { pageAccess, shortcutAccess } from "../lib/page-access.mjs";
const base = () => ({
  pages: [
    { id: "home", url: "/", parentId: null },
    { id: "child", url: "/child/", parentId: "home" },
    { id: "grandchild", url: "/child/grandchild/", parentId: "child" },
  ],
  records: [
    { kind: "webrole", id: "reader", name: "Reader" },
    { kind: "webrole", id: "editor", name: "Editor" },
    {
      kind: "webrole",
      id: "anonymous",
      name: "Anonymous",
      adx_anonymoususersrole: true,
    },
  ],
});
const rule = (id, page, roles, right = 2, scope = 1) => ({
  kind: "webpageaccesscontrolrule",
  id,
  adx_webpageid: page,
  adx_right: right,
  adx_scope: scope,
  adx_webpageaccesscontrolrule_webrole: roles,
});

test("a missing sibling role does not cancel a proven active role's page grant or itself grant access", () => {
  const p = base();
  p.records.push(rule("mixed", "home", ["reader", "missing-role"]));
  const allowed = pageAccess(p, "/child/", {
    id: "one",
    roleSource: "memberships",
    roleIds: ["reader"],
    roles: ["Reader"],
  });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.diagnostics[0].roleIds, ["missing-role"]);
  for (const identity of [
    { id: "two", roles: ["missing-role"] },
    { id: "two", roleSource: "memberships", roleIds: ["missing-role"] },
    { id: "two", roles: ["Editor"] },
  ]) {
    const denied = pageAccess(p, "/child/", identity);
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, "PAGE_ACCESS_DENIED");
  }
  p.records = p.records.filter((record) => record.id !== "reader");
  assert.equal(
    pageAccess(p, "/child/", { id: "one", roles: ["Reader"] }).code,
    "PAGE_RULE_UNRESOLVED",
  );
});

test("membership identities use only resolved renamed default roles and role IDs", () => {
  const p = base();
  p.records.push({
    kind: "webrole",
    id: "signed-in",
    name: "Portal signed-in members",
    adx_authenticatedusersrole: true,
  });
  p.records.push(rule("auth-only", "home", ["signed-in"]));
  assert.equal(
    pageAccess(p, "/child/", {
      id: "person",
      roleSource: "memberships",
      roles: [],
    }).allowed,
    false,
  );
  assert.equal(
    pageAccess(p, "/child/", {
      id: "person",
      roleSource: "memberships",
      roles: ["Portal signed-in members"],
      roleIds: ["signed-in"],
    }).allowed,
    true,
  );
  assert.equal(
    pageAccess(p, "/child/", {
      id: "person",
      roleSource: "memberships",
      roles: ["Authenticated Users"],
    }).allowed,
    false,
  );
  assert.equal(
    pageAccess(p, "/child/", {
      id: "person",
      roleSource: "memberships",
      roles: ["Portal signed-in members"],
      roleIds: ["another-role"],
    }).allowed,
    false,
  );
  assert.equal(
    pageAccess(p, "/child/", { id: "person", roles: [] }).allowed,
    true,
  );
  p.records.find(
    (record) => record.id === "signed-in",
  ).adx_authenticatedusersrole = "false";
  assert.equal(
    pageAccess(p, "/child/", { id: "person", roles: [] }).allowed,
    false,
  );
  p.records = p.records.filter((record) => record.id !== "auth-only");
  p.records.push(rule("anon-only", "home", ["anonymous"]));
  assert.equal(
    pageAccess(p, "/child/", { roleSource: "memberships", roles: [] }).allowed,
    false,
  );
  // The Anonymous Users role "respects only table permissions": no page grant.
  const anonymous = pageAccess(p, "/child/", {
    roleSource: "memberships",
    roles: ["Anonymous"],
    roleIds: ["anonymous"],
  });
  assert.equal(anonymous.allowed, false);
  assert.ok(anonymous.diagnostics.some((d) => d.code === "PAGE_RULE_ANONYMOUS_ROLE_IGNORED"));
});
test("page restrictions inherit and support role IDs, names and edit grant override", () => {
  const p = base();
  p.records.push(rule("private", "home", ["reader"]));
  assert.equal(
    pageAccess(p, "/child/", { id: "person", roles: [] }).allowed,
    false,
  );
  assert.equal(
    pageAccess(p, "/child/", { id: "person", roles: ["Reader"] }).allowed,
    true,
  );
  assert.equal(
    pageAccess(p, "/child/", { id: "person", roles: ["reader"] }).allowed,
    true,
  );
  p.records.push(rule("edit", "home", ["editor"], 1));
  assert.equal(
    pageAccess(p, "/child/grandchild/", { id: "person", roles: ["Editor"] })
      .allowed,
    true,
  );
});
test("same-page restrictions allow any matching rule; nested restrictions also apply", () => {
  const p = base();
  p.records.push(
    rule("a", "home", ["reader"]),
    rule("b", "home", ["editor"]),
    rule("c", "child", ["editor"]),
  );
  assert.equal(
    pageAccess(p, "/child/", { id: "person", roles: ["Reader"] }).allowed,
    false,
  );
  assert.equal(
    pageAccess(p, "/child/", { id: "person", roles: ["Editor"] }).allowed,
    true,
  );
});
test("page scope 1 protects direct assets and scope 2 excludes only direct child files", () => {
  const p = base();
  p.records.push(rule("restrict", "home", ["reader"], 2, 1));
  assert.equal(
    pageAccess(
      p,
      { file: "app.js", metadata: { adx_parentpageid: "home" } },
      { id: null, roles: [] },
    ).allowed,
    false,
  );
  p.records[3].adx_scope = 2;
  assert.equal(
    pageAccess(
      p,
      { file: "app.js", metadata: { adx_parentpageid: "home" } },
      { id: null, roles: [] },
    ).allowed,
    true,
  );
  // Web files use only their direct parent's rules (legacy algorithm; G-D8 default):
  // the home restriction is reported but does not protect a file under /child/.
  const nested = pageAccess(
    p,
    { file: "app.js", metadata: { adx_parentpageid: "child" } },
    { id: null, roles: [] },
  );
  assert.equal(nested.allowed, true);
  assert.ok(nested.diagnostics.some((d) => d.code === "PAGE_FILE_ANCESTOR_RULE_IGNORED"));
  p.records.push(rule("child-restrict", "child", ["reader"], 2, 1));
  assert.equal(
    pageAccess(
      p,
      { file: "app.js", metadata: { adx_parentpageid: "child" } },
      { id: null, roles: [] },
    ).allowed,
    false,
  );
  p.records.pop();
  p.records.push(rule("missing", "child", ["unknown"]));
  assert.equal(
    pageAccess(p, "/child/", { id: "person", roles: ["Reader"] }).code,
    "PAGE_RULE_UNRESOLVED",
  );
});
test("an omitted page rule scope uses the documented All content default", () => {
  const p = base();
  const restricted = rule("default-scope", "home", ["reader"]);
  delete restricted.adx_scope;
  p.records.push(restricted);
  assert.equal(
    pageAccess(
      p,
      { file: "app.js", metadata: { adx_parentpageid: "home" } },
      { id: null, roles: [] },
    ).allowed,
    false,
  );
});
test("anonymous visitors have no page roles and grant change requires resolved metadata", () => {
  const p = base();
  p.records.push(rule("anon", "child", ["anonymous"]));
  assert.equal(pageAccess(p, "/child/", { id: null, roles: [] }).allowed, false);
  assert.equal(
    pageAccess(p, "/child/", { id: "person", roles: [] }).allowed,
    false,
  );
  p.records.push(rule("unresolved", "home", ["unknown"], 1));
  assert.equal(
    pageAccess(p, "/child/", { id: "person", roles: ["unknown"] }).allowed,
    false,
  );
});

const published = () => {
  const p = base();
  p.publishingStates = [
    { id: "draft", name: "Draft", isVisible: false },
    { id: "live", name: "Published", isVisible: true, active: false },
  ];
  p.pages[1].metadata = { adx_publishingstateid: "draft" };
  p.pages[2].metadata = { adx_publishingstateid: "live" };
  p.websiteAccess = [
    { id: "preview", name: "Preview", roleIds: ["editor"], previewUnpublishedEntities: true },
  ];
  return p;
};
test("non-visible publishing states hide content except for preview website access", () => {
  const p = published();
  const draft = pageAccess(p, "/child/", { id: "person", roles: ["Reader"] });
  assert.equal(draft.allowed, false);
  assert.equal(draft.code, "PAGE_UNPUBLISHED");
  assert.equal(draft.status, 403);
  // An inactive state record still applies its Is Visible flag.
  assert.equal(pageAccess(p, "/child/grandchild/", { id: "person", roles: [] }).allowed, true);
  assert.equal(pageAccess(p, "/child/", { id: "person", roles: ["Editor"] }).allowed, true);
  assert.equal(pageAccess(p, "/child/", { id: "person", roles: ["Editor"] }, { previewCookie: false }).allowed, false);
  // Anonymous visitors have no roles, so no preview permission.
  assert.equal(pageAccess(p, "/child/", { id: null, roles: ["Editor"] }).allowed, false);
  p.pages[1].metadata = { adx_publishingstateid: "missing-state" };
  const unknown = pageAccess(p, "/child/", { id: "person", roles: [] });
  assert.equal(unknown.allowed, true);
  assert.ok(unknown.diagnostics.some((d) => d.code === "PUBLISHING_STATE_UNRESOLVED"));
});
test("service pages stay readable, unpublished languages are not found and web file dates apply", () => {
  const p = published();
  p.records.push(rule("locked", "home", ["reader"]));
  p.siteMarkers = [{ id: "m1", name: "Access Denied", pageId: "child" }];
  assert.equal(pageAccess(p, "/child/", { id: null, roles: [] }).reason, "service-page");
  assert.equal(pageAccess(p, "/", { id: null, roles: [] }).allowed, false);
  p.language = { id: "en", name: "English", published: false };
  const hidden = pageAccess(p, "/child/grandchild/", { id: "person", roles: ["Reader"] });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.code, "LANGUAGE_UNPUBLISHED");
  delete p.language;
  const file = (metadata) => ({ file: "a.pdf", metadata: { adx_parentpageid: "grandchild", ...metadata } });
  const now = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(pageAccess(p, file({ adx_releasedate: "2026-10-08T00:00:00Z" }), { id: "person", roles: ["Reader"] }, { now }).code, "WEB_FILE_NOT_RELEASED");
  assert.equal(pageAccess(p, file({ adx_expirationdate: "2026-10-01T00:00:00Z" }), { id: "person", roles: ["Reader"] }, { now }).code, "WEB_FILE_NOT_RELEASED");
  assert.equal(pageAccess(p, file({ adx_releasedate: "2026-10-01T00:00:00Z" }), { id: "person", roles: ["Reader"] }, { now }).allowed, true);
});
test("grant change rules tied to the current publishing state take precedence", () => {
  const p = published();
  p.pages[1].metadata = { adx_publishingstateid: "live" };
  p.records.push(rule("restrict", "child", ["reader"]));
  p.records.push({ ...rule("draft-editor", "child", ["editor"], 1), adx_accesscontrolrule_publishingstate: ["draft"] });
  // A grant limited to Draft does not apply to Published content.
  assert.equal(pageAccess(p, "/child/", { id: "person", roles: ["Editor"] }).allowed, false);
  p.records.push({ ...rule("live-editor", "child", ["editor"], 1), adx_accesscontrolrule_publishingstate: ["live"] });
  assert.equal(pageAccess(p, "/child/", { id: "person", roles: ["Editor"] }).reason, "grant-change");
});
test("shortcuts follow their target's access, or the parent page when target validation is disabled", () => {
  const p = base();
  p.webFiles = [];
  p.records.push(rule("lock-grandchild", "grandchild", ["reader"]));
  const shortcut = (extra) => ({ id: "s", parentId: "child", ...extra });
  assert.equal(shortcutAccess(p, shortcut({ targetPageId: "grandchild" }), { id: "person", roles: [] }).allowed, false);
  assert.equal(shortcutAccess(p, shortcut({ targetPageId: "grandchild" }), { id: "person", roles: ["Reader"] }).allowed, true);
  assert.equal(shortcutAccess(p, shortcut({ targetPageId: "grandchild", disableTargetValidation: true }), { id: "person", roles: [] }).allowed, true);
  assert.equal(shortcutAccess(p, shortcut({ url: "https://example.test" }), { id: null, roles: [] }).reason, "external-url");
  assert.equal(shortcutAccess(p, shortcut({ targetPageId: "missing" }), { id: null, roles: [] }).code, "SHORTCUT_TARGET_UNRESOLVED");
});

test("a web file without a parent page has no page rules; its publishing state and dates still apply", () => {
  // Example exports parentless web files (RTE configuration) served at their own partial URL.
  const p = published();
  p.records.push(rule("locked", "home", ["reader"]));
  const file = (metadata = {}) => ({ file: "config.json", url: "/RTE/config.json", metadata });
  const open = pageAccess(p, file(), { id: null, roles: [] });
  assert.equal(open.allowed, true);
  assert.ok(open.diagnostics.some((d) => d.code === "PAGE_FILE_WITHOUT_PARENT"));
  assert.ok(!open.diagnostics.some((d) => d.code === "PAGE_FILE_ANCESTOR_RULE_IGNORED"));
  const draft = pageAccess(p, file({ adx_publishingstateid: "draft" }), { id: null, roles: [] });
  assert.equal(draft.allowed, false);
  assert.equal(draft.code, "PAGE_UNPUBLISHED");
  const now = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(pageAccess(p, file({ adx_releasedate: "2026-10-08T00:00:00Z" }), { id: null, roles: [] }, { now }).code, "WEB_FILE_NOT_RELEASED");
  // A page target still needs its identity.
  assert.equal(pageAccess(p, "/no-such-page/", { id: null, roles: [] }).code, "PAGE_IDENTITY_UNRESOLVED");
});
