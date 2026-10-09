import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";

test("permission source changes apply atomically and failed reload retains the applied grant ledger", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pp-permission-api-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, "Home.webpage.yml"),
    "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n",
  );
  await fs.writeFile(
    path.join(directory, "sitesetting.yml"),
    "- adx_name: Webapi/contact/enabled\n  adx_value: true\n- adx_name: Webapi/contact/fields\n  adx_value: fullname\n",
  );
  await fs.writeFile(
    path.join(directory, "Home.webpage.copy.html"),
    "<p>{{user.fullname}}</p>",
  );
  await fs.writeFile(
    path.join(directory, "Role.webrole.yml"),
    "adx_webroleid: reader\nadx_name: Reader\n",
  );
  const permissionFile = path.join(directory, "Read.tablepermission.yml");
  const sourceGrant = (entity) =>
    `adx_entitypermissionid: native-read\nadx_entityname: Native contact read\nadx_entitylogicalname: ${entity}\nadx_scope: 756150000\nadx_read: true\nadx_entitypermission_webrole:\n- reader\n`;
  await fs.writeFile(permissionFile, sourceGrant("contact"));
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: "contacts", idColumn: "contactid" } },
    tables: {
      contact: [{ contactid: "person", fullname: "Local person", admin: true }],
    },
    permissions: [
      {
        id: "local-read",
        entity: "contact",
        scope: "global",
        roles: ["Reader"],
        operations: ["read"],
      },
    ],
    settings: { permissionMode: "enforce" },
    simulator: {
      mode: "local",
      pageMode: "local",
      identity: { id: "person", roles: ["Reader"] },
      // The configured persona (switched through /__sim/api/config) drives /_api.
      identityScope: "configured",
      permissionSource: "configured",
      live: {},
      endpoints: [],
    },
  };
  const app = await createSimulator({
    sourceDir: directory,
    stateFile: path.join(directory, "state.json"),
    initial,
    watch: false,
  });
  t.after(() => app.close());
  const patch = (body) =>
    fetch(app.url + "/__sim/api/config", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-sim-csrf": app.state().csrf,
      },
      body: JSON.stringify(body),
    });
  const before = app.state();
  let response = await patch({
    permissionSource: "exported",
    permissionMode: "invalid",
  });
  assert.equal(response.status, 400);
  assert.equal(app.state().status.permissionModel.source, "configured");
  assert.deepEqual(app.store.snapshot().permissions, before.config.permissions);
  assert.equal(app.state().status.revision, before.status.revision);
  response = await patch({
    contactRoles: [{ contactId: "person", roleId: "missing" }],
    identity: { contactId: "person", roleSource: "memberships", roles: [] },
  });
  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).error.code,
    "PERSONA_CONFIGURATION_INVALID",
  );
  assert.equal(app.state().config.identity.roleSource, undefined);
  response = await patch({
    identity: { id: "person", roles: [], admin: true },
  });
  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).error.code,
    "IDENTITY_CAPABILITY_RESERVED",
  );
  response = await patch({
    identity: {
      id: "person",
      roles: [],
      roleIds: ["reader"],
      roleSource: "override",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(app.state().status.effectiveIdentity.admin, undefined);
  assert.deepEqual(app.state().status.effectiveIdentity.roleIds, []);
  response = await fetch(app.url + "/_api/contacts");
  assert.equal(response.status, 403);
  // sandbox answers a table read denial with 90040120;
  // the simulator's own classification stays in X-Sim-Error-Code.
  assert.equal(response.headers.get("x-sim-error-code"), "PermissionDenied");
  assert.equal((await response.json()).error.code, "90040120");
  response = await patch({
    identity: { id: "person", roles: ["Reader"], roleSource: "override" },
  });
  assert.equal(response.status, 200);
  response = await patch({ permissionSource: "exported" });
  assert.equal(response.status, 200);
  const applied = app.state();
  assert.equal(applied.status.permissionModel.applied, true);
  assert.equal(applied.status.permissionModel.source, "exported");
  assert.deepEqual(
    applied.status.permissionModel.tree.map((rule) => rule.id),
    ["native-read"],
  );
  assert.deepEqual(
    app.store.snapshot().permissions.map((rule) => rule.id),
    ["native-read"],
  );
  response = await fetch(app.url + "/__sim/api/permissions/native-read", {
    method: "DELETE",
    headers: { "x-sim-csrf": app.state().csrf },
  });
  assert.equal(response.status, 409);
  assert.equal(
    (await response.json()).error.code,
    "SOURCE_PERMISSION_READ_ONLY",
  );
  assert.equal(app.store.snapshot().permissions[0].id, "native-read");
  await fs.writeFile(permissionFile, sourceGrant("invalid/table/name"));
  await assert.rejects(app.reload(), /identifier|name/i);
  const failed = app.state();
  assert.deepEqual(
    failed.status.permissionModel.tree,
    applied.status.permissionModel.tree,
  );
  assert.deepEqual(failed.config.permissions, applied.config.permissions);
  assert.equal(failed.status.revision, applied.status.revision);
  assert.ok(failed.diagnostics.some((d) => d.code === "RELOAD_FAILED"));
  // A $select read: select-less collection reads are refused (sandbox, 90040101).
  assert.equal((await fetch(app.url + "/_api/contacts?$select=contactid")).status, 200);
  await fs.writeFile(permissionFile, sourceGrant("contact"));
  await app.reload();
  assert.ok(!app.state().diagnostics.some((d) => d.code === "RELOAD_FAILED"));
});
