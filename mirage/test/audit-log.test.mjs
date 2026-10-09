import test from "node:test";
import assert from "node:assert/strict";
import { AuditLog, auditText } from "../lib/audit-log.mjs";

test("audit correlates nested calls, records outcomes, bounds retention and paginates detached entries", () => {
  const audit = new AuditLog({ limit: 3 });
  const request = audit.begin({
    kind: "page",
    path: "/products/?token=secret",
    identity: { id: "alice", roles: ["Member"] },
  });
  const fetch = audit.begin({
    kind: "liquid-fetchxml",
    path: "/products/",
    entity: "product",
    query: '<fetch><entity name="product"/></fetch>',
    correlationId: request.correlationId,
    parentId: request.id,
  });
  fetch.finish({ rowCount: 45 });
  request.finish({ status: 200 });
  const denied = audit.begin({
    kind: "api",
    method: "PATCH",
    path: "/_api/products(foreign)",
    identity: { id: "alice", roles: ["Member"] },
  });
  denied.finish({
    status: 403,
    error: { code: "PermissionDenied", message: "Scoped update denied" },
  });
  denied.finish({ status: 200 });
  const page = audit.list({ pageSize: 2 });
  assert.equal(page.items.length, 2);
  assert.equal(page.total, 3);
  assert.equal(page.pageCount, 2);
  assert.equal(page.items[0].outcome, "denied");
  assert.equal(page.items[1].rowCount, 45);
  assert.equal(page.items[1].parentId, request.id);
  assert.equal(page.items[1].correlationId, request.correlationId);
  page.items[1].identity.roles.push("Injected");
  assert.deepEqual(
    audit.list({ kind: "liquid-fetchxml" }).items[0].identity.roles,
    [],
  );
  assert.equal(audit.list({ search: "Scoped update" }).total, 1);
  assert.equal(
    audit.list({ page: 2, pageSize: 2 }).items[0].path,
    "/products/",
  );
  audit
    .begin({ kind: "api", path: "/_api/products" })
    .finish({ status: 502, error: new Error("upstream unavailable") });
  assert.equal(audit.list().retained, 3);
  assert.equal(audit.list().dropped, 1);
  assert.equal(audit.list({ outcome: "error" }).total, 1);
  audit.clear();
  assert.equal(audit.list().total, 0);
  assert.equal(audit.list().latestSequence, 4);
});

test("audit does not retain headers, payloads or credential query/error values", () => {
  const audit = new AuditLog();
  audit
    .begin({
      path: "https://user:PASS@portal.test/_api/contacts?access_token=TOPSECRET",
      headers: { authorization: "SECRET" },
      body: { password: "SECRET" },
      query: new URLSearchParams({
        access_token: "TOPSECRET",
        $filter: "password eq 'HIDDEN' and fullname eq 'Example'",
        fetchXml:
          '<fetch><entity name="x"><filter><condition attribute="secret" value="HIDDENXML"/></filter></entity></fetch>',
      }),
    })
    .finish({
      status: 500,
      error: {
        code: "FAIL",
        message: 'Bearer BEARERSECRET access_token=ANOTHER secret: "THING"',
      },
    });
  const text = JSON.stringify(audit.export());
  for (const sensitive of [
    "TOPSECRET",
    "HIDDEN",
    "HIDDENXML",
    "BEARERSECRET",
    "ANOTHER",
    "THING",
    "PASS",
    "authorization",
  ])
    assert.equal(text.includes(sensitive), false, sensitive);
  assert.ok(text.includes("fullname"));
  assert.ok(text.includes("[redacted]"));
  const nested = auditText(
    '<condition attribute="client_secret" operator="in"><value>DO_NOT_STORE</value><value>ALSO_PRIVATE</value></condition>',
  );
  assert.doesNotMatch(nested, /DO_NOT_STORE|ALSO_PRIVATE/);
  assert.doesNotMatch(
    auditText('password="' + "PRIVATE".repeat(3000) + '"', 30),
    /PRIVATE/,
  );
});

test("audit filters by path, entity, status class, method and correlation, lists kinds and notifies observers", () => {
  const audit = new AuditLog();
  const observed = [];
  const unsubscribe = audit.subscribe((entry) => observed.push(entry));
  const page = audit.begin({ kind: "page", method: "GET", path: "/workspace/" });
  const read = audit.begin({ kind: "liquid-fetchxml", path: "/workspace/", entity: "Contact", correlationId: page.correlationId, parentId: page.id });
  read.finish({ rowCount: 2 });
  page.finish({ status: 200 });
  const redirect = audit.begin({ kind: "page", method: "GET", path: "/old-guidance/" });
  redirect.finish({ status: 301 });
  const service = audit.begin({ kind: "native-service", method: "POST", path: "/_services/lookup", entity: "account" });
  service.finish({ status: 500, error: { code: "ServiceFailed", message: "Lookup failed" } });
  const unknown = audit.begin({ kind: "Not A Kind", path: "/x" });
  unknown.finish({ status: 404 });
  assert.equal(audit.entries.find((entry) => entry.path === "/x").kind, "api", "invalid kinds fall back to api");
  assert.deepEqual(audit.list({ path: "WORKSPACE" }).items.map((item) => item.kind).sort(), ["liquid-fetchxml", "page"]);
  assert.deepEqual(audit.list({ entity: "contact" }).items.map((item) => item.kind), ["liquid-fetchxml"]);
  assert.deepEqual(audit.list({ status: "3xx" }).items.map((item) => item.path), ["/old-guidance/"]);
  assert.deepEqual(audit.list({ status: "500" }).items.map((item) => item.kind), ["native-service"]);
  assert.deepEqual(audit.list({ method: "post" }).items.map((item) => item.kind), ["native-service"]);
  assert.equal(audit.list({ correlationId: page.correlationId }).total, 2);
  assert.ok(audit.list().kinds.includes("native-service"));
  assert.ok(audit.list().kinds.includes("entity-query"), "documented kinds remain selectable before they occur");
  const pending = audit.begin({ kind: "api", path: "/slow" });
  assert.equal(audit.list({ status: "pending" }).items[0].path, "/slow");
  pending.finish({ status: 200 });
  assert.deepEqual(observed.map((entry) => entry.path), ["/workspace/", "/workspace/", "/old-guidance/", "/_services/lookup", "/x", "/slow"]);
  observed[0].path = "mutated";
  assert.notEqual(audit.entries[0].path, "mutated", "observers receive copies");
  unsubscribe();
  audit.begin({ kind: "api", path: "/after" }).finish({ status: 200 });
  assert.equal(observed.length, 6);
  audit.subscribe(() => { throw new Error("observer failure"); });
  assert.doesNotThrow(() => audit.begin({ kind: "api", path: "/still-recorded" }).finish({ status: 200 }));
  assert.equal(audit.entries.at(-1).outcome, "success");
});

test("audit keeps the simulator error code and a differing portal envelope code", () => {
  const audit = new AuditLog();
  const denied = audit.begin({ kind: "api", method: "PATCH", path: "/_api/contacts(1)" });
  denied.finish({ status: 403, error: { code: "PermissionDenied", message: "Table permission denies update" }, portalError: { code: "90040102", message: "Update denied" }, simulatorCode: "PermissionDenied" });
  assert.deepEqual(audit.entries[0].error, { code: "PermissionDenied", message: "Table permission denies update", portalCode: "90040102" });
  const headerOnly = audit.begin({ kind: "api", path: "/_api/items" });
  headerOnly.finish({ status: 404, portalError: { code: "9004010C", message: "Table not enabled" }, simulatorCode: "UnknownEntity" });
  assert.deepEqual(audit.entries[1].error, { code: "UnknownEntity", message: "Table not enabled", portalCode: "9004010C" });
  const same = audit.begin({ kind: "api", path: "/_api/other" });
  same.finish({ status: 400, error: { code: "InvalidRequest", message: "Bad" }, portalError: { code: "InvalidRequest", message: "Bad" } });
  assert.equal(audit.entries[2].error.portalCode, undefined, "identical codes are not repeated");
  const ok = audit.begin({ kind: "api", path: "/_api/ok" });
  ok.finish({ status: 200 });
  assert.equal(audit.entries[3].error, undefined);
});
