const table = { name: 'entity', label: 'Table logical name', type: 'table', required: true };
const guid = { name: 'id', label: 'Record ID', type: 'guid', required: true };
const definitions = [
  [
    'form:show-logical-names',
    'Logical names',
    'Inspect',
    'Show clickable logical column names.',
    'presentation',
    ['form'],
    [],
    { id: 'form:clear-logical-names' },
  ],
  [
    'form:clear-logical-names',
    'Clear logical names',
    'Inspect',
    'Remove labels added by this session.',
    'presentation',
    ['form'],
  ],
  [
    'form:god-mode',
    'Form overrides',
    'Workflows',
    'Reveal and enable controls and remove client required levels. Server permissions still apply.',
    'client-form',
    ['form'],
    [],
    { id: 'form:restore-overrides' },
  ],
  [
    'form:restore-overrides',
    'Restore form overrides',
    'Workflows',
    'Restore the exact control, tab, section and required states saved by this session.',
    'client-form',
    ['form'],
  ],
  ['form:changed-fields', 'Changed fields', 'Inspect', 'List fields changed but not saved yet.', 'read', ['form']],
  [
    'form:record-url',
    'Record URL',
    'Inspect',
    'Show a link to this saved record in the current app.',
    'read',
    ['saved-record'],
  ],
  ['form:record-id', 'Record ID', 'Inspect', 'Show the saved record GUID.', 'read', ['saved-record']],
  [
    'form:open-web-api',
    'Open record Web API',
    'Open',
    'Open this record’s Web API URL.',
    'navigate',
    ['saved-record', 'metadata'],
  ],
  [
    'form:refresh-subgrids',
    'Refresh subgrids',
    'Workflows',
    'Refresh every subgrid on this form.',
    'native-read',
    ['form', 'subgrids'],
  ],
  [
    'form:show-optionset-values',
    'Choice values',
    'Inspect',
    'Show available choice labels and numeric values.',
    'read',
    ['form'],
  ],
  [
    'form:clone-record',
    'Prepare clone',
    'Workflows',
    'Open an unsaved create form with eligible typed values. No record is created until Save.',
    'draft',
    ['form', 'metadata', 'open-form', 'prefill'],
  ],
  [
    'form:refresh-autosave-off',
    'Discard and refresh',
    'Workflows',
    'Refresh without saving the draft. Autosave behavior is controlled separately.',
    'discard',
    ['form', 'refresh'],
  ],
  [
    'form:toggle-autosave',
    'Autosave guard',
    'Workflows',
    'Block autosave. Save and Save & Close still work.',
    'client-form',
    ['form', 'save-events'],
    [{ name: 'enabled', label: 'Block autosave', type: 'boolean', default: true }],
    { id: 'form:toggle-autosave', label: 'Remove autosave guard', params: { enabled: false } },
  ],
  [
    'form:all-fields',
    'Saved record fields',
    'Inspect',
    'Read the saved server record, including columns absent from the form.',
    'native-read',
    ['saved-record', 'metadata'],
  ],
  [
    'form:open-editor',
    'Open form editor',
    'Open',
    'Open this form in the form designer (preferred or default solution).',
    'navigate',
    ['form', 'form-selector', 'environment', 'metadata'],
  ],
  [
    'form:table-processes',
    'Table processes',
    'Inspect',
    'Read active workflows, rules, flows, actions and bound custom APIs.',
    'native-read',
    ['form', 'metadata'],
  ],
  [
    'navigation:open-record-by-id',
    'Open by ID',
    'Open',
    'Open a record in this environment and app.',
    'navigate',
    ['open-form', 'metadata'],
    [table, guid],
  ],
  [
    'navigation:new-record',
    'New record',
    'Open',
    'Open an unsaved create form for a table.',
    'draft',
    ['open-form', 'metadata'],
    [table],
  ],
  [
    'navigation:open-list',
    'Open table list',
    'Open',
    'Open a table list in this app.',
    'navigate',
    ['navigate', 'metadata'],
    [table],
  ],
  [
    'navigation:open-security',
    'Security',
    'Open',
    'Open this environment’s user and security administration.',
    'navigate',
    ['environment'],
  ],
  ['navigation:open-system-jobs', 'System jobs', 'Open', 'Open the System Jobs list.', 'navigate', ['navigate']],
  ['navigation:open-solutions', 'Solutions', 'Open', 'Open this environment’s solutions.', 'navigate', ['environment']],
  ['navigation:open-processes', 'Processes', 'Open', 'Open the Processes list.', 'navigate', ['navigate']],
  ['navigation:open-mailboxes', 'Mailboxes', 'Open', 'Open the Mailboxes list.', 'navigate', ['navigate']],
  ['navigation:open-main', 'App home', 'Open', 'Open this environment’s app home.', 'navigate', ['navigate']],
  [
    'navigation:open-advanced-find',
    'Advanced Find',
    'Open',
    'Open Advanced Find, if this environment still has it.',
    'navigate',
    ['navigate'],
  ],
  [
    'navigation:open-mobile-client',
    'Legacy mobile client',
    'Open',
    'Open the environment’s legacy mobile client, if the environment still has it.',
    'navigate',
    ['navigate', 'organization'],
  ],
  [
    'navigation:open-solutions-history',
    'Solution history',
    'Open',
    'Open this environment’s solution import history.',
    'navigate',
    ['environment'],
  ],
  [
    'navigation:pin-to-side-panel',
    'Pin to side pane',
    'Workflows',
    'Open this record or list in a side pane you can close.',
    'presentation',
    ['side-panes'],
    [],
    { id: 'navigation:close-side-panes', label: 'Close side pane' },
  ],
  [
    'navigation:close-side-panes',
    'Close pinned side panes',
    'Workflows',
    'Close the side panes that Pin to side pane opened.',
    'presentation',
    ['side-panes'],
  ],
  [
    'navigation:open-power-platform-admin',
    'Environment administration',
    'Open',
    'Open this environment in Power Platform admin center.',
    'navigate',
    ['environment'],
  ],
  [
    'admin:environment-context',
    'Environment and user',
    'Inspect',
    'Show the environment, client version and signed-in user.',
    'read',
    ['context'],
  ],
  [
    'identity:users',
    'Find users',
    'Workflows',
    'Find enabled users, including application users, to act as.',
    'native-read',
    ['metadata'],
    [{ name: 'query', label: 'Name or domain contains', type: 'text', default: '', maxLength: 100 }],
  ],
  [
    'identity:status',
    'Identity and acting-as privilege',
    'Inspect',
    'Show who you are signed in as and whether you may act as another user.',
    'read',
    ['context', 'privileges'],
  ],
  [
    'debugging:forms-monitor',
    'Forms monitor',
    'Diagnose',
    'Reload with Monitor on (monitor=true).',
    'reload',
    ['navigate'],
  ],
  [
    'debugging:ribbon-debugger',
    'Command checker',
    'Diagnose',
    'Reload with Command checker on (ribbondebug=true).',
    'reload',
    ['navigate'],
  ],
  [
    'debugging:perf-center',
    'Performance center',
    'Diagnose',
    'Reload with Performance center on (perf=true).',
    'reload',
    ['navigate'],
  ],
  [
    'debugging:disable-form-handlers',
    'Disable form handlers',
    'Diagnose',
    'Reload with form event handlers turned off.',
    'client-reload',
    ['navigate'],
  ],
  [
    'debugging:disable-business-rules',
    'Disable business rules',
    'Diagnose',
    'Reload with business rules turned off.',
    'client-reload',
    ['navigate'],
  ],
  [
    'debugging:disable-form-libraries',
    'Disable form libraries',
    'Diagnose',
    'Reload with form script libraries turned off.',
    'client-reload',
    ['navigate'],
  ],
  ['debugging:enable-dark-mode', 'Dark theme', 'Diagnose', 'Reload in the dark theme.', 'reload', ['navigate']],
  [
    'debugging:clear-flags',
    'Reset diagnostics',
    'Diagnose',
    'Turn off all diagnostic options above; other URL parameters stay.',
    'reload',
    ['navigate'],
  ],
];
// An action that changes the current page in place declares its undo: the action (and parameters) that reverses it.
// The result of a run offers that undo, unless the run already had the undo's parameters. Actions that reload or leave
// the page, open another window, or discard a draft have no undo.
export const MODEL_DRIVEN_ACTIONS = Object.freeze(
  definitions.map(([id, label, group, description, effect, requirements, inputs = [], undo = null]) =>
    Object.freeze({
      id,
      label,
      group,
      description,
      effect,
      requirements: Object.freeze(requirements),
      inputs: Object.freeze(inputs.map((input) => Object.freeze({ ...input }))),
      undo: undo && Object.freeze({ ...undo, ...(undo.params ? { params: Object.freeze({ ...undo.params }) } : {}) }),
    }),
  ),
);
export const modelDrivenAction = (id) => MODEL_DRIVEN_ACTIONS.find((action) => action.id === id);

export function validateModelDrivenAction(id, params = {}) {
  const action = modelDrivenAction(id);
  if (!action) throw new Error('Unknown model-driven action.');
  if (
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    Object.getPrototypeOf(params) !== Object.prototype
  )
    throw new Error('Action parameters must be an object.');
  const result = {};
  for (const key of Object.keys(params))
    if (!action.inputs.some((input) => input.name === key)) throw new Error(`Unknown action parameter: ${key}`);
  for (const input of action.inputs) {
    const value = params[input.name] ?? input.default;
    if (value === undefined && !input.required) continue;
    assignValidatedActionInput(result, input, value);
  }
  return { action: action.id, params: result };
}

function assignValidatedActionInput(result, input, value) {
  if (input.type === 'table') {
    result[input.name] = validateTableInput(value);
  } else if (input.type === 'guid') {
    result[input.name] = validateGuidInput(value);
  } else if (input.type === 'boolean') {
    result[input.name] = validateBooleanInput(value);
  } else if (input.type === 'text') {
    result[input.name] = validateTextInput(value, input.maxLength);
  }
}

function validateTableInput(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/i.test(value))
    throw new Error('Enter a table logical name.');
  return value.toLowerCase();
}

function validateGuidInput(value) {
  if (
    typeof value !== 'string' ||
    /* NOSONAR */ !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})$/i.test(
      value,
    )
  )
    throw new Error('Enter a valid record GUID.');
  return value.replace(/[{}]/g, '').toLowerCase();
}

function validateBooleanInput(value) {
  if (typeof value !== 'boolean') throw new Error('Action switches must be Boolean values.');
  return value;
}

function validateTextInput(value, maxLength) {
  // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
  if (typeof value !== 'string' || value.length > (maxLength ?? 200) || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('Enter a bounded text value without control characters.');
  return value;
}

export function modelDrivenDiagnosticUrl(value, action) {
  const url = new URL(value),
    flags = new Set([
      'DisableFormHandlers=true',
      'DisableFormHandlers=businessrule',
      'DisableFormLibraries=true',
      'themeoption=darkmode',
    ]);
  const changes = {
    'debugging:forms-monitor': ['monitor', 'true'],
    'debugging:ribbon-debugger': ['ribbondebug', 'true'],
    'debugging:perf-center': ['perf', 'true'],
    'debugging:disable-form-handlers': ['flags', 'DisableFormHandlers=true'],
    'debugging:disable-business-rules': ['flags', 'DisableFormHandlers=businessrule'],
    'debugging:disable-form-libraries': ['flags', 'DisableFormLibraries=true'],
    'debugging:enable-dark-mode': ['flags', 'themeoption=darkmode'],
  };
  if (action === 'debugging:clear-flags') {
    const retained = [...url.searchParams].filter(
      ([key, item]) =>
        !(key === 'flags' && flags.has(item)) && !(['monitor', 'ribbondebug', 'perf'].includes(key) && item === 'true'),
    );
    url.search = new URLSearchParams(retained).toString();
  } else {
    const change = changes[action];
    if (!change) throw new Error('Unknown diagnostic action.');
    if (!url.searchParams.getAll(change[0]).includes(change[1])) url.searchParams.append(...change);
  }
  return url.href;
}
