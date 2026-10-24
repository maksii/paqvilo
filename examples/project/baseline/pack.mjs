// Mirage data pack for the baseline fixture: the same invented rows as the live reset, the
// synthetic tester contact, and explicit local models of the baseline plugin steps (Mirage does
// not execute the compiled assembly). Register it through the catalogue's `mirage.dataPacks`.
import fs from "node:fs";
import { mirageTables, TESTER_CONTACT, ITEM, PARENT, CHILD } from "./data.mjs";

const mappings = {
  [ITEM]: { entitySet: `${ITEM}s`, idColumn: `${ITEM}id` },
  [PARENT]: { entitySet: `${PARENT}s`, idColumn: `${PARENT}id` },
  [CHILD]: { entitySet: `${CHILD}s`, idColumn: `${CHILD}id` },
  account: { entitySet: "accounts", idColumn: "accountid" },
  contact: { entitySet: "contacts", idColumn: "contactid" },
  annotation: { entitySet: "annotations", idColumn: "annotationid" },
  transactioncurrency: { entitySet: "transactioncurrencies", idColumn: "transactioncurrencyid" },
};
const tables = mirageTables(TESTER_CONTACT);
const personaRoles = [{ contactId: TESTER_CONTACT, roles: ["Baseline Editors"] }];

// Local models of the registered baseline plugin steps (ids from plugins.json when present).
const SENTINEL = /^plugin-fail-(create|update|delete)-(prevalidation|preoperation|postoperation)$/;
const stageName = { 10: "prevalidation", 20: "preoperation", 40: "postoperation" };
const failing = (message, stage) => ({ target, preImage, reject }) => {
  const text = target?.pqvd_text ?? preImage?.pqvd_text;
  const match = typeof text === "string" ? SENTINEL.exec(text) : null;
  if (match && match[1] === message && match[2] === stageName[stage]) reject(`Baseline plugin rejected ${message} at ${stageName[stage]}`);
};
const mutate = ({ target }) => {
  const result = {};
  if (Object.hasOwn(target, "pqvd_ticker") && target.pqvd_ticker != null) result.pqvd_ticker = String(target.pqvd_ticker).trim().toUpperCase();
  if (Object.hasOwn(target, "pqvd_textarea") && target.pqvd_textarea === "mutate-me") result.pqvd_textarea = "mutated by plugin";
  return { target: result };
};
const pluginSteps = {};
try {
  const registered = JSON.parse(fs.readFileSync(new URL("./plugins.json", import.meta.url), "utf8"));
  for (const step of registered.steps ?? []) pluginSteps[step.id] = step.kind === "mutate" ? mutate : failing(step.message.toLowerCase(), step.stage);
} catch {
  /* plugins not registered yet: no local models */
}

export default {
  id: "baseline",
  name: "Paqvilo baseline fixture",
  description: "Invented baseline parents, items, children, notes and the synthetic tester",
  // Registered explicitly through a catalogue; it applies to any portal that carries the baseline fixture pages.
  matches: () => true,
  presets: () => ({
    baseline: { name: "Baseline fixture", description: "2 parents, 8 items, 4 children, 2 notes; tester is a Baseline Editor", mappings, tables, permissions: [], plugins: [], personaRoles, permissionSource: "exported", settings: { permissionMode: "enforce" } },
  }),
  generators: {},
  personas: [],
  plugins: [],
  pluginSteps,
};
