const API = "/__sim/api";
const $ = (selector, root = document) => root.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const json = (value) => JSON.stringify(value, null, 2);
const badge = (text, tone = "") =>
  `<span class="badge ${tone}">${escape(text)}</span>`;
const views = [
  ["overview", "Overview", "◈"],
  ["records", "Data records", "▤"],
  ["portal", "Portal configuration", "✎"],
  ["endpoints", "Endpoints", "⇄"],
  ["operations", "Server logic & flows", ""],
  ["mappings", "Entity mappings", "◇"],
  ["plugins", "Plugins & presets", "⌘"],
  ["access", "Identity & permissions", "♙"],
  ["scenarios", "Scenarios", "▶"],
  ["environment", "Environment", "⚙"],
  ["connection", "Live connection", "↗"],
  ["runtime", "Runtime state", "⟳"],
  ["evidence", "Render & diagnostics", "◎"],
  ["audit", "Request audit", "≋"],
  ["logs", "Live logs", "☰"],
];
let state;
// Deep links are #view or #view?name=value: records (entity, id), audit filters,
// portal items (kind, name), access (contact) and logs (type).
const parseHash = () => {
  const [view = "", query = ""] = location.hash.slice(1).split("?");
  return { view, params: new URLSearchParams(query) };
};
let activeView = views.some(([id]) => id === parseHash().view)
  ? parseHash().view
  : "overview";
let pendingRoute = null,
  routeNotice = "";
let selectedEntity = "";
let filter = "";
let editContext;
let confirmAction;
let toastTimer;
let shellCaptureResult;
// Shell capture starts from the site home page; any other portal page can be entered.
let shellCapturePath = "/";
let managedControlPath = "";
const browsers = new Map();
const browserFor = (key) => {
  if (!browsers.has(key))
    browsers.set(key, {
      page: 1,
      size: key === "records" ? 20 : 10,
      search: "",
    });
  return browsers.get(key);
};
const openDisclosures = new Set(),
  disclosureRenderers = new Map();
function disclosure(key, label, renderer) {
  disclosureRenderers.set(key, renderer);
  return `<details class="panel section-gap disclosure" data-disclosure="${escape(key)}" ${openDisclosures.has(key) ? "open" : ""}><summary>${escape(label)}</summary><div data-disclosure-body>${openDisclosures.has(key) ? renderer() : ""}</div></details>`;
}
// Unsaved form input belongs to the user until that form is submitted successfully or the
// view changes. Views re-render for lazy loads, refreshes and live updates; restore the
// controls the user changed instead of silently replacing them with stored values.
const drafts = new Map();
function rememberDraft(control) {
  const form = control?.closest?.("#content form[id]");
  // File inputs cannot be restored programmatically; their contents are read immediately.
  if (!form || !control.id || !("value" in control) || control.type === "file") return;
  if (!drafts.has(form.id)) drafts.set(form.id, new Map());
  drafts
    .get(form.id)
    .set(
      control.id,
      control.type === "checkbox" || control.type === "radio"
        ? { checked: control.checked }
        : { value: control.value },
    );
}
function restoreDrafts() {
  for (const [formId, controls] of drafts) {
    const form = document.getElementById(formId);
    if (!form) continue;
    for (const [id, saved] of controls) {
      const control = form.querySelector(`#${CSS.escape(id)}`);
      if (!control) continue;
      if ("checked" in saved) control.checked = saved.checked;
      else control.value = saved.value;
    }
  }
}
const lazyValues = new Map();
function lazyJson(label, value) {
  const key = String(lazyValues.size);
  lazyValues.set(key, value);
  return `<details class="section-gap lazy-detail" data-lazy-json="${key}"><summary>${escape(label)}</summary><pre class="json-view"></pre></details>`;
}
function inspectButton(value) {
  const key = String(lazyValues.size);
  lazyValues.set(key, value);
  return `<button class="button small" data-inspect="${key}">Inspect request</button>`;
}
function sliceRows(key, items) {
  const settings = browserFor(key),
    matches = settings.search
      ? items.filter((item) =>
          JSON.stringify(item)
            .toLowerCase()
            .includes(settings.search.toLowerCase()),
        )
      : items;
  const pages = Math.max(1, Math.ceil(matches.length / settings.size));
  settings.page = Math.min(settings.page, pages);
  return {
    items: matches.slice(
      (settings.page - 1) * settings.size,
      settings.page * settings.size,
    ),
    total: matches.length,
    pages,
    settings,
  };
}
function tableTools(key, total, pages, { search = true } = {}) {
  const settings = browserFor(key);
  return `<div class="table-tools">${search ? `<input type="search" data-table-search="${escape(key)}" aria-label="Search ${escape(key)}" placeholder="Filter ${escape(key)}…" value="${escape(settings.search)}">` : ""}<span class="record-count">${total} results · Page ${settings.page} of ${pages}</span><label>Rows <select data-table-size="${escape(key)}" aria-label="Rows per page for ${escape(key)}">${[10, 20, 50].map((size) => `<option ${settings.size === size ? "selected" : ""}>${size}</option>`).join("")}</select></label><div class="pager"><button class="button small" data-table-page="${escape(key)}" data-delta="-1" ${settings.page <= 1 ? "disabled" : ""}>Previous</button><button class="button small" data-table-page="${escape(key)}" data-delta="1" ${settings.page >= pages ? "disabled" : ""}>Next</button></div></div>`;
}
let auditResult,
  auditLoading = false,
  auditError = "",
  auditGeneration = 0;
let recordResult,
  recordLoading = false,
  recordError = "",
  recordGeneration = 0,
  contactsLoading = false;
async function loadRecords() {
  if (state?.data && !state.summaryMode) return;
  const names = entities();
  if (!names.includes(selectedEntity)) selectedEntity = names[0] || "";
  if (!selectedEntity) return;
  const generation = ++recordGeneration,
    settings = browserFor("records");
  recordLoading = true;
  recordError = "";
  render();
  try {
    const result = await request(
      `/records/${encodeURIComponent(selectedEntity)}?` +
        new URLSearchParams({
          page: settings.page,
          pageSize: settings.size,
          search: filter,
        }),
    );
    if (generation === recordGeneration) {
      recordResult = result;
      settings.page = result.page;
    }
  } catch (error) {
    if (generation === recordGeneration) recordError = error.message;
  } finally {
    if (generation === recordGeneration) {
      recordLoading = false;
      if (activeView === "records") render();
    }
  }
}
async function loadContacts() {
  if (state?.data?.contact || contactsLoading) return;
  contactsLoading = true;
  try {
    let page = 1,
      rows = [],
      result;
    do {
      result = await request(`/records/contact?page=${page++}&pageSize=100`);
      rows.push(...result.items);
    } while (page <= result.pageCount);
    state.data ??= {};
    state.data.contact = rows;
  } catch (error) {
    notify(error.message, true);
  } finally {
    contactsLoading = false;
    if (["access", "scenarios"].includes(activeView)) render();
  }
}
let accessRules,
  accessRulesError = "";
async function loadAccessRules() {
  try {
    accessRules = await request("/portal-access-rules");
    accessRulesError = "";
  } catch (error) {
    accessRules = undefined;
    accessRulesError = error.message;
  }
  if (activeView === "portal") render();
}
let environmentResult,
  environmentError = "",
  enrichmentReport = null;
async function loadEnvironment() {
  try {
    environmentResult = await request("/environment");
    environmentError = "";
  } catch (error) {
    environmentResult = undefined;
    environmentError = error.message;
  }
  if (activeView === "environment") render();
}
async function loadView() {
  if (activeView !== "logs") disconnectLogs();
  if (activeView === "audit") await loadAudit();
  if (activeView === "records") await loadRecords();
  if (["access", "scenarios"].includes(activeView)) await loadContacts();
  if (activeView === "access") {
    await loadExternalIdentities();
    if (activeView === "access") render();
  }
  if (activeView === "portal") await loadAccessRules();
  if (activeView === "environment") await loadEnvironment();
  if (activeView === "logs") connectLogs();
  await followRoute();
}
/** Filters and selections a deep link sets before its view loads. */
function applyRoute(view, params) {
  const has = [...params.keys()].length > 0;
  if (view === "records") {
    if (params.get("entity")) {
      selectedEntity = params.get("entity");
      recordResult = undefined;
      browserFor("records").page = 1;
    }
    if (params.has("id")) {
      filter = params.get("id") ?? "";
      browserFor("records").page = 1;
    }
  }
  if (view === "audit" && has) {
    for (const key of Object.keys(auditFilters))
      auditFilters[key] = params.get(key) ?? "";
    browserFor("audit").page = 1;
  }
  if (view === "access" && params.get("contact"))
    selectedPersona = params.get("contact");
  if (view === "logs" && params.get("type")) logFilters.type = params.get("type");
  routeNotice = "";
  pendingRoute = has ? { view, params } : null;
}
/** Actions a deep link asks for once its data is loaded: open a record or portal item. */
async function followRoute() {
  const route = pendingRoute;
  if (!route || route.view !== activeView || !state) return;
  pendingRoute = null;
  if (route.view === "records" && route.params.get("id")) {
    const id = route.params.get("id");
    const mapping = collection("mappings").find(
      (item) => (item.logicalName || item.entity) === selectedEntity,
    );
    const idColumn = mapping?.idColumn || `${selectedEntity}id`;
    const key = (value) =>
      String(value ?? "")
        .replace(/[{}]/g, "")
        .toLowerCase();
    const rows = state.summaryMode
      ? recordResult?.items || []
      : state.data?.[selectedEntity] || [];
    const match = rows.find((row) => key(row[idColumn] ?? row.id) === key(id));
    if (match) await openEditor("records", String(match[idColumn] ?? match.id));
    else {
      routeNotice = `No ${selectedEntity} record has ID ${id}; the list shows records whose values contain it.`;
      render();
    }
  }
  if (route.view === "portal") {
    const editorName = {
      settings: "portal-settings",
      snippets: "portal-snippets",
      roles: "portal-roles",
      "access-rules": "portal-access-rules",
    }[route.params.get("kind")];
    if (editorName && route.params.get("name"))
      await openEditor(editorName, route.params.get("name"));
  }
}
const auditFilters = {
  kind: "",
  provider: "",
  outcome: "",
  status: "",
  path: "",
  entity: "",
  search: "",
  correlationId: "",
};
const activeAuditFilters = () =>
  Object.fromEntries(Object.entries(auditFilters).filter(([, value]) => value));
// ---- Live logs: /__sim/events?channels=logs while the Live logs view is open.
const logEntries = [],
  pausedLogs = [],
  logFilters = { type: "", search: "" };
let logSource = null,
  logPaused = false,
  logStatus = "Disconnected",
  logFrame = 0;
function connectLogs() {
  if (logSource || typeof EventSource !== "function") return;
  logStatus = "Connecting…";
  logSource = new EventSource("/__sim/events?channels=logs");
  const add = (entry) => {
    if (logPaused) pausedLogs.push(entry);
    else logEntries.unshift(entry);
    if (logEntries.length > 500) logEntries.length = 500;
    if (pausedLogs.length > 500) pausedLogs.splice(0, pausedLogs.length - 500);
    scheduleLogs();
  };
  logSource.addEventListener("open", () => {
    logStatus = "Streaming";
    scheduleLogs();
  });
  logSource.addEventListener("error", () => {
    logStatus = "Reconnecting…";
    scheduleLogs();
  });
  logSource.addEventListener("log", (event) => {
    try {
      add(JSON.parse(event.data));
    } catch {
      /* ignore malformed frames */
    }
  });
  logSource.addEventListener("reload", (event) =>
    add({
      type: "reload",
      level: "info",
      time: new Date().toISOString(),
      revision: Number(event.data),
    }),
  );
}
function disconnectLogs() {
  logSource?.close();
  logSource = null;
  logStatus = "Disconnected";
}
async function loadAudit() {
  const generation = ++auditGeneration;
  auditLoading = true;
  auditError = "";
  render();
  const settings = browserFor("audit"),
    query = new URLSearchParams({
      page: String(settings.page),
      pageSize: String(settings.size),
      ...activeAuditFilters(),
    });
  try {
    const result = await request("/audit?" + query);
    if (generation === auditGeneration) auditResult = result;
  } catch (error) {
    if (generation === auditGeneration) auditError = error.message;
  } finally {
    if (generation === auditGeneration) {
      auditLoading = false;
      if (activeView === "audit") render();
    }
  }
}
const config = () => state?.config || {};
const collection = (name) => config()[name] || state?.[name] || [];
const entities = () =>
  [
    ...new Set([
      ...Object.keys(state?.data || {}),
      ...Object.keys(state?.status?.tableCounts || {}),
      ...collection("mappings")
        .map((item) => item.logicalName || item.entity)
        .filter(Boolean),
    ]),
  ].sort();
const heading = (title, description, action = "") =>
  `<div class="page-heading"><div><span class="eyebrow">SIMULATOR WORKSPACE</span><h1>${escape(title)}</h1><p>${escape(description)}</p></div>${action}</div>`;
const addButton = (name, label) =>
  `<button class="button primary" type="button" data-add="${name}" aria-label="${escape(label)}">+ ${escape(label)}</button>`;
const empty = (title, description, action = "") =>
  `<div class="empty"><div class="empty-icon" aria-hidden="true">◇</div><h2>${escape(title)}</h2><p>${escape(description)}</p>${action}</div>`;
const rowActions = (name, id) =>
  `<button class="button small" type="button" data-edit="${name}" data-id="${escape(id)}">Edit</button><button class="button small quiet" type="button" data-delete="${name}" data-id="${escape(id)}" aria-label="Delete ${escape(id)}">Delete</button>`;
const objectValue = (value) =>
  value === undefined || value === null
    ? "—"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
const previewValue = (value) => {
  const text = objectValue(value);
  return text.length > 140 ? text.slice(0, 137) + "…" : text;
};

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.method && options.method !== "GET" && state?.csrf
        ? { "X-Sim-CSRF": state.csrf }
        : {}),
      ...options.headers,
    },
    cache: "no-store",
  });
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Simulator returned invalid JSON (${response.status}).`);
  }
  if (!response.ok) {
    const error = new Error(
      typeof result.error === "string"
        ? result.error
        : result.error?.message ||
            result.message ||
            `Request failed (${response.status}).`,
    );
    error.details = result;
    throw error;
  }
  return result;
}

function notify(message, error = false) {
  clearTimeout(toastTimer);
  const el = $("#notification");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  toastTimer = setTimeout(
    () => {
      el.hidden = true;
    },
    error ? 9000 : 4500,
  );
}

// This browser's own sign-in session: a cookie the Mirage sets on the browser that asks.
// It is separate from the default persona that the local sign-in page offers.
let browserSession = null,
  sessionPick = "";
async function loadSession() {
  try {
    const session = await request("/session");
    browserSession = {
      signedIn: Boolean(session.signedIn),
      contactId: session.contactId ?? null,
      name: session.name ?? null,
      roles: Array.isArray(session.roles) ? session.roles : [],
      roleSource: session.roleSource ?? "memberships",
      accountId: session.accountId ?? null,
      identityProvider: session.identityProvider && typeof session.identityProvider === "object" ? session.identityProvider : null,
    };
  } catch (error) {
    browserSession = { signedIn: false, roles: [], error: error.message };
  }
}
// External identity records (GET /session/identities: { table, identities, registrations }),
// for the access view; null when this Mirage does not report them.
let externalIdentities;
async function loadExternalIdentities() {
  try {
    const result = await request("/session/identities");
    externalIdentities = {
      table: typeof result?.table === "string" ? result.table : null,
      identities: Array.isArray(result?.identities) ? result.identities : [],
    };
  } catch {
    externalIdentities = null;
  }
}
/** The provider the portal's sign-in uses (its default one), or null: the local sign-in page. */
function signInProvider() {
  const idp = browserSession?.identityProvider;
  if (!idp?.available) return null;
  const providers = Array.isArray(idp.providers) ? idp.providers : [];
  return providers.find((item) => item?.default) || providers[0] || null;
}
/** How the portal signs in, as label/value rows: the provider, its callback and the local identity provider. */
function signInRoute() {
  const idp = browserSession?.identityProvider;
  const provider = signInProvider();
  if (!provider) return [["Sign-in", `Local sign-in page${idp?.reason ? ` (${idp.reason})` : ""}`]];
  return [
    ["Identity provider", `${provider.caption || provider.name || provider.id}${provider.type ? ` (${provider.type})` : ""}`],
    ["Callback path", provider.callbackPath || "Not reported"],
    ["Local identity provider", idp.origin ? `${idp.origin}${idp.port ? ` (port ${idp.port})` : ""}` : idp.port ? `Port ${idp.port}` : "Not reported"],
  ];
}
const returnHere = () => `/_sim/${location.hash || "#access"}`;
/**
 * The portal's own sign-in for this browser, as a person runs it: the identity provider's
 * external login with a login_hint (the local identity provider answers it without a click), or
 * the local persona sign-in page when the site has no external provider. A signed-in browser
 * signs out first, because an external login made while signed in links to that account. The
 * page navigates and comes back to this view; it never sets the session cookie itself.
 */
async function signInThroughPortal(contactId) {
  const provider = signInProvider();
  if (browserSession?.signedIn)
    await fetch("/Account/Login/LogOff?returnUrl=%2F", { credentials: "same-origin", redirect: "manual", cache: "no-store" });
  const response = await fetch("/_layout/tokenhtml", { credentials: "same-origin", cache: "no-store" });
  const html = response.ok ? await response.text() : "";
  const token = new DOMParser().parseFromString(html, "text/html").querySelector('input[name="__RequestVerificationToken"]')?.value;
  if (!token) throw new Error(`The portal returned no antiforgery token at /_layout/tokenhtml (HTTP ${response.status}).`);
  const form = document.createElement("form");
  form.method = "post";
  form.action = provider
    ? `/Account/Login/ExternalLogin?returnUrl=${encodeURIComponent(returnHere())}`
    : `/SignIn?ReturnUrl=${encodeURIComponent(returnHere())}`;
  form.hidden = true;
  const fields = provider ? { provider: provider.id, login_hint: contactId } : { contactId };
  for (const [name, value] of Object.entries({ ...fields, __RequestVerificationToken: token })) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  HTMLFormElement.prototype.submit.call(form);
}
/** The portal's sign-out (through the provider's end-session); it comes back to this view. */
function signOutThroughPortal() {
  location.assign(`/Account/Login/LogOff?returnUrl=${encodeURIComponent(returnHere())}`);
}
/** The simulation override: explicit web roles for this browser's signed-in session; null clears it. */
async function setSessionRoles(roles) {
  await request("/session/roles", { method: "POST", body: JSON.stringify({ roles }) });
  await loadSession();
  render();
}
/**
 * The simulation override: explicit web-role names for this browser's signed-in session instead
 * of the contact's memberships. It applies on top of a real sign-in and never signs in by itself.
 */
function sessionOverrideForm() {
  const session = browserSession || {};
  const override = session.roleSource === "override";
  const disabled = session.signedIn ? "" : " disabled";
  return `<section class="advanced-content"><div class="panel-heading"><h2>Simulation override</h2>${badge(override ? "Override active" : "No override", override ? "amber" : "")}</div><p class="muted">Replaces the web roles of this browser's signed-in session with explicit role names, for quick role tests. It applies on top of a real sign-in through the portal and never signs in by itself; signing out or signing in again ends it.</p>${session.signedIn ? "" : '<div class="notice section-gap">Sign this browser in through the portal first.</div>'}<form id="session-override-form" class="form-grid"><div><label for="override-roles">Web roles for ${escape(session.signedIn ? session.name || session.contactId : "this browser's session")}</label><input id="override-roles" value="${escape(override ? (session.roles || []).join(", ") : "")}" placeholder="Authenticated Users, Administrators"${disabled}><p class="field-help">Separate role names with commas.</p></div><div class="toolbar"><button class="button primary" type="submit"${disabled}>Apply override</button>${override ? '<button class="button" type="button" data-action="session-override-clear">Clear override</button>' : ""}</div></form></section>`;
}
const sessionSummary = () =>
  !browserSession
    ? "Loading this browser's session"
    : browserSession.signedIn
      ? `Signed in as ${browserSession.name || browserSession.contactId}`
      : "Anonymous: this browser is not signed in";
const contactLabel = (record) =>
  record
    ? record.fullname ||
      [record.firstname, record.lastname].filter(Boolean).join(" ") ||
      record.contactid
    : "";
function sessionPanel() {
  const session = browserSession || { signedIn: false, roles: [] };
  const contacts = state.data?.contact || [];
  const wanted = personaId(
    sessionPick ||
      (session.signedIn ? session.contactId : "") ||
      selectedPersona ||
      contacts[0]?.contactid,
  );
  const chosen =
    contacts.find((record) => personaId(record.contactid) === wanted) ||
    contacts[0];
  const signOut = session.signedIn
    ? '<button class="button" type="button" data-action="session-sign-out">Sign out</button>'
    : "";
  const provider = signInProvider();
  return `<section class="panel"><div class="panel-heading"><h2>This browser's session</h2>${session.roleSource === "override" ? badge("Simulation override", "amber") : ""}${badge(session.signedIn ? "Signed in" : "Anonymous", session.signedIn ? "green" : "")}</div><p class="muted">Portal pages opened in this browser use this session. Signing in runs the portal's own sign-in (${provider ? "the identity provider's external login, answered by the local identity provider" : "the local sign-in page"}) and comes back here; signing out ends the session${provider ? " through the provider's end-session" : ""}. Other browsers, including the toolkit browser, keep their own sessions, and the sign-in page default below does not change it.</p><div class="notice"><strong>${escape(sessionSummary())}</strong><br>${escape((session.roles || []).join(", ") || "No roles")}${session.roleSource === "override" ? " (simulation override)" : ""}${session.accountId ? `<br>Account: ${escape(session.accountId)}` : ""}</div><div class="detail-list section-gap" id="sign-in-route">${signInRoute().map(([title, value]) => `<div class="row"><span class="row-title">${escape(title)}</span><span class="row-detail source-path">${escape(value)}</span></div>`).join("")}</div>${session.error ? `<div class="notice warning section-gap">${escape(session.error)}</div>` : ""}${
    contacts.length
      ? `<div class="form-grid section-gap"><div><label for="session-contact">Persona for this browser</label><select id="session-contact">${contacts.map((record) => `<option value="${escape(record.contactid)}" ${personaId(record.contactid) === personaId(chosen?.contactid) ? "selected" : ""}>${escape(contactLabel(record))}</option>`).join("")}</select></div></div><div class="toolbar"><button class="button primary" type="button" data-action="session-sign-in">Sign in as ${escape(contactLabel(chosen))}</button>${signOut}</div>`
      : `<div class="notice section-gap">No local contacts to sign in as yet: create a persona below.</div>${signOut ? `<div class="toolbar">${signOut}</div>` : ""}`
  }</section>`;
}
async function refresh({ announce = false } = {}) {
  const refreshButton = $("#refresh");
  refreshButton.disabled = true;
  try {
    state = await request("/state?summary=1");
    state.summaryMode = !state.data;
    await loadSession();
    recordResult = undefined;
    $("#connection-dot").className = "status-dot ready";
    $("#connection-label").textContent = "Simulator connected";
    render();
    await loadView();
    if (announce) notify("Workspace refreshed.");
  } catch (error) {
    $("#connection-dot").className = "status-dot error";
    $("#connection-label").textContent = "Connection interrupted";
    if (!state)
      $("#content").innerHTML = empty(
        "Unable to load the workspace",
        error.message,
        '<button class="button primary" data-action="retry">Try again</button>',
      );
    notify(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
}

function overview() {
  const rows = Object.values(
    state.status?.tableCounts ||
      Object.fromEntries(
        Object.entries(state.data || {}).map(([name, rows]) => [
          name,
          rows.length,
        ]),
      ),
  ).reduce((sum, count) => sum + Number(count || 0), 0);
  const status = state.status || {};
  const diagnostics = state.diagnostics || status.diagnostics || [];
  const pages = status.pages || state.pages || [];
  const pageCount = Array.isArray(pages) ? pages.length : pages;
  const metrics = [
    ["Data records", rows, `${entities().length} configured entities`, "▤"],
    [
      "Discovered pages",
      pageCount || status.pageCount || 0,
      status.exportFormat || status.format || "From your PAC export",
      "◇",
    ],
    [
      "Active plugins",
      collection("plugins").filter((item) => item.enabled !== false).length,
      `${collection("presets").length} simulation presets`,
      "⌘",
    ],
    [
      "Diagnostics",
      diagnostics.length,
      "Inspect rendering and runtime evidence",
      "◎",
    ],
  ];
  return (
    heading(
      "Your local portal workspace",
      "Render portal sources and test configured data and backend rules.",
    ) +
    `<div class="cards">${metrics.map(([label, value, detail, icon]) => `<div class="metric"><span class="metric-icon" aria-hidden="true">${icon}</span><div class="metric-label">${label}</div><div class="metric-value">${escape(value)}</div><div class="metric-detail">${escape(detail)}</div></div>`).join("")}</div>` +
    `<div class="grid-two"><section class="panel tall-panel"><div class="panel-heading"><h2>Workspace configuration</h2>${badge(config().mode === "live" ? "Live data" : "Local data", config().mode === "live" ? "amber" : "green")}</div>
      <div class="row"><div><div class="row-title">Page rendering</div><div class="row-detail">${config().pageMode === "live" ? "Pages from the connected environment" : "Liquid and portal metadata from local sources"}</div></div>${badge(config().pageMode === "live" ? "Live" : "Local")}</div>
      <div class="row"><div><div class="row-title">Data provider</div><div class="row-detail">${config().mode === "live" ? escape(config().live?.origin || "Live environment selected") : "Persistent mock data and configurable plugin rules"}</div></div><button class="button small" data-view="connection">Configure</button></div>
      <div class="row"><div><div class="row-title">This browser</div><div class="row-detail">${escape(sessionSummary())} · ${escape((browserSession?.roles || []).join(", ") || "No roles")}</div></div>${badge(browserSession?.signedIn ? "Signed in" : "Anonymous", browserSession?.signedIn ? "green" : "")}<button class="button small" data-view="access">Manage</button></div>
      <div class="row"><div><div class="row-title">Sign-in route</div><div class="row-detail">${escape(signInRoute().map(([title, value]) => `${title}: ${value}`).join(" · "))}</div></div></div>
      <div class="row"><div><div class="row-title">Sign-in page default</div><div class="row-detail">${escape(config().identity?.name || config().identity?.contactId || config().identity?.id || "No default persona")}</div></div></div>
      <div class="row"><div><div class="row-title">Source checkout</div><div class="row-detail source-path">${escape(status.repo || status.source || status.sourceDir || state.repo || "See simulator launch configuration")}</div></div></div>
      <div class="row"><div><div class="row-title">Runtime</div><div class="row-detail">Revision ${escape(status.revision ?? "not reported")} · source ${escape(String(status.sourceFingerprint ?? "").slice(0, 12) || "not reported")}${config().activeScenario ? ` · scenario ${escape(config().activeScenario.name || config().activeScenario.id)}` : ""}</div></div><button class="button small" data-view="runtime">Details</button></div>
    </section><section class="panel"><div class="panel-heading"><h2>Make the simulation yours</h2></div>
      ${[
        [
          "records",
          "Populate your data",
          "Create records for FetchXML and Web API queries.",
        ],
        [
          "plugins",
          "Simulate backend rules",
          "Validate mutations and populate fields automatically.",
        ],
        [
          "evidence",
          "Inspect render evidence",
          "Review diagnostics and compare captured portal output.",
        ],
      ]
        .map(
          ([view, title, desc]) =>
            `<div class="row"><div><div class="row-title">${title}</div><div class="row-detail">${desc}</div></div><button class="button small quiet" data-view="${view}" aria-label="${title}">→</button></div>`,
        )
        .join("")}
      <p class="muted">Source coverage and rendered fidelity are separate checks. The evidence view reports only observed results.</p>
    </section></div>`
  );
}

function records() {
  const names = entities();
  if (!names.includes(selectedEntity)) selectedEntity = names[0] || "";
  const all = state.summaryMode
    ? recordResult?.items || []
    : state.data?.[selectedEntity] || [];
  const rows = all.filter((item) =>
    JSON.stringify(item).toLowerCase().includes(filter.toLowerCase()),
  );
  const page = state.summaryMode
    ? {
        items: all,
        total: recordResult?.total || 0,
        pages: recordResult?.pageCount || 1,
      }
    : sliceRows("records", rows);
  const mapping = collection("mappings").find(
    (item) => (item.logicalName || item.entity) === selectedEntity,
  );
  const idColumn = mapping?.idColumn || `${selectedEntity}id`;
  const columns = [
    ...new Set([idColumn, ...all.flatMap((item) => Object.keys(item))]),
  ].slice(0, 6);
  return (
    heading(
      "Data records",
      "Manage mock records used by local data requests and form/list schemas.",
      selectedEntity ? addButton("records", "Create record") : "",
    ) +
    (config().mode === "live"
      ? '<div class="notice section-gap">This editor changes local records. Selecting live data does not turn record administration into live environment administration.</div>'
      : "") +
    `<div class="toolbar"><label class="nowrap" for="entity-select">Entity</label><select id="entity-select">${names.map((name) => `<option ${name === selectedEntity ? "selected" : ""}>${escape(name)}</option>`).join("")}</select><input id="record-search" type="search" placeholder="Search record values…" aria-label="Search record values" value="${escape(filter)}"><span class="record-count">${page.total} matching records</span></div>${recordLoading ? '<p role="status" class="muted">Loading records…</p>' : ""}${recordError ? `<div class="notice warning">${escape(recordError)}</div>` : ""}${routeNotice ? `<div class="notice warning">${escape(routeNotice)}</div>` : ""}` +
    (!selectedEntity
      ? empty(
          "Map your first entity",
          "Entity mappings connect Dataverse logical names, entity sets, and primary ID fields.",
          '<button class="button primary" data-view="mappings">Configure entities</button>',
        )
      : !rows.length
        ? empty(
            all.length
              ? "No matching records"
              : "This entity is ready for data",
            all.length
              ? "Try a different search."
              : `Create a ${selectedEntity} record or apply a preset to populate this entity.`,
            all.length ? "" : addButton("records", "Create record"),
          )
        : tableTools("records", page.total, page.pages, { search: false }) +
          `<div class="table-wrap"><table><thead><tr>${columns.map((column) => `<th>${escape(column)}</th>`).join("")}<th>Actions</th></tr></thead><tbody>${page.items
            .map((record, index) => {
              const id = record[idColumn] ?? record.id;
              return `<tr>${columns.map((column) => `<td title="${escape(previewValue(record[column]))}">${escape(previewValue(record[column]))}</td>`).join("")}<td class="actions">${id === undefined ? `<span class="muted">Missing ${escape(idColumn)}</span>` : rowActions("records", id)}</td></tr>`;
            })
            .join("")}</tbody></table></div>`)
  );
}

function operations() {
  const items = config().operations ?? [];
  return heading('Server logic & flows', 'Discovered from the selected portal and solution exports. Responses and execution choices stay in local simulator state.') +
    '<div class="notice section-gap">Supported Request/Response flows run locally. Other operations start as explicit placeholders. Choose a mock response, a trusted project handler, or opt in to executing the exported server code against local data. External connectors are never contacted by this adapter.</div>' +
    (items.length ? items.map((item, index) => {
      const value = item.configuration ?? { mode: item.mode, status: 200, body: {} };
      const disabled = !item.configurable ? ' disabled' : '';
      return `<section class="panel section-gap"><div class="panel-heading"><h2>${escape(item.name)}</h2>${badge(item.kind)}${badge(item.mode)}</div><p class="muted">${item.path ? escape(item.path) : 'No exported portal consumer. Add a consumer with its web-role grants before invoking this workflow.'}</p>${item.sourceFile ? `<p class="field-help">Source: ${escape(item.sourceFile)}</p>` : '<p class="field-help">No executable definition in the selected sources.</p>'}${item.contract ? lazyJson('Input schema and exported actions', item.contract) : ''}<form id="operation-form-${index}" data-operation-key="${escape(item.key)}" class="form-grid"><div><label for="operation-mode-${index}">Local behavior</label><select id="operation-mode-${index}" name="mode"${disabled}>${[['placeholder','Placeholder (501)'],['mock','Configured response'],['exported','Execute exported definition'],['handler','Trusted project handler']].map(([mode,label]) => `<option value="${mode}"${value.mode === mode ? ' selected' : ''}${mode === 'handler' && !item.registered || mode === 'exported' && !item.definitionAvailable ? ' disabled' : ''}>${label}</option>`).join('')}</select></div><div><label for="operation-status-${index}">Mock response status</label><input id="operation-status-${index}" name="status" type="number" min="200" max="599" value="${escape(value.status ?? 200)}"${disabled}><p class="field-help">Server logic uses its native success envelope; status 400 or above simulates failure.</p></div><div><label for="operation-body-${index}">Mock response body (JSON)</label><textarea id="operation-body-${index}" name="body" class="code-editor" rows="6" spellcheck="false"${disabled}>${escape(json(Object.hasOwn(value, 'body') ? value.body : {}))}</textarea></div><div class="toolbar"><button class="button primary" type="submit"${disabled}>Save local behavior</button>${item.configuration ? `<button class="button" type="button" data-operation-reset="${escape(item.key)}">Use source default</button>` : ''}</div></form><p class="field-help">Exported web-role grants still apply. A mock response does not test the flow's business logic or connector behavior.</p></section>`;
    }).join('') : empty('No exported operations', 'Include server logic, cloud-flow consumers or unpacked solution Workflows in the selected sources.'));
}

const definitions = {
  mappings: {
    title: "Entity mappings",
    description:
      "Connect logical names to Web API entity sets, primary IDs, and relationships.",
    label: "Add mapping",
    help: "Use the same logical names and ID columns as your exported portal. The mapping ID equals its logical name. Relationships may be added to resolve linked queries.",
    sample: () => ({
      logicalName: "account",
      entitySet: "accounts",
      idColumn: "accountid",
      relationships: {},
    }),
    columns: [
      ["Entity", "logicalName"],
      ["Entity set", "entitySet"],
      ["Primary ID", "idColumn"],
    ],
  },
  endpoints: {
    title: "Endpoints",
    description:
      "Define custom responses or route individual requests to the connected environment.",
    label: "Add endpoint",
    help: "Match a request path and HTTP method. Local endpoints return the configured status and body; live endpoints use the connected environment.",
    sample: () => ({
      id: crypto.randomUUID(),
      path: "/api/example",
      method: "GET",
      mode: "local",
      status: 200,
      body: { value: [] },
    }),
    columns: [
      ["Path", "path"],
      ["Method", "method"],
      ["Provider", "mode"],
      ["Status", "status"],
    ],
  },
  plugins: {
    title: "Plugins & presets",
    description:
      "Simulate backend validations, computed fields, and repeatable data scenarios.",
    label: "Add plugin",
    help: "Plugin rules run on the configured operations. Validate inputs and set or default fields using declarative expressions.",
    sample: () => ({
      id: crypto.randomUUID(),
      name: "Require account name",
      entity: "account",
      enabled: true,
      operations: ["create", "update"],
      validate: [
        { field: "name", required: true, message: "Account name is required." },
      ],
      defaults: {},
      set: {},
      secondary: [],
    }),
    columns: [
      ["Plugin", "name"],
      ["Entity", "entity"],
      ["Operations", "operations"],
      ["Enabled", "enabled"],
    ],
  },
  permissions: {
    title: "Table permissions",
    description: "Define which roles can read or mutate each simulated table.",
    label: "Add permission",
    help: "Assign operations and roles to a table. Contact and account scopes use the configured identity and optional relationship field.",
    sample: () => ({
      id: crypto.randomUUID(),
      entity: "account",
      operations: ["read"],
      roles: ["Authenticated Users"],
      scope: "global",
    }),
    columns: [
      ["Entity", "entity"],
      ["Operations", "operations"],
      ["Roles", "roles"],
      ["Scope", "scope"],
    ],
  },
  presets: {
    title: "Simulation presets",
    description:
      "Save data and configuration scenarios and apply them to the workspace.",
    label: "Add preset",
    help: "A preset can seed tables and configure mappings, permissions, plugins, and settings for a repeatable scenario. Applying a preset changes simulator state.",
    sample: () => ({
      id: crypto.randomUUID(),
      name: "Example account",
      tables: {
        account: [{ accountid: crypto.randomUUID(), name: "Contoso local" }],
      },
      mappings: { account: { entitySet: "accounts", idColumn: "accountid" } },
    }),
    columns: [
      ["Preset", "name"],
      ["Description", "description"],
    ],
  },
  scenarios: {
    title: "Scenarios",
    description:
      "Combine a preset, a persona and permission settings, then apply them in one step.",
    label: "Add scenario",
    help: 'A scenario applies its optional preset first, then its persona and permission settings, in one local state change. persona is null for an anonymous visitor or {"contactId": "..."} for a local contact; permissionMode is enforce or permissive; permissionSource is configured, exported or combined. Omitted parts keep the current setup.',
    sample: () => ({
      id: "example-scenario",
      name: "Example scenario",
      description: "",
      preset: state?.status?.availablePresets?.[0]?.id ?? null,
      persona: null,
      permissionMode: "enforce",
    }),
    columns: [
      ["Scenario", "name"],
      ["Preset", "preset", (item) => item.preset || "Keep current data"],
      [
        "Persona",
        "persona",
        (item) =>
          item.persona === undefined
            ? "Keep current persona"
            : item.persona === null
              ? "Anonymous visitor"
              : item.persona.contactId,
      ],
      ["Permissions", "permissionMode", (item) => item.permissionMode || "Keep current"],
    ],
  },
};

function collectionTable(name) {
  const def = definitions[name];
  const items = collection(name);
  const page = sliceRows(name, items);
  if (!items.length)
    return empty(
      `No ${name} configured`,
      def.description,
      addButton(name, def.label),
    );
  return (
    tableTools(name, page.total, page.pages) +
    `<div class="table-wrap"><table><thead><tr>${def.columns.map(([label]) => `<th>${label}</th>`).join("")}<th>Actions</th></tr></thead><tbody>${page.items
      .map(
        (item) =>
          `<tr>${def.columns
            .map(([label, field, format], index) => {
              const value = format
                ? format(item)
                : item[field] ??
                  (field === "name" ? item.id : field === "enabled" ? true : "—");
              return `<td ${index === 0 ? 'class="item-title"' : ""}>${field === "mode" ? badge(value, value === "live" ? "amber" : "green") : escape(previewValue(Array.isArray(value) ? value.join(", ") : value))}</td>`;
            })
            .join(
              "",
            )}<td class="actions">${name === "presets" ? `<button class="button small" data-apply="${escape(item.id)}">Apply</button> ` : name === "scenarios" ? `<button class="button small" data-apply-scenario="${escape(item.id)}">Apply</button> ` : ""}${rowActions(name, item.id)}</td></tr>`,
      )
      .join("")}</tbody></table></div>`
  );
}

function configurationView(name) {
  const def = definitions[name];
  return (
    heading(def.title, def.description, addButton(name, def.label)) +
    collectionTable(name) +
    (name === "plugins"
      ? `<section class="section-gap"><div class="panel-heading"><div><h2>Simulation presets</h2><p class="muted">Restore a repeatable data scenario in one action.</p></div>${addButton("presets", "Add preset")}</div>${collectionTable("presets")}</section>${presetPicker()}`
      : "") +
    (name === "mappings"
      ? solutionMetadataPanel() +
        `<section class="panel section-gap"><div class="panel-heading"><div><h2>Form & view schema overrides</h2><p class="muted">Imported solution schemas apply automatically. Define overrides for unresolved or custom components.</p></div><button class="button" data-add="componentSchemas">Edit schemas</button></div>${lazyJson("Inspect schema overrides", config().componentSchemas || {})}</section>`
      : "")
  );
}

function solutionMetadataPanel() {
  const metadata = state.status?.solutionMetadata;
  const counts =
    metadata?.counts ||
    (metadata
      ? {
          ...metadata.resolved,
          ...metadata.data,
          solutionForms: metadata.forms ?? "Not reported",
          solutionViews: metadata.views ?? "Not reported",
          unresolved:
            typeof metadata.unresolved === "number"
              ? metadata.unresolved
              : (metadata.unresolved || []).length,
        }
      : {});
  const sources = metadata?.sources || metadata?.roots || [];
  const unresolved = metadata?.unresolved || metadata?.diagnostics || [];
  const hasSources = Array.isArray(sources) && sources.length > 0;
  return `<section class="panel section-gap"><div class="panel-heading"><h2>Imported solution metadata</h2>${badge(metadata ? (hasSources ? "Sources reported" : "No solution sources") : "No import status", "amber")}</div><p class="muted">Configured unpacked solutions supply form layouts, saved views, fields, and relationships. Imported counts describe available metadata; they do not prove native layout equivalence. Restart with repeatable <code>--solution-root PATH</code> arguments to change source roots.</p>${
    metadata
      ? `<div class="detail-list">${Object.entries(counts)
          .map(
            ([key, value]) =>
              `<div class="row"><span class="row-title">${escape(key)}</span><span class="row-detail">${escape(objectValue(value))}</span></div>`,
          )
          .join(
            "",
          )}</div>${lazyJson("Metadata sources", sources)}${Array.isArray(unresolved) && unresolved.length ? `<h3 class="section-gap">Unresolved metadata</h3>${diagnosticGroups(unresolved)}` : ""}${lazyJson("Full import status", metadata)}`
      : '<p class="muted">The server has not reported an import summary. Inspect the configured solution roots and runtime diagnostics.</p>'
  }</section>`;
}

function presetPicker() {
  const presets = state.status?.availablePresets || collection("presets");
  if (!presets.length) return "";
  return `<section class="panel section-gap"><div class="panel-heading"><h2>Apply a simulation scenario</h2>${badge("Local state change")}</div><p class="muted">Presets can replace records, identity, roles, and backend rules. Review the selected scenario before applying it.</p><div class="toolbar"><label for="available-preset">Available preset</label><select id="available-preset">${presets.map((preset) => `<option value="${escape(preset.id)}">${escape(preset.name || preset.id)}</option>`).join("")}</select><button class="button" data-apply-selected>Apply selected preset</button></div></section>`;
}

let selectedPersona = null;
const personaId = (value) =>
  String(value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
function personaPanel() {
  const model = state.status?.permissionModel || {};
  const contacts = state.data?.contact || [];
  const identity = state.status?.effectiveIdentity || config().identity || {};
  const desired = personaId(
    selectedPersona || identity.contactId || identity.id,
  );
  const chosen = contacts.some(
    (record) => personaId(record.contactid) === desired,
  )
    ? desired
    : personaId(contacts[0]?.contactid);
  const contact = contacts.find(
    (record) => personaId(record.contactid) === chosen,
  );
  const assignments = model.memberships || config().contactRoles || [];
  const assigned = new Set(
    assignments
      .filter((row) => row.contactId === chosen)
      .map((row) => row.roleId),
  );
  const roles = model.webRoles || state.status?.webRoles || [];
  return `<section class="panel section-gap"><div class="panel-heading"><h2>Contact personas</h2>${badge(identity.roleSource === "memberships" ? "Contact memberships" : "Role override", identity.roleSource === "memberships" ? "green" : "amber")}</div><p class="muted">Select a local contact and its exported web-role memberships. The account comes from that contact's parent customer. The default persona is the one the local sign-in page offers first; browsers sign in through that page or with "Sign in as" above. The live browser identity remains independent.</p>${
    contacts.length
      ? `<form id="persona-form" class="form-grid"><div><label for="persona-contact">Local contact</label><select id="persona-contact">${contacts.map((record) => `<option value="${escape(record.contactid)}" ${personaId(record.contactid) === chosen ? "selected" : ""}>${escape(record.fullname || [record.firstname, record.lastname].filter(Boolean).join(" ") || record.contactid)}</option>`).join("")}</select><p class="field-help">Selected contact account: ${escape(contact?.parentcustomerid?.name || contact?.parentcustomerid?.id || contact?.parentcustomerid || "None")}</p></div><fieldset class="role-picker"><legend>Contact web-role memberships</legend><p class="field-help">Assignments use the imported role IDs. Authenticated and anonymous roles marked in the export apply automatically.</p>${roles
          .filter((role) => role.id)
          .map(
            (role, index) =>
              `<div class="checkbox-line"><input type="checkbox" id="contact-role-${index}" data-contact-role="${escape(role.id)}" ${assigned.has(role.id) ? "checked" : ""}><label for="contact-role-${index}">${escape(role.name)}${role.authenticated ? " · authenticated default" : role.anonymous ? " · anonymous default" : ""}</label></div>`,
          )
          .join(
            "",
          )}</fieldset><div class="toolbar"><button class="button" type="submit" value="memberships">Save contact roles</button><button class="button primary" type="submit" value="select">Save roles and make default</button><button class="button" type="button" data-action="persona-sign-in">Make default on the sign-in page</button><button class="button quiet" type="button" data-action="persona-sign-out">No default persona</button></div></form>`
      : '<div class="notice">No local contacts are available. Add contact records under Data records or apply a persona preset.</div>'
  }<div class="notice section-gap"><strong>Sign-in page default:</strong> ${escape(identity.name || "No default persona")}<br>${escape((identity.roles || []).join(", ") || "No roles")}<br>Account: ${escape(identity.accountId || "None")}</div></section>`;
}
/**
 * External identities per contact: the identity records the local identity provider signs each
 * contact in with (provider, username and where the record came from).
 */
function externalIdentitiesPanel() {
  if (externalIdentities === undefined) return "";
  const provider = signInProvider();
  const report = externalIdentities;
  let body = '<div class="notice">This Mirage does not report external identities.</div>';
  if (report) {
    const byContact = new Map();
    for (const item of report.identities) {
      const key = personaId(item.contactId);
      if (!byContact.has(key)) byContact.set(key, { name: item.contactName, rows: [] });
      byContact.get(key).rows.push(item);
    }
    // Every local contact, then identities whose contact is not loaded here.
    const entries = (state.data?.contact || []).map((record) => [personaId(record.contactid), contactLabel(record)]);
    for (const [key, value] of byContact) if (!entries.some(([id]) => id === key)) entries.push([key, value.name || key]);
    const describe = (item) =>
      `${escape(item.providerName || item.provider)}: ${escape(item.username)}${item.origin || item.active === false ? ` (${escape([item.origin, item.active === false ? "inactive" : ""].filter(Boolean).join(", "))})` : ""}`;
    body = entries.length
      ? `<div class="detail-list">${entries.map(([key, name]) => `<div class="row" data-contact-id="${escape(key)}"><span class="row-title">${escape(name)}</span><span class="row-detail source-path">${(byContact.get(key)?.rows || []).map(describe).join("; ") || "None recorded yet: the first sign-in through the provider records one"}</span></div>`).join("")}</div>`
      : '<div class="notice">No local contacts to sign in as.</div>';
  }
  return `<section class="panel section-gap" id="external-identities"><div class="panel-heading"><h2>External identities</h2>${badge(provider ? provider.caption || provider.name || "Identity provider" : "Local sign-in page", provider ? "green" : "")}</div><p class="muted">The local identity provider offers the active contacts. A contact signs in with its external identity record for the provider (${escape(report?.table || "adx_externalidentity, or mspp_externalidentity in enhanced exports")}); the first sign-in of a contact without one records it.</p>${body}</section>`;
}
function createPersonaForm() {
  const roles = (state.status?.permissionModel?.webRoles || state.status?.webRoles || []).filter((role) => role.id);
  return `<section class="advanced-content"><p class="muted">Create a local contact with exported web-role memberships. Backend plugin rules apply to the contact record. The live browser identity is not affected.</p><form id="create-persona-form" class="form-grid"><div class="inline-fields"><div><label for="new-persona-first">First name</label><input id="new-persona-first" autocomplete="off"></div><div><label for="new-persona-last">Last name</label><input id="new-persona-last" required autocomplete="off"></div></div><div class="inline-fields"><div><label for="new-persona-email">Email</label><input id="new-persona-email" type="email" autocomplete="off"></div><div><label for="new-persona-account">Account ID</label><input id="new-persona-account" placeholder="Optional parent account ID" autocomplete="off"></div></div><fieldset class="role-picker"><legend>New persona web roles</legend>${roles.map((role, index) => `<div class="checkbox-line"><input type="checkbox" id="new-persona-role-${index}" data-new-persona-role="${escape(role.id)}"><label for="new-persona-role-${index}">${escape(role.name)}</label></div>`).join("") || '<p class="field-help">The export defines no web roles.</p>'}</fieldset><div class="checkbox-line"><input type="checkbox" id="new-persona-select" checked><label for="new-persona-select">Sign this browser in as the new persona</label></div><div><button class="button primary" type="submit">Create persona</button></div></form></section>`;
}
function permissionTree() {
  const model = state.status?.permissionModel;
  if (!model) return "";
  const rows = model.tree || [],
    byId = new Map(rows.map((row) => [row.id, row])),
    page = sliceRows("grant tree", rows);
  const depth = (row) => {
    let level = 0,
      parent = row.parentId;
    const visited = new Set([row.id]);
    while (parent && byId.has(parent) && !visited.has(parent) && level < 6) {
      visited.add(parent);
      level++;
      parent = byId.get(parent).parentId;
    }
    return level;
  };
  return `<section class="panel section-gap"><div class="panel-heading"><h2>Effective permission hierarchy</h2>${badge(model.source || "Configured")}</div><p class="muted">Each child grant requires a matching accessible parent record. Unresolved source relationships, parent cycles, and missing roles remain disabled. Counts reported by the server describe the current persona's accessible local records.</p><form id="permission-source-form" class="toolbar"><label for="permission-source">Grant source</label><select id="permission-source"><option value="configured" ${config().permissionSource === "configured" || !config().permissionSource ? "selected" : ""}>Configured local rules</option><option value="exported" ${config().permissionSource === "exported" ? "selected" : ""}>Imported portal grants</option><option value="combined" ${config().permissionSource === "combined" ? "selected" : ""}>Imported grants + local additions</option></select><button class="button" type="submit">Apply grant source</button></form>${tableTools("grant tree", page.total, page.pages)}<div class="table-wrap section-gap"><table><thead><tr><th>Permission / parent</th><th>Scope</th><th>Operations / roles</th><th>Accessible records</th><th>Status</th></tr></thead><tbody>${page.items.map((row) => `<tr><td style="padding-left:${12 + depth(row) * 18}px"><strong>${escape(row.name || row.entity)}</strong><div class="row-detail">${escape(row.entity)}${row.parentId ? ` · parent ${escape(byId.get(row.parentId)?.name || row.parentId)}` : ""}</div><div class="row-detail">${escape(row.relationshipName || "")} · ${escape(row.provenance?.type || "Configured")}</div></td><td>${escape(row.scope)}</td><td>${escape((row.operations || []).join(", "))}<div class="row-detail">${escape((row.roles || []).join(", "))}${row.inheritedRoles ? " · inherited" : ""}</div></td><td>${escape(model.visibleCounts?.[row.entity] ?? "Not reported")}</td><td>${badge(row.enabled ? "Enabled" : "Disabled", row.enabled ? "green" : "amber")}${row.disabledReason ? `<div class="row-detail">${escape(row.disabledReason)}</div>` : ""}</td></tr>`).join("") || '<tr><td colspan="5">No grants were reported.</td></tr>'}</tbody></table></div>${model.diagnostics?.length ? lazyJson(`${model.diagnostics.length} permission observations`, model.diagnostics) : ""}</section>`;
}
function access() {
  const identity = config().identity || {};
  const roleNames = [
    ...new Set(
      [
        ...(state.status?.webRoles || []).map((role) =>
          typeof role === "string" ? role : role.name,
        ),
        ...collection("permissions").flatMap(
          (permission) => permission.roles || [],
        ),
        ...(identity.roles || []),
      ].filter(Boolean),
    ),
  ].sort();
  const rolePicker = roleNames.length
    ? `<fieldset class="role-picker"><legend>Available web roles</legend><p class="field-help">Select imported role names, then save the identity. These roles affect local simulation; the connected browser retains its own live permissions.</p>${roleNames.map((role, index) => `<div class="checkbox-line"><input type="checkbox" id="role-choice-${index}" data-role-choice="${escape(role)}" ${(identity.roles || []).includes(role) ? "checked" : ""}><label for="role-choice-${index}">${escape(role)}</label></div>`).join("")}</fieldset>`
    : "";
  return (
    heading(
      "Identity & permissions",
      "Test portal behavior for the current contact, account, and web roles.",
    ) +
    sessionPanel() +
    personaPanel() +
    externalIdentitiesPanel() +
    disclosure("create-persona", "Create a persona", createPersonaForm) +
    disclosure(
      "session-override",
      "Simulation override",
      sessionOverrideForm,
    ) +
    disclosure(
      "manual-identity",
      "Advanced: configured identity (sign-in default and scripts)",
      () =>
        `<section class="advanced-content"><div class="panel-heading"><h2>Configured identity</h2>${badge(identity.id || identity.contactId ? "Authenticated" : "Anonymous", identity.id || identity.contactId ? "green" : "")}</div><p class="muted">This identity is the default persona the sign-in page offers and the identity of requests without a browser session (scripts and tests); browsers use their own sessions. Saving this form overrides contact memberships with these role names for that configured identity.</p><form id="identity-form" class="form-grid"><div class="inline-fields"><div><label for="identity-id">Contact ID</label><input id="identity-id" value="${escape(identity.contactId || identity.id || "")}" placeholder="Leave empty for anonymous"></div><div><label for="identity-name">Display name</label><input id="identity-name" value="${escape(identity.name || "")}" placeholder="Local tester"></div></div><div class="inline-fields"><div><label for="identity-account">Account ID</label><input id="identity-account" value="${escape(identity.accountId || "")}"></div><div><label for="identity-roles">Web roles</label><input id="identity-roles" value="${escape((identity.roles || []).join(", "))}" placeholder="Authenticated Users, Administrators"><p class="field-help">Separate role names with commas.</p></div></div>${rolePicker}<div><label for="permission-mode">Permission enforcement</label><select id="permission-mode"><option value="permissive" ${config().permissionMode !== "enforce" ? "selected" : ""}>Permissive sandbox</option><option value="enforce" ${config().permissionMode === "enforce" ? "selected" : ""}>Enforce configured permissions</option></select></div><div><button class="button primary" type="submit">Save identity</button></div></form></section>`,
    ) +
    permissionTree() +
    presetPicker() +
    disclosure(
      "raw-permissions",
      `Edit local table permission rules (${collection("permissions").length})`,
      () =>
        `<section class="section-gap"><div class="panel-heading"><div><h2>Table permissions</h2><p class="muted">Read and mutation access for the simulated identity.</p></div>${addButton("permissions", "Add permission")}</div>${["exported", "combined"].includes(config().permissionSource) ? '<div class="notice section-gap">Imported grants are source controlled. Choose configured local rules to edit their local copies, or imported grants + local additions to create separately identified local rules.</div>' : ""}${collectionTable("permissions")}</section>`,
    )
  );
}

function connection() {
  const live = config().live || {};
  const connected =
    state.status?.liveConnected ||
    state.status?.live?.connected ||
    live.connected ||
    state.live?.connected;
  return (
    heading(
      "Live connection",
      "Choose local simulation or data and pages from an authenticated online environment.",
    ) +
    `<div class="grid-two"><section class="panel"><div class="panel-heading"><h2>Request routing</h2>${badge(config().mode === "live" ? "Live data selected" : "Local data selected", config().mode === "live" ? "amber" : "green")}</div><form id="connection-form" class="form-grid"><div class="inline-fields"><div><label for="data-mode">Data provider</label><select id="data-mode"><option value="local" ${config().mode !== "live" ? "selected" : ""}>Local mock</option><option value="live" ${config().mode === "live" ? "selected" : ""}>Live environment</option></select></div><div><label for="page-mode">Page provider</label><select id="page-mode"><option value="local" ${config().pageMode !== "live" ? "selected" : ""}>Local Liquid rendering</option><option value="live" ${config().pageMode === "live" ? "selected" : ""}>Live rendered pages</option></select></div></div><div><label for="live-origin">Environment origin</label><input id="live-origin" type="url" value="${escape(live.origin || "")}" placeholder="https://your-portal.powerappsportals.com"><p class="field-help">Use the portal origin. Individual endpoint routes can override the data provider.</p></div><div><label for="fetchxml-path">Live FetchXML endpoint override</label><input id="fetchxml-path" value="${escape(live.fetchXmlPath || "")}" placeholder="/fetch-data/?query={fetchXml}"><p class="field-help">Leave blank for native /_api/&lt;mappedSet&gt;?fetchXml= reads. An optional existing same-origin JSON endpoint must include {fetchXml}.</p></div><div class="checkbox-line"><input id="live-writes" type="checkbox" ${live.allowWrites && state.status?.liveWrites !== "disabled" ? "checked" : ""}${state.status?.liveWrites === "disabled" ? ' disabled aria-describedby="live-writes-disabled"' : ""}><label for="live-writes">Allow create, update, and delete requests to the live environment.<br><span class="field-help">These requests affect actual environment data.</span>${state.status?.liveWrites === "disabled" ? '<br><span class="field-help" id="live-writes-disabled">Disabled for this runtime: start the Mirage with --allow-live-writes (mirage dev and start pass it through) to allow it.</span>' : ""}</label></div><div class="checkbox-line"><input id="confine-portal-pages" type="checkbox" ${config().confinePortalPages ? "checked" : ""}><label for="confine-portal-pages">Confine local pages to loopback.<br><span class="field-help">Adds a Content-Security-Policy that keeps local portal pages on this loopback origin. When off, pages carry only the headers the portal's site settings define, as they do online.</span></label></div><fieldset id="confinement-options" class="confinement-options${config().confinePortalPages ? "" : " is-off"}" ${config().confinePortalPages ? "" : "disabled"}><legend>Exceptions while confined</legend><div class="checkbox-line"><input id="external-assets" type="checkbox" ${config().externalAssets ? "checked" : ""}><label for="external-assets">Allow external assets in local portal pages.<br><span class="field-help">Enable when your exported styles, fonts, or images use online URLs.</span></label></div><div><label for="external-frame-origins">Online embedded content</label><textarea id="external-frame-origins" rows="2" style="width:100%" placeholder="https://app.powerbi.com">${escape((config().externalFrameOrigins || []).join("\n"))}</textarea><p class="field-help">One exact HTTPS origin per line. These frames use the selected online service even when portal API and data stay local. Leave blank to block online embedded content.</p></div><p class="field-help confinement-note">These apply only while local pages are confined to loopback.</p></fieldset><div><button class="button primary" type="submit">Save routing</button></div></form></section>
    <section class="panel"><div class="panel-heading"><h2>Authenticated browser</h2>${badge(connected ? "Connected" : "Not connected", connected ? "green" : "")}</div><p class="muted">Connect to an existing browser through its local debugging address. Sign-in stays in that browser; simulator configuration contains no credentials.</p><form id="live-connect-form" class="form-grid"><div><label for="cdp-url">Browser debugging address</label><input id="cdp-url" type="url" value="http://127.0.0.1:9222" required><p class="field-help">Use the free debugging port reported by your development session.</p></div><div><button class="button" type="submit">Connect browser</button></div></form><div class="notice section-gap">Provider settings apply to requests reaching this mirage. Live page passthrough is online output, not proof of local rendering parity. Hardcoded online URLs in portal scripts remain browser requests.</div></section></div><section class="panel section-gap"><div class="panel-heading"><h2>Capture page shell</h2>${badge("Read-only live page")}</div><p class="muted">Read an observed live page and capture its supported static dependencies. A complete capture replaces your current shell stylesheet and script order; failed captures leave the existing profile unchanged. This does not copy business data or establish rendering parity.</p><form id="shell-capture-form" class="form-grid"><div><label for="shell-page-path">Portal page path</label><input id="shell-page-path" value="${escape(shellCapturePath)}" placeholder="/" required></div><div><label for="managed-control-path">Managed editor page (optional)</label><input id="managed-control-path" value="${escape(managedControlPath)}" placeholder="/_portal/modal-form-template-path/…"><p class="field-help">Read an explicitly known native rich-text page to capture static PCF manifests. This GET saves no record values; existing connected pages supply observed font resource URLs.</p></div><div><button class="button" type="submit">Capture and replace shell</button></div></form>${shellCaptureResult ? `<details class="section-gap" open><summary class="muted">Page shell capture report</summary><pre class="json-view" id="shell-capture-report">${escape(json(shellCaptureResult))}</pre></details>` : ""}</section><section class="panel section-gap"><div class="panel-heading"><h2>Capture static portal assets</h2>${badge("Explicit files only")}</div><p class="muted">Capture selected portal styles, scripts, images, or fonts into the ignored asset cache. Portal files use the connected browser; approved public platform CDN files are fetched anonymously. Enter one portal-relative file path per line.</p><form id="asset-capture-form" class="form-grid"><div><label for="asset-paths">Static file paths</label><textarea id="asset-paths" rows="4" style="width:100%" placeholder="/xrm-adx/js/jquery-ui-1.11.4.min.js" required></textarea></div><div><label class="checkbox-label"><input id="observe-stylesheets" type="checkbox"> Observe selected stylesheet versions</label><p class="field-help">CSS files only. Explicit native versions apply while their exported source hashes are unchanged; local edits win.</p><button class="button" type="submit">Capture assets</button></div></form></section><section class="panel section-gap"><div class="panel-heading"><div><h2>Portal shell resources</h2><p class="muted">Match the observed stylesheet and script order around local page templates.</p></div><button class="button" data-add="shellProfile">Edit shell profile</button></div>${lazyJson("Inspect shell profile", config().shellProfile || {})}</section>`
  );
}

function richTextBaselines() {
  const rows = state.status?.richTextConfigurations || [];
  if (!rows.length) return "";
  const page = sliceRows("rich-text baselines", rows);
  return `<section class="panel section-gap"><div class="panel-heading"><h2>Versioned rich-text JSON baselines</h2>${badge(`${rows.length} deployment observations`)}</div><p class="muted">Captured JSON applies only while its mapped source file hash is unchanged. Edited local source wins. Capture records an observed deployment configuration; it does not identify the deployed commit.</p>${tableTools("rich-text baselines", page.total, page.pages)}<div class="table-wrap"><table><thead><tr><th>Local resource / source</th><th>Observed origin / path</th><th>Source binding</th><th>Provenance</th></tr></thead><tbody>${page.items.map((row) => `<tr><td><code>${escape(row.url)}</code><div class="row-detail">${escape(row.sourceFile)}</div></td><td>${escape(row.origin)}<div class="row-detail">${escape(row.observedPath)}</div></td><td>${badge(row.status === "eligible" ? "Source unchanged" : row.status === "stale" ? "Local source wins" : "Invalid baseline", row.status === "eligible" ? "green" : "amber")}${row.diagnostic ? `<div class="row-detail">${escape(row.diagnostic.message)}</div>` : ""}</td><td>${lazyJson("Inspect versioned provenance", row)}</td></tr>`).join("")}</tbody></table></div></section>`;
}

function observedStylesheetBaselines() {
  const rows =
    state.status?.observedStylesheets ??
    config().shellProfile?.observedStylesheets ??
    [];
  if (!rows.length) return "";
  const page = sliceRows("stylesheet baselines", rows);
  return (
    '<section class="panel section-gap"><div class="panel-heading"><h2>Observed stylesheet versions</h2>' +
    badge(rows.length + " source-bound observations") +
    '</div><p class="muted">These exact static native bytes apply only while mapped local source and cache hashes match. Local edits win; source/native differences remain inspectable.</p>' +
    tableTools("stylesheet baselines", page.total, page.pages) +
    '<div class="table-wrap"><table><thead><tr><th>Mapped CSS / source</th><th>Source binding</th><th>Provenance</th></tr></thead><tbody>' +
    page.items
      .map(
        (row) =>
          "<tr><td><code>" +
          escape(row.path) +
          '</code><div class="row-detail">' +
          escape(row.sourceFile) +
          "</div></td><td>" +
          badge(
            row.state === "observed"
              ? "Observed bytes active"
              : row.state === "source-edited"
                ? "Local source wins"
                : (row.state ?? "Captured; checked on request"),
            row.state === "observed" ? "green" : "",
          ) +
          (row.diagnostic
            ? '<div class="row-detail">' +
              escape(row.diagnostic.message) +
              "</div>"
            : "") +
          "</td><td>" +
          lazyJson("Inspect source/native hashes", row) +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table></div></section>"
  );
}
function snippetCompositionControls() {
  const rows = config().shellProfile?.snippetCompositions ?? [];
  return `<section class="panel section-gap"><details><summary>Observed snippet compositions ${badge(rows.length)}</summary><p class="muted">Verify an observed native empty state consists of an existing local snippet plus an existing exported action. Both source hashes and the portal origin bind this observation. Local edits win; the source action and handlers retain their visibility and permission rules.</p><form id="snippet-composition-form" class="form-grid"><div><label for="composition-page">Observed page path</label><input id="composition-page" placeholder="/owned-products/" required></div><div><label for="composition-parent">Parent snippet name</label><input id="composition-parent" required></div><div><label for="composition-child">Existing action snippet name</label><input id="composition-child" required></div><div><button class="button" type="submit">Observe static composition</button></div></form>${lazyJson("Inspect source-bound compositions", rows)}</details></section>`;
}

function diagnosticGroups(diagnostics) {
  const grouped = new Map();
  for (const item of diagnostics) {
    const key = item.code || item.type || item.severity || "Observation";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return [...grouped]
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([key, items]) =>
        `<details class="diagnostic-group"><summary><code>${escape(key)}</code>${badge(`${items.length}`, items.some((item) => /error|fail/i.test(item.severity || item.level || "")) ? "red" : "amber")}</summary><div class="diagnostic-items">${items
          .slice(0, 12)
          .map((item) => {
            const where = item.path || item.page || item.file;
            const route =
              typeof item.path === "string" &&
              /^\/(?!\/)/.test(item.path) &&
              !/^\/_{1,2}sim(?:\/|$)/.test(item.path)
                ? item.path
                : null;
            const links = route
              ? `<div class="diagnostic-links"><a class="button small" href="${escape(route)}" target="_blank" rel="noopener">Open page ↗</a><a class="button small" href="#audit?path=${escape(encodeURIComponent(route))}">Requests for this path</a></div>`
              : item.file
                ? `<div class="diagnostic-links"><button class="button small" data-copy-text="${escape(item.file)}">Copy source path</button></div>`
                : "";
            return `<div class="diagnostic"><p>${escape(item.message || (typeof item === "string" ? item : JSON.stringify(item)))}</p>${where ? `<div class="row-detail source-path">${escape(where)}</div>` : ""}${links}</div>`;
          })
          .join(
            "",
          )}${items.length > 12 ? `<p class="muted">${items.length - 12} additional observations in this group. The full set remains available from the simulator diagnostics API.</p>` : ""}</div></details>`,
    )
    .join("");
}

function evidenceSummary(evidence) {
  if (!evidence || !Object.keys(evidence).length) return "";
  const pixels = evidence.pixels;
  const urls = evidence.artifactUrls || {};
  return `<div class="detail-list"><div class="row"><span class="row-title">Compared route</span><span class="row-detail">${escape(evidence.path || "Not reported")}</span></div><div class="row"><span class="row-title">Captured</span><span class="row-detail">${escape(evidence.time || "Not reported")}</span></div>${pixels ? `<div class="row"><span class="row-title">Different pixels</span><span class="row-detail">${escape(pixels.different)} / ${escape(pixels.total)}</span></div><div class="row"><span class="row-title">Difference</span><span class="row-detail">${escape((Number(pixels.fraction || 0) * 100).toFixed(4))}%</span></div>` : ""}</div>${evidence.differences?.length ? `<ul class="muted">${evidence.differences.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>` : ""}${Object.entries(
    urls,
  )
    .filter(
      ([, url]) =>
        typeof url === "string" &&
        /^\/__sim\//.test(url) &&
        !url.includes("\\"),
    )
    .map(
      ([label, url]) =>
        `<details class="evidence-image"><summary>${escape(label)} screenshot</summary><a href="${escape(url)}" target="_blank" rel="noopener"><img src="${escape(url)}" alt="${escape(label)} rendering evidence" loading="lazy"></a></details>`,
    )
    .join("")}`;
}

function evidence() {
  const status = state.status || {};
  const diagnostics = state.diagnostics || status.diagnostics || [];
  const evidence = state.evidence || status.evidence || {};
  const pages = status.pages || state.pages || [];
  const page = sliceRows("pages", Array.isArray(pages) ? pages : []);
  const stale = evidence.stale === true;
  const observed =
    !stale && (evidence.verified === true || evidence.passed === true);
  return (
    heading(
      "Render & diagnostics",
      "Inspect observed render results, unsupported behavior, and runtime failures.",
    ) +
    `<div class="notice ${observed ? "" : "warning"}">${stale ? "Saved evidence is stale because its source or simulator state differs from this workspace. Run verification again to establish current results." : observed ? "Passing evidence applies only to the compared route, state, identity, and viewport. It does not establish exact parity for the entire portal." : "Exact portal parity has not been established by this workspace state. Configured pages and successful rendering alone do not prove equivalence to the live portal."}</div>` +
    `<div class="grid-two"><section class="panel"><div class="panel-heading"><h2>Runtime diagnostics</h2>${badge(`${diagnostics.length} observations`, diagnostics.length ? "amber" : "green")}</div>${diagnostics.length ? diagnosticGroups(diagnostics) : '<p class="muted">No diagnostics reported. Visit a portal page and refresh to inspect rendering observations.</p>'}</section><section class="panel"><div class="panel-heading"><h2>Rendering evidence</h2>${badge(stale ? "Stale evidence" : observed ? "Evidence reported" : "Unverified", observed ? "green" : "amber")}</div>${evidenceSummary(evidence)}${lazyJson("Full evidence report", evidence)}${lazyJson("Runtime status", status)}</section></div>` +
    `<section class="panel section-gap"><div class="panel-heading"><h2>Discovered pages</h2><span class="record-count">${Array.isArray(pages) ? pages.length : 0} routes</span></div>${
      Array.isArray(pages) && pages.length
        ? tableTools("pages", page.total, page.pages) +
          `<div class="table-wrap"><table><thead><tr><th>Page</th><th>Route</th><th>Action</th></tr></thead><tbody>${page.items
            .map((page) => {
              const route =
                typeof page === "string"
                  ? page
                  : page.path || page.route || page.url || "/";
              const safeRoute = /^\/(?!\/)/.test(route) ? route : "/";
              return `<tr><td>${escape(page.name || page.title || route)}</td><td><code>${escape(route)}</code></td><td><a class="button small" href="${escape(safeRoute)}" target="_blank" rel="noopener">Open page ↗</a></td></tr>`;
            })
            .join("")}</tbody></table></div>`
        : '<p class="muted">Page route details are not included in the current server status.</p>'
    }</section>`
  );
}

function audit() {
  const result = auditResult || { items: [], total: 0, pageCount: 1 },
    settings = browserFor("audit");
  const select = (name, label, values) =>
    `<label>${label}<select data-audit-filter="${name}"><option value="">All</option>${values.map((value) => `<option value="${value}" ${auditFilters[name] === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>`;
  return (
    heading(
      "Request audit",
      "Inspect bounded, sanitized API, Liquid FetchXML, form, and page activity.",
      '<button class="button" data-audit-action="refresh">Refresh audit</button>',
    ) +
    `<section class="panel"><div class="toolbar audit-filters">${select("kind", "Kind", [...new Set(["api", "liquid-fetchxml", "form", "page", "entity-read", "entity-query", ...(Array.isArray(result.kinds) ? result.kinds : []), ...(auditFilters.kind ? [auditFilters.kind] : [])])])}${select("provider", "Provider", ["local", "live"])}${select("outcome", "Outcome", ["success", "error", "denied", "pending"])}${select("status", "Status", ["2xx", "3xx", "4xx", "5xx", "pending"])}<input type="search" data-audit-filter="path" aria-label="Filter audit by path" placeholder="Path contains…" value="${escape(auditFilters.path)}"><input type="search" data-audit-filter="entity" aria-label="Filter audit by table" placeholder="Table logical name" value="${escape(auditFilters.entity)}"><input type="search" data-audit-filter="search" aria-label="Search audit" placeholder="Contact, table, path or error…" value="${escape(auditFilters.search)}">${auditFilters.correlationId ? `<button class="button small" data-audit-action="uncorrelate">Correlation ${escape(auditFilters.correlationId.slice(0, 8))} ×</button>` : ""}<button class="button small" data-audit-action="export">Export filtered JSON</button><button class="button small" data-audit-action="copy">Copy filtered JSON</button><button class="button small quiet" data-audit-action="clear">Clear audit</button></div><p class="muted">${escape(result.retained ?? 0)} retained · ${escape(result.dropped ?? 0)} dropped. Request bodies, credentials, cookies, and tokens are excluded.</p>${auditError ? `<div class="notice warning">${escape(auditError)}</div>` : ""}${auditLoading ? '<p role="status" class="muted">Loading request audit…</p>' : ""}${tableTools("audit", result.total, result.pageCount || 1, { search: false })}<div class="table-wrap"><table><thead><tr><th>Sequence / time</th><th>Request</th><th>Provider / contact</th><th>Status / duration</th><th>Rows / outcome</th><th>Details</th></tr></thead><tbody>${result.items.map((item) => `<tr><td>${escape(item.sequence)}<div class="row-detail">${escape(item.startedAt)}</div></td><td><strong>${escape(item.kind)}</strong><div class="row-detail">${escape(item.method)} ${escape(item.path)}</div><code>${escape(item.entity || "")}</code></td><td>${badge(item.provider)}<div class="row-detail">${escape(item.identity?.contactId || "Anonymous")}</div></td><td>${badge(item.status, item.status >= 400 ? "red" : "green")}<div class="row-detail">${escape(Number(item.durationMs || 0).toFixed(1))} ms</div></td><td>${escape(item.rowCount ?? "—")} · ${escape(item.outcome)}${item.error ? `<div class="row-detail">${escape(item.error.code)}${item.error.portalCode ? ` · portal ${escape(item.error.portalCode)}` : ""}</div>` : ""}</td><td>${inspectButton(item)}</td></tr>`).join("") || '<tr><td colspan="6">No matching requests have been recorded.</td></tr>'}</tbody></table></div></section>`
  );
}

function portal() {
  return heading("Portal configuration", "Experiment with local settings, snippets and web roles. Changes persist in this simulator workspace and refresh the portal.") +
    [ ["portal-settings", "Site settings", "portalSettings"], ["portal-snippets", "Content snippets", "portalSnippets"], ["portal-roles", "Web roles", "portalRoles"] ].map(([kind, title, key]) => {
      const rows = config()[key] ?? [];
      const page = sliceRows(kind, rows);
      const displayValue = row => {
        if (row.deleted) return "Removed locally";
        if (kind !== "portal-roles") return String(row.value ?? "").slice(0, 160);
        return [row.value?.authenticatedUsersRole && "Signed-in contacts", row.value?.anonymousUsersRole && "Anonymous visitors"].filter(Boolean).join(", ") || "Assigned through contact memberships";
      };
      return `<section class="panel section-gap"><div class="panel-heading"><h2>${title}</h2><button class="button" data-add="${kind}">Add ${title === "Site settings" ? "setting" : title === "Web roles" ? "role" : "snippet"}</button></div>${tableTools(kind, page.total, page.pages)}<div class="table-wrap"><table><thead><tr><th>Name</th><th>${kind === "portal-roles" ? "Membership" : "Value"}</th><th>Origin</th><th>Actions</th></tr></thead><tbody>${page.items.map(row => `<tr><td>${escape(row.name)}</td><td>${escape(displayValue(row))}</td><td>${badge(row.overridden ? "Local override" : "Exported source")}</td><td><button class="button small" data-edit="${kind}" data-id="${escape(row.id)}">Edit</button>${row.overridden ? `<button class="button small" data-delete="${kind}" data-id="${escape(row.id)}">Reset</button>` : ""}</td></tr>`).join("")}</tbody></table></div></section>`;
    }).join("") + accessRulesPanel();
}

function accessRulesPanel() {
  const pages = new Map((state.status?.pages || []).map((page) => [String(page.id).toLowerCase(), page]));
  const roles = new Map((state.status?.webRoles || []).map((role) => [String(role.id).toLowerCase(), role.name]));
  const head = `<div class="panel-heading"><div><h2>Page access rules</h2><p class="muted">Grant change (1) and restrict read (2) rules decide which web roles may open a page branch. Local overrides apply immediately to page access, navigation and files; reset restores the export.</p></div><button class="button" data-add="portal-access-rules">Add rule</button></div>`;
  if (accessRulesError)
    return `<section class="panel section-gap">${head}<div class="notice warning">${escape(accessRulesError)}</div></section>`;
  if (!accessRules)
    return `<section class="panel section-gap">${head}<p role="status" class="muted">Loading page access rules…</p></section>`;
  const page = sliceRows("portal-access-rules", accessRules);
  const describe = (row) => {
    const value = row.value;
    if (!value) return ["Removed locally", "—", "—"];
    const target = pages.get(String(value.webPageId).toLowerCase());
    return [
      target ? `${target.name || target.url} (${target.url || target.path})` : `Unknown page ${value.webPageId}`,
      `${value.right === 1 ? "Grant change" : value.right === 2 ? "Restrict read" : "Unresolved"} · ${value.scope === 2 ? "exclude direct child files" : "all content"}`,
      (value.roleIds || []).map((roleId) => roles.get(String(roleId).toLowerCase()) || `${roleId} (unknown)`).join(", ") || "No roles",
    ];
  };
  return `<section class="panel section-gap">${head}${tableTools("portal-access-rules", page.total, page.pages)}<div class="table-wrap"><table><thead><tr><th>Rule</th><th>Page</th><th>Right / scope</th><th>Web roles</th><th>Origin</th><th>Actions</th></tr></thead><tbody>${
    page.items
      .map((row) => {
        const [target, right, roleNames] = describe(row);
        return `<tr><td class="item-title">${escape(row.name)}</td><td>${escape(target)}</td><td>${escape(right)}</td><td>${escape(roleNames)}</td><td>${badge(row.deleted ? "Removed locally" : row.overridden ? "Local override" : "Exported source", row.overridden ? "amber" : "")}</td><td class="actions"><button class="button small" data-edit="portal-access-rules" data-id="${escape(row.id)}">Edit</button>${row.overridden ? `<button class="button small" data-delete="portal-access-rules" data-id="${escape(row.id)}">Reset</button>` : ""}</td></tr>`;
      })
      .join("") || '<tr><td colspan="6">The export defines no page access rules.</td></tr>'
  }</tbody></table></div></section>`;
}

function scenarios() {
  const active = config().activeScenario;
  const presets = state.status?.availablePresets || [];
  const contacts = state.data?.contact || [];
  const option = (value, label) => `<option value="${escape(value)}">${escape(label)}</option>`;
  return (
    heading(
      "Scenarios",
      "Name a combination of preset, persona and permission enforcement, then switch between them in one step.",
      addButton("scenarios", "Add scenario"),
    ) +
    (active
      ? `<div class="notice">Active scenario: <strong>${escape(active.name || active.id)}</strong> · applied ${escape(active.appliedAt || "")}</div>`
      : "") +
    collectionTable("scenarios") +
    `<section class="panel section-gap"><div class="panel-heading"><h2>Save a scenario</h2>${badge("Saved definitions do not reload pages")}</div><p class="muted">Choose what the scenario changes. Parts left on “keep” stay as they are when it is applied. Applying a preset first replaces the data sections that preset defines; the persona must exist afterwards.</p><form id="scenario-form" class="form-grid"><div class="inline-fields"><div><label for="scenario-name">Scenario name</label><input id="scenario-name" required placeholder="Reviewer with enforced permissions"></div><div><label for="scenario-id">Scenario ID</label><input id="scenario-id" placeholder="reviewer-enforced"><p class="field-help">Letters, numbers, dots, underscores or hyphens. Derived from the name when empty.</p></div></div><div><label for="scenario-preset">Preset</label><select id="scenario-preset">${option("", "Keep current data")}${presets.filter((preset) => !preset.unavailable).map((preset) => option(preset.id, preset.name || preset.id)).join("")}</select></div><div><label for="scenario-persona">Persona</label><select id="scenario-persona">${option("__keep", "Keep current persona")}${option("", "Anonymous visitor")}${contacts.map((contact) => option(contact.contactid, contact.fullname || [contact.firstname, contact.lastname].filter(Boolean).join(" ") || contact.contactid)).join("")}</select></div><div><label for="scenario-permission-mode">Permission enforcement</label><select id="scenario-permission-mode">${option("", "Keep current")}${option("enforce", "Enforce table permissions")}${option("permissive", "Permissive sandbox")}</select></div><div><button class="button primary" type="submit">Save scenario</button></div></form></section>` +
    `<section class="panel section-gap"><div class="panel-heading"><h2>Reset the workspace</h2>${badge("Local state change", "amber")}</div><p class="muted">Restore the imported records, configuration, identity and permissions of this workspace. Saved scenario definitions are kept.</p><button class="button danger" data-action="reset-workspace">Reset to imported defaults</button></section>`
  );
}

function environment() {
  const env = environmentResult;
  const project = state.status?.project;
  const references = Array.isArray(project?.references) ? project.references : [];
  const live = env?.live || state.status?.live || {};
  const variables = env?.environmentVariables;
  const valueCell = (value) => (value === null || value === undefined ? "—" : String(value));
  const referenceRows = references
    .map(
      (reference) =>
        `<tr><td class="item-title">${escape(reference.name || reference.id)}</td><td><code>${escape(reference.origin)}</code></td><td>${reference.origin === live.origin ? badge("Selected", "green") : ""}${reference.default || reference.id === (project?.defaultReference?.id ?? project?.defaultReference) ? badge("Default") : ""}</td><td class="actions"><button class="button small" data-reference-origin="${escape(reference.origin)}">Use for live routing</button></td></tr>`,
    )
    .join("");
  return (
    heading(
      "Environment",
      "Reference environments, environment variables, deployment profile and reference enrichment for this workspace.",
      '<button class="button" data-action="reload-environment">Refresh environment</button>',
    ) +
    (environmentError ? `<div class="notice warning">${escape(environmentError)}</div>` : "") +
    `<div class="grid-two"><section class="panel"><div class="panel-heading"><h2>Reference environments</h2>${badge(live.connected ? "Browser connected" : "Not connected", live.connected ? "green" : "")}</div><p class="muted">Selecting a reference sets the origin used for live routing and enrichment. It never connects by itself: connect the intended signed-in browser under Live connection.</p>${
      references.length
        ? `<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Origin</th><th>State</th><th>Actions</th></tr></thead><tbody>${referenceRows}</tbody></table></div>`
        : '<div class="notice">No reference environments are configured for this runtime. A Mirage project file lists them under <code>references</code>; the toolkit can write one with <code>mirage init</code>.</div>'
    }<div class="detail-list section-gap"><div class="row"><span class="row-title">Live origin</span><span class="row-detail">${escape(live.origin || "Not set")}</span></div><div class="row"><span class="row-title">Live writes</span><span class="row-detail">${escape(
      (live.liveWrites ?? state.status?.liveWrites) === "disabled"
        ? "Disabled for this runtime (start the Mirage with --allow-live-writes)"
        : live.allowWrites ? "Allowed" : "Blocked",
    )}</span></div></div><button class="button small section-gap" data-view="connection">Open live connection</button></section>` +
    `<section class="panel"><div class="panel-heading"><h2>Deployment profile</h2>${badge(env?.deploymentProfile ? "Applied" : "None applied", env?.deploymentProfile ? "amber" : "")}</div><div class="detail-list"><div class="row"><span class="row-title">Applied profile</span><span class="row-detail">${escape(env?.deploymentProfile || "None")}</span></div><div class="row"><span class="row-title">Profile field changes</span><span class="row-detail">${escape(env?.profileChanges ?? 0)}</span></div><div class="row"><span class="row-title">Exported profiles</span><span class="row-detail">${escape((env?.deploymentProfiles || []).join(", ") || "None")}</span></div><div class="row"><span class="row-title">Source</span><span class="row-detail source-path">${escape(env?.sourceDir || state.status?.sourceDir || "")}</span></div></div><p class="muted">Profiles are applied only when the runtime starts with <code>--deployment-profile NAME</code>; they do not identify the deployed commit.</p></section></div>` +
    `<section class="panel section-gap"><div class="panel-heading"><h2>Environment variables</h2>${badge(variables?.available ? `${variables.definitions.length} definitions` : "Not imported", variables?.available ? "green" : "")}</div><p class="muted">Definitions and values are local Dataverse tables seeded from the Solution sources. A local value is kept as an override until it is reset; then the Solution value or the definition default applies.</p>${
      variables?.available
        ? `<div class="table-wrap"><table><thead><tr><th>Schema name</th><th>Display name</th><th>Default</th><th>Current value</th><th>Effective</th><th>Actions</th></tr></thead><tbody>${
            variables.definitions
              .map(
                (item) =>
                  `<tr><td class="item-title"><code>${escape(item.schemaName)}</code></td><td>${escape(item.displayName || "")}</td><td>${escape(item.secret ? "secret" : valueCell(item.defaultValue))}</td><td>${escape(item.secret ? "secret" : valueCell(item.value))}${item.overridden ? ` ${badge("Local override", "amber")}` : ""}</td><td>${escape(item.secret ? "secret" : valueCell(item.effectiveValue))}</td><td class="actions"><button class="button small" data-edit="environment-variable" data-id="${escape(item.schemaName)}" ${variables.valuesMapped ? "" : "disabled"}>Edit value</button>${item.overridden ? `<button class="button small quiet" data-reset-variable="${escape(item.schemaName)}">Reset local value</button>` : ""}</td></tr>`,
              )
              .join("") || '<tr><td colspan="6">No environment variable definitions are stored.</td></tr>'
          }</tbody></table></div>`
        : '<div class="notice">This workspace has no environmentvariabledefinition table. Import Solution environment variables during bootstrap to edit them here.</div>'
    }</section>` +
    `<section class="panel section-gap"><div class="panel-heading"><h2>Reference enrichment</h2>${badge("Reads the selected reference", "amber")}</div><p class="muted">An enrichment plan lists explicit FetchXML reads (entity, fetchXml, optional pageSize, maxPages and mode merge/replace). Validation never reads the reference. Running copies the selected records from the connected browser identity into local state in one change; complete pages only.</p><form id="enrichment-form" class="form-grid"><div><label for="enrichment-plan">Enrichment plan (JSON array)</label><textarea id="enrichment-plan" class="code-editor" rows="8" spellcheck="false" placeholder='[{"entity":"account","fetchXml":"<fetch><entity name=\\"account\\"><attribute name=\\"name\\"/></entity></fetch>","pageSize":100,"maxPages":1}]'></textarea></div><div><label for="enrichment-file">Load plan file</label><input id="enrichment-file" type="file" accept="application/json,.json"></div><div class="toolbar"><button class="button" type="submit" value="validate">Validate plan</button><button class="button primary" type="submit" value="run" ${live.connected ? "" : "disabled"}>Run plan</button></div></form>${enrichmentReport ? `<details class="section-gap" open><summary class="muted">Enrichment report</summary><pre class="json-view" id="enrichment-report">${escape(json(enrichmentReport))}</pre></details>` : ""}${(env?.referenceImports || []).length ? lazyJson(`${env.referenceImports.length} recorded reference imports`, env.referenceImports) : ""}</section>` +
    (project ? `<section class="panel section-gap"><div class="panel-heading"><h2>Project</h2>${badge(project.configFile ? "Project file" : "No project file")}</div><div class="detail-list"><div class="row"><span class="row-title">Configuration</span><span class="row-detail source-path">${escape(project.configFile || "Started from a portal source without --project")}</span></div><div class="row"><span class="row-title">Portals</span><span class="row-detail source-path">${escape((project.portals || []).map((item) => (typeof item === "string" ? item : item.id || item.sourceDir || "")).join(", "))}</span></div><div class="row"><span class="row-title">Solutions</span><span class="row-detail source-path">${escape((project.solutions || []).map((item) => (typeof item === "string" ? item : item.id || item.root || "")).join(", ") || "None")}</span></div><div class="row"><span class="row-title">Data packs</span><span class="row-detail">${escape((project.dataPacks || []).map((item) => (typeof item === "string" ? item : item.id || item.module || "")).join(", ") || "None")}</span></div></div>${lazyJson("Full project configuration", project)}</section>` : "")
  );
}

function runtimeState() {
  const status = state.status || {};
  // status.bootstrap reports what the runtime loaded: Solution roots, layers in load order, timings.
  const bootstrap = status.bootstrap || {};
  const roots = Array.isArray(bootstrap.solutionRoots) && bootstrap.solutionRoots.length
    ? bootstrap.solutionRoots
    : status.solutionMetadata?.roots || status.solutionMetadata?.sources || [];
  const layers = Array.isArray(bootstrap.layers) ? bootstrap.layers : [];
  const timings = bootstrap.timings || {};
  const lastReload = timings.lastReload;
  // The local sign-in page and the platform behaviour recorded for this site (with its evidence).
  const signIn = bootstrap.signInPath;
  const signInText = signIn?.path
    ? `${signIn.path} (${signIn.source === "site-setting" ? "exported LoginPath setting" : signIn.source === "observed" ? `observed${signIn.evidence ? `; evidence ${signIn.evidence}` : ""}` : "platform default"})`
    : null;
  const observed = bootstrap.observed && typeof bootstrap.observed === "object" ? bootstrap.observed : null;
  // Nested observations (headers) read "page name=value; webFile name=value, name=value".
  const nested = (value) => {
    if (!value || typeof value !== "object") return String(value);
    const entries = Object.entries(value);
    return entries.every(([, item]) => !item || typeof item !== "object")
      ? entries.map(([key, item]) => `${key}=${item}`).join(", ")
      : entries.map(([key, item]) => `${key} ${nested(item)}`).join("; ");
  };
  const observedText = observed
    ? `${Object.entries(observed).filter(([key]) => key !== "evidence").map(([key, value]) => (value && typeof value === "object" ? `${key} (${nested(value)})` : `${key} ${value}`)).join(", ")}${observed.evidence ? ` (evidence: ${observed.evidence})` : ""}`
    : "None recorded";
  const row = (title, value) =>
    `<div class="row"><span class="row-title">${escape(title)}</span><span class="row-detail source-path">${escape(value ?? "Not reported")}</span></div>`;
  return (
    heading(
      "Runtime state",
      "Fingerprints, reloads and portable copies of this local workspace state.",
    ) +
    `<div class="grid-two"><section class="panel"><div class="panel-heading"><h2>Fingerprints</h2>${badge(status.implementationChanged ? "Restart to load edited runtime code" : "Runtime code current", status.implementationChanged ? "amber" : "green")}</div><div class="detail-list">${row("Runtime revision", status.revision)}${row("Source fingerprint", status.sourceFingerprint)}${row("Loaded implementation", status.loadedImplementationFingerprint)}${row("Current implementation", status.implementationFingerprint)}${row("Source directory", status.sourceDir)}${row("Solution roots", roots.join(", ") || "None")}${row("Solution layers", layers.map((layer) => `${layer.solution || layer.dir || "Solution"}${layer.version ? ` ${layer.version}` : ""}${layer.type ? ` (${layer.type})` : ""}`).join(" → ") || "None")}${row("Environment variable definitions", String(bootstrap.environmentVariables ?? 0))}${row("Sign-in page", signInText)}${row("Observed platform behaviour", observedText)}${row("Startup", Number.isFinite(timings.startupMs) ? `${timings.startupMs} ms${Number.isFinite(timings.solutionsMs) ? ` (Solutions ${timings.solutionsMs} ms)` : ""}` : null)}${row("Last source reload", lastReload ? `${lastReload.at} · ${lastReload.durationMs} ms · ${lastReload.changedCount ?? 0} changed files` : "None since start")}</div><p class="muted">Evidence binds these fingerprints. A source save reloads the runtime and changes the source fingerprint; editing Mirage code requires a restart.</p></section>` +
    `<section class="panel"><div class="panel-heading"><h2>Workspace state</h2>${badge("Local only")}</div><p class="muted">Export saves records, mappings, presets, rules and configuration as JSON. Import replaces the whole local state (saved scenarios are kept) and reloads open portal pages. Reset restores the imported defaults.</p><div class="toolbar"><button class="button" data-action="reload-sources">Reload sources</button><button class="button" data-action="export-state">Export state JSON</button><label class="button" for="state-import-file">Import state JSON</label><input id="state-import-file" type="file" accept="application/json,.json" hidden></div><button class="button danger" data-action="reset-workspace">Reset to imported defaults</button></section></div>`
  );
}

const LOG_TYPES = ["request", "liquid", "data", "plugin", "diagnostic", "reload", "connected"];
function logSummary(entry) {
  const item = entry.entry;
  if (item)
    return `${item.method} ${item.path} → ${item.status ?? "pending"}${item.entity ? ` · ${item.entity}` : ""}${item.rowCount !== null && item.rowCount !== undefined ? ` · ${item.rowCount} rows` : ""} · ${Number(item.durationMs || 0).toFixed(1)} ms${item.error ? ` · ${item.error.code}${item.error.portalCode ? ` (portal ${item.error.portalCode})` : ""}: ${item.error.message}` : ""}`;
  if (entry.type === "plugin")
    return `${entry.operation} ${entry.entity}: ${(entry.plugins || []).join(", ") || "no matching rules"} ${entry.outcome}${entry.error ? ` · ${entry.error.message}` : ""}`;
  if (entry.type === "diagnostic")
    return `${entry.diagnostic?.code || "Observation"}: ${entry.diagnostic?.message || ""}${entry.diagnostic?.path ? ` · ${entry.diagnostic.path}` : ""}`;
  if (entry.type === "reload") return `Runtime revision ${entry.revision}`;
  if (entry.type === "connected") return `Log stream connected at revision ${entry.revision ?? "?"}`;
  return JSON.stringify(entry);
}
const filteredLogs = () =>
  logEntries.filter(
    (entry) =>
      (!logFilters.type || entry.type === logFilters.type) &&
      (!logFilters.search ||
        JSON.stringify(entry).toLowerCase().includes(logFilters.search.toLowerCase())),
  );
function logRows() {
  const rows = filteredLogs().slice(0, 300);
  return (
    rows
      .map(
        (entry) =>
          `<div class="log-row ${escape(entry.level || "info")}"><span class="log-time">${escape(String(entry.time || "").slice(11, 23))}</span>${badge(entry.type, entry.level === "error" ? "red" : entry.level === "warning" ? "amber" : "")}<span class="log-text">${escape(logSummary(entry))}</span><button class="button small quiet" data-log-entry="${escape(entry.sequence ?? "")}" data-log-time="${escape(entry.time ?? "")}">Inspect</button></div>`,
      )
      .join("") ||
    `<p class="muted">${logEntries.length ? "No log entries match the filter." : "Waiting for runtime activity. Open or reload a portal page to see its requests."}</p>`
  );
}
const logStatusText = () =>
  `${logStatus}${logPaused ? ` · paused, ${pausedLogs.length} new entries waiting` : ""} · ${logEntries.length} retained (newest 500)`;
function scheduleLogs() {
  if (activeView !== "logs" || logFrame) return;
  logFrame = requestAnimationFrame(() => {
    logFrame = 0;
    const list = $("#log-list"),
      status = $("#log-status");
    if (list) list.innerHTML = logRows();
    if (status) status.textContent = logStatusText();
  });
}
function logs() {
  return (
    heading(
      "Live logs",
      "Requests, Liquid and data reads, plugin evaluations, diagnostics and reloads as they happen in this runtime.",
    ) +
    `<section class="panel"><div class="toolbar"><label class="nowrap">Type <select data-log-filter="type" aria-label="Log type"><option value="">All</option>${LOG_TYPES.map((type) => `<option ${logFilters.type === type ? "selected" : ""}>${type}</option>`).join("")}</select></label><input type="search" data-log-filter="search" aria-label="Filter live logs" placeholder="Path, table, code or message…" value="${escape(logFilters.search)}"><button class="button small" data-log-action="pause">${logPaused ? "Resume" : "Pause"}</button><button class="button small" data-log-action="copy">Copy filtered JSON</button><button class="button small quiet" data-log-action="clear">Clear</button></div><p class="muted" id="log-status" role="status">${escape(logStatusText())}</p><div id="log-list" class="log-list">${logRows()}</div></section>`
  );
}

function render() {
  const focused = document.activeElement;
  const focusKey =
    focused?.id === "record-search"
      ? "#record-search"
      : focused?.dataset?.tableSearch
        ? `[data-table-search="${CSS.escape(focused.dataset.tableSearch)}"]`
        : null;
  const selection = focused?.selectionStart;
  lazyValues.clear();
  $("#navigation").innerHTML = views
    .map(
      ([id, label, icon]) =>
        `<a class="nav-item ${activeView === id ? "active" : ""}" href="#${id}" ${activeView === id ? 'aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</a>`,
    )
    .join("");
  $("#breadcrumb").textContent =
    views.find(([id]) => id === activeView)?.[1] || "Overview";
  const renderers = { overview, records, portal, operations, access, scenarios, environment, connection, runtime: runtimeState, evidence, audit, logs };
  $("#content").innerHTML = renderers[activeView]
    ? renderers[activeView]()
    : configurationView(activeView);
  if (activeView === "connection" || activeView === "mappings")
    $("#content").insertAdjacentHTML(
      "beforeend",
      richTextBaselines() +
        observedStylesheetBaselines() +
        snippetCompositionControls(),
    );
  restoreDrafts();
  syncConfinement();
  if (focusKey) {
    const replacement = document.querySelector(focusKey);
    replacement?.focus();
    try {
      replacement?.setSelectionRange(selection, selection);
    } catch {}
  }
}

async function openEditor(name, id) {
  let item;
  let help;
  let title;
  if (name === "portal-access-rules") {
    const existing = (accessRules ?? []).find((row) => row.id === id);
    if (id !== undefined && !existing) {
      notify("This page access rule is not available. Refresh the workspace.", true);
      return;
    }
    item =
      id === undefined
        ? { id: crypto.randomUUID(), value: { name: "Local page rule", webPageId: state.status?.pages?.[0]?.id ?? "", right: 2, scope: 1, roleIds: [] } }
        : { id, value: existing.value };
    title = `${id === undefined ? "Add" : "Edit"} page access rule`;
    help = `right 1 grants change (and read) to the roles on that page branch; right 2 restricts reading the branch to the roles. scope 1 covers all content, scope 2 excludes direct child web files. webPageId and roleIds are exported IDs (roles: ${(state.status?.webRoles || []).map((role) => `${role.name}=${role.id}`).join(", ") || "none"}). A null value removes the rule locally; Reset restores the export.`;
    editContext = { name, id };
  } else if (name === "environment-variable") {
    const variable = environmentResult?.environmentVariables?.definitions?.find((entry) => entry.schemaName === id);
    if (!variable) {
      notify("This environment variable is not available. Refresh the environment.", true);
      return;
    }
    item = { value: variable.value ?? variable.defaultValue ?? "" };
    title = `Set ${id}`;
    help = "Set the local current value as text. A null value removes the local value so the definition default applies.";
    editContext = { name, id };
  } else if (["portal-settings", "portal-snippets", "portal-roles"].includes(name)) {
    const key = name === "portal-settings" ? "portalSettings" : name === "portal-roles" ? "portalRoles" : "portalSnippets";
    const existing = (config()[key] ?? []).find(row => row.id === id);
    item = id === undefined ? (name === "portal-roles" ? { id: crypto.randomUUID(), value: { name: "Local role", authenticatedUsersRole: false, anonymousUsersRole: false } } : { name: "", value: "" }) : { name: existing?.name, value: existing?.value };
    title = `${id === undefined ? "Add" : "Edit"} ${name === "portal-settings" ? "site setting" : name === "portal-roles" ? "web role" : "content snippet"}`;
    help = name === "portal-roles" ? "Edit the role name and automatic membership flags inside value. Null removes the role locally. Imported permission/page rules and contact memberships resolve these roles by ID; reset restores the source." : "Enter name and string value. A null value removes this value locally. Reset restores the exported source. Snippets support Liquid. Local overrides persist across source reloads.";
    editContext = { name, id };
  } else if (name === "shellProfile") {
    item = config().shellProfile || {};
    title = "Edit portal shell profile";
    help =
      'Set stylesheets, headScripts, and bodyScripts arrays in the observed live resource order. Use portal-relative paths or HTTP(S) URLs. Script entries can be objects with src and defer. An empty object keeps the default shell resource selection. Example: {"stylesheets":["/bootstrap.min.css","/theme.css"],"headScripts":["/jquery.min.js"],"bodyScripts":[]}.';
    editContext = { name, configField: true };
  } else if (name === "componentSchemas") {
    item = config().componentSchemas || {};
    title = "Edit form & view schemas";
    help =
      'Key each schema by the exported form or list name or ID. Example: {"Contact form":{"entity":"contact","title":"Contact","fields":[{"name":"firstname","label":"First name","type":"text","required":true}]}}. List schemas use the same entity and fields, with optional query parameters. Explicit schemas enable simulation; they do not prove the live layout matches.';
    editContext = { name, configField: true };
  } else if (name === "records") {
    const mapping = collection("mappings").find(
      (entry) => (entry.logicalName || entry.entity) === selectedEntity,
    );
    const idColumn = mapping?.idColumn || `${selectedEntity}id`;
    item =
      id === undefined
        ? { [idColumn]: crypto.randomUUID() }
        : (recordResult?.items || state.data?.[selectedEntity] || []).find(
            (record) => String(record[idColumn] ?? record.id) === id,
          );
    title = `${id === undefined ? "Create" : "Edit"} ${selectedEntity} record`;
    help =
      "Edit local field values as JSON, even when live routing is selected. Backend plugin rules apply. Admin edits bypass portal table permissions; test role access through the portal.";
    editContext = { name, id, entity: selectedEntity };
  } else {
    const def = definitions[name];
    item =
      id === undefined
        ? def.sample()
        : collection(name).find((entry) => String(entry.id) === id);
    title = `${id === undefined ? "Add" : "Edit"} ${name === "presets" ? "preset" : name.slice(0, -1)}`;
    help = def.help;
    editContext = { name, id };
  }
  if (name === "presets" && id !== undefined) {
    try {
      item = await request(`/presets/${encodeURIComponent(id)}`);
    } catch (error) {
      notify(error.message, true);
      return;
    }
  }
  if (!item) {
    notify("This item is no longer available. Refresh the workspace.", true);
    return;
  }
  $("#editor-title").textContent = title;
  $("#editor-category").textContent =
    name === "records" ? "LOCAL DATA" : "CONFIGURATION";
  $("#editor-description").textContent = help;
  $("#editor-json").value = json(item);
  $("#editor-error").hidden = true;
  $("#editor").showModal();
  $("#editor-json").focus();
}

function askConfirmation(title, message, action, label = "Delete") {
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  $("#confirm-submit").textContent = label;
  confirmAction = action;
  $("#confirm").showModal();
  $("#confirm-cancel").focus();
}

async function saveConfig(patch, { form } = {}) {
  await request("/config", { method: "PATCH", body: JSON.stringify(patch) });
  // Saved values now come from the simulator; a failed save keeps the draft.
  if (form) drafts.delete(form);
  await refresh();
  notify("Configuration saved.");
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.operationReset) {
    try {
      await request(`/operations/${encodeURIComponent(target.dataset.operationReset)}`, { method: 'DELETE' });
      drafts.clear();
      await refresh();
      notify('Source operation default restored.');
    } catch (error) { notify(error.message, true); }
    return;
  }
  if (target.dataset.inspect !== undefined) {
    const value = lazyValues.get(target.dataset.inspect);
    $("#inspection-json").textContent = json(value);
    const correlated = $("#inspection-correlated");
    if (correlated) {
      correlated.hidden = !value?.correlationId;
      correlated.dataset.correlation = value?.correlationId ?? "";
    }
    $("#inspection").showModal();
    return;
  }
  if (target.id === "inspection-correlated") {
    $("#inspection").close();
    const correlation = target.dataset.correlation;
    if (!correlation) return;
    if (activeView === "audit") {
      auditFilters.correlationId = correlation;
      browserFor("audit").page = 1;
      await loadAudit();
    } else location.hash = `audit?correlationId=${encodeURIComponent(correlation)}`;
    return;
  }
  if (target.dataset.logEntry !== undefined) {
    const entry = logEntries.find(
      (item) =>
        String(item.sequence ?? "") === target.dataset.logEntry &&
        String(item.time ?? "") === target.dataset.logTime,
    );
    if (!entry) return;
    $("#inspection-json").textContent = json(entry);
    const correlated = $("#inspection-correlated");
    if (correlated) {
      correlated.hidden = !entry.entry?.correlationId;
      correlated.dataset.correlation = entry.entry?.correlationId ?? "";
    }
    $("#inspection").showModal();
    return;
  }
  if (target.dataset.logAction) {
    const action = target.dataset.logAction;
    if (action === "pause") {
      logPaused = !logPaused;
      if (!logPaused) {
        logEntries.unshift(...pausedLogs.slice().reverse());
        pausedLogs.length = 0;
        if (logEntries.length > 500) logEntries.length = 500;
      }
      render();
    } else if (action === "clear") {
      logEntries.length = 0;
      pausedLogs.length = 0;
      scheduleLogs();
    } else {
      try {
        await navigator.clipboard.writeText(json(filteredLogs()));
        notify("Filtered log copied.");
      } catch (error) {
        notify(error.message, true);
      }
    }
    return;
  }
  if (target.dataset.copyText !== undefined) {
    try {
      await navigator.clipboard.writeText(target.dataset.copyText);
      notify("Copied.");
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.id === "inspection-close") {
    $("#inspection").close();
    return;
  }
  if (target.id === "inspection-copy") {
    try {
      await navigator.clipboard.writeText($("#inspection-json").textContent);
      notify("Request details copied.");
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.tablePage) {
    browserFor(target.dataset.tablePage).page += Number(target.dataset.delta);
    if (target.dataset.tablePage === "audit") await loadAudit();
    else if (target.dataset.tablePage === "records" && state.summaryMode)
      await loadRecords();
    else render();
    return;
  }
  if (target.dataset.auditAction) {
    const action = target.dataset.auditAction;
    if (action === "refresh") {
      await loadAudit();
      return;
    }
    if (action === "uncorrelate") {
      auditFilters.correlationId = "";
      browserFor("audit").page = 1;
      await loadAudit();
      return;
    }
    if (action === "clear") {
      askConfirmation(
        "Clear request audit?",
        "Remove retained diagnostic activity from this simulator session.",
        async () => {
          await request("/audit/clear", { method: "POST", body: "{}" });
          browserFor("audit").page = 1;
          await loadAudit();
        },
        "Clear audit",
      );
      return;
    }
    try {
      const exported = await request(
          "/audit/export?" + new URLSearchParams(activeAuditFilters()),
        ),
        content = json(exported);
      if (action === "copy") {
        await navigator.clipboard.writeText(content);
        notify("Filtered audit copied.");
      } else {
        const url = URL.createObjectURL(
            new Blob([content], { type: "application/json" }),
          ),
          link = document.createElement("a");
        link.href = url;
        link.download = "simulator-audit.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.applyScenario) {
    const id = target.dataset.applyScenario;
    const scenario = collection("scenarios").find((item) => item.id === id);
    askConfirmation(
      "Apply this scenario?",
      `${scenario?.preset ? `Preset ${scenario.preset} replaces the local data it defines, then ` : ""}the persona and permission settings of “${scenario?.name ?? id}” apply in one change. Open portal pages reload.`,
      async () => {
        // The scenario applies first (its preset can create the persona). A scenario persona
        // (null = anonymous) then signs this browser in or out through the portal, which comes
        // back to this view.
        const persona = Boolean(scenario && scenario.persona !== undefined);
        const contactId = scenario?.persona?.contactId ?? null;
        await request(`/scenarios/${encodeURIComponent(id)}/apply`, {
          method: "POST",
          body: "{}",
        });
        await refresh();
        const current = browserSession?.signedIn ? browserSession.contactId : null;
        if (persona && personaId(current) !== personaId(contactId)) {
          notify(`Scenario applied. ${contactId ? "Signing this browser in as its persona" : "Signing this browser out"} through the portal ...`);
          if (contactId) await signInThroughPortal(contactId);
          else signOutThroughPortal();
          return;
        }
        notify(persona ? `Scenario applied. ${sessionSummary()}.` : "Scenario applied.");
      },
      "Apply scenario",
    );
    return;
  }
  if (target.dataset.referenceOrigin) {
    try {
      await request("/environment/reference", {
        method: "POST",
        body: JSON.stringify({ origin: target.dataset.referenceOrigin }),
      });
      await refresh();
      notify("Reference origin selected for live routing. Connect its signed-in browser to read from it.");
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.resetVariable) {
    try {
      await request(`/environment/variables/${encodeURIComponent(target.dataset.resetVariable)}`, {
        method: "PUT",
        body: JSON.stringify({ value: null }),
      });
      await loadEnvironment();
      notify("Local value removed; the Solution value or definition default applies.");
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.action === "reset-workspace") {
    askConfirmation(
      "Reset the workspace?",
      "Restore imported records, configuration, identity and permissions. Local records, overrides and rules are replaced; saved scenarios are kept. Open portal pages reload.",
      async () => {
        await request("/reset", { method: "POST", body: "{}" });
        await refresh();
        notify("Workspace reset to imported defaults.");
      },
      "Reset workspace",
    );
    return;
  }
  if (target.dataset.action === "reload-sources") {
    try {
      await request("/reload", { method: "POST", body: "{}" });
      await refresh();
      notify("Sources reloaded.");
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.action === "reload-environment") {
    await loadEnvironment();
    return;
  }
  if (target.dataset.action === "export-state") {
    try {
      const exported = await request("/state/export");
      const url = URL.createObjectURL(
          new Blob([json(exported)], { type: "application/json" }),
        ),
        link = document.createElement("a");
      link.href = url;
      link.download = "simulator-state.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.action === "persona-sign-in" || target.dataset.action === "persona-sign-out") {
    const contactId =
      target.dataset.action === "persona-sign-in"
        ? personaId($("#persona-contact")?.value) || null
        : null;
    if (target.dataset.action === "persona-sign-in" && !contactId) return;
    try {
      await request("/personas/select", {
        method: "POST",
        body: JSON.stringify({ contactId }),
      });
      await refresh();
      notify(contactId ? "The sign-in page now offers the selected contact first." : "The sign-in page offers no default persona.");
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.action === "session-sign-in" || target.dataset.action === "session-sign-out") {
    const signIn = target.dataset.action === "session-sign-in";
    const contactId = signIn ? personaId($("#session-contact")?.value) || null : null;
    if (signIn && !contactId) return;
    try {
      const provider = signInProvider();
      notify(signIn ? `Signing in through ${provider ? provider.caption || provider.name || "the identity provider" : "the local sign-in page"} ...` : "Signing out through the portal ...");
      if (signIn) await signInThroughPortal(contactId);
      else signOutThroughPortal();
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.action === "session-override-clear") {
    try {
      await setSessionRoles(null);
      notify("The simulation override is cleared: the session uses the contact's web roles again.");
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.view) location.hash = target.dataset.view;
  if (target.dataset.action === "retry") await refresh();
  if (target.dataset.add) await openEditor(target.dataset.add);
  if (target.dataset.edit)
    await openEditor(target.dataset.edit, target.dataset.id);
  if (target.dataset.delete) {
    const { delete: name, id } = target.dataset;
    const entity = selectedEntity;
    const reset = ["portal-settings", "portal-snippets", "portal-roles", "portal-access-rules"].includes(name);
    askConfirmation(
      reset ? "Reset local override?" : `Delete ${name === "records" ? "record" : "configuration item"}?`,
      reset ? `Reset ${id} to its exported source value?` : `Delete ${id}? This removes it from the local simulator.`,
      async () => {
        await request(
          `/${name === "records" ? `records/${encodeURIComponent(entity)}` : name}/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        await refresh();
        notify("Item deleted.");
      },
    );
  }
  if (target.dataset.apply || target.hasAttribute("data-apply-selected")) {
    const id = target.dataset.apply || $("#available-preset").value;
    askConfirmation(
      "Apply this preset?",
      "The preset will update simulator records and configuration according to its definition.",
      async () => {
        await request(`/presets/${encodeURIComponent(id)}/apply`, {
          method: "POST",
          body: "{}",
        });
        await refresh();
        notify("Preset applied.");
      },
      "Apply preset",
    );
  }
});

/** Confinement exceptions look and act disabled while local pages are not confined. */
function syncConfinement() {
  const toggle = $("#confine-portal-pages"),
    options = $("#confinement-options");
  if (!toggle || !options) return;
  options.disabled = !toggle.checked;
  options.classList.toggle("is-off", !toggle.checked);
}
document.addEventListener("change", (event) => {
  if (event.target.id === "confine-portal-pages") syncConfinement();
  if (event.target.id === "session-contact") {
    sessionPick = event.target.value;
    const button = document.querySelector('[data-action="session-sign-in"]');
    const option = event.target.selectedOptions?.[0];
    if (button && option) button.textContent = `Sign in as ${option.textContent}`;
    return;
  }
  if (event.target.dataset.logFilter === "type") {
    logFilters.type = event.target.value;
    scheduleLogs();
    return;
  }
  if (event.target.id === "state-import-file") {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    file.text().then((text) =>
      askConfirmation(
        "Import this state?",
        `Replace the whole local workspace state with ${file.name}? Saved scenarios are kept; open portal pages reload.`,
        async () => {
          await request("/state/import", { method: "POST", body: text });
          await refresh();
          notify("State imported.");
        },
        "Import state",
      ),
    );
    return;
  }
  if (event.target.id === "enrichment-file") {
    const file = event.target.files?.[0];
    if (file)
      file.text().then((text) => {
        $("#enrichment-plan").value = text;
        rememberDraft($("#enrichment-plan"));
      });
    return;
  }
  if (event.target.dataset.tableSize) {
    browserFor(event.target.dataset.tableSize).size = Number(
      event.target.value,
    );
    browserFor(event.target.dataset.tableSize).page = 1;
    if (event.target.dataset.tableSize === "audit") loadAudit();
    else if (event.target.dataset.tableSize === "records" && state.summaryMode)
      loadRecords();
    else render();
    return;
  }
  if (event.target.dataset.auditFilter) {
    auditFilters[event.target.dataset.auditFilter] = event.target.value;
    browserFor("audit").page = 1;
    loadAudit();
    return;
  }
  rememberDraft(event.target);
  if (event.target.id === "persona-contact") {
    selectedPersona = event.target.value;
    // Membership choices belong to the previously selected contact.
    drafts.delete("persona-form");
    render();
  }
  if (event.target.hasAttribute("data-role-choice")) {
    const role = event.target.dataset.roleChoice;
    const values = new Set(
      $("#identity-roles")
        .value.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    if (event.target.checked) values.add(role);
    else values.delete(role);
    $("#identity-roles").value = [...values].join(", ");
    rememberDraft($("#identity-roles"));
  }

  if (event.target.id === "entity-select") {
    selectedEntity = event.target.value;
    filter = "";
    browserFor("records").page = 1;
    recordResult = undefined;
    render();
    loadRecords();
  }
});
document.addEventListener("input", (event) => {
  if (event.target.dataset.logFilter === "search") {
    logFilters.search = event.target.value;
    scheduleLogs();
    return;
  }
  if (event.target.dataset.tableSearch) {
    const key = event.target.dataset.tableSearch,
      value = event.target.value;
    browserFor(key).search = value;
    browserFor(key).page = 1;
    render();
    const input = document.querySelector(
      `[data-table-search="${CSS.escape(key)}"]`,
    );
    input.focus();
    return;
  }
  rememberDraft(event.target);
  if (event.target.id === "identity-roles") {
    const values = new Set(
      event.target.value
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    document.querySelectorAll("[data-role-choice]").forEach((input) => {
      input.checked = values.has(input.dataset.roleChoice);
      rememberDraft(input);
    });
  }

  if (event.target.id === "record-search") {
    const input = event.target;
    const position = input.selectionStart;
    filter = input.value;
    browserFor("records").page = 1;
    if (state.summaryMode) {
      loadRecords();
      return;
    }
    render();
    $("#record-search").focus();
    try {
      $("#record-search").setSelectionRange(position, position);
    } catch {
      /* Search inputs may not support selection ranges. */
    }
  }
});

$("#editor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const body = JSON.parse($("#editor-json").value);
    if (!body || Array.isArray(body) || typeof body !== "object")
      throw new Error("Enter a JSON object with named fields.");
    const { name, id, entity, configField } = editContext;
    if (name === "mappings") {
      if (!body.logicalName) throw new Error("Mappings require a logicalName.");
      if (
        (body.id && body.id !== body.logicalName) ||
        (id !== undefined && id !== body.logicalName)
      )
        throw new Error(
          "The mapping ID must equal its logicalName. To rename an entity, create a new mapping.",
        );
      body.id = body.logicalName;
    }
    if (name === "environment-variable") {
      if (body.value !== null && typeof body.value !== "string")
        throw new Error("Enter a text value, or null to use the definition default.");
      await request(`/environment/variables/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ value: body.value }),
      });
      $("#editor").close();
      await loadEnvironment();
      notify("Environment variable saved.");
      return;
    }
    if (configField) {
      await request("/config", {
        method: "PATCH",
        body: JSON.stringify({ [name]: body }),
      });
      $("#editor").close();
      await refresh();
      notify(
        name === "shellProfile" ? "Shell profile saved." : "Schemas saved.",
      );
      return;
    }
    const path = `/${name === "records" ? `records/${encodeURIComponent(entity)}` : name}${id === undefined ? "" : `/${encodeURIComponent(id)}`}`;
    await request(path, {
      method: id === undefined ? "POST" : "PATCH",
      body: JSON.stringify(body),
    });
    $("#editor").close();
    await refresh();
    notify("Changes saved.");
  } catch (error) {
    $("#editor-error").textContent = error.message;
    $("#editor-error").hidden = false;
  } finally {
    button.disabled = false;
  }
});

$("#confirm-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await confirmAction();
    $("#confirm").close();
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});
for (const selector of ["#editor-close", "#editor-cancel"])
  $(selector).addEventListener("click", () => $("#editor").close());
$("#confirm-cancel").addEventListener("click", () => $("#confirm").close());
$("#refresh").addEventListener("click", () => refresh({ announce: true }));
// Views that summarize live runtime state fetch it again when they are opened.
const FRESH_VIEWS = ["overview", "environment", "runtime", "evidence"];
window.addEventListener("hashchange", () => {
  const { view, params } = parseHash();
  if (!views.some(([id]) => id === view)) return;
  const entered = view !== activeView;
  if (entered) drafts.clear();
  activeView = view;
  filter = "";
  applyRoute(view, params);
  if (entered && FRESH_VIEWS.includes(view)) {
    refresh();
    return;
  }
  render();
  loadView();
});

document.addEventListener(
  "toggle",
  (event) => {
    const detail = event.target;
    if (detail.open && detail.dataset?.lazyJson !== undefined) {
      const value = lazyValues.get(detail.dataset.lazyJson);
      detail.querySelector("pre").textContent = json(value);
    }
    if (detail.dataset?.disclosure) {
      const key = detail.dataset.disclosure;
      if (detail.open) {
        openDisclosures.add(key);
        const body = detail.querySelector("[data-disclosure-body]");
        if (!body.children.length) {
          body.innerHTML = disclosureRenderers.get(key)?.() || "";
          restoreDrafts();
        }
      } else openDisclosures.delete(key);
    }
  },
  true,
);
document.addEventListener("submit", async (event) => {
  if (
    ![
      "identity-form",
      "connection-form",
      "live-connect-form",
      "snippet-composition-form",
      "asset-capture-form",
      "shell-capture-form",
      "persona-form",
      "permission-source-form",
      "scenario-form",
      "create-persona-form",
      "enrichment-form",
      "session-override-form",
    ].includes(event.target.id) && !event.target.matches('form[data-operation-key]')
  )
    return;
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    if (event.target.matches('form[data-operation-key]')) {
      const form = event.target;
      await request(`/operations/${encodeURIComponent(form.dataset.operationKey)}`, { method: 'PATCH', body: JSON.stringify({ mode: form.elements.mode.value, status: Number(form.elements.status.value), body: JSON.parse(form.elements.body.value) }) });
      drafts.delete(form.id);
      await refresh();
      notify('Local operation saved.');
    } else if (event.target.id === "session-override-form") {
      const roles = $("#override-roles")
        .value.split(",")
        .map((role) => role.trim())
        .filter(Boolean);
      if (!roles.length) throw new Error("Enter at least one web role, or clear the override.");
      await setSessionRoles(roles);
      drafts.delete("session-override-form");
      notify(`Simulation override: ${browserSession.name || browserSession.contactId} has ${roles.join(", ")} in this browser.`);
    } else if (event.target.id === "identity-form") {
      await saveConfig({
        permissionMode: $("#permission-mode").value,
        identity: {
          roleSource: "override",
          id: $("#identity-id").value.trim(),
          contactId: $("#identity-id").value.trim(),
          name: $("#identity-name").value.trim(),
          accountId: $("#identity-account").value.trim(),
          roles: $("#identity-roles")
            .value.split(",")
            .map((role) => role.trim())
            .filter(Boolean),
        },
      }, { form: "identity-form" });
    } else if (event.target.id === "persona-form") {
      const contactId = personaId($("#persona-contact").value);
      const contactRoles = (
        state.status?.permissionModel?.memberships ||
        config().contactRoles ||
        []
      ).filter((assignment) => personaId(assignment.contactId) !== contactId);
      document
        .querySelectorAll("[data-contact-role]:checked")
        .forEach((input) =>
          contactRoles.push({ contactId, roleId: input.dataset.contactRole }),
        );
      const patch = { contactRoles };
      if (button.value === "select")
        patch.identity = {
          id: contactId,
          contactId,
          roleSource: "memberships",
          roles: [],
        };
      await saveConfig(patch, { form: "persona-form" });
    } else if (event.target.id === "permission-source-form") {
      await saveConfig({
        permissionSource: $("#permission-source").value,
        permissionMode: "enforce",
      }, { form: "permission-source-form" });
    } else if (event.target.id === "connection-form") {
      const origin = $("#live-origin").value.trim();
      if (origin && !/^https?:\/\//i.test(origin))
        throw new Error("Enter an HTTP or HTTPS environment origin.");
      const externalFrameOrigins = [...new Set($("#external-frame-origins").value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean).map(value=>{
        let url;try{url=new URL(value);}catch{throw new Error("Online embedded content requires one exact HTTPS origin per line.");}
        if(url.protocol!=="https:" || url.username || url.password || url.pathname!=="/" || url.search || url.hash)
          throw new Error("Online embedded content requires exact HTTPS origins without credentials, paths, queries or fragments.");
        return url.origin;
      }))];
      await saveConfig({
        mode: $("#data-mode").value,
        pageMode: $("#page-mode").value,
        confinePortalPages: $("#confine-portal-pages").checked,
        externalAssets: $("#external-assets").checked,
        externalFrameOrigins,
        live: {
          ...config().live,
          origin,
          fetchXmlPath: $("#fetchxml-path").value.trim() || null,
          // A runtime started without --allow-live-writes refuses true; its switch stays off.
          allowWrites: !$("#live-writes").disabled && $("#live-writes").checked,
        },
      }, { form: "connection-form" });
    } else if (event.target.id === "scenario-form") {
      const name = $("#scenario-name").value.trim();
      const id =
        $("#scenario-id").value.trim() ||
        name
          .toLowerCase()
          .replace(/[^\w.-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80);
      const persona = $("#scenario-persona").value;
      const body = { id, name };
      if ($("#scenario-preset").value) body.preset = $("#scenario-preset").value;
      if (persona !== "__keep") body.persona = persona ? { contactId: persona } : null;
      if ($("#scenario-permission-mode").value)
        body.permissionMode = $("#scenario-permission-mode").value;
      await request("/scenarios", { method: "POST", body: JSON.stringify(body) });
      drafts.delete("scenario-form");
      await refresh();
      notify("Scenario saved.");
    } else if (event.target.id === "create-persona-form") {
      const signIn = $("#new-persona-select").checked;
      const created = await request("/personas", {
        method: "POST",
        body: JSON.stringify({
          firstname: $("#new-persona-first").value.trim(),
          lastname: $("#new-persona-last").value.trim(),
          emailaddress1: $("#new-persona-email").value.trim(),
          accountId: $("#new-persona-account").value.trim(),
          roleIds: [...document.querySelectorAll("[data-new-persona-role]:checked")].map(
            (input) => input.dataset.newPersonaRole,
          ),
        }),
      });
      drafts.delete("create-persona-form");
      const contactId = created.contact?.contactid;
      if (contactId) selectedPersona = sessionPick = contactId;
      await refresh();
      if (signIn && contactId) {
        notify(`Persona ${created.contact?.fullname ?? ""} created; signing this browser in as it through the portal ...`);
        await signInThroughPortal(contactId);
      } else notify(`Persona ${created.contact?.fullname ?? ""} created.`);
    } else if (event.target.id === "enrichment-form") {
      let plan;
      try {
        plan = JSON.parse($("#enrichment-plan").value);
      } catch {
        throw new Error("The enrichment plan must be a JSON array of table queries.");
      }
      if (button.value === "run") {
        askConfirmation(
          "Run this enrichment plan?",
          "The connected browser reads the listed records from the selected reference origin. Complete results replace or merge into local tables in one change; open portal pages reload.",
          async () => {
            try {
              enrichmentReport = await request("/reference/enrich", {
                method: "POST",
                body: JSON.stringify({ plan }),
              });
            } catch (error) {
              enrichmentReport = error.details ?? { error: error.message };
              render();
              throw error;
            }
            await refresh();
            notify("Reference records imported into local state.");
          },
          "Run plan",
        );
      } else {
        try {
          enrichmentReport = await request("/reference/enrich/validate", {
            method: "POST",
            body: JSON.stringify({ plan }),
          });
        } catch (error) {
          enrichmentReport = error.details ?? { error: error.message };
          render();
          throw error;
        }
        render();
        notify("The plan is valid. No reference reads were made.");
      }
    } else if (event.target.id === "shell-capture-form") {
      const path = $("#shell-page-path").value.trim();
      shellCapturePath = path;
      managedControlPath = $("#managed-control-path").value.trim();
      if (!/^\/(?!\/)/.test(path) || path.includes("\\"))
        throw new Error("Enter a portal-relative page path.");
      try {
        shellCaptureResult = await request("/assets/capture-shell", {
          method: "POST",
          body: JSON.stringify({
            path,
            managedControlPath: managedControlPath || undefined,
          }),
        });
      } catch (error) {
        shellCaptureResult = error.details?.report ||
          error.details || { error: error.message };
        render();
        throw error;
      }
      drafts.delete(event.target.id);
      await refresh();
      notify(
        `Page shell ${shellCaptureResult.applied === false ? "not replaced" : "replaced"}. Captured ${shellCaptureResult.captured?.length ?? 0} static files.${shellCaptureResult.complete === false ? " Dependencies remain incomplete; inspect the capture report." : ""}`,
        shellCaptureResult.complete === false,
      );
    } else if (event.target.id === "snippet-composition-form") {
      await request("/assets/capture-snippet-composition", {
        method: "POST",
        body: JSON.stringify({
          path: $("#composition-page").value.trim(),
          parentName: $("#composition-parent").value.trim(),
          childName: $("#composition-child").value.trim(),
        }),
      });
      drafts.delete(event.target.id);
      await refresh();
      notify("Observed composition verified against both local snippets.");
    } else if (event.target.id === "asset-capture-form") {
      const paths = $("#asset-paths")
        .value.split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (
        !paths.length ||
        paths.some((item) => !/^\/(?!\/)/.test(item) || item.includes("\\"))
      )
        throw new Error(
          "Enter portal-relative static file paths, one per line.",
        );
      const observingStylesheets = $("#observe-stylesheets")?.checked;
      if (observingStylesheets && paths.some((item) => !item.endsWith(".css")))
        throw new Error(
          "Stylesheet observations require mapped CSS paths only.",
        );
      const result = await request(
        observingStylesheets
          ? "/assets/capture-stylesheets"
          : "/assets/capture",
        {
          method: "POST",
          body: JSON.stringify({ paths }),
        },
      );
      drafts.delete(event.target.id);
      await refresh();
      const failures = result.failures || result.errors || [];
      const captured =
        result.captured?.length ?? (failures.length ? 0 : paths.length);
      notify(
        `Captured ${captured} files for ${paths.length} requested paths.${failures.length ? ` ${failures.length} failed: ${failures.map((item) => `${item.path || ""} ${item.message || item}`).join("; ")}` : ""}`,
        failures.length > 0,
      );
    } else {
      await request("/live/connect", {
        method: "POST",
        body: JSON.stringify({ cdpUrl: $("#cdp-url").value.trim() }),
      });
      drafts.delete(event.target.id);
      await refresh();
      notify("Authenticated browser connected.");
    }
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});

applyRoute(activeView, parseHash().params);
await refresh();
