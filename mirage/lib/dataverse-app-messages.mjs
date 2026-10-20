// Simulated Dataverse model-driven app and report messages: RetrieveAppComponents, ValidateApp, RemoveAppComponents,
// DownloadReportDefinition, GetReportHistoryLimit and SetReportRelated. Contracts: the Web API reference pages for each message
// (read 2026-10-20). Invented data only. Report rendering is not simulated: DownloadReportDefinition returns the stored
// definition text, and nothing runs a report.
import { DataError } from "./data-error.mjs";
import { componentsOf } from "./dataverse-solution-messages.mjs";
import { privilegeDeniedError, privilegeName, uuidV5 } from "./dataverse-security.mjs";
import { contextUrl } from "./dataverse-odata.mjs";

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const key = (value) => String(value ?? "").toLowerCase();
const sameId = (a, b) => key(a) === key(b);
function idOf(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.match(GUID)?.[0] ?? null;
  if (typeof value !== "object") return null;
  const direct = value.id ?? value["@odata.id"];
  if (direct != null) return idOf(direct);
  return Object.values(value).map(idOf).find(Boolean) ?? null;
}
const tableOf = (store, logical) => (store.state.tables[logical] ??= []);
const rowOf = (store, logical, pk, id) => (id == null ? null : tableOf(store, logical).find((row) => sameId(row[pk], id)) ?? null);
const body = (c) => (typeof c.body === "string" ? JSON.parse(c.body || "{}") : (c.body ?? {}));
const argsOf = (c) => ({ ...body(c), ...(c.params ?? {}) });
const invalid = (message, innerCode = "0x80040203") => new DataError(message, 400, "InvalidRequest", { innerCode });
const notFound = (logical, id) => new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, "NotFound", { id, innerCode: "0x80040217" });
const integers = (value, name) => {
  if (!Array.isArray(value)) throw invalid(`${name} must be a collection.`);
  return value.map((entry) => {
    const number = Number(entry);
    if (!Number.isInteger(number)) throw invalid(`${name} must contain integers.`);
    return number;
  });
};

function operations(api) {
  const { store } = api;
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const need = (c, logical, right) => {
    const privilege = privilegeName(right, api.principals.privilegeNoun(logical));
    if (!(api.principals.privileges(c.user).get(privilege) > 0)) throw privilegeDeniedError(c.user, privilege, logical);
  };
  const respond = (c, name, payload) => ({ status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`), ...payload } });
  const appOf = (id) => rowOf(store, "appmodule", "appmoduleid", id) ?? throwNotFound("appmodule", id);
  // Components reference the app by its unique id (appmodulecomponent.appmoduleidunique), which is not always its row id.
  const uniqueOf = (app) => idOf(app.appmoduleidunique) ?? idOf(app.appmoduleid);
  const components = (app) => tableOf(store, "appmodulecomponent").filter((row) => sameId(idOf(row.appmoduleidunique), uniqueOf(app)));
  const reportOf = (c) => {
    const id = c.target?.id;
    return rowOf(store, "report", "reportid", id) ?? throwNotFound("report", id);
  };

  return [
    {
      name: "AddAppComponents", kind: "action", binding: "unbound",
      signature: { params: [["AppId", "Edm.Guid"], ["Components", "Collection(mscrm.crmbaseentity)"]] },
      async handle(c) {
        // https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/addappcomponents
        need(c, "appmodule", "Write");
        const args = argsOf(c), app = appOf(idOf(args.AppId));
        if (!Array.isArray(args.Components)) throw invalid("Components must be a collection.");
        const sourceTypes = { savedquery: 26, workflow: 29, systemform: 60, sitemap: 62 };
        // Validate every source before changing membership. The ids/type codes are platform solution component codes.
        // unverified: the native validation errors and duplicate-add behavior (local membership is idempotent).
        const selected = args.Components.map((entry) => {
          if (!entry || typeof entry !== "object") throw invalid("Each component must be an entity reference.");
          const logical = String(entry["@odata.type"] ?? "").replace(/^#?Microsoft\.Dynamics\.CRM\./, "");
          const sourceId = idOf(entry.objectid ?? entry);
          const type = Number(entry.componenttype ?? sourceTypes[logical] ?? (logical === "entity" ? 1 : NaN));
          let exists = componentsOf(store.state).some((component) => component.type === type && sameId(component.id, sourceId));
          if (logical === "entity") exists ||= (api.metadata?.entities() ?? []).some((table) => sameId(table.MetadataId, sourceId));
          const sourceLogical = sourceTypes[logical] ? logical : Object.keys(sourceTypes).find((name) => sourceTypes[name] === type);
          if (sourceLogical) {
            const mapping = store.resolveMapping(sourceLogical);
            const row = rowOf(store, sourceLogical, mapping.idColumn, sourceId);
            if (row) {
              api.principals.authorize({ user: c.user, entity: sourceLogical, operation: "read", row, mapping });
              exists = true;
            }
          }
          if (!sourceId || !Number.isInteger(type) || !exists) throw notFound(logical || "appmodulecomponent", sourceId ?? ZERO_GUID);
          return { objectid: sourceId, componenttype: type };
        });
        await write(() => {
          const existing = components(app), appUnique = uniqueOf(app);
          for (const selectedComponent of selected) {
            if (existing.some((row) => sameId(row.objectid, selectedComponent.objectid) && Number(row.componenttype) === selectedComponent.componenttype)) continue;
            const row = { appmodulecomponentid: uuidV5(appUnique, `${selectedComponent.componenttype}:${selectedComponent.objectid}`), appmoduleidunique: appUnique, ...selectedComponent };
            tableOf(store, "appmodulecomponent").push(row);
            existing.push(row);
            const source = store.state.dataverse?.sourceSolutionComponents;
            const sourceKey = `appmodulecomponent/${key(row.appmodulecomponentid)}`;
            if (source?.baseline[sourceKey]) source.overlays[sourceKey] = { values: {}, unset: [] };
          }
        });
        return { status: 204 };
      },
    },
    {
      name: "RetrieveAppComponents", kind: "function", binding: "unbound",
      signature: { params: [["AppModuleId", "Edm.Guid"]], returns: "Collection(mscrm.crmbaseentity)" },
      // Learn: returns the components of an app. unverified: live capture (each component is returned as its appmodulecomponent row).
      handle: (c) => {
        need(c, "appmodule", "Read");
        const app = appOf(idOf(argsOf(c).AppModuleId));
        return { status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, "appmodulecomponents"), value: components(app) } };
      },
    },
    {
      name: "ValidateApp", kind: "function", binding: "unbound",
      csdl: `<EnumType Name="ErrorType"><Member Name="Error" Value="1" /><Member Name="Warning" Value="2" /></EnumType>
<ComplexType Name="Component"><Property Name="DisplayName" Type="Edm.String" /><Property Name="SchemaName" Type="Edm.String" /><Property Name="ComponentType" Type="Edm.Int32" /><Property Name="ComponentSubType" Type="Edm.Int32" /><Property Name="ComponentId" Type="Edm.Guid" /><Property Name="ParentEntityId" Type="Edm.Guid" /><Property Name="ParentEntityName" Type="Edm.String" /></ComplexType>
<ComplexType Name="ValidationIssue"><Property Name="ErrorType" Type="mscrm.ErrorType" /><Property Name="Message" Type="Edm.String" /><Property Name="DisplayName" Type="Edm.String" /><Property Name="ComponentId" Type="Edm.Guid" /><Property Name="ComponentType" Type="Edm.Int32" /><Property Name="ComponentSubType" Type="Edm.Int32" /><Property Name="ParentEntityId" Type="Edm.Guid" /><Property Name="ParentEntityName" Type="Edm.String" /><Property Name="RequiredComponents" Type="Collection(mscrm.Component)" /><Property Name="CRMErrorCode" Type="Edm.Int32" /></ComplexType>
<ComplexType Name="AppValidationResponse"><Property Name="ValidationSuccess" Type="Edm.Boolean" /><Property Name="ValidationIssueList" Type="Collection(mscrm.ValidationIssue)" /></ComplexType>
<ComplexType Name="ValidateAppResponse"><Property Name="AppValidationResponse" Type="mscrm.AppValidationResponse" /></ComplexType>
<Function Name="ValidateApp"><Parameter Name="AppModuleId" Type="Edm.Guid" Nullable="false" /><ReturnType Type="mscrm.ValidateAppResponse" Nullable="false" /></Function>`,
      // Learn: validates an app. ponytail: no component checks are modelled, so an app with components validates clean. unverified:
      // live capture (ValidationIssueList is empty for every app).
      handle: (c) => {
        need(c, "appmodule", "Read");
        const appId = idOf(argsOf(c).AppModuleId);
        appOf(appId);
        return respond(c, "ValidateApp", { AppValidationResponse: { ValidationIssueList: [], ValidationSuccess: true } });
      },
    },
    {
      name: "RemoveAppComponents", kind: "action", binding: "unbound",
      signature: { params: [["AppId", "Edm.Guid"], ["Components", "Collection(mscrm.crmbaseentity)"]] },
      // Removes the components named (by appmodulecomponentid or objectid) from the app. unverified: live capture (the match key).
      handle: async (c) => {
        need(c, "appmodule", "Write");
        const args = argsOf(c);
        const app = appOf(idOf(args.AppId));
        const names = Array.isArray(args.Components) ? args.Components : [];
        const ids = new Set(names.flatMap((entry) => [idOf(entry?.appmodulecomponentid), idOf(entry?.objectid)]).filter(Boolean).map(key));
        await write(() => {
          const rows = tableOf(store, "appmodulecomponent");
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (!sameId(idOf(rows[i].appmoduleidunique), uniqueOf(app))) continue;
            if (ids.has(key(rows[i].appmodulecomponentid)) || ids.has(key(rows[i].objectid))) {
              const source = store.state.dataverse?.sourceSolutionComponents;
              const sourceKey = `appmodulecomponent/${key(rows[i].appmodulecomponentid)}`;
              if (source?.baseline[sourceKey]) source.overlays[sourceKey] = null;
              rows.splice(i, 1);
            }
          }
        });
        return { status: 204 };
      },
    },
    {
      name: "DownloadReportDefinition", kind: "function", binding: "entity", entity: "report",
      signature: { response: [["BodyText", "Edm.String"]] },
      // Learn: returns the report definition (BodyText). Rendering is not simulated.
      handle: (c) => {
        need(c, "report", "Read");
        const row = reportOf(c);
        return respond(c, "DownloadReportDefinition", { BodyText: row.bodytext ?? null });
      },
    },
    {
      name: "GetReportHistoryLimit", kind: "function", binding: "entity", entity: "report",
      signature: { response: [["HistoryLimit", "Edm.Int32"]] },
      // unverified: live capture (the limit is a fixed stand-in of 0; no snapshot history is kept).
      handle: (c) => {
        need(c, "report", "Read");
        reportOf(c);
        return respond(c, "GetReportHistoryLimit", { HistoryLimit: 0 });
      },
    },
    {
      name: "SetReportRelated", kind: "action", binding: "unbound",
      signature: { params: [["ReportId", "Edm.Guid"], ["Entities", "Collection(Edm.Int32)"], ["Categories", "Collection(Edm.Int32)"], ["Visibility", "Collection(Edm.Int32)"]] },
      // Learn: links a report to related entities, categories and visibility codes. Categories replace the report's category
      // rows (reportcategory_categorycode 1 to 4; unverified: live capture). Entities and Visibility are checked but not stored:
      // reportentity and reportvisibility are absent natively.
      handle: async (c) => {
        need(c, "report", "Write");
        const args = argsOf(c);
        const reportId = idOf(args.ReportId);
        if (!rowOf(store, "report", "reportid", reportId)) throw notFound("report", reportId ?? ZERO_GUID);
        integers(args.Entities, "Entities");
        const categories = [...new Set(integers(args.Categories, "Categories"))];
        if (categories.some((code) => ![1, 2, 3, 4].includes(code))) throw invalid("Categories must be 1, 2, 3 or 4.");
        integers(args.Visibility, "Visibility");
        await write(() => {
          const rows = tableOf(store, "reportcategory");
          for (let i = rows.length - 1; i >= 0; i -= 1) if (sameId(idOf(rows[i].reportid), reportId)) rows.splice(i, 1);
          for (const code of categories) rows.push({ reportcategoryid: uuidV5(reportId, `rc:${code}`), reportid: reportId, categorycode: code });
        });
        return { status: 204 };
      },
    },
  ];
}

function throwNotFound(logical, id) {
  throw notFound(logical, id);
}

export function install(api) {
  for (const op of operations(api)) api.registry.register(op);
}

export const EXTENSION = { name: "dataverse-app-messages", install };
