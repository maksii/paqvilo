const table = { name: 'entity', label: 'Table logical name', type: 'table', required: true };
const guid = { name: 'id', label: 'Record ID', type: 'guid', required: true };
const definitions = [
  ['form:show-logical-names', 'Logical names', 'Inspect', 'Show clickable logical column names.', 'presentation', ['form']],
  ['form:clear-logical-names', 'Clear logical names', 'Inspect', 'Remove labels added by this session.', 'presentation', ['form']],
  ['form:god-mode', 'Form overrides', 'Workflows', 'Reveal and enable controls and remove client required levels. Server permissions still apply.', 'client-form', ['form']],
  ['form:restore-overrides', 'Restore form overrides', 'Workflows', 'Restore the exact control, tab, section and required states saved by this session.', 'client-form', ['form']],
  ['form:changed-fields', 'Changed fields', 'Inspect', 'Show dirty fields in the current form draft.', 'read', ['form']],
  ['form:record-url', 'Record URL', 'Inspect', 'Show a link to this saved record in the current app.', 'read', ['saved-record']],
  ['form:record-id', 'Record ID', 'Inspect', 'Show the saved record GUID.', 'read', ['saved-record']],
  ['form:open-web-api', 'Open record Web API', 'Open', 'Open the saved record endpoint using its actual entity set.', 'navigate', ['saved-record', 'metadata']],
  ['form:refresh-subgrids', 'Refresh subgrids', 'Workflows', 'Refresh the form’s actual subgrid controls.', 'native-read', ['form']],
  ['form:show-optionset-values', 'Choice values', 'Inspect', 'Show available choice labels and numeric values.', 'read', ['form']],
  ['form:clone-record', 'Prepare clone', 'Workflows', 'Open an unsaved create form with eligible typed values. No record is created until Save.', 'draft', ['form', 'metadata', 'open-form']],
  ['form:refresh-autosave-off', 'Discard and refresh', 'Workflows', 'Refresh without saving the draft. Autosave behavior is controlled separately.', 'discard', ['form', 'refresh']],
  ['form:toggle-autosave', 'Autosave guard', 'Workflows', 'Block autosave mode 70 only; ordinary Save and Save & Close remain available.', 'client-form', ['form', 'save-events'], [{ name: 'enabled', label: 'Block autosave', type: 'boolean', default: true }]],
  ['form:all-fields', 'Saved record fields', 'Inspect', 'Read the saved server record, including columns absent from the form.', 'native-read', ['saved-record', 'metadata']],
  ['form:open-editor', 'Open form editor', 'Open', 'Open the current form in its actual preferred or default solution.', 'navigate', ['form', 'form-selector', 'environment', 'metadata']],
  ['form:table-processes', 'Table processes', 'Inspect', 'Read active workflows, rules, flows, actions and bound custom APIs.', 'native-read', ['form', 'metadata']],
  ['navigation:open-record-by-id', 'Open by ID', 'Open', 'Open a record in this environment and app.', 'navigate', ['open-form', 'metadata'], [table, guid]],
  ['navigation:new-record', 'New record', 'Open', 'Open an unsaved create form for a table.', 'draft', ['open-form', 'metadata'], [table]],
  ['navigation:open-list', 'Open table list', 'Open', 'Open a table list in this app.', 'navigate', ['navigate', 'metadata'], [table]],
  ['navigation:open-security', 'Security', 'Open', 'Open this environment’s user and security administration.', 'navigate', ['environment']],
  ['navigation:open-system-jobs', 'System jobs', 'Open', 'Open native system jobs.', 'navigate', ['navigate']],
  ['navigation:open-solutions', 'Solutions', 'Open', 'Open this environment’s solutions.', 'navigate', ['environment']],
  ['navigation:open-processes', 'Processes', 'Open', 'Open the native workflow list.', 'navigate', ['navigate']],
  ['navigation:open-mailboxes', 'Mailboxes', 'Open', 'Open the native mailbox list.', 'navigate', ['navigate']],
  ['navigation:open-main', 'App home', 'Open', 'Open this environment’s app home.', 'navigate', ['navigate']],
  ['navigation:open-advanced-find', 'Advanced Find', 'Open', 'Open native Advanced Find where the environment supports it.', 'navigate', ['navigate']],
  ['navigation:open-mobile-client', 'Legacy mobile client', 'Open', 'Open the environment’s legacy mobile client; availability is determined by the native app.', 'navigate', ['navigate']],
  ['navigation:open-solutions-history', 'Solution history', 'Open', 'Open this environment’s solution import history.', 'navigate', ['environment']],
  ['navigation:pin-to-side-panel', 'Pin to native side pane', 'Workflows', 'Open the current native record or list in a closeable app side pane.', 'presentation', ['side-panes']],
  ['navigation:open-power-platform-admin', 'Environment administration', 'Open', 'Open this environment in Power Platform admin center.', 'navigate', ['environment']],
  ['admin:environment-context', 'Environment and user', 'Inspect', 'Read the native environment, client version and signed-in user context.', 'read', ['context']],
  ['identity:users', 'Find native users', 'Workflows', 'Read active non-application users for an explicit acting-as selection.', 'native-read', ['metadata'], [{ name: 'query', label: 'Name or domain contains', type: 'text', default: '', maxLength: 100 }]],
  ['identity:status', 'Identity and acting-as privilege', 'Inspect', 'Read the signed-in identity and exact native impersonation privilege.', 'read', ['context', 'privileges']],
  ['debugging:forms-monitor', 'Forms monitor', 'Diagnose', 'Reload with the native monitor query option.', 'reload', ['navigate']],
  ['debugging:ribbon-debugger', 'Command checker', 'Diagnose', 'Reload with the native ribbon debugger query option.', 'reload', ['navigate']],
  ['debugging:perf-center', 'Performance center', 'Diagnose', 'Reload with the native performance query option.', 'reload', ['navigate']],
  ['debugging:disable-form-handlers', 'Disable form handlers', 'Diagnose', 'Reload with the native form-handler diagnostic flag.', 'client-reload', ['navigate']],
  ['debugging:disable-business-rules', 'Disable business rules', 'Diagnose', 'Reload with the native business-rule diagnostic flag.', 'client-reload', ['navigate']],
  ['debugging:disable-form-libraries', 'Disable form libraries', 'Diagnose', 'Reload with the native form-library diagnostic flag.', 'client-reload', ['navigate']],
  ['debugging:enable-dark-mode', 'Native dark theme', 'Diagnose', 'Reload with the native dark-theme flag.', 'reload', ['navigate']],
  ['debugging:clear-flags', 'Reset diagnostics', 'Diagnose', 'Remove known diagnostic options, preserving unrelated query parameters and flags.', 'reload', ['navigate']],
];
export const MODEL_DRIVEN_ACTIONS = Object.freeze(definitions.map(([id, label, group, description, effect, requirements, inputs = []]) => Object.freeze({ id, label, group, description, effect, requirements: Object.freeze(requirements), inputs: Object.freeze(inputs.map(input => Object.freeze({ ...input }))) })));
export const modelDrivenAction = id => MODEL_DRIVEN_ACTIONS.find(action => action.id === id);

export function validateModelDrivenAction(id, params = {}) {
  const action = modelDrivenAction(id);
  if (!action) throw new Error('Unknown model-driven action.');
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.getPrototypeOf(params) !== Object.prototype) throw new Error('Action parameters must be an object.');
  const result = {};
  for (const key of Object.keys(params)) if (!action.inputs.some(input => input.name === key)) throw new Error(`Unknown action parameter: ${key}`);
  for (const input of action.inputs) {
    const value = params[input.name] ?? input.default;
    if (value === undefined && !input.required) continue;
    if (input.type === 'table') {
      if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/i.test(value)) throw new Error('Enter a table logical name.');
      result[input.name] = value.toLowerCase();
    } else if (input.type === 'guid') {
      if (typeof value !== 'string' || !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})$/i.test(value)) throw new Error('Enter a valid record GUID.');
      result[input.name] = value.replace(/[{}]/g, '').toLowerCase();
    } else if (input.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error('Action switches must be Boolean values.');
      result[input.name] = value;
    } else if (input.type === 'text') {
// eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
      if (typeof value !== 'string' || value.length > (input.maxLength ?? 200) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Enter a bounded text value without control characters.');
      result[input.name] = value;
    }
  }
  return { action: action.id, params: result };
}

export function modelDrivenDiagnosticUrl(value, action) {
  const url = new URL(value), flags = new Set(['DisableFormHandlers=true', 'DisableFormHandlers=businessrule', 'DisableFormLibraries=true', 'themeoption=darkmode']);
  const changes = { 'debugging:forms-monitor': ['monitor', 'true'], 'debugging:ribbon-debugger': ['ribbondebug', 'true'], 'debugging:perf-center': ['perf', 'true'], 'debugging:disable-form-handlers': ['flags', 'DisableFormHandlers=true'], 'debugging:disable-business-rules': ['flags', 'DisableFormHandlers=businessrule'], 'debugging:disable-form-libraries': ['flags', 'DisableFormLibraries=true'], 'debugging:enable-dark-mode': ['flags', 'themeoption=darkmode'] };
  if (action === 'debugging:clear-flags') {
    const retained = [...url.searchParams].filter(([key, item]) => !(key === 'flags' && flags.has(item)) && !(['monitor', 'ribbondebug', 'perf'].includes(key) && item === 'true'));
    url.search = new URLSearchParams(retained).toString();
  } else {
    const change = changes[action]; if (!change) throw new Error('Unknown diagnostic action.');
    if (!url.searchParams.getAll(change[0]).includes(change[1])) url.searchParams.append(...change);
  }
  return url.href;
}
