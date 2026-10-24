// Simulated Dataverse asynchronous service. Its state lives in the store, so it survives a restart (install resumes it).
//  - BulkDelete queues a system job (asyncoperation) and returns its JobId. The job runs on a later tick under the
//    submitter's identity: it collects the QuerySet ids through FetchXML, then deletes active rows through the record
//    handlers or retained snapshots from their own store, with privileges and row access checked. StartDateTime postpones it and RecurrencePattern queues the next
//    occurrence. Each job has one bulkdeleteoperation row with the counts, and one bulkdeletefailure row per row it could
//    not delete.
//  - A custom API call with Prefer: respond-async is a background operation (backgroundoperations row): 202 with its
//    status monitor location. The status monitor, GET or DELETE on /api/backgroundoperation/<id>, is outside /api/data.
import { DataError } from "./data-error.mjs";
import { fromBulkDeleteJson, toFetchXml } from "./dataverse-soap-query.mjs";
import { dataverseIdentity, ownerColumns, privilegeDeniedError } from "./dataverse-security.mjs";
import { dataverseError, parseDataverseRoute, parsePrefer } from "./dataverse-odata.mjs";
import { isLoopbackUrl, loopbackFetch } from "./dataverse-webhooks.mjs";
import { createScheduler, systemIds } from "./runtime-clock.mjs";

const BULK_DELETE_TYPE = 13; // asyncoperation.operationtype: Bulk Delete
// asyncoperation.operationtype: Bulk Duplicate Detection. Used by dataverse-duplicates.mjs.
export const BULK_DUPLICATE_TYPE = 8;
// asyncoperation.operationtype labels. 202, 203, 207, 208 and 211 are the solution jobs (dataverse-solutions.mjs,
// dataverse-solution-messages.mjs); 209 and 210 are the language jobs; 63 is the alternate key index job (dataverse-metadata-messages.mjs).
const OPERATION_TYPES = [
  [BULK_DELETE_TYPE, "Bulk Delete"], [BULK_DUPLICATE_TYPE, "Bulk Duplicate Detection"], [63, "EntityKey Index Creation"], [202, "Export Solution Async Operation"], [203, "Import Solution Async Operation"],
  [207, "DeleteAndPromote Async Operation"], [208, "UninstallSolution Async Operation"], [209, "ProvisionLanguage Async Operation"],
  [210, "ImportTranslation Async Operation"], [211, "StageAndUpgrade Async Operation"],
].map(([value, label]) => ({ value, label }));
const STATE = { Ready: 0, Suspended: 1, Locked: 2, Completed: 3 };
const STATUS = { WaitingForResources: 0, Waiting: 10, InProgress: 20, Succeeded: 30, Failed: 31, Canceled: 32 };
const CANCELING = 22; // backgroundoperation status Canceling (state Locked); the job status Canceling too
const PAUSING = 21; // job status Pausing (state Locked)
// Status written by each allowed statecode change, keyed "from>to". Anything else is refused.
// Without a live run a Locked job is written straight to Canceled or Waiting; the native behaviour is a guess.
const TRANSITIONS = {
  "0>3": STATUS.Canceled, "1>3": STATUS.Canceled, "2>3": STATUS.Canceled, // cancel
  "1>0": STATUS.WaitingForResources, // resume
  "2>1": STATUS.Waiting, // pause
};
// A cancel or pause of a Locked job whose run is live is written as its transitional status; the run finishes it at its
// next row (Canceling ends Canceled, Pausing ends Suspended). Both are Locked statuses; the native order of writes is a guess.
const TRANSITIONAL = { "2>3": CANCELING, "2>1": PAUSING };
const JOB_WRITABLE = new Set(["statecode", "statuscode", "postponeuntil"]);
const STATUS_OPTIONS = [
  { value: 0, label: "Waiting For Resources", state: 0 }, { value: 10, label: "Waiting", state: 1 },
  { value: 20, label: "In Progress", state: 2 }, { value: 21, label: "Pausing", state: 2 }, { value: 22, label: "Canceling", state: 2 },
  { value: 30, label: "Succeeded", state: 3 }, { value: 31, label: "Failed", state: 3 }, { value: 32, label: "Canceled", state: 3 },
];
const STATE_OPTIONS = [
  { value: 0, label: "Ready" }, { value: 1, label: "Suspended" }, { value: 2, label: "Locked" }, { value: 3, label: "Completed" },
];
const BACKGROUND_STATUS_OPTIONS = [
  { value: 0, label: "Waiting For Resources", state: 0 }, { value: 20, label: "In Progress", state: 2 },
  { value: CANCELING, label: "Canceling", state: 2 }, { value: 30, label: "Succeeded", state: 3 },
  { value: 31, label: "Failed", state: 3 }, { value: 32, label: "Canceled", state: 3 },
];
// backgroundoperation states are a picklist of 0, 2 and 3: no Suspended.
const BACKGROUND_STATE_OPTIONS = STATE_OPTIONS.filter((option) => option.value !== STATE.Suspended);
// The state and status columns take their Dataverse types (State, Status, Picklist); a stored mapping that types them int is corrected.
const STATE_COLUMNS = new Set(["statecode", "statuscode", "backgroundoperationstatecode", "backgroundoperationstatuscode"]);
// A cancel of a background operation: Ready or Locked moves to Locked/Canceling, and its run then finishes it as Canceled.
const CANCEL_PATCH = { backgroundoperationstatecode: STATE.Locked, backgroundoperationstatuscode: CANCELING };
const TERMINAL_CANCEL = "Canceling background operation is not allowed after it is in terminal state.";
const MONITOR = /^\/api\/backgroundoperation\/([^/]+)$/;

const invalid = (message, code = "InvalidRequest", details) => new DataError(message, 400, code, details);
const json = (status, body) => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body });
// Parameters are stored as a JSON array of { Key, Value } (backgroundoperation inputparameters and outputparameters).
const keyValues = (obj) => JSON.stringify(Object.entries(obj).map(([Key, Value]) => ({ Key, Value })));
// The errorcode columns hold the Dataverse error number as a signed int; 0 when the error carries no Dataverse code.
const errorNumber = (error) => {
  const code = dataverseError(error, {}).body?.error?.code;
  return /^0x[0-9a-f]+$/i.test(code ?? "") ? Number.parseInt(code, 16) | 0 : 0;
};
// The CSDL of the BulkDelete action; the recipient types are a guess. The EntityContainer import is emitted by the operation registry.
const BULK_DELETE_CSDL = `<ComplexType Name="BulkDeleteResponse"><Property Name="JobId" Type="Edm.Guid" /></ComplexType>
<Action Name="BulkDelete">
  <Parameter Name="QuerySet" Type="Collection(mscrm.QueryExpression)" />
  <Parameter Name="JobName" Type="Edm.String" />
  <Parameter Name="SendEmailNotification" Type="Edm.Boolean" />
  <Parameter Name="ToRecipients" Type="Collection(Edm.Int32)" />
  <Parameter Name="CCRecipients" Type="Collection(Edm.Int32)" />
  <Parameter Name="RecurrencePattern" Type="Edm.String" />
  <Parameter Name="StartDateTime" Type="Edm.DateTimeOffset" />
  <ReturnType Type="mscrm.BulkDeleteResponse" Nullable="false" />
</Action>`;

// The in-flight bulk delete runs of each API (api -> jobId -> run token). install registers it; reset clears it.
const activeRuns = new WeakMap();

// Seeds the system tables as Dataverse-only mappings. An existing mapping keeps its settings; missing fields are added.
// Install and reset share it.
function seedMappings(store) {
  const user = { ownerid: { dataverseType: "lookup" }, owninguser: { dataverseType: "lookup" }, owningteam: { dataverseType: "lookup" }, owningbusinessunit: { dataverseType: "lookup" } };
  const defs = {
    asyncoperation: {
      set: "asyncoperations", id: "asyncoperationid", name: "name",
      fields: {
        asyncoperationid: { dataverseType: "uniqueidentifier" }, name: { dataverseType: "nvarchar" },
        operationtype: { dataverseType: "picklist", options: OPERATION_TYPES },
        statecode: { dataverseType: "state", options: STATE_OPTIONS },
        statuscode: { dataverseType: "status", statuses: STATUS_OPTIONS },
        message: { dataverseType: "nvarchar" }, friendlymessage: { dataverseType: "nvarchar" }, errorcode: { dataverseType: "int" },
        startedon: { dataverseType: "datetime" }, completedon: { dataverseType: "datetime" }, postponeuntil: { dataverseType: "datetime" },
        recurrencepattern: { dataverseType: "nvarchar" }, recurrencestarttime: { dataverseType: "datetime" },
        submission: { dataverseType: "nvarchar" }, data: { dataverseType: "nvarchar" }, regardingobjectid: { dataverseType: "lookup" }, ...user,
      },
    },
    bulkdeleteoperation: {
      set: "bulkdeleteoperations", id: "bulkdeleteoperationid", name: "name",
      fields: {
        bulkdeleteoperationid: { dataverseType: "uniqueidentifier" }, name: { dataverseType: "nvarchar" },
        asyncoperationid: { dataverseType: "lookup" }, successcount: { dataverseType: "int" }, failurecount: { dataverseType: "int" },
        isrecurring: { dataverseType: "bit" }, ...user,
      },
    },
    // name stays as the primary-name column the mapping needs; the other columns follow the bulkdeletefailure table.
    bulkdeletefailure: {
      set: "bulkdeletefailures", id: "bulkdeletefailureid", name: "name",
      fields: {
        bulkdeletefailureid: { dataverseType: "uniqueidentifier" }, name: { dataverseType: "nvarchar" },
        errornumber: { dataverseType: "int" }, errordescription: { dataverseType: "nvarchar" }, asyncoperationid: { dataverseType: "lookup" },
        bulkdeleteoperationid: { dataverseType: "lookup" }, regardingobjectid: { dataverseType: "lookup" }, orderedqueryindex: { dataverseType: "int" },
      },
    },
    backgroundoperation: {
      set: "backgroundoperations", id: "backgroundoperationid", name: "name",
      fields: {
        backgroundoperationid: { dataverseType: "uniqueidentifier" }, name: { dataverseType: "nvarchar" }, displayname: { dataverseType: "nvarchar" },
        backgroundoperationstatecode: { dataverseType: "picklist", options: BACKGROUND_STATE_OPTIONS },
        backgroundoperationstatuscode: { dataverseType: "picklist", options: BACKGROUND_STATUS_OPTIONS },
        inputparameters: { dataverseType: "nvarchar" }, outputparameters: { dataverseType: "nvarchar" }, runas: { dataverseType: "nvarchar" },
        starttime: { dataverseType: "datetime" }, endtime: { dataverseType: "datetime" }, retrycount: { dataverseType: "int" },
        errorcode: { dataverseType: "int" }, errormessage: { dataverseType: "nvarchar" }, ttlinseconds: { dataverseType: "int" }, ...user,
      },
    },
  };
  for (const [logical, def] of Object.entries(defs)) {
    const mapping = (store.state.mappings[logical] ??= {
      logicalName: logical, entitySet: def.set, idColumn: def.id, nameColumn: def.name,
      userConfigured: true, dataverseOnly: true, fields: {}, relationships: {},
    });
    for (const [name, type] of Object.entries(def.fields)) {
      if (STATE_COLUMNS.has(name) && mapping.fields[name]?.dataverseType !== type.dataverseType) mapping.fields[name] = type;
      else mapping.fields[name] ??= type;
    }
    store.state.tables[logical] ??= [];
  }
}

const sameGuid = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const rowOf = (store, logical, id) => (store.state.tables[logical] ?? []).find((row) => sameGuid(row[`${logical}id`], id)) ?? null;
const jobOperation = (store, jobId) => (store.state.tables.bulkdeleteoperation ?? []).find((row) => sameGuid(row.asyncoperationid?.id ?? row.asyncoperationid, jobId)) ?? null;

// Checks an update against the transition table and fills the status the transition writes. `running` is whether the job
// has a live run: a cancel or pause of a running job writes its transitional status (see TRANSITIONAL).
function checkJobUpdate(data, existing, running) {
  for (const key of Object.keys(data)) {
    if (!JOB_WRITABLE.has(key)) throw invalid(`The system job field '${key}' cannot be changed through the Web API. Only statecode, statuscode and postponeuntil can.`);
  }
  if (!("statecode" in data) && !("statuscode" in data)) return;
  const from = Number(existing.statecode);
  const to = "statecode" in data ? Number(data.statecode) : from;
  if (to === from) {
    if ("statuscode" in data && Number(data.statuscode) !== Number(existing.statuscode)) {
      throw invalid(`A system job in state ${from} cannot change its status by itself.`);
    }
    return;
  }
  const key = `${from}>${to}`;
  const status = TRANSITIONS[key];
  if (status === undefined) throw invalid(`A system job cannot move from state ${from} to state ${to}.`);
  if ("statuscode" in data && Number(data.statuscode) !== status) throw invalid(`A system job moving to state ${to} takes status ${status}.`);
  if (running && TRANSITIONAL[key] !== undefined) {
    data.statecode = from;
    data.statuscode = TRANSITIONAL[key];
    return;
  }
  data.statecode = to;
  data.statuscode = status;
}

// The RFC 2445 subset documented for RecurrencePattern: FREQ HOURLY, DAILY, WEEKLY or MONTHLY, with an optional INTERVAL.
// ponytail: COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH and YEARLY are not documented for Dataverse, so they are refused.
// The refusal's native message and code are not known.
const FREQUENCIES = ["HOURLY", "DAILY", "WEEKLY", "MONTHLY"];
function parseRecurrence(text) {
  if (!text) return null;
  const parts = Object.fromEntries(String(text).split(";").filter(Boolean).map((part) => part.split("=").map((item) => item.trim().toUpperCase())));
  const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL);
  const documented = Object.keys(parts).every((key) => key === "FREQ" || key === "INTERVAL");
  if (!documented || !FREQUENCIES.includes(parts.FREQ) || !Number.isInteger(interval) || interval < 1) {
    throw new DataError("Only FREQ=HOURLY, DAILY, WEEKLY or MONTHLY with an INTERVAL is simulated for RecurrencePattern.", 501, "NotImplemented");
  }
  return { freq: parts.FREQ, interval };
}

// The occurrence after `from` (epoch ms), as an ISO string.
function nextOccurrence(from, { freq, interval }) {
  const at = new Date(from);
  if (freq === "HOURLY") at.setUTCHours(at.getUTCHours() + interval);
  else if (freq === "MONTHLY") at.setUTCMonth(at.getUTCMonth() + interval);
  else at.setUTCDate(at.getUTCDate() + (freq === "WEEKLY" ? 7 : 1) * interval);
  return at.toISOString();
}

// The QueryExpression model of a QuerySet item. DataSource is not part of the query model: the job reads it (see collectIds).
const queryOf = (item) => {
  const query = { ...item };
  delete query.DataSource;
  return fromBulkDeleteJson(query);
};
// DataSource "retained" is the long-term store. Only "default" and "retained" are documented.
const RETAINED_SOURCE = /^retained$/i;
const SOURCES = /^(?:default|retained)$/i;

// odata.callback; url="<url>" is read from the raw Prefer header, since parsePrefer keeps only the flags it applies.
function callbackOf(header) {
  const text = [header ?? ""].flat().join(",");
  return /odata\.callback\s*;\s*url\s*=\s*"([^"]*)"/i.exec(text)?.[1] ?? null;
}

// The identity the router gives a caller, rebuilt from the submitter's row so a job can run after a restart.
function identityFor(store, user) {
  const { hierarchy, userHierarchy, ...identityData } = dataverseIdentity(store, user);
  const dataverse = Object.defineProperties(
    { accessMode: user.accessmode, callerId: user.systemuserid, ...identityData },
    { hierarchy: { value: hierarchy }, userHierarchy: { value: userHierarchy } },
  );
  return { admin: true, id: user.systemuserid, systemUserId: user.systemuserid, businessUnitId: identityData.businessUnitId, dataverse };
}

// The organization's scheduler (runtime-clock.mjs) clamps long delays, tracks its tasks and is closed with the API. An API
// object without one (a direct install in a test) gets its own, keyed by the API: several simulators can share a process.
// The organization's scheduler is the store's shared one (committed jobs and flow runs use it too): an API keeps the handles
// it scheduled there, so closing it cancels only its own tasks.
const fallbackSchedulers = new WeakMap(), ownHandles = new WeakMap(), closedApis = new WeakSet();
const schedulerOf = (api) => {
  if (api.scheduler) return api.scheduler;
  if (!fallbackSchedulers.has(api)) fallbackSchedulers.set(api, createScheduler({ clock: api.clock ?? Date.now }));
  return fallbackSchedulers.get(api);
};
/** Default schedule: the next turn of the event loop, or after delayMs on an unref'd timer, through the API's scheduler. */
export function defaultSchedule(api, task, delayMs = 0) {
  if (closedApis.has(api)) return;
  const scheduler = schedulerOf(api);
  if (scheduler === fallbackSchedulers.get(api)) { scheduler.schedule(task, delayMs, { name: "dataverse-async" }); return; }
  if (!ownHandles.has(api)) ownHandles.set(api, new Set());
  const handles = ownHandles.get(api);
  const handle = scheduler.schedule(() => { handles.delete(handle); return task(); }, delayMs, { name: "dataverse-async" });
  if (handle !== null) handles.add(handle);
}
/** Stops the API's tasks: its own fallback scheduler is closed, its tasks on a shared one are cancelled; nothing is scheduled again. */
export function close(api) {
  closedApis.add(api);
  fallbackSchedulers.get(api)?.close();
  for (const handle of ownHandles.get(api) ?? []) api.scheduler?.cancel(handle);
  ownHandles.delete(api);
}
// Milliseconds until a postponed job's time; 0 when it is not postponed or already due.
const waitFor = (now, postponeuntil) => (postponeuntil ? Math.max(0, Date.parse(postponeuntil) - now) : 0);
// ponytail: a plain POST with no retry; a failed callback is logged and the operation keeps its result.
const postCallback = (url, body) => loopbackFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });

// reset runs on every reseed (/_sim/ reset, state import) inside the change queue, so it writes through the store only.
// Clearing the run tokens stops in-flight runs at their next row (their job rows are gone). Timers already queued find no
// row and return. ponytail: an imported state's Ready or Locked jobs run again only after a restart (install resumes them).
export function reset(api) {
  activeRuns.get(api)?.clear();
  return api.store.transact(() => seedMappings(api.store));
}

/**
 * Registers the BulkDelete action, the background operation call path and the system-table write rules.
 * options.schedule(task, delayMs) runs a task on a later tick (tests inject their own); options.pageSize is the FetchXML
 * page used to collect ids; options.notify(url, body) posts a callback.
 * The router calls runInBackground before each registered operation; see that export.
 */
export async function install(api, { schedule = (task, delayMs) => defaultSchedule(api, task, delayMs), pageSize = 5000, notify = postCallback } = {}) {
  const { store } = api;
  seedMappings(store);
  const stamp = () => new Date(api.clock()).toISOString();
  const uuid = () => (api.ids ?? systemIds).uuid();
  const write = (fn) => api.change(() => store.transact(fn));
  const setRow = (logical, id, patch) => write(() => {
    const row = rowOf(store, logical, id);
    if (row) Object.assign(row, patch);
  });
  const bumpCount = (jobId, field) => write(() => {
    const op = jobOperation(store, jobId);
    if (op) op[field] = (op[field] ?? 0) + 1;
  });
  // A task on a later tick; a failure is logged rather than thrown into the scheduler.
  const defer = (task, delayMs = 0) => schedule(() => task().catch((error) => api.log?.("dataverse async task failed", { message: error?.message })), delayMs);
  const isCustomApi = (name) => store.tableRows("customapi").some((row) => row.uniquename === name);
  const active = new Map(); // jobId -> the token of the run allowed to continue; a newer run supersedes older ones
  activeRuns.set(api, active);
  const liveRuns = new Map(); // requestId of a run's deletes -> its live check, read by the delete hook (see beforeWrite)

  // One Ready bulk delete job and its operation row. The submission (QuerySet and submitter ids, no tokens) is kept on the
  // job row, so the job runs again after a restart.
  async function enqueue(submission, { name, postponeuntil = null, recurrencepattern = null, recurrencestarttime = null }) {
    const jobId = uuid();
    const owner = ownerColumns(store, { id: submission.callerId, logical_name: "systemuser" });
    await write(() => {
      store.state.tables.asyncoperation.push({
        asyncoperationid: jobId, name, operationtype: BULK_DELETE_TYPE, statecode: STATE.Ready, statuscode: STATUS.WaitingForResources,
        postponeuntil, recurrencepattern, recurrencestarttime, submission: JSON.stringify(submission), ...owner,
      });
      store.state.tables.bulkdeleteoperation.push({
        bulkdeleteoperationid: uuid(), asyncoperationid: jobId, name, successcount: 0, failurecount: 0,
        isrecurring: Boolean(recurrencepattern), ...owner,
      });
    });
    defer(() => start(jobId), waitFor(api.clock(), postponeuntil));
    return jobId;
  }

  // A system job for another module (duplicate detection): one Ready asyncoperation row, then work() on a later tick under the
  // same state machine as BulkDelete. work() returns the job's message. ponytail: the job writes no submission, so a restart
  // does not run it again (it stays Ready); a postponed or recurring system job is not modelled.
  // columns: extra asyncoperation values (dataverse-workflows.mjs). A work() error with jobStatus 32 ends the job Canceled.
  api.systemJob = async ({ name, operationtype, regardingobjectid = null, callerId, columns = {} }, work) => {
    const jobId = uuid();
    const owner = ownerColumns(store, { id: callerId, logical_name: "systemuser" });
    await write(() => {
      store.state.tables.asyncoperation.push({
        asyncoperationid: jobId, name, operationtype, statecode: STATE.Ready, statuscode: STATUS.WaitingForResources,
        regardingobjectid, ...columns, ...owner,
      });
    });
    defer(async () => {
      await setRow("asyncoperation", jobId, { statecode: STATE.Locked, statuscode: STATUS.InProgress, startedon: stamp() });
      try {
        const message = await work();
        await setRow("asyncoperation", jobId, { statecode: STATE.Completed, statuscode: STATUS.Succeeded, completedon: stamp(), message: message ?? null });
      } catch (error) {
        await setRow("asyncoperation", jobId, { statecode: STATE.Completed, statuscode: error?.jobStatus ?? STATUS.Failed, completedon: stamp(), message: error.message, errorcode: errorNumber(error) });
      }
    });
    return jobId;
  };

  // Collects every id a QuerySet item selects, page by page, before any delete (rows created later are not deleted).
  async function collectIds(job, item, queryIndex) {
    const retained = RETAINED_SOURCE.test(item.DataSource ?? "");
    const mapping = store.resolveMapping(item.EntityName);
    const model = queryOf(item);
    const paged = model.topCount == null;
    const ids = [];
    for (let page = 1; ; page += 1) {
      let xml = toFetchXml({ ...model, pageInfo: paged ? { count: pageSize, pageNumber: page } : undefined }, { primaryIdOf: () => mapping.idColumn });
      if (retained) xml = xml.replace(/<fetch\b/i, '<fetch datasource="retained"');
      const path = `/api/data/${job.version}/${mapping.entitySet}`;
      const url = new URL(`${job.origin}${path}`);
      url.searchParams.set("fetchXml", xml);
      const res = await api.records.handle({
        method: "GET", route: parseDataverseRoute(path), url, origin: job.origin, version: job.version,
        prefer: parsePrefer(undefined), headers: {}, user: job.user, caller: job.caller, identity: job.identity, requestId: job.requestId,
      });
      const rows = res.body?.value ?? [];
      ids.push(...rows.map((row) => ({ mapping, id: row[mapping.idColumn], queryIndex, retained })));
      if (!paged || rows.length < pageSize) return ids;
    }
  }

  // One delete through the record handlers under the submitter's identity: the same privilege and row checks as a DELETE.
  async function deleteRow(job, mapping, id) {
    const path = `/api/data/${job.version}/${mapping.entitySet}(${id})`;
    await api.records.handle({
      method: "DELETE", route: parseDataverseRoute(path), url: new URL(`${job.origin}${path}`), origin: job.origin, version: job.version,
      prefer: parsePrefer(undefined), headers: {}, user: job.user, caller: job.caller, identity: job.identity, requestId: job.requestId,
    });
  }

  // Retained snapshots are independent of active records, even when their ids match. Do not invoke active CRUD,
  // cascade, recycle-bin or plug-in hooks. Recheck authorization and cancellation inside the serialized write.
  async function deleteRetainedRow(job, mapping, id) {
    await write(() => {
      if (!liveRuns.get(job.requestId)?.()) throw new DataError("The bulk delete run has stopped.", 400, "InvalidRequest");
      const rows = store.state.dataverse?.retained?.[mapping.logicalName] ?? [];
      const index = rows.findIndex((row) => String(row[mapping.idColumn]).toLowerCase() === String(id).toLowerCase());
      if (index < 0) throw new DataError(`The retained ${mapping.logicalName} record does not exist.`, 404, "NotFound");
      for (const operation of ["read", "delete"]) api.principals.authorize({ user: job.user, entity: mapping.logicalName, operation, mapping, row: rows[index] });
      rows.splice(index, 1);
    });
  }

  // A row the run could not delete: its Dataverse error number and description, the operation, the QuerySet index and the row.
  async function recordFailure(jobId, mapping, id, error, queryIndex) {
    await write(() => {
      const op = jobOperation(store, jobId);
      store.state.tables.bulkdeletefailure.push({
        bulkdeletefailureid: uuid(), name: `${mapping.logicalName} ${id}`, errornumber: errorNumber(error),
        errordescription: error.message, asyncoperationid: jobId, bulkdeleteoperationid: op?.bulkdeleteoperationid ?? null,
        regardingobjectid: { id, logical_name: mapping.logicalName }, orderedqueryindex: queryIndex,
      });
    });
  }

  // Runs a queued job. A job that is no longer Ready (cancelled or paused) does not start; a postponed job waits for its
  // time. A run stops at its next row when the job leaves Locked or another run has taken over.
  async function start(jobId) {
    const row = rowOf(store, "asyncoperation", jobId);
    if (!row || row.statecode !== STATE.Ready) return;
    const wait = waitFor(api.clock(), row.postponeuntil);
    if (wait > 0) return defer(() => start(jobId), wait);
    const submission = JSON.parse(row.submission);
    const token = {};
    const requestId = uuid();
    active.set(jobId, token);
    // A cancel or pause request moves the job to Canceling or Pausing, so the run stops at its next row.
    const live = () => {
      const current = rowOf(store, "asyncoperation", jobId);
      return active.get(jobId) === token && current?.statecode === STATE.Locked && current.statuscode === STATUS.InProgress;
    };
    liveRuns.set(requestId, live);
    let owned;
    try {
      const user = api.principals.byId(submission.callerId);
      if (!user) throw new DataError("The user who submitted this bulk delete no longer exists.", 400, "InvalidRequest");
      await setRow("asyncoperation", jobId, { statecode: STATE.Locked, statuscode: STATUS.InProgress, startedon: stamp() });
      const job = { origin: submission.origin, version: submission.version, user, caller: user, identity: identityFor(store, user), requestId };
      const targets = [];
      for (const [queryIndex, item] of submission.querySet.entries()) targets.push(...(await collectIds(job, item, queryIndex)));
      for (const { mapping, id, queryIndex, retained } of targets) {
        if (!live()) break;
        try {
          if (retained) await deleteRetainedRow(job, mapping, id);
          else await deleteRow(job, mapping, id);
          await bumpCount(jobId, "successcount");
        } catch (error) {
          // A row refused because the run stopped (reset, cancel or a newer run) is not a failure of the job.
          if (!live()) break;
          await bumpCount(jobId, "failurecount");
          await recordFailure(jobId, mapping, id, error, queryIndex);
        }
      }
      // The run that is still active finishes the job: a cancel or pause requested while it ran ends Canceled or Suspended.
      const ended = rowOf(store, "asyncoperation", jobId);
      if (active.get(jobId) === token && ended?.statecode === STATE.Locked) {
        if (ended.statuscode === PAUSING) await setRow("asyncoperation", jobId, { statecode: STATE.Suspended, statuscode: STATUS.Waiting });
        else if (ended.statuscode === CANCELING) await setRow("asyncoperation", jobId, { statecode: STATE.Completed, statuscode: STATUS.Canceled, completedon: stamp() });
        else await setRow("asyncoperation", jobId, { statecode: STATE.Completed, statuscode: STATUS.Succeeded, completedon: stamp() });
      }
    } catch (error) {
      if (active.get(jobId) === token) {
        await setRow("asyncoperation", jobId, {
          statecode: STATE.Completed, statuscode: STATUS.Failed, completedon: stamp(), message: error.message, errorcode: errorNumber(error),
        });
      }
    } finally {
      // Only the run still active at its end owns the job; a superseded run must not queue a second occurrence.
      owned = active.get(jobId) === token;
      if (owned) active.delete(jobId);
      liveRuns.delete(requestId);
    }
    // A recurring job queues its next occurrence once this one has completed (a cancelled or paused one does not recur).
    const done = rowOf(store, "asyncoperation", jobId);
    if (owned && done?.statecode === STATE.Completed && done.statuscode !== STATUS.Canceled && done.recurrencepattern) {
      const rule = parseRecurrence(done.recurrencepattern);
      // Stepped from this occurrence's own start, so the cadence does not drift. Occurrences a late or resumed job has
      // already passed are skipped; native handling of them is not known.
      let next = Date.parse(nextOccurrence(Date.parse(done.recurrencestarttime ?? stamp()), rule));
      while (next <= api.clock()) next = Date.parse(nextOccurrence(next, rule));
      const at = new Date(next).toISOString();
      await enqueue(submission, { name: done.name, postponeuntil: at, recurrencepattern: done.recurrencepattern, recurrencestarttime: at });
    }
  }

  api.registry.register({
    name: "BulkDelete", kind: "action", binding: "unbound",
    csdl: BULK_DELETE_CSDL,
    async handle(ctx) {
      // prvBulkDelete is held only by System Administrator (dataverse-security.mjs), so it is checked before anything else.
      if (!(api.principals.privileges(ctx.user).get("prvBulkDelete") > 0)) throw privilegeDeniedError(ctx.user, "prvBulkDelete", "asyncoperation");
      const body = ctx.body;
      if (!body || typeof body !== "object" || !Array.isArray(body.QuerySet) || body.QuerySet.length === 0) {
        throw invalid("QuerySet is required and must list at least one query.");
      }
      const recurrence = parseRecurrence(body.RecurrencePattern);
      // ponytail: SendEmailNotification and the recipients are accepted and ignored.
      for (const item of body.QuerySet) {
        queryOf(item); // refuses unsupported keys
        // The refusal's native message and code are not known.
        if (item.DataSource != null && !SOURCES.test(item.DataSource)) throw invalid(`The QuerySet DataSource '${item.DataSource}' is not supported.`);
        const mapping = store.resolveMapping(item.EntityName);
        api.principals.authorize({ user: ctx.user, entity: mapping.logicalName, operation: "read", mapping });
        api.principals.authorize({ user: ctx.user, entity: mapping.logicalName, operation: "delete", mapping });
      }
      const startAt = body.StartDateTime ? Date.parse(body.StartDateTime) : NaN;
      const postponeuntil = Number.isFinite(startAt) && startAt > api.clock() ? new Date(startAt).toISOString() : null;
      const name = typeof body.JobName === "string" && body.JobName ? body.JobName : "Bulk Delete";
      // RecurrenceStartTime is the start of the pattern: StartDateTime, or the submission time when there is none.
      const jobId = await enqueue(
        { querySet: body.QuerySet, callerId: ctx.caller.systemuserid, origin: ctx.origin, version: ctx.version },
        {
          name, postponeuntil,
          recurrencepattern: recurrence ? body.RecurrencePattern : null,
          recurrencestarttime: recurrence ? postponeuntil ?? new Date(api.clock()).toISOString() : null,
        },
      );
      return { status: 200, body: { JobId: jobId } };
    },
  });

  // Cascades run synchronously here, so no cascade job row exists and the answer is the empty id.
  // The response property name and the empty-id answer are a guess.
  const NO_CASCADE_JOB = "00000000-0000-0000-0000-000000000000";
  const requiredGuid = (value, name) => {
    if (value == null || value === "") throw invalid(`${name} is required.`); // Native message text not known.
    return value;
  };
  api.registry.register({
    name: "RetrieveCascadeAssignAsyncJobId", kind: "function", binding: "unbound",
    csdl: `<ComplexType Name="RetrieveCascadeAssignAsyncJobIdResponse"><Property Name="AsyncJobId" Type="Edm.Guid" /></ComplexType>
<Function Name="RetrieveCascadeAssignAsyncJobId">
  <Parameter Name="ParentEntityId" Type="Edm.Guid" Nullable="false" />
  <ReturnType Type="mscrm.RetrieveCascadeAssignAsyncJobIdResponse" Nullable="false" />
</Function>`,
    async handle(ctx) {
      requiredGuid(ctx.params?.ParentEntityId, "ParentEntityId");
      return { status: 200, body: { AsyncJobId: NO_CASCADE_JOB } };
    },
  });
  api.registry.register({
    name: "RetrieveCascadeDeleteAsyncJobId", kind: "function", binding: "unbound",
    csdl: `<ComplexType Name="RetrieveCascadeDeleteAsyncJobIdResponse"><Property Name="AsyncJobId" Type="Edm.Guid" /></ComplexType>
<Function Name="RetrieveCascadeDeleteAsyncJobId">
  <Parameter Name="ParentEntityIds" Type="Collection(Edm.Guid)" Nullable="false" />
  <ReturnType Type="mscrm.RetrieveCascadeDeleteAsyncJobIdResponse" Nullable="false" />
</Function>`,
    async handle(ctx) {
      const ids = ctx.params?.ParentEntityIds;
      if (!Array.isArray(ids)) throw invalid("ParentEntityIds must be a collection of ids."); // Native message text not known.
      return { status: 200, body: { AsyncJobId: NO_CASCADE_JOB } };
    },
  });
  // A business event the platform raises when a background operation completes; the docs say not to call it directly.
  // The native direct-call result is not known; the parameters are checked and the call changes nothing.
  // ponytail: no plug-in subscribes to it here, so no event is delivered.
  api.registry.register({
    name: "OnBackgroundOperationComplete", kind: "action", binding: "unbound",
    csdl: `<Action Name="OnBackgroundOperationComplete">
  <Parameter Name="CallbackUrl" Type="Edm.String" />
  <Parameter Name="BackgroundOperationId" Type="Edm.Guid" Nullable="false" />
  <Parameter Name="PayloadType" Type="Edm.Int32" Nullable="false" />
  <Parameter Name="LocationUrl" Type="Edm.String" Nullable="false" />
  <ReturnType Type="mscrm.OnBackgroundOperationCompleteResponse" Nullable="false" />
</Action>
<ComplexType Name="OnBackgroundOperationCompleteResponse" />`,
    async handle(ctx) {
      const body = typeof ctx.body === "string" ? JSON.parse(ctx.body || "{}") : (ctx.body ?? {});
      requiredGuid(body.BackgroundOperationId, "BackgroundOperationId");
      if (!body.LocationUrl) throw invalid("LocationUrl is required."); // Native message text not known.
      if (!rowOf(store, "backgroundoperation", body.BackgroundOperationId)) {
        throw new DataError(`backgroundoperation With Id = ${body.BackgroundOperationId} Does Not Exist`, 404, "NotFound"); // Native message text not known.
      }
      return { status: 204 };
    },
  });

  // Background operations. A respond-async call is answered 202 once its row exists; the call runs on a later tick under
  // the caller's identity, and its output or error becomes the row's result.
  const monitorOf = (origin, id) => `${origin}/api/backgroundoperation/${id}`;

  // The operation's result as row values: its output, or its error. The @odata.context annotation is not an output.
  async function invokeOutcome(op, call) {
    try {
      const result = await op.handle(call);
      const output = { ...(result?.body ?? {}) };
      delete output["@odata.context"];
      return { backgroundoperationstatuscode: STATUS.Succeeded, outputparameters: keyValues(output) };
    } catch (error) {
      return { backgroundoperationstatuscode: STATUS.Failed, errorcode: errorNumber(error), errormessage: error.message };
    }
  }

  async function runBackground(id, op, call, callback, location) {
    const current = rowOf(store, "backgroundoperation", id);
    if (!current) return;
    let patch = { backgroundoperationstatuscode: STATUS.Canceled };
    if (current.backgroundoperationstatuscode !== CANCELING) {
      if (current.backgroundoperationstatecode !== STATE.Ready) return;
      await setRow("backgroundoperation", id, { backgroundoperationstatecode: STATE.Locked, backgroundoperationstatuscode: STATUS.InProgress, starttime: stamp() });
      // A cancel that arrives while the operation runs does not stop it: Dataverse keeps the started result.
      patch = await invokeOutcome(op, call);
    }
    await setRow("backgroundoperation", id, { backgroundoperationstatecode: STATE.Completed, endtime: stamp(), ...patch });
    if (!callback) return;
    // The callback carries the status and any error, never the output: the receiver reads the output from the monitor.
    const done = rowOf(store, "backgroundoperation", id);
    const body = { location, backgroundOperationId: id, backgroundOperationStateCode: done.backgroundoperationstatecode, backgroundOperationStatusCode: done.backgroundoperationstatuscode };
    if (done.errorcode != null) Object.assign(body, { backgroundOperationErrorCode: done.errorcode, backgroundOperationErrorMessage: done.errormessage });
    try {
      await notify(callback, body);
    } catch (error) {
      api.log?.("background operation callback failed", { id, message: error?.message });
    }
  }

  // The router's hook for a registered operation: a respond-async call to a custom API is queued and answered 202; any
  // other call resolves to null and runs as usual.
  api.backgroundOperations = {
    async submit(call, op) {
      if (!call.prefer?.respondAsync || !isCustomApi(op.name)) return null;
      const callback = callbackOf(call.headers?.prefer);
      // Callbacks go only to a loopback address (the shared guard); anything else is refused before the request is queued.
      if (callback !== null && !isLoopbackUrl(callback)) {
        throw invalid("The callback URI must be a loopback address in this simulator.", "InvalidCallbackUri", { innerCode: "0x8009732A" }); // Native message text not known.
      }
      const mapping = store.resolveMapping("backgroundoperation");
      api.principals.authorize({ user: call.user, entity: "backgroundoperation", operation: "read", mapping });
      api.principals.authorize({ user: call.user, entity: "backgroundoperation", operation: "write", mapping });
      const id = uuid();
      const owner = ownerColumns(store, { id: call.caller.systemuserid, logical_name: "systemuser" });
      const location = monitorOf(call.origin, id);
      await write(() => {
        store.state.tables.backgroundoperation.push({
          backgroundoperationid: id, name: op.name, displayname: op.name,
          backgroundoperationstatecode: STATE.Ready, backgroundoperationstatuscode: STATUS.WaitingForResources,
          inputparameters: keyValues({ ...(call.params ?? {}), ...(call.body ?? {}) }), runas: call.user.systemuserid, retrycount: 0, ...owner,
        });
      });
      defer(() => runBackground(id, op, call, callback, location));
      const headers = { Location: location, "x-ms-dyn-backgroundoperationid": id, "Preference-Applied": callback === null ? "respond-async" : "callback" };
      return callback === null ? { status: 202, headers } : { status: 202, headers, body: { backgroundOperationId: id, location } };
    },
  };

  // The status monitor sits outside /api/data, so the router passes the caller it resolved from the bearer token (c.caller).
  async function statusMonitor(c) {
    if (!c.caller) throw new DataError("Authentication is required.", 401, "Unauthorized");
    const id = MONITOR.exec(c.url.pathname)[1];
    const mapping = store.resolveMapping("backgroundoperation");
    api.principals.authorize({ user: c.caller, entity: "backgroundoperation", operation: c.method === "DELETE" ? "write" : "read", mapping });
    const row = rowOf(store, "backgroundoperation", id);
    if (!row) throw new DataError(`Could not find item '${id}'.`, 404, "NotFound");
    if (c.method === "DELETE") {
      if (row.backgroundoperationstatecode === STATE.Completed) throw invalid(TERMINAL_CANCEL);
      await setRow("backgroundoperation", id, CANCEL_PATCH);
      return json(200, { backgroundOperationStateCode: CANCEL_PATCH.backgroundoperationstatecode, backgroundOperationStatusCode: CANCEL_PATCH.backgroundoperationstatuscode });
    }
    const body = { backgroundOperationStateCode: row.backgroundoperationstatecode, backgroundOperationStatusCode: row.backgroundoperationstatuscode };
    if (row.errorcode != null) Object.assign(body, { backgroundOperationErrorCode: row.errorcode, backgroundOperationErrorMessage: row.errormessage });
    if (row.backgroundoperationstatuscode === STATUS.Succeeded && row.outputparameters) {
      Object.assign(body, Object.fromEntries(JSON.parse(row.outputparameters).map((param) => [param.Key, param.Value])));
    }
    return json(200, body);
  }
  api.addRoute((pathname, method) => MONITOR.test(pathname) && (method === "GET" || method === "DELETE"), statusMonitor);

  // Rules for the system tables. Jobs and background operations are created by their actions only; the operation and
  // failure rows are read-only; a background operation can be changed only to cancel it.
  api.recordHooks.add("beforeWrite", (c, mapping, { operation, data, existing }) => {
    // A row of a bulk delete run is refused once that run is no longer live (a reset, a cancel or a newer run), even if it
    // was queued before the change: the reseeded row with the same id is not deleted by the stale run.
    if (operation === "delete") {
      const live = liveRuns.get(c.requestId);
      if (live && !live()) throw invalid("The bulk delete run stopped before this row was deleted.");
      return;
    }
    const logical = mapping.logicalName;
    if (logical === "bulkdeleteoperation" || logical === "bulkdeletefailure") {
      if (operation === "create" || operation === "update") throw invalid("The bulk deletion operation is written by the system and is read-only."); // Native message and status not known.
      return;
    }
    if (logical === "backgroundoperation") {
      if (operation === "create") throw invalid("Background operations are created by requests sent with Prefer: respond-async.");
      if (operation === "update") {
        // The documented cancel: statuscode 22 (Canceling), with statecode 2 (Locked) when it is given. Anything else is refused.
        const cancelKeys = new Set(["backgroundoperationstatecode", "backgroundoperationstatuscode"]);
        const onlyCancel = Object.keys(data).every((key) => cancelKeys.has(key)) && Number(data.backgroundoperationstatuscode) === CANCELING
          && (!("backgroundoperationstatecode" in data) || Number(data.backgroundoperationstatecode) === STATE.Locked);
        if (!onlyCancel) throw invalid("A background operation can only be changed through the Web API to cancel it (backgroundoperationstatuscode 22).");
        if (Number(existing?.backgroundoperationstatecode) === STATE.Completed) throw invalid(TERMINAL_CANCEL);
        Object.assign(data, CANCEL_PATCH);
      }
      return;
    }
    if (logical !== "asyncoperation") return;
    if (operation === "create") throw invalid("System jobs are created by their actions, not through the Web API."); // Native message and status not known.
    if (operation !== "update") return;
    const before = Number(existing?.statecode);
    checkJobUpdate(data, existing, active.has(existing.asyncoperationid));
    // Resume: the job starts again on the next tick, if the write survives (a rollback leaves it Suspended and start() does nothing).
    if (before === STATE.Suspended && Number(data.statecode) === STATE.Ready) defer(() => start(existing.asyncoperationid));
  });

  // A restart. A bulk delete still Ready or Locked runs again, since its submission is on its row. A background operation
  // still in flight is failed: its request was not kept, so it cannot run again. ponytail: no re-run of background work.
  const resumed = [];
  await write(() => {
    for (const row of store.state.tables.asyncoperation) {
      if (!row.submission || (row.statecode !== STATE.Ready && row.statecode !== STATE.Locked)) continue;
      // A cancel or pause requested before the restart is finished here: its run cannot continue.
      if (row.statecode === STATE.Locked && row.statuscode === CANCELING) {
        Object.assign(row, { statecode: STATE.Completed, statuscode: STATUS.Canceled, completedon: stamp() });
        continue;
      }
      if (row.statecode === STATE.Locked && row.statuscode === PAUSING) {
        Object.assign(row, { statecode: STATE.Suspended, statuscode: STATUS.Waiting });
        continue;
      }
      Object.assign(row, { statecode: STATE.Ready, statuscode: STATUS.WaitingForResources });
      resumed.push(row.asyncoperationid);
    }
    for (const row of store.state.tables.backgroundoperation) {
      if (row.backgroundoperationstatecode === STATE.Completed) continue;
      Object.assign(row, {
        backgroundoperationstatecode: STATE.Completed, backgroundoperationstatuscode: STATUS.Failed, endtime: stamp(),
        errormessage: "The background operation was interrupted by a restart.",
      });
    }
  });
  for (const id of resumed) defer(() => start(id));
}

/** Router hook: resolves to the 202 for a respond-async call to a custom API, or null when the operation runs as usual. */
export const runInBackground = (api, call, op) => api.backgroundOperations?.submit(call, op) ?? null;
