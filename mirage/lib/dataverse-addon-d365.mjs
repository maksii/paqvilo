// Dynamics 365 application messages (Sales, Marketing and Service stubs): Recalculate (goal rollups), SyncBulkOperation,
// SendBulkMail, ImmediateBook, CalculatePrice and ApplyRecordCreationAndUpdateRule. Contracts: the SDK and Web API pages of each
// message (RecalculateRequest, SendBulkMail, ImmediateBook, CalculatePrice, ApplyRecordCreationAndUpdateRule), read 2026-10-20.
// Invented data only. Every operation is registered through registerAddon (dataverse-addon-common.mjs), so a trusted pack's
// dataverseMessages handler replaces it. Book, InstantiateTemplate and SendEmail are reused through api.registry: their
// modules are not edited. unverified: the bulk-mail failure text, the SyncBulkOperation result and state mapping, the rollup
// column stem (goalattribute without "rollupfield") and the LC7 cases.
// ponytail: one GET page per query (the records default), QueryByAttribute is not modelled, no Exchange (EWS) attachments,
// a rollup query on a missing row does not restrict, and the time window is the goal's own dates (no entityfordateattribute join).
import { DataError } from "./data-error.mjs";
import { argsOf, idOf, registerAddon } from "./dataverse-addon-common.mjs";
import { parseDataverseRoute, parsePrefer } from "./dataverse-odata.mjs";
import { fromBulkDeleteJson, toFetchXml } from "./dataverse-soap-query.mjs";
import { privilegeDeniedError, privilegeName } from "./dataverse-security.mjs";
import { parseXmlDocument } from "./fetchxml-engine.mjs";

const key = (value) => String(value ?? "").toLowerCase();
const sameId = (a, b) => key(a) === key(b);
const invalid = (message, innerCode = "0x80040203") => new DataError(message, 400, "InvalidRequest", { innerCode });
const notFound = (logical, id) => new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, "NotFound", { id, innerCode: "0x80040217" });
const iso = (at) => new Date(at).toISOString();
const RETAINED = /^retained$/i;
// goal amount columns by metric.amountdatatype: 0 money, 1 decimal, 2 integer.
const SUFFIX = ["money", "decimal", "integer"];
// AsyncOperation states for SyncBulkOperation: pause (Suspended, Pausing), resume (Ready) and cancel (Canceled).
const SYNC_ACTION = { 0: { statecode: 1, statuscode: 21 }, 1: { statecode: 0, statuscode: 0 }, 2: { statecode: 3, statuscode: 32 } };
const addAll = (into, from) => {
  for (const [name, value] of Object.entries(from)) into[name] = (into[name] ?? 0) + value;
  return into;
};
const logicalOf = (ref) => String(ref?.["@odata.type"] ?? "").split(".").pop() || null;

// A reference argument (an entity object with @odata.type) as { logical, id }.
function refOf(args, name) {
  const ref = args[name];
  const logical = logicalOf(ref);
  if (!logical) throw invalid(`${name} must name its table in @odata.type.`);
  return { logical, id: idOf(ref) };
}

function operations(api) {
  const { store } = api;
  const rowsOf = (logical) => store.state.tables[logical] ?? [];
  const mappingOf = (logical) => {
    try {
      return store.resolveMapping(logical);
    } catch {
      return null;
    }
  };
  const rowIn = (logical, id) => {
    const mapping = mappingOf(logical);
    if (!mapping || id == null) return null;
    return rowsOf(logical).find((row) => sameId(row[mapping.idColumn], id)) ?? null;
  };
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const need = (c, logical, right) => {
    const privilege = privilegeName(right, api.principals.privilegeNoun(logical));
    if (!(api.principals.privileges(c.user).get(privilege) > 0)) throw privilegeDeniedError(c.user, privilege, logical);
  };
  // The handler another module registered (Book, InstantiateTemplate, SendEmail), called with a context of its own.
  const handlerOf = (name, binding = "unbound", entity) => {
    const op = api.registry.find({ name, kind: "action", binding, entity });
    if (!op) throw new Error(`${name} is not registered`);
    return op.handle;
  };

  // The rows of a FetchXML, through the records GET as the caller (one page, the GET default).
  async function rowsByXml(c, entity, xml) {
    const mapping = store.resolveMapping(entity);
    const path = `/api/data/${c.version}/${mapping.entitySet}`;
    const url = new URL(`${c.origin}${path}`);
    url.searchParams.set("fetchXml", xml);
    const res = await api.records.handle({
      method: "GET", route: parseDataverseRoute(path), url, origin: c.origin, version: c.version, prefer: parsePrefer(undefined),
      headers: {}, user: c.user, caller: c.caller, identity: c.identity, requestId: c.requestId,
    });
    return res.body?.value ?? [];
  }

  // The rows a QueryExpression JSON selects. DataSource "retained" selects none (the long-term store is not simulated).
  async function selectedRows(c, query) {
    const { DataSource, ...rest } = query ?? {};
    if (RETAINED.test(DataSource ?? "")) return { entity: rest.EntityName ?? null, rows: [] };
    const model = fromBulkDeleteJson(rest);
    const mapping = store.resolveMapping(model.entityName);
    const xml = toFetchXml(model, { primaryIdOf: () => mapping.idColumn });
    return { entity: model.entityName, rows: await rowsByXml(c, model.entityName, xml) };
  }

  // ---- Recalculate -------------------------------------------------------------------------------------------------------

  const parentOf = (goal) => (idOf(goal.parentgoalid) == null ? null : rowIn("goal", idOf(goal.parentgoalid)));
  const childrenOf = (goal) => rowsOf("goal").filter((row) => sameId(idOf(row.parentgoalid), goal.goalid));
  const rootOf = (goal) => {
    const seen = new Set([key(goal.goalid)]);
    let root = goal;
    for (let parent = parentOf(root); parent && !seen.has(key(parent.goalid)); parent = parentOf(root)) {
      seen.add(key(parent.goalid));
      root = parent;
    }
    return root;
  };

  // Rolled-up amounts of one goal's own metric, keyed by goal attribute (actual, inprogress, customrollupfield).
  async function ownValues(c, goal, suffix) {
    const totals = {};
    const metricId = idOf(goal.metricid);
    for (const rf of rowsOf("rollupfield").filter((row) => sameId(idOf(row.metricid), metricId))) {
      const mapping = store.resolveMapping(rf.sourceentity);
      const allowed = await allowedIds(c, goal, rf, suffix, mapping);
      const from = goal.goalstartdate ? Date.parse(goal.goalstartdate) : -Infinity;
      const to = goal.goalenddate ? Date.parse(goal.goalenddate) : Infinity;
      const matches = (row) =>
        (rf.sourcestate == null || row.statecode === rf.sourcestate) &&
        (rf.sourcestatus == null || row.statuscode === rf.sourcestatus) &&
        (!goal.consideronlygoalownersrecords || sameId(idOf(row.ownerid), idOf(goal.goalownerid))) &&
        (!rf.dateattribute || (Date.parse(row[rf.dateattribute]) >= from && Date.parse(row[rf.dateattribute]) <= to)) &&
        (allowed == null || allowed.has(key(row[mapping.idColumn])));
      const sum = rowsOf(rf.sourceentity).filter(matches).reduce((total, row) => total + (Number(row[rf.sourceattribute]) || 0), 0);
      addAll(totals, { [rf.goalattribute]: sum });
    }
    return totals;
  }

  // The ids a goal's rollup query selects for this column (rollupquery<stem><suffix>id), or null when no query is set.
  async function allowedIds(c, goal, rf, suffix, mapping) {
    const stem = String(rf.goalattribute).replace(/rollupfield$/, "");
    const query = rowIn("goalrollupquery", idOf(goal[`rollupquery${stem}${suffix}id`]));
    if (!query?.fetchxml) return null;
    const fetch = parseXmlDocument(query.fetchxml, { root: "fetch" });
    const entity = fetch.children?.find((node) => node.name === "entity")?.attrs?.name;
    if (!entity) throw invalid("Invalid FetchXML");
    const rows = await rowsByXml(c, entity, query.fetchxml);
    return new Set(rows.map((row) => key(row[mapping.idColumn])));
  }

  async function recalculate(c) {
    need(c, "goal", "Write");
    const goal = c.target.row;
    // A goal whose metric has no rollup field cannot roll up.
    if (!rowsOf("rollupfield").some((rf) => sameId(idOf(rf.metricid), idOf(goal.metricid)))) {
      throw new DataError("For rollup to succeed atleast one rollup attribute needs to be associated with the goal metric", 400, "InvalidRequest", { innerCode: "0x8004F681" });
    }
    // Totals are computed (async) before the writes, which run in one synchronous store transaction.
    const plan = [];
    const compute = async (node, seen) => {
      const suffix = SUFFIX[rowIn("metric", idOf(node.metricid))?.amountdatatype ?? 1];
      const totals = node.rolluponlyfromchildgoals ? {} : await ownValues(c, node, suffix);
      for (const child of childrenOf(node)) {
        if (seen.has(key(child.goalid))) continue;
        seen.add(key(child.goalid));
        addAll(totals, await compute(child, seen));
      }
      plan.push({ node, totals, suffix });
      return totals;
    };
    const root = rootOf(goal);
    await compute(root, new Set([key(root.goalid)]));
    const at = api.clock();
    await write(async () => {
      for (const { node, totals, suffix } of plan) {
        const target = Number(node[`target${suffix}`]) || 0;
        const actual = totals.actual ?? 0;
        const fields = { lastrolledupdate: iso(at), percentage: target ? (actual / target) * 100 : 0 };
        for (const [attribute, value] of Object.entries(totals)) fields[`${attribute}${suffix}`] = value;
        await api.records.updateInternal(c, "goal", node.goalid, fields, { authorized: true });
      }
    });
    return undefined;
  }

  // ---- SyncBulkOperation -------------------------------------------------------------------------------------------------

  async function syncBulkOperation(c) {
    need(c, "asyncoperation", "Write");
    const args = argsOf(c);
    const change = SYNC_ACTION[Number(args.OperationType)];
    if (!change) throw invalid("OperationType must be 0 (pause), 1 (resume) or 2 (cancel).");
    const idColumn = store.resolveMapping("asyncoperation").idColumn;
    const ids = [];
    for (const query of Array.isArray(args.QuerySet) ? args.QuerySet : []) {
      const { entity, rows } = await selectedRows(c, query);
      // unverified: a query on another table is refused; Learn says the rows are bulk operation jobs.
      if (entity !== "asyncoperation") throw invalid("SyncBulkOperation selects asyncoperation rows only.");
      ids.push(...rows.map((row) => row[idColumn]));
    }
    await write(async () => {
      for (const id of ids) await store.updateRecordAsync("asyncoperation", id, change, c.identity);
    });
    return { Result: ids.length };
  }

  // ---- SendBulkMail ------------------------------------------------------------------------------------------------------

  async function sendBulkMail(c) {
    const args = argsOf(c);
    const template = rowIn("template", args.TemplateId);
    if (!template) throw notFound("template", args.TemplateId);
    const { rows: recipients } = await selectedRows(c, args.Query);
    const senderAddress = args.Sender?.internalemailaddress ?? args.Sender?.emailaddress1 ?? null;
    const instantiate = handlerOf("InstantiateTemplate");
    const send = handlerOf("SendEmail", "entity", "email");
    const emailIdColumn = store.resolveMapping("email").idColumn;
    await api.systemJob({ name: "Bulk e-mail", operationtype: 2, callerId: c.user?.systemuserid }, async () => {
      let failed = 0;
      for (const recipient of recipients) {
        try {
          // One draft from the template for the regarding record, addressed to this recipient, then sent.
          const drafted = await instantiate({ ...c, body: { TemplateId: args.TemplateId, ObjectType: args.RegardingType, ObjectId: args.RegardingId }, params: {} });
          const emailId = drafted.body.value[0][emailIdColumn];
          const address = recipient.emailaddress1 ?? recipient.internalemailaddress ?? null;
          await write(() => api.records.updateInternal(c, "email", emailId, { sender: senderAddress, torecipients: address }, { authorized: true }));
          await send({ ...c, target: { mapping: store.resolveMapping("email"), id: emailId, row: rowIn("email", emailId) }, body: { IssueSend: true }, params: {} });
        } catch {
          failed += 1;
        }
      }
      if (failed) {
        throw new DataError(`BulkMailOperationFailed: ${failed} of ${recipients.length} e-mails were not sent.`, 500, "BulkMailOperationFailed", { innerCode: "0x8004502D" });
      }
    });
    return undefined;
  }

  // ---- ImmediateBook, CalculatePrice, ApplyRecordCreationAndUpdateRule ---------------------------------------------------

  // The appointment is booked by the Book handler from the Target's own fields. The Exchange attachment parameters are ignored.
  async function immediateBook(c) {
    const booked = await handlerOf("Book")({ ...c, body: { ...(argsOf(c).Target ?? {}) }, params: {} });
    return { ValidationResult: booked.body.ValidationResult, Notifications: [] };
  }

  function calculatePrice(c) {
    const { logical, id } = refOf(argsOf(c), "Target");
    // A table the store does not hold (opportunity, quote and the other ABSENT price tables, LC7) has no price to compute.
    if (!mappingOf(logical)) throw notFound(logical, id);
    return undefined;
  }

  function applyRecordCreation(c) {
    const { logical, id } = refOf(argsOf(c), "Target");
    if (!mappingOf(logical) || !rowIn(logical, id)) throw notFound(logical, id);
    // No rule can exist (convertrule is ABSENT natively), so nothing is applied (unverified, LC7).
    return undefined;
  }

  return [
    // unverified: the percentage is 0 when the target is unset; rollup attribute names are read from goalattribute (LC7).
    {
      name: "Recalculate", kind: "action", binding: "entity", entity: "goal", signature: { params: [] },
      handle: recalculate,
    },
    {
      name: "SyncBulkOperation", kind: "action", binding: "unbound",
      signature: { params: [["QuerySet", "Collection(Edm.Untyped)"], ["OperationType", "Edm.Int32"]], response: [["Result", "Edm.Int32"]] },
      handle: syncBulkOperation,
    },
    {
      // unverified: Query is mscrm.QueryBase (QueryExpression JSON here, the native type is not declared); Sender is a crmbaseentity.
      name: "SendBulkMail", kind: "action", binding: "unbound",
      signature: { params: [["Sender", "mscrm.crmbaseentity"], ["TemplateId", "Edm.Guid"], ["RegardingType", "Edm.String"], ["RegardingId", "Edm.Guid"], ["Query", "Edm.Untyped"]] },
      handle: sendBulkMail,
    },
    {
      // unverified: ValidationResult and BusinessNotification are not declared here, so Edm.Untyped stands in (as the Book CSDL does).
      name: "ImmediateBook", kind: "action", binding: "unbound",
      signature: {
        params: [["Target", "mscrm.crmbaseentity"], ["AttachmentIds", "Collection(Edm.String)"], ["EWSUrl", "Edm.String"], ["AttachmentToken", "Edm.String"]],
        response: [["ValidationResult", "Edm.Untyped"], ["Notifications", "Collection(Edm.Untyped)"]],
      },
      handle: immediateBook,
    },
    // C (internal-only, custom pricing): the pack hook dataverseMessages.CalculatePrice replaces this default.
    // unverified: the 404 for an absent table and the 204 otherwise (LC7).
    {
      name: "CalculatePrice", kind: "action", binding: "unbound",
      signature: { params: [["Target", "mscrm.crmbaseentity"], ["ParentId", "Edm.Guid"]] },
      handle: calculatePrice,
    },
    {
      name: "ApplyRecordCreationAndUpdateRule", kind: "action", binding: "unbound",
      signature: { params: [["Target", "mscrm.crmbaseentity"]] },
      handle: applyRecordCreation,
    },
  ];
}

export function install(api) {
  for (const op of operations(api)) registerAddon(api, op);
}

export const EXTENSION = { name: "dataverse-addon-d365", install };
