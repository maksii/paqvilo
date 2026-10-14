#!/usr/bin/env node
// Baseline plugin registration: uploads the rebuilt demo assembly (same record, so the demo's
// eight steps keep working) and registers the BaselineRules steps on pqvd_baselineitem in the
// PaqviloBaseline solution. Idempotent: ids derive from names; create when missing, patch when
// different, otherwise "exists". Always rewrites plugins.json (the step inventory).
//
//   node examples/project/baseline/plugins.mjs --connection <private connection.json> [--apply]
//   node examples/project/baseline/plugins.mjs --connection <private connection.json> --verify
//
// --verify is read-only: it reads every step back from Dataverse and writes plugins-readback.json
// (statecode/statuscode, stage, rank, mode, invocation source, images, impersonation as read).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConnection, connectedClient } from "paqvilo/lense/dataverse/index.mjs";
import { guid } from "./generate.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(root, "../components/DataversePlugins");
const SOLUTION = "PaqviloBaseline";
const TABLE = "pqvd_baselineitem";
const STAGES = { 10: "prevalidation", 20: "preoperation", 40: "postoperation" };
const MESSAGES = ["Create", "Update", "Delete", "Retrieve", "RetrieveMultiple"];
const IMAGE_TYPES = { PreImage: 0, PostImage: 1 };

export function baselineSteps() {
  const steps = [];
  for (const message of MESSAGES.slice(0, 3)) for (const stage of [10, 20, 40]) {
    const key = `${message.toLowerCase()}-${STAGES[stage]}`;
    steps.push({
      id: guid(`plugin:step:${key}`), kind: "fail", message, stage, rank: 10, mode: 0,
      sentinel: `plugin-fail-${key}`, error: `Baseline plugin rejected ${message.toLowerCase()} at ${STAGES[stage]}`,
      filteringAttributes: message === "Update" ? "pqvd_text" : null,
      image: message === "Delete" ? { id: guid(`plugin:image:${key}:baseline`), name: "baseline", type: "PreImage", attributes: "pqvd_text" }
        : key === "update-postoperation" ? { id: guid(`plugin:image:${key}:baselinepost`), name: "baselinepost", type: "PostImage", attributes: "pqvd_text" } : null,
    });
  }
  steps.push({
    id: guid("plugin:step:retrieve-postoperation"), kind: "fail", message: "Retrieve", stage: 40, rank: 10, mode: 0,
    sentinel: "plugin-fail-retrieve-postoperation", error: "Baseline plugin rejected retrieve at postoperation", filteringAttributes: null, image: null,
  });
  steps.push({
    id: guid("plugin:step:retrievemultiple-postoperation"), kind: "hide", message: "RetrieveMultiple", stage: 40, rank: 10, mode: 0,
    sentinel: "plugin-hide-retrievemultiple", filteringAttributes: null, image: null,
  });
  // Registration-state-only steps: the code ignores configuration "noop".
  steps.push({ id: guid("plugin:step:update-postoperation-impersonated"), kind: "impersonated-noop", message: "Update", stage: 40, rank: 30, mode: 0, configuration: "noop", runAs: "application-user", filteringAttributes: null, image: null });
  steps.push({ id: guid("plugin:step:create-postoperation-async"), kind: "async-noop", message: "Create", stage: 40, rank: 30, mode: 1, asyncAutoDelete: true, configuration: "noop", filteringAttributes: null, image: null });
  steps.push({ id: guid("plugin:step:delete-prevalidation-disabled"), kind: "disabled", message: "Delete", stage: 10, rank: 20, mode: 0, configuration: "noop", disabled: true, filteringAttributes: null, image: null });
  for (const message of ["Create", "Update"]) steps.push({
    id: guid(`plugin:step:mutate-${message.toLowerCase()}`), kind: "mutate", message, stage: 20, rank: 20, mode: 0, configuration: "mutate",
    filteringAttributes: message === "Update" ? "pqvd_ticker,pqvd_textarea" : null, image: null,
  });
  return steps;
}

async function main() {
  const { values } = parseArgs({ options: { connection: { type: "string" }, apply: { type: "boolean", default: false }, verify: { type: "boolean", default: false } } });
  if (!values.connection) throw new Error("--connection FILE is required.");
  if (values.verify) return verify(values.connection);
  const apply = values.apply;
  const registrations = JSON.parse(await fs.readFile(path.join(pluginRoot, "registrations.json"), "utf8"));
  const assemblyId = registrations.assemblyId;
  const typeName = `${registrations.assemblyName}.BaselineRules`;
  const typeId = guid(`plugin:type:${typeName}`);
  const steps = baselineSteps();
  await fs.writeFile(path.join(root, "plugins.json"), `${JSON.stringify({ table: TABLE, solution: SOLUTION, assemblyId, assemblyName: registrations.assemblyName, typeId, typeName, steps }, null, 2)}\n`);

  const connection = await loadConnection(values.connection);
  const client = connectedClient(connection);
  const who = await client.verify(connection.organisationId);
  const rows = [];
  const log = (row) => { rows.push(row); console.log(JSON.stringify(row)); };
  const [solution] = await client.list(`solutions?$select=solutionid&$filter=uniquename eq '${SOLUTION}'`);
  if (!solution) throw new Error(`Solution ${SOLUTION} not found.`);
  const membership = new Set((await client.list(`solutioncomponents?$select=objectid,componenttype&$filter=_solutionid_value eq ${solution.solutionid}`)).map((c) => `${c.componenttype}/${c.objectid.toLowerCase()}`));
  async function include(id, type) {
    if (!apply || membership.has(`${type}/${id}`)) return;
    await client.request("AddSolutionComponent", { method: "POST", body: { ComponentId: id, ComponentType: type, SolutionUniqueName: SOLUTION, AddRequiredComponents: false } });
    membership.add(`${type}/${id}`);
  }
  const differs = (existing, body) => Object.entries(body).some(([k, v]) => {
    if (k.endsWith("@odata.bind")) {
      const attr = k.slice(0, -11).toLowerCase().replace("eventhandler_plugintype", "eventhandler");
      return existing[`_${attr}_value`]?.toLowerCase() !== v.match(/\(([a-f0-9-]+)\)$/i)[1].toLowerCase();
    }
    return (existing[k] ?? null) !== (v ?? null);
  });
  async function ensure(set, primary, key, id, body, type) {
    const existing = await client.optional(`${set}(${id})`);
    const status = !existing ? "create" : differs(existing, body) ? "update" : "exists";
    if (apply && status === "create") await client.request(set, { method: "POST", body: { [primary]: id, ...body }, solution: SOLUTION });
    if (apply && status === "update") await client.request(`${set}(${id})`, { method: "PATCH", body, solution: SOLUTION });
    if (type) await include(id, type);
    log({ key, id, status: apply ? { create: "created", update: "updated", exists: "exists" }[status] : status });
  }

  // Assembly: patch the content of the existing demo record; its identity stays as registrations.json describes.
  const bytes = await fs.readFile(path.join(pluginRoot, "bin/Release/net462", `${registrations.assemblyName}.dll`));
  const assembly = await client.get(`pluginassemblies(${assemblyId})?$select=content`);
  const content = bytes.toString("base64");
  const assemblyStatus = assembly.content === content ? "exists" : "update";
  if (apply && assemblyStatus === "update") await client.request(`pluginassemblies(${assemblyId})`, { method: "PATCH", body: { content } });
  await include(assemblyId, 91);
  log({ key: `assembly/${registrations.assemblyName}`, id: assemblyId, status: apply && assemblyStatus === "update" ? "updated" : assemblyStatus });

  await ensure("plugintypes", "plugintypeid", `type/${typeName}`, typeId, { typename: typeName, name: typeName, friendlyname: typeName, "pluginassemblyid@odata.bind": `/pluginassemblies(${assemblyId})` });

  const messageIds = new Map();
  for (const name of MESSAGES) {
    const found = await client.list(`sdkmessages?$select=sdkmessageid&$filter=name eq '${name}'`);
    if (found.length !== 1) throw new Error(`Ambiguous SDK message ${name}.`);
    const filters = (await client.list(`sdkmessagefilters?$select=sdkmessagefilterid,iscustomprocessingstepallowed&$filter=_sdkmessageid_value eq ${found[0].sdkmessageid} and primaryobjecttypecode eq '${TABLE}'`)).filter((f) => f.iscustomprocessingstepallowed);
    if (filters.length !== 1) throw new Error(`No unique ${name} message filter for ${TABLE}.`);
    messageIds.set(name, { message: found[0].sdkmessageid, filter: filters[0].sdkmessagefilterid });
  }

  for (const step of steps) {
    const ids = messageIds.get(step.message);
    const label = step.kind === "fail" ? `fail ${STAGES[step.stage]}` : step.kind;
    await ensure("sdkmessageprocessingsteps", "sdkmessageprocessingstepid", `step/${step.message}/${step.stage}/${step.rank}`, step.id, {
      name: `Baseline: ${step.message} ${TABLE} ${label}`, stage: step.stage, rank: step.rank, mode: step.mode, supporteddeployment: 0,
      configuration: step.configuration ?? null, filteringattributes: step.filteringAttributes,
      "sdkmessageid@odata.bind": `/sdkmessages(${ids.message})`, "sdkmessagefilterid@odata.bind": `/sdkmessagefilters(${ids.filter})`,
      "eventhandler_plugintype@odata.bind": `/plugintypes(${typeId})`,
      ...(step.mode === 1 ? { asyncautodelete: step.asyncAutoDelete } : {}),
      ...(step.runAs === "application-user" ? { "impersonatinguserid@odata.bind": `/systemusers(${who.applicationUserId})` } : {}),
    }, 92);
    if (step.disabled) {
      const { statecode } = await client.get(`sdkmessageprocessingsteps(${step.id})?$select=statecode`).catch(() => ({ statecode: null }));
      const status = statecode === 1 ? "exists" : "update";
      if (apply && status === "update") await client.request(`sdkmessageprocessingsteps(${step.id})`, { method: "PATCH", body: { statecode: 1, statuscode: 2 } });
      log({ key: `state/${step.message}/${step.stage}/${step.rank}`, id: step.id, status: apply && status === "update" ? "updated" : status });
    }
    if (step.image) await ensure("sdkmessageprocessingstepimages", "sdkmessageprocessingstepimageid", `image/${step.message}/${step.stage}/${step.image.name}`, step.image.id, {
      name: step.image.name, entityalias: step.image.name, imagetype: IMAGE_TYPES[step.image.type], messagepropertyname: "Target", attributes: step.image.attributes,
      "sdkmessageprocessingstepid@odata.bind": `/sdkmessageprocessingsteps(${step.id})`,
    });
  }
  console.log(JSON.stringify({ state: apply ? "Applied" : "Plan", components: rows.length, changes: rows.filter((r) => r.status !== "exists").length }));
}

// Read-only read-back of the registered steps; no writes to Dataverse, no tokens or user ids in the output.
async function verify(connectionFile) {
  const { steps } = JSON.parse(await fs.readFile(path.join(root, "plugins.json"), "utf8"));
  const connection = await loadConnection(connectionFile);
  const client = connectedClient(connection);
  const who = await client.verify(connection.organisationId);
  const select = "name,statecode,statuscode,stage,rank,mode,invocationsource,asyncautodelete,filteringattributes,configuration,_impersonatinguserid_value";
  const imageTypes = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([name, value]) => [value, name]));
  const rows = [];
  for (const step of steps) {
    const row = await client.optional(`sdkmessageprocessingsteps(${step.id})?$select=${select}`);
    if (!row) { rows.push({ id: step.id, found: false }); continue; }
    const images = await client.list(`sdkmessageprocessingstepimages?$select=name,imagetype,attributes&$filter=_sdkmessageprocessingstepid_value eq ${step.id}`);
    const impersonating = row._impersonatinguserid_value?.toLowerCase();
    const read = {
      id: step.id, found: true, name: row.name, message: step.message, statecode: row.statecode, statuscode: row.statuscode,
      stage: row.stage, rank: row.rank, mode: row.mode, invocationSource: row.invocationsource, asyncAutoDelete: row.asyncautodelete,
      filteringAttributes: row.filteringattributes || null, configuration: row.configuration || null,
      impersonation: !impersonating ? "calling-user" : impersonating === who.applicationUserId?.toLowerCase() ? "application-user" : "other-user",
      images: images.map((image) => ({ name: image.name, type: imageTypes[image.imagetype] ?? image.imagetype, attributes: image.attributes })).sort((a, b) => a.name.localeCompare(b.name)),
    };
    const expected = { statecode: step.disabled ? 1 : 0, stage: step.stage, rank: step.rank, mode: step.mode, impersonation: step.runAs === "application-user" ? "application-user" : "calling-user", images: step.image ? 1 : 0 };
    read.mismatches = Object.entries(expected).filter(([key, value]) => (key === "images" ? read.images.length : read[key]) !== value).map(([key]) => key);
    rows.push(read);
  }
  const out = { solution: SOLUTION, table: TABLE, readAt: new Date().toISOString(), source: "Dataverse Web API read-back (sdkmessageprocessingsteps, sdkmessageprocessingstepimages)", steps: rows };
  await fs.writeFile(path.join(root, "plugins-readback.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ state: "Verified", steps: rows.length, missing: rows.filter((r) => !r.found).length, mismatched: rows.filter((r) => r.mismatches?.length).map((r) => ({ id: r.id, fields: r.mismatches })) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
