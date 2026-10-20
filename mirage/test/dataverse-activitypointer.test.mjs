// The activitypointer view through the Dataverse Web API: rows from the activity tables with activitytypecode, $filter,
// a by-id read, refused writes, and a Basic User who does not see another user's task. Invented site and loopback only.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";

const ADMIN_APP = "22222222-2222-2222-2222-222222222222";
const BASIC_APP = "33333333-3333-3333-3333-333333333333";
const NOROLE_APP = "44444444-4444-4444-4444-444444444444";
const SECRET_VAR = "PAQVILO_ACTIVITYPOINTER_TEST_SECRET";
const API = "/api/data/v9.2/";

async function start() {
  process.env[SECRET_VAR] = "activitypointer-test-secret";
  const store = await new DataStore({ state: emptyState() }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      { appId: ADMIN_APP, displayName: "Admin client", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] },
      { appId: BASIC_APP, displayName: "Basic client", secretEnvironmentVariable: SECRET_VAR, roles: ["Basic User"] },
      { appId: NOROLE_APP, displayName: "No-role client", secretEnvironmentVariable: SECRET_VAR, roles: [] },
    ],
  });
  const api = await startDataverseApi({ store, change: (fn) => fn(), settings, log: () => {} });
  const clientFor = async (appId) => {
    const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: appId,
        client_secret: process.env[SECRET_VAR],
        scope: `${api.origin}/.default`,
      }),
    });
    const headers = { authorization: `Bearer ${(await response.json()).access_token}` };
    return (path, init = {}) =>
      fetch(`${api.origin}${API}${path}`, {
        ...init,
        headers: { ...headers, ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(init.headers ?? {}) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
  };
  return {
    origin: api.origin,
    store,
    admin: await clientFor(ADMIN_APP),
    basic: await clientFor(BASIC_APP),
    noRole: await clientFor(NOROLE_APP),
    async close() {
      delete process.env[SECRET_VAR];
      await api.close();
    },
  };
}

const idOf = (response) => /\(([0-9a-f-]{36})\)/i.exec(response.headers.get("OData-EntityId") ?? "")?.[1].toLowerCase();

describe("activitypointer view", () => {
  let dv;
  let taskId;
  let emailId;
  let basicTaskId;

  before(async () => {
    dv = await start();
    const task = await dv.admin("tasks", { method: "POST", body: { subject: "Quarterly review" } });
    assert.equal(task.status, 204);
    taskId = idOf(task);
    const email = await dv.admin("emails", { method: "POST", body: { subject: "Kickoff note" } });
    assert.equal(email.status, 204);
    emailId = idOf(email);
    const own = await dv.basic("tasks", { method: "POST", body: { subject: "Basic follow-up" } });
    assert.equal(own.status, 204);
    basicTaskId = idOf(own);
  });

  after(() => dv?.close());

  const idsOf = (body) => body.value.map((row) => row.activityid.toLowerCase());

  it("lists the task and the email with activitytypecode set to their table", async () => {
    const response = await dv.admin("activitypointers");
    assert.equal(response.status, 200);
    const rows = new Map((await response.json()).value.map((row) => [row.activityid.toLowerCase(), row]));
    assert.equal(rows.get(taskId).activitytypecode, "task");
    assert.equal(rows.get(taskId).subject, "Quarterly review");
    assert.equal(rows.get(emailId).activitytypecode, "email");
  });

  it("filters on subject and on activitytypecode across the tables", async () => {
    const bySubject = await dv.admin(`activitypointers?${new URLSearchParams({ $filter: "subject eq 'Kickoff note'", $select: "subject,activitytypecode" })}`);
    const subjectBody = await bySubject.json();
    assert.equal(bySubject.status, 200);
    assert.equal(subjectBody.value.length, 1);
    assert.equal(subjectBody.value[0].activitytypecode, "email");
    assert.deepEqual(Object.keys(subjectBody.value[0]).sort(), ["activitytypecode", "activityid", "subject"].sort());

    const byType = await dv.admin(`activitypointers?${new URLSearchParams({ $filter: "activitytypecode eq 'task'", $count: "true" })}`);
    const typeBody = await byType.json();
    assert.equal(typeBody["@odata.count"], 2);
    assert.deepEqual(idsOf(typeBody).sort(), [taskId, basicTaskId].sort());
  });

  it("reads one activity by id from whichever table holds it", async () => {
    const response = await dv.admin(`activitypointers(${taskId})`);
    assert.equal(response.status, 200);
    const row = await response.json();
    assert.equal(row.activitytypecode, "task");
    assert.equal(row.activityid.toLowerCase(), taskId);
  });

  it("refuses every write to activitypointers with a 400", async () => {
    const writes = [
      ["POST", "activitypointers", { subject: "New" }],
      ["PATCH", `activitypointers(${taskId})`, { subject: "Changed" }],
      ["DELETE", `activitypointers(${taskId})`, undefined],
    ];
    for (const [method, path, body] of writes) {
      const response = await dv.admin(path, { method, body });
      assert.equal(response.status, 400, `${method} ${path}`);
      const error = (await response.json()).error;
      assert.match(error.message, /read-only view/);
    }
    const kept = await dv.admin(`tasks(${taskId})`);
    assert.equal((await kept.json()).subject, "Quarterly review");
  });

  it("shows a Basic User only the rows they may read", async () => {
    const response = await dv.basic("activitypointers");
    assert.equal(response.status, 200);
    const ids = idsOf(await response.json());
    assert.ok(ids.includes(basicTaskId));
    assert.ok(!ids.includes(taskId), "another user's task stays hidden");
    assert.ok(!ids.includes(emailId), "another user's email stays hidden");
    // A by-id read answers as the source table does: the row exists, the Basic User may not read it.
    const hidden = await dv.basic(`activitypointers(${taskId})`);
    const direct = await dv.basic(`tasks(${taskId})`);
    assert.equal(hidden.status, direct.status);
    assert.equal(hidden.status, 403);
  });
});

describe("activitypointer by-id reads and privilege", () => {
  let dv;
  let taskId;

  before(async () => {
    dv = await start();
    const task = await dv.admin("tasks", { method: "POST", body: { subject: "Quarterly review" } });
    assert.equal(task.status, 204);
    taskId = idOf(task);
  });

  after(() => dv?.close());

  it("refuses a caller without the Activity read privilege with the standard privilege error, for the collection and a row", async () => {
    const collection = await dv.noRole("activitypointers");
    assert.equal(collection.status, 403);
    assert.match((await collection.json()).error.message, /prvReadActivity/);
    assert.equal((await dv.noRole(`activitypointers(${taskId})`)).status, 403);
  });

  it("answers a property and its $value from the table that holds the row, with the activitypointers context", async () => {
    const property = await dv.admin(`activitypointers(${taskId})/subject`);
    assert.equal(property.status, 200);
    const body = await property.json();
    assert.equal(body.value, "Quarterly review");
    assert.match(body["@odata.context"], /#activitypointers/);
    const raw = await dv.admin(`activitypointers(${taskId})/subject/$value`);
    assert.equal(raw.status, 200);
    assert.equal(await raw.text(), "Quarterly review");
  });

  it("answers $expand on a row by id by delegating to the table: the same answer as the table's own read, and a missing id is a 404", async () => {
    // The fixture has no task navigations, so the table itself refuses createdby (400); the view must give the same answer.
    const query = "$select=subject&$expand=createdby($select=fullname)";
    const viaView = await dv.admin(`activitypointers(${taskId})?${query}`);
    const viaTable = await dv.admin(`tasks(${taskId})?${query}`);
    assert.equal(viaView.status, viaTable.status);
    assert.equal((await viaView.json()).error.message, (await viaTable.json()).error.message);
    assert.equal((await dv.admin("activitypointers(00000000-0000-4000-8000-00000000dead)?$expand=createdby")).status, 404);
  });
});

describe("activitypointer union past one page", () => {
  const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("follows each source's nextLink, so the union holds every row past 5000 and the count is exact", async () => {
    const dv = await start();
    try {
      const tasks = (dv.store.state.tables.task ??= []);
      for (let i = 1; i <= 5005; i++) tasks.push({ activityid: guid(i), taskid: guid(i), subject: `bulk ${i}` });
      const first = await (await dv.admin("activitypointers?$count=true")).json();
      assert.equal(first.value.length, 5000);
      assert.equal(first["@odata.count"], 5005);
      assert.ok(first["@odata.nextLink"], "a second page is linked");
      const next = first["@odata.nextLink"].slice(`${dv.origin}${API}`.length);
      const second = await (await dv.admin(next)).json();
      assert.equal(second.value.length, 5);
      const ids = new Set([...first.value, ...second.value].map((row) => row.activityid.toLowerCase()));
      assert.equal(ids.size, 5005);
      assert.equal(second["@odata.nextLink"], undefined);
    } finally {
      await dv.close();
    }
  });
});
