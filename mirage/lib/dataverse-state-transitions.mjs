// State transitions (status reasons) in the Dataverse API: on a table that enforces them, a status change may only go to a
// status the current status allows.
//
// A table enforces transitions when install's `transitions` names it, or when its metadata carries EnforceStateTransitions
// (dataverseMetadata.EnforceStateTransitions === true). Other tables are untouched. An explicit table entry enforces even
// when the metadata flag is false, and its lists replace the metadata lists for the statuses it names.
// The targets allowed from a status, first match wins:
//   1. the explicit list for that status in `transitions`;
//   2. the status option's TransitionData: an array of statuscode values (exported metadata form) or the native
//      allowedtransitions XML, where sourcestatusid is the status and tostatusid the allowed targets;
//   3. no list: any target is allowed, reported once as STATE_TRANSITIONS_UNCONFIGURED.
// beforeWrite on update (and on an upsert that updates): a statuscode change to a status the current one does not allow is
// refused, whichever state the target status belongs to. A state change through Update (PATCH of statecode/statuscode) is the
// Web API's way to change state and SetStateRequest is deprecated in its favour, so a state change itself is not refused;
// Mirage's SOAP SetState is such a PATCH and gets the same check. Creates are not transitions and are not checked.
// IsValidStateTransition is registered by dataverse-record-messages.mjs and is reused, not registered again: its handler asks
// api.stateTransitions.isValid first, which calls the exported isValidStateTransition evaluator. On an enforced table this module answers IsValid with the same targets (the state must match
// and the target must be allowed; a state change is valid here, as SetState makes it). Other tables keep that module's answer.
// unverified: the refusal's inner code 0x8004F00E (InvalidStateTransition) is matched by its documented name only, and its 400
// status is assumed. The brief's 0x80044331 is StringLengthTooLong on Learn, so it is not used.
// unverified: the XML attribute order (sourcestatusid before tostatusid) is the order of the Learn example.
import { DataError } from "./data-error.mjs";
import { parseEntityReference } from "./data.mjs";
import { packCheck, registerPackExport } from "./pack-exports.mjs";
import { isValidStateTransition } from "./dataverse-record-messages.mjs";
import { onceReporter, packOverrides } from "./dataverse-addon-common.mjs";

const OPERATIONS = ["StatusTransition", "IsValidStateTransition"];
const REFUSED = "0x8004F00E";
const TABLE = /^[a-z][a-z0-9_]*$/;
const WHOLE = /^\d+$/;

// Per-API state: one WeakMap entry per installed API. Never module-global mutable state.
const states = new WeakMap();
function stateOf(api) {
  if (!states.has(api)) states.set(api, { explicit: {}, reporter: onceReporter() });
  return states.get(api);
}

// Diagnostics: once per key (code, table, status), then never again until reset.
const report = (state, entry) => state.reporter.report(entry, `${entry.code}\u0000${entry.table}\u0000${entry.status}`);

/**
 * Validates the pack export 'transitions': { table: { statuscode: [allowed statuscodes] } }. Returns the normalised map
 * { table: { statuscode(number): number[] } }; throws TypeError naming the bad key.
 */
export function validateTransitions(map) {
  if (map === undefined) return {};
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new TypeError("transitions must map table names to status transition maps.");
  const result = {};
  for (const [table, statuses] of Object.entries(map)) {
    const logical = table.trim().toLowerCase();
    if (!TABLE.test(logical)) throw new TypeError(`transitions key '${table}' must be a table logical name.`);
    if (Object.hasOwn(result, logical)) throw new TypeError(`transitions key '${table}' repeats table ${logical}.`);
    if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) throw new TypeError(`transitions['${table}'] must map statuscodes to arrays of statuscodes.`);
    const entries = {};
    for (const [from, targets] of Object.entries(statuses)) {
      if (!WHOLE.test(from)) throw new TypeError(`transitions['${table}']['${from}'] must be a statuscode (a whole number).`);
      if (!Array.isArray(targets) || !targets.every((target) => Number.isInteger(target) && target >= 0)) {
        throw new TypeError(`transitions['${table}']['${from}'] must be an array of statuscode integers.`);
      }
      entries[Number(from)] = [...new Set(targets)];
    }
    result[logical] = entries;
  }
  return result;
}

// ---- Metadata and lookups -------------------------------------------------------------------------------------------

// Exported metadata nests column facts under columnMetadata; runtime definitions may hold them at the top level.
const facts = (definition) => ({ ...definition, ...(definition?.columnMetadata ?? {}) });
const statusOptions = (api, logical) => facts(api.store.fieldDefinition(logical, "statuscode", api.metadataFields)).options ?? [];
const stateOptions = (api, logical) => facts(api.store.fieldDefinition(logical, "statecode", api.metadataFields)).options ?? [];
const optionOf = (options, value) => options.find((option) => Number(option.value) === value) ?? null;
const sameId = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase() && a != null && b != null;

// OptionSetValue ({ Value }) or a plain number; null when absent or not a whole number.
function numberOf(value) {
  const raw = value !== null && typeof value === "object" ? value.Value : value;
  if (raw === null || raw === undefined || raw === "") return null;
  const number = Number(raw);
  return Number.isInteger(number) ? number : null;
}

const enforces = (state, mapping) => Object.hasOwn(state.explicit, mapping.logicalName) || mapping.dataverseMetadata?.EnforceStateTransitions === true;

// The statuses `from` may move to: { allowed: number[] | null (null: any), source: "explicit" | "metadata" | "unconfigured" }.
function targetsFrom(state, logical, options, from) {
  const explicit = state.explicit[logical]?.[from];
  if (explicit) return { allowed: explicit, source: "explicit" };
  const data = optionOf(options, from)?.TransitionData;
  if (Array.isArray(data)) return { allowed: data.map(Number), source: "metadata" };
  if (typeof data === "string") {
    const xml = data.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (/<allowedtransition\b/.test(xml)) {
      const allowed = [...xml.matchAll(/sourcestatusid="(\d+)"\s+tostatusid="(\d+)"/g)]
        .filter((match) => Number(match[1]) === from).map((match) => Number(match[2]));
      return { allowed, source: "metadata" };
    }
  }
  return { allowed: null, source: "unconfigured" };
}

function noteUnconfigured(state, logical, from, source) {
  if (source !== "unconfigured") return;
  report(state, {
    code: "STATE_TRANSITIONS_UNCONFIGURED", table: logical, status: from,
    message: `Status ${from} of ${logical} lists no allowed transitions (TransitionData), so any change from it is allowed.`,
  });
}

// ---- Write check ----------------------------------------------------------------------------------------------------

// unverified: the refusal's outer status (400) is assumed for the native transition errors.
const refuse = (message) => new DataError(message, 400, "InvalidRequest", { innerCode: REFUSED });

function checkWrite(state, api, mapping, existing, data) {
  const logical = mapping.logicalName;
  const from = numberOf(existing.statuscode);
  const to = data.statuscode === undefined ? null : numberOf(data.statuscode);
  if (to !== null && from !== null && to !== from) {
    const options = statusOptions(api, logical);
    const { allowed, source } = targetsFrom(state, logical, options, from);
    noteUnconfigured(state, logical, from, source);
    if (allowed && !allowed.includes(to)) {
      throw refuse(`The status of ${logical} cannot change from ${from} to ${to}: the transitions allowed from status ${from} do not include ${to}.`);
    }
  }
}

// ---- IsValidStateTransition reuse -----------------------------------------------------------------------------------

const stripOrigin = (text) => text.trim().replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?api\/data\/v\d+\.\d+\//i, "");

// Entity reference parameter: an @odata.id string or object, or a typed object (same forms as record-messages).
function entityOf(api, value) {
  if (value && typeof value === "object" && value["@odata.id"] === undefined) {
    const logical = /^#?Microsoft\.Dynamics\.CRM\.(\w+)$/.exec(String(value["@odata.type"] ?? ""))?.[1] ?? null;
    if (!logical) return null;
    const mapping = api.store.resolveMapping(logical);
    return value[mapping.idColumn] == null ? null : { mapping, id: String(value[mapping.idColumn]) };
  }
  const ref = parseEntityReference(stripOrigin(String((value && typeof value === "object" ? value["@odata.id"] : value) ?? "")));
  return ref ? { mapping: api.store.resolveMapping(ref.set), id: ref.id } : null;
}

// The record-messages evaluator does the authorization, the entity lookup and the unknown-status refusal, then this
// answers IsValid for enforced tables with the rule above. Other tables keep that evaluator's answer.
function isValidFor(api, state) {
  return async (c) => {
    const answer = await isValidStateTransition(api, c);
    const target = entityOf(api, c.params?.Entity);
    if (!target || !enforces(state, target.mapping)) return answer;
    const logical = target.mapping.logicalName;
    const row = api.store.tableRows(logical).find((item) => sameId(item[target.mapping.idColumn], target.id));
    const from = numberOf(row?.statuscode);
    if (!row || from === null) return answer;
    const options = statusOptions(api, logical);
    const next = Number(c.params.NewStatus);
    const option = optionOf(options, next);
    const { allowed, source } = targetsFrom(state, logical, options, from);
    noteUnconfigured(state, logical, from, source);
    const stateValue = Number(option?.state ?? 0);
    const stateOption = stateOptions(api, logical).find((item) => Number(item.value) === stateValue);
    const wanted = String(c.params.NewState ?? "").toLowerCase();
    const stateMatches = wanted === String(stateValue)
      || [stateOption?.invariantName, stateOption?.label].some((name) => name != null && String(name).toLowerCase() === wanted);
    const isValid = option !== null && stateMatches && (allowed === null || allowed.includes(next));
    return { ...answer, body: { ...answer.body, IsValid: isValid } };
  };
}

// ---- Extension ------------------------------------------------------------------------------------------------------

/**
 * install(api, { transitions, diagnostic }): transitions is the pack export (validateTransitions), diagnostic receives each
 * diagnostic once. Exposes api.stateTransitions = { diagnostics() }.
 */
function install(api, options = {}) {
  const state = stateOf(api);
  state.explicit = validateTransitions(options.transitions ?? packOverrides(api, "transitions"));
  state.reporter = onceReporter(options.diagnostic ?? api.diagnostic ?? null);
  api.stateTransitions = { diagnostics: () => [...state.reporter.diagnostics], isValid: isValidFor(api, state) };
  api.recordHooks.add("beforeWrite", (c, mapping, { operation, data, existing }) => {
    if (operation === "delete" || operation === "create" || !data || !existing) return;
    if (!enforces(state, mapping)) return;
    checkWrite(state, api, mapping, existing, data);
  });
}

function reset(api) {
  stateOf(api).reporter.clear();
}

/** Capability record for the capability registry. */
function describe() {
  return {
    name: "dataverse-state-transitions",
    version: 1,
    kind: "dataverse-extension",
    level: "behaviour",
    operations: OPERATIONS,
    requires: ["metadata:TransitionData"],
    principal: "caller",
    stateOwner: "none",
    lifecycle: "per-request",
  };
}

export const EXTENSION = { name: "dataverse-state-transitions", install, reset, describe };

registerPackExport("transitions", { key: (key) => key.trim().toLowerCase(), check: packCheck(validateTransitions) });
