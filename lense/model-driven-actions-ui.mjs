// Browser-only developer tools. Results and transient inputs never enter inspector snapshots.
// The Actions tab of the shared Lense panel: its rows, chips, icon buttons, buttons and view switch are the kit's (.row,
// .main, .acts, .ib, .f, .btn, .btn.sec, .seg, .gh); this sheet adds only layout the kit has no rule for (inline
// cards, results, the identity bar).
export function modelDrivenActionsUi(data) {
  const host = document.getElementById('paqvilo-panel');
  if (location.origin !== data.origin || !host?.shadowRoot || host.__paqModelInspector?.token !== data.token) return;
  if (host.__paqModelActions?.token === data.token) {
    host.__paqModelActions.update(data);
    return;
  }
  host.__paqModelActions?.dispose();
  const root = host.shadowRoot,
    lifetime = new AbortController(),
    signal = lifetime.signal;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .actions-search{margin-bottom:8px}.actions-group{margin-top:8px}.actions-buttons{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0}
    .actions-tabs{margin-bottom:8px}.actions-head>.ib{margin-left:auto}
    .actions-inline{padding:0 8px 8px;border-bottom:1px solid var(--line)}
    .actions-input{display:flex;flex-direction:column;gap:3px;margin:6px 0;font-size:12px;color:var(--muted)}
    .actions-detail h3{margin:0 0 4px;font-size:13px}.actions-reason{color:var(--warn);font-size:12px}.actions-muted{color:var(--muted);font-size:12px}
    .actions-status{color:var(--link);font-size:12px}.actions-result{margin-top:6px}.actions-result:focus{outline:none}
    .actions-result h3{margin:0;font-size:13px}.actions-head{display:flex;align-items:flex-start;gap:8px}
    .actions-head>:first-child:not(.ib){flex:1;min-width:0}
    .actions-result p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}.actions-head>p{margin:5px 0}
    .actions-result-tools{display:flex;align-items:center;gap:6px;margin:6px 0}.actions-result-tools>.search{margin:0}
    .actions-table-wrap{max-height:25vh;overflow:auto}.actions-result table{border-collapse:collapse;width:100%;font-size:12px}
    .actions-result th,.actions-result td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:break-word;max-width:360px}
    .actions-result pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:28dvh;overflow:auto;font:12px/1.5 Consolas,monospace}
    .actions-users{max-height:28dvh;overflow:auto}.actions-users button{display:block;width:100%;text-align:left;margin:4px 0}
    .actions-label{width:100%;margin-bottom:6px}.actions-code{width:100%;min-height:180px;font:12px/1.5 Consolas,monospace!important;tab-size:2;resize:vertical}
    .actions-identity{padding:8px;margin-bottom:8px;background:var(--warn-bg);border-radius:var(--radius)}.actions-identity:empty{display:none}.actions-identity button{margin-left:8px}
    .actions-bar-identity{display:flex;align-items:center;gap:8px;margin:6px 10px;padding:8px;background:var(--warn-bg);border:1px solid var(--warn);border-radius:var(--radius)}
    .actions-bar-identity>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions-bar-identity>button{flex:none}
  `);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  const make = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  // A command: the kit's outlined secondary button; the one main action of a view passes 'btn' (filled).
  const button = (label, callback, cls = 'btn sec') => {
    const node = make('button', label, cls);
    node.type = 'button';
    node.addEventListener('click', callback, { signal });
    return node;
  };
  // A pressed state (filter chip or view switch button) shows as .on, as on every other tab.
  const toggle = (label, callback, pressed, cls) => {
    const node = button(label, callback, cls);
    node.classList.toggle('on', pressed);
    node.setAttribute('aria-pressed', String(pressed));
    return node;
  };
  // The panel's own icons (same shape, size and colour as on every tab).
  const icon = (name) => host.__pp?.icon?.(name) ?? '';
  // The kit's icon button (.ib): its icon, its name for assistive technology and a tooltip that adds to it.
  const iconButton = (name, label, title, callback) => {
    const node = button('', callback, 'ib');
    node.innerHTML = icon(name);
    node.setAttribute('aria-label', label);
    node.title = title;
    return node;
  };
  const panel = make('section', null, 'actions-panel');
  panel.id = 'paqvilo-actions-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Model-driven actions');
  const acting = make('div', null, 'actions-identity');
  acting.setAttribute('role', 'status');
  const actingBar = make('div', null, 'actions-bar-identity');
  actingBar.hidden = true;
  actingBar.setAttribute('role', 'status');
  root.querySelector('.wrap')?.prepend(actingBar);
  // The view switch is the kit's segmented control; the filter chips below it filter the Built-in list.
  const tabs = make('div', null, 'seg actions-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Developer tools');
  const content = make('div'),
    status = make('div', '', 'actions-status'),
    waiting = make('div', null, 'actions-buttons'),
    results = make('section', null, 'actions-result');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  results.hidden = true;
  results.tabIndex = -1;
  results.setAttribute('aria-label', 'Action results');
  panel.append(acting, tabs, content, status, waiting, results);
  let current = data,
    view = 'Actions',
    selectedAction,
    selectedUser,
    identity = { active: false },
    identityRequest,
    disposed = false,
    selectedCommand,
    actionSearch = '',
    actionFilter = 'all',
    lastResultRequest,
    // The view (Actions, Identity or Custom) whose request produced the shown status and result.
    resultView,
    unavailableOpen = false;
  // Built-in groups the user folded, by group name.
  const foldedGroups = new Set();
  const requests = new Map(),
    // Page changes this panel made and has not undone, for a session whose runner reports none.
    applied = new Set(),
    params = new Map(),
    drafts = new Map(),
    commandKey = 'paqvilo.modelActions.commands.v1',
    preferenceKey = 'paqvilo.modelActions.labels.v1';
  const readStore = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const writeStore = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      status.textContent = 'Browser storage is unavailable. Changes remain in this panel.';
      return false;
    }
  };
  const preferences = readStore(preferenceKey, {}),
    labels = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 100) : []),
    favorites = new Set(labels(preferences.favorites)),
    // Actions this person hid from the list; the Hidden filter lists them to show again.
    hidden = new Set(labels(preferences.hidden));
  let recent = labels(preferences.recent).slice(0, 12);
  const persistLabels = () =>
    writeStore(preferenceKey, { version: 1, favorites: [...favorites], hidden: [...hidden], recent });
  const validateCommands = (value) => {
    if (value?.version !== 1 || !Array.isArray(value.commands) || value.commands.length > 50)
      throw new Error('Use version 1 JSON with at most 50 commands.');
    const ids = new Set();
    return value.commands.map((item) => {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !/^[\w-]{1,100}$/.test(item.id) ||
        ids.has(item.id) ||
        typeof item.label !== 'string' ||
        !item.label.trim() ||
        item.label.length > 120 ||
        typeof item.code !== 'string' ||
        item.code.length > 65536 ||
        (item.description != null && (typeof item.description !== 'string' || item.description.length > 500))
      )
        throw new Error('Each command needs a unique ID, a label, and code up to 64 KiB.');
      ids.add(item.id);
      return { id: item.id, label: item.label.trim(), description: item.description ?? '', code: item.code };
    });
  };
  let commands;
  try {
    commands = validateCommands(readStore(commandKey, { version: 1, commands: [] }));
  } catch {
    commands = [];
  }
  const availability = (action) =>
    current.availability?.find((entry) => entry.id === action.id) ?? {
      available: false,
      reason: 'Reconnect Lense to read this action’s current context.',
    };
  const requestId = () =>
    globalThis.crypto?.randomUUID?.() ?? `action-${Date.now()}-${Math.random().toString(36).slice(2)}`; // NOSONAR: pseudo-random value for simulation, not a secret
  const busy = () => requests.size > 0;
  const remember = (label) => {
    recent = [label, ...recent.filter((value) => value !== label)].slice(0, 12);
    persistLabels();
  };
  function renderIdentity() {
    acting.replaceChildren();
    actingBar.replaceChildren();
    actingBar.hidden = !identity.active;
    if (identity.active) {
      acting.append(
        make('span', `Acting as ${identity.label || 'the selected user'} for this tab’s Dataverse requests.`),
        button('Stop', () => startIdentity(null)),
      );
    }
    if (identity.active) {
      const label = make('span', `Acting as ${identity.label || 'selected user'}`);
      label.title = label.textContent;
      actingBar.append(
        label,
        button('Stop', () => startIdentity(null)),
      );
    }
  }
  // An action that changed the page declares its undo, offered by its row's Reset; the runner reports which changes
  // are still in place, so Reset also covers a change made before this panel was drawn.
  function reversalOf(action) {
    const reversal = action.undo,
      undo = reversal && current.actions?.find((item) => item.id === reversal.id);
    if (!undo || !availability(undo).available) return undefined;
    return { undo, params: reversal.params ?? {}, title: undo.id === action.id ? reversal.label : undo.description };
  }
  const inEffect = (action) => {
    const state = host.__paqModelActionState;
    return state?.token === current.token && !state.retired
      ? Boolean(state.active?.()[action.id])
      : applied.has(action.id);
  };
  function renderResult(value) {
    results.replaceChildren();
    results.hidden = !value;
    if (!value) {
      lastResultRequest = undefined;
      return;
    }
    // The first line holds the title (or, under a Built-in row that already names the action, the message) and the
    // close icon; no line holds the close icon alone.
    const heading = make('div', null, 'actions-head'),
      close = iconButton(
        'close',
        'Close result',
        'Remove this result from the panel. Changes on the page stay.',
        closeResult,
      );
    const titled = value.title && resultView !== 'Actions',
      // A table without rows is only its message: no filter, no empty table, nothing to copy.
      table = Array.isArray(value.columns) && Array.isArray(value.rows) && value.rows.length > 0;
    if (titled) heading.append(make('h3', value.title));
    else if (value.message) heading.append(make('p', String(value.message)));
    // With no text for the first line, a table's filter row takes the close icon.
    if (heading.childElementCount || !table) {
      heading.append(close);
      results.append(heading);
    }
    if (titled && value.message) results.append(make('p', String(value.message)));
    if (table) appendResultTable(value, heading.isConnected ? null : close);
    if (value.text != null) results.append(make('pre', String(value.text)));
    appendResultCopy(value);
    appendResultLinks(value);
    appendResultUsers(value);
  }
  // Close removes the result; a Built-in result also folds its action's card, so no empty card stays, and the focus
  // goes back to that action's Run, or in another view to its first control.
  function closeResult() {
    renderResult(null);
    status.textContent = '';
    if (view === 'Actions' && selectedAction) collapseAction();
    else content.querySelector('button,input,select,textarea')?.focus();
  }
  // Cell text that breaks after underscores (logical names) rather than in the middle of a word.
  const cell = (tag, text) => {
    const node = make(tag);
    const parts = text.split(/(?<=_)/);
    parts.forEach((part, index) => {
      node.append(part);
      if (index < parts.length - 1) node.append(make('wbr'));
    });
    return node;
  };
  function appendResultTable(value, close) {
    const wrap = make('div', null, 'actions-table-wrap'),
      table = make('table'),
      header = make('tr');
    for (const label of value.columns.slice(0, 30)) {
      const th = cell('th', String(label));
      th.scope = 'col';
      header.append(th);
    }
    const thead = make('thead');
    thead.append(header);
    table.append(thead);
    const body = make('tbody');
    // hideEmpty: rows whose values (every cell after the name) are empty or [NULL] fold behind Show empty.
    const blank = (item) => item == null || item === '' || item === '[NULL]';
    let emptyRows = 0;
    for (const row of value.rows.slice(0, 200)) {
      const tr = make('tr'),
        cells = (Array.isArray(row) ? row : [row]).slice(0, 30);
      for (const item of cells) tr.append(cell('td', String(item ?? '')));
      if (value.hideEmpty === true && cells.length > 1 && cells.slice(1).every(blank)) {
        tr.dataset.empty = 'true';
        emptyRows++;
      }
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    let showEmpty = false;
    const filter = make('input');
    filter.type = 'search';
    filter.setAttribute('aria-label', 'Filter results');
    filter.placeholder = 'Filter results';
    const apply = (announce) => {
      const term = filter.value.toLocaleLowerCase();
      let count = 0;
      for (const row of body.children) {
        row.hidden =
          (!showEmpty && row.dataset.empty === 'true') || !row.textContent.toLocaleLowerCase().includes(term);
        if (!row.hidden) count++;
      }
      if (announce) status.textContent = `${count} result rows shown.`;
    };
    filter.addEventListener('input', () => apply(true), { signal });
    const tools = make('div', null, 'actions-result-tools');
    tools.append(searchBox(filter));
    if (emptyRows) {
      const empty = toggle(
        'Show empty ',
        () => {
          showEmpty = !showEmpty;
          empty.classList.toggle('on', showEmpty);
          empty.setAttribute('aria-pressed', String(showEmpty));
          apply(false);
        },
        false,
        'f',
      );
      empty.append(make('span', String(emptyRows), 'n dimn'));
      empty.title = 'Show the columns without a saved value';
      tools.append(empty);
    }
    if (close) tools.append(close);
    results.append(tools, wrap);
    apply(false);
  }
  function appendResultCopy(value) {
    const copyText =
      value.copyText ??
      (Array.isArray(value.columns) && Array.isArray(value.rows) && value.rows.length
        ? [value.columns, ...value.rows].map((row) => row.map((item) => String(item ?? '')).join('\t')).join('\n')
        : undefined);
    if (copyText == null) return;
    results.append(
      button('Copy result', async () => {
        try {
          await navigator.clipboard.writeText(String(copyText));
          status.textContent = 'Result copied.';
        } catch {
          status.textContent = 'Copy unavailable. Select the result text to copy it.';
        }
      }),
    );
  }
  function appendResultLinks(value) {
    if (!Array.isArray(value.links)) return;
    for (const item of value.links.slice(0, 200)) appendResultLink(item);
  }
  function appendResultLink(item) {
    try {
      const url = new URL(item.url, current.origin);
      if (url.origin !== current.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        return;
      const link = make('a', String(item.label || 'Open record'));
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const row = make('p');
      row.append(link);
      results.append(row);
    } catch {
      /* Untrusted result links remain inert. */
    }
  }
  function appendResultUsers(value) {
    if (!Array.isArray(value.users)) return;
    const list = make('div', null, 'actions-users');
    for (const user of value.users.slice(0, 200))
      if (typeof user.objectId === 'string' && typeof user.label === 'string')
        list.append(
          button(user.label, () => {
            selectedUser = { objectId: user.objectId, label: user.label };
            view = 'Identity';
            renderView();
          }),
        );
    results.append(list);
  }
  const OUTCOMES = { ok: '', cancelled: 'Cancelled.', unsupported: 'Not available here.' };
  function receive(id, value) {
    const request = requests.get(id);
    if (disposed || !request || location.origin !== current.origin) return;
    requests.delete(id);
    resultView = request.view;
    if (request.kind === 'identity' && identityRequest === id && value?.identity) {
      identity = { active: Boolean(value.identity.active), label: value.identity.label ?? selectedUser?.label };
      renderIdentity();
    }
    if (request.undo && value?.status === 'ok') {
      finishUndo(request, value);
      return;
    }
    if (value?.status === 'ok' && !request.undo && current.actions?.find((item) => item.id === request.actionId)?.undo)
      applied.add(request.actionId);
    const shown = value ?? { message: 'The action completed without a result.' };
    renderResult(shown.title === request.label ? { ...shown, title: undefined } : shown);
    lastResultRequest = id;
    // A completed run shows only its result; a status line names the other outcomes.
    status.textContent = Object.hasOwn(OUTCOMES, value?.status ?? '') ? OUTCOMES[value.status] : 'Failed.';
    rerender();
    showResult();
  }
  // A successful undo closes the result it reversed and turns Reset back into Run; its message stays as the status.
  function finishUndo(request, value) {
    applied.delete(request.undo);
    renderResult(null);
    status.textContent = value.message ? String(value.message) : 'Undone.';
    rerender();
    // Reset is Run again, in the same place.
    if (request.view === 'Actions') focusRun(request.undo);
  }
  // Redraws the view and keeps the focus, with its selection, in the field the user was typing in.
  function rerender() {
    const focused = root.activeElement,
      anchor =
        focused && content.contains(focused)
          ? {
              label: focused.getAttribute('aria-label'),
              name: focused.getAttribute('name'),
              start: focused.selectionStart,
              end: focused.selectionEnd,
            }
          : undefined;
    renderView();
    if (!anchor) return;
    const replacement = [...content.querySelectorAll('input,textarea,select')].find((node) =>
      anchor.label
        ? node.getAttribute('aria-label') === anchor.label
        : anchor.name && node.getAttribute('name') === anchor.name,
    );
    if (!replacement) return;
    replacement.focus({ preventScroll: true });
    if (anchor.start != null)
      try {
        replacement.setSelectionRange(anchor.start, anchor.end);
      } catch {
        /* A field type without a text selection keeps only the focus. */
      }
  }
  // The result scrolls into view in the panel, message included. Its heading takes the focus unless the user is typing
  // in a field, in the panel or on the page.
  function showResult() {
    if (panel.hidden || results.hidden) return;
    results.scrollIntoView?.({ block: 'nearest' });
    const focused = root.activeElement ?? document.activeElement;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(focused?.tagName) && !focused?.isContentEditable)
      results.focus({ preventScroll: true });
  }
  async function dispatch(kind, label, invoke, actionId, extra = {}) {
    const id = requestId();
    requests.set(id, { kind, label, actionId, view, ...extra });
    resultView = view;
    if (kind === 'identity') identityRequest = id;
    status.textContent = `Running ${label}…`;
    renderResult(null);
    renderView();
    waiting.querySelector('button')?.focus({ preventScroll: true });
    try {
      const ack = await invoke(id);
      if (ack?.accepted !== true && requests.has(id))
        receive(id, {
          status: 'unsupported',
          title: label,
          message:
            ack?.reason === 'invalid-input'
              ? 'Check the action inputs and try again.'
              : 'This tool could not start. Reconnect Lense and try again.',
        });
    } catch {
      receive(id, {
        status: 'error',
        title: label,
        message: 'This tool could not start. Reconnect Lense and try again.',
      });
    }
  }
  // A boolean input with a default (the autosave guard's) is not asked for: Run uses it and Reset is its opposite.
  const needsInput = (action) => (action.inputs ?? []).some((spec) => spec.type !== 'boolean');
  const defaults = (action) =>
    Object.fromEntries(
      (action.inputs ?? []).filter((spec) => spec.default !== undefined).map((spec) => [spec.name, spec.default]),
    );
  // undoOf: the id of the action whose page change this run reverses (its row's Reset).
  function runAction(action, given, undoOf) {
    const values = given === undefined ? { ...defaults(action), ...params.get(action.id) } : given;
    const supported = availability(action);
    if (!supported.available || busy()) return;
    // A Reset is not a choice to list under Recent.
    if (!undoOf) remember(action.label);
    return dispatch(
      'action',
      action.label,
      (id) =>
        globalThis.__paqviloModelAction?.({
          token: current.token,
          requestId: id,
          action: action.id,
          params: values,
          // Activity names a Reset by the row's action.
          ...(undoOf ? { undoOf } : {}),
        }),
      action.id,
      { undo: undoOf },
    );
  }
  function startIdentity(objectId) {
    const label = objectId ? selectedUser?.label : 'Stop acting as another user';
    return dispatch('identity', label || 'Act as selected user', (id) =>
      globalThis.__paqviloModelIdentity?.({ token: current.token, requestId: id, objectId }),
    );
  }
  // inline: the inputs under the action's own row, whose name, description and Run button (submitting this form)
  // are on the row itself.
  function actionForm(action, parent, inline = false) {
    const section = make('form', null, 'actions-detail');
    if (inline) section.id = `paqvilo-action-form-${action.id.replace(/\W/g, '-')}`;
    else section.append(make('h3', action.label), make('p', action.description));
    const values = params.get(action.id) ?? {};
    params.set(action.id, values);
    for (const spec of action.inputs ?? [])
      if (!inline || spec.type !== 'boolean') section.append(makeActionInput(spec, values));
    const support = availability(action);
    if (!inline) {
      if (!support.available)
        section.append(make('p', support.reason || 'Not available on this page.', 'actions-reason'));
      const run = button(`Run ${action.label}`, () => {}, 'btn');
      run.type = 'submit';
      run.disabled = !support.available || busy();
      section.append(run);
    }
    section.addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        if (section.reportValidity()) void runAction(action);
      },
      { signal },
    );
    parent.append(section);
  }
  function makeActionInput(spec, values) {
    const label = make('label', spec.label, 'actions-input'),
      input = make('input');
    input.name = spec.name;
    input.required = Boolean(spec.required);
    input.type = spec.type === 'boolean' ? 'checkbox' : 'text';
    if (spec.maxLength) input.maxLength = spec.maxLength;
    if (spec.type === 'table') {
      input.maxLength = 128;
      input.pattern = '[A-Za-z][A-Za-z0-9_]{0,127}';
      input.title = 'Enter a table logical name using letters, digits and underscores.';
    }
    if (spec.type === 'guid') {
      const guid = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
      input.maxLength = 38;
      input.pattern = String.raw`(?:${guid}|\{${guid}\})`;
      input.title = 'Enter a record GUID, optionally enclosed in matching braces.';
    }
    if (spec.type === 'boolean') {
      input.checked = values[spec.name] ?? spec.default ?? false;
      values[spec.name] = input.checked;
    } else {
      input.value = values[spec.name] ?? spec.default ?? '';
      if (spec.type === 'guid') input.placeholder = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
    }
    input.addEventListener(
      'input',
      () => {
        values[spec.name] = spec.type === 'boolean' ? input.checked : input.value;
      },
      { signal },
    );
    label.append(input);
    return label;
  }
  // The panel's search box: its icon and border around the input.
  function searchBox(input) {
    const box = make('label', null, 'search actions-search');
    box.innerHTML = icon('search');
    box.append(input);
    return box;
  }
  function inFilter(action) {
    if (actionFilter === 'hidden') return hidden.has(action.label);
    if (hidden.has(action.label)) return false;
    if (actionFilter === 'favorites') return favorites.has(action.label);
    if (actionFilter === 'recent') return recent.includes(action.label);
    return true;
  }
  function renderActions() {
    const search = make('input');
    search.type = 'search';
    search.placeholder = 'Find actions';
    search.setAttribute('aria-label', 'Find actions');
    search.value = actionSearch;
    const list = make('div', null, 'actions-list'),
      detail = make('div', null, 'actions-inline');
    content.append(searchBox(search));
    const controls = make('div', null, 'filters actions-toolbar'),
      filters = [
        ['All', 'all', 'Every action except the ones you hid'],
        ['Favorites', 'favorites', 'Actions you starred'],
        ['Recent', 'recent', 'Actions you ran last'],
        ['Hidden', 'hidden', 'Actions you hid; show one again with its eye button'],
      ].map(([label, value, title]) => {
        const control = toggle(
          label,
          () => {
            actionFilter = value;
            draw();
          },
          value === actionFilter,
          'f',
        );
        control.title = title;
        control.dataset.filter = value;
        controls.append(control);
        return control;
      });
    content.append(controls, list);
    // An action that only reverses another one (Clear logical names) is that action's Reset, not a row of its own.
    const undoOnly = new Set(
      (current.actions ?? []).filter((action) => action.undo && action.undo.id !== action.id).map((a) => a.undo.id),
    );
    const formId = (action) => `paqvilo-action-form-${action.id.replace(/\W/g, '-')}`;
    // The open action's inputs, status and result sit directly under its row.
    const showDetail = (action, row) => {
      detail.replaceChildren();
      if (needsInput(action)) actionForm(action, detail, true);
      detail.append(status, waiting, results);
      row.after(detail);
    };
    const select = (action, open) => {
      // Another action's result does not move under this row.
      if (!busy() && selectedAction !== action.id && resultView === 'Actions') {
        status.textContent = '';
        renderResult(null);
      }
      selectedAction = open ? action.id : undefined;
      draw();
    };
    // The panel's row: name and description in .main, Run (or Reset) and the icon buttons in .acts.
    function actionRow(action) {
      const row = make('div', null, 'row actions-item'),
        support = availability(action),
        inputs = needsInput(action),
        open = selectedAction === action.id,
        main = make(inputs ? 'button' : 'div', null, 'main actions-select'),
        name = make('div', null, 'name');
      name.append(make('span', action.label));
      main.append(
        name,
        make('div', support.available ? action.description : support.reason || 'Not available on this page.', 'sub'),
      );
      main.dataset.action = action.id;
      main.dataset.key = `${action.id}:main`;
      if (inputs) {
        main.type = 'button';
        main.setAttribute('aria-expanded', String(open));
        main.title = open ? 'Hide the inputs of this action' : 'Show the inputs of this action';
        main.addEventListener('click', () => select(action, !open), { signal });
      }
      const acts = make('div', null, 'acts');
      acts.append(runButton(action, support, inputs, open), ...rowToggles(action));
      row.append(main, acts);
      return row;
    }
    // Run turns into Reset while the page change it made is in place, and back after Reset.
    function runButton(action, support, inputs, open) {
      const reversal = inEffect(action) ? reversalOf(action) : undefined,
        verb = reversal ? 'Reset' : 'Run',
        run = button(
          verb,
          () => {
            if (reversal) {
              select(action, true);
              void runAction(reversal.undo, reversal.params, action.id);
            } else if (!inputs) {
              select(action, true);
              void runAction(action);
            } else if (!open) {
              select(action, true);
              detail.querySelector('input')?.focus();
            }
            // With the inputs open, Run submits their form, which checks them first.
          },
          'btn sec actions-run',
        );
      run.dataset.action = action.id;
      run.dataset.key = `${action.id}:run`;
      if (inputs && open && !reversal) {
        run.type = 'submit';
        run.setAttribute('form', formId(action));
      }
      run.disabled = !support.available || busy();
      run.setAttribute('aria-label', `${verb} ${action.label}`);
      if (reversal) run.title = reversal.title;
      else run.title = inputs && !open ? 'Show the inputs, then Run' : action.description;
      return run;
    }
    // The row's favorite star and hide eye.
    function rowToggles(action) {
      const starred = favorites.has(action.label),
        favorite = iconButton(
          starred ? 'starred' : 'star',
          `Favorite ${action.label}`,
          starred ? 'Remove from Favorites' : 'Add to Favorites',
          () => {
            starred ? favorites.delete(action.label) : favorites.add(action.label);
            persistLabels();
            draw();
          },
        );
      favorite.setAttribute('aria-pressed', String(starred));
      favorite.classList.toggle('on', starred);
      favorite.dataset.key = `${action.id}:favorite`;
      const isHidden = hidden.has(action.label),
        hide = iconButton(
          isHidden ? 'show' : 'hide',
          `${isHidden ? 'Show' : 'Hide'} ${action.label}`,
          isHidden ? 'Show this action in the list again' : 'Hide this action from the list',
          () => {
            isHidden ? hidden.delete(action.label) : hidden.add(action.label);
            persistLabels();
            draw();
          },
        );
      hide.dataset.key = `${action.id}:hide`;
      return [favorite, hide];
    }
    // A group the user folded stays folded while this panel lives. A group a search or the selected
    // action holds open is not the user's choice, so that opening is not remembered.
    const groupOpen = (section, key, forced) => {
      section.addEventListener(
        'toggle',
        () => {
          if (forced && section.open) return;
          if (section.open) foldedGroups.delete(key);
          else foldedGroups.add(key);
        },
        { signal },
      );
    };
    // The filter chips: the pressed one, and Hidden with its count (shown only while something is hidden).
    function drawFilters(hiddenCount) {
      // With nothing hidden any more, the Hidden filter has nothing to list: the list shows All again.
      if (actionFilter === 'hidden' && !hiddenCount) actionFilter = 'all';
      for (const control of filters) {
        const value = control.dataset.filter;
        control.setAttribute('aria-pressed', String(value === actionFilter));
        control.classList.toggle('on', value === actionFilter);
        if (value === 'hidden') {
          control.replaceChildren('Hidden ', make('span', String(hiddenCount), 'n dimn'));
          control.hidden = !hiddenCount && actionFilter !== 'hidden';
        }
      }
    }
    // A group's rows under a summary with the kit chevron, its name and its count pill.
    function groupHeading(label, count) {
      const summary = make('summary', null, 'gh');
      summary.innerHTML = icon('right');
      summary.append(make('span', label), make('span', String(count), 'n dimn'));
      return summary;
    }
    function appendRows(section, actions, rows) {
      for (const action of actions) {
        const row = actionRow(action);
        rows.set(action.id, row);
        section.append(row);
      }
    }
    // Each group folds like the groups of Inspect.
    function groupSection(group, usable, term, rows) {
      const members = usable.filter((entry) => entry.group === group),
        section = make('details', null, 'actions-group');
      const forced = Boolean(term) || members.some((action) => action.id === selectedAction);
      section.open = !foldedGroups.has(group) || forced;
      groupOpen(section, group, forced);
      section.append(groupHeading(group, members.length));
      appendRows(section, members, rows);
      return section;
    }
    function unavailableSection(unusable, term, rows) {
      const section = make('details', null, 'actions-group actions-unavailable');
      const forced = Boolean(term) || unusable.some((action) => action.id === selectedAction);
      section.open = unavailableOpen || forced;
      section.addEventListener(
        'toggle',
        () => {
          if (forced && section.open) return;
          unavailableOpen = section.open;
        },
        { signal },
      );
      section.append(groupHeading('Not available here', unusable.length));
      if (unusable.some((action) => availability(action).needsRecord))
        section.append(
          make('p', 'Open a record of this table (or any table) to use the form actions.', 'actions-muted'),
        );
      appendRows(section, unusable, rows);
      return section;
    }
    function draw() {
      // The row control that had the focus is redrawn; the focus moves to its new copy (the same action's toggle,
      // Run, star or eye), else to the search box when the row left the list.
      const focused = root.activeElement,
        focusKey = focused && list.contains(focused) ? focused.dataset.key : undefined;
      list.replaceChildren();
      const listed = (current.actions ?? []).filter((action) => !undoOnly.has(action.id)),
        hiddenCount = listed.filter((action) => hidden.has(action.label)).length;
      drawFilters(hiddenCount);
      const term = search.value.toLocaleLowerCase(),
        entries = listed.filter(
          (action) =>
            `${action.label} ${action.description} ${action.group}`.toLocaleLowerCase().includes(term) &&
            inFilter(action),
        );
      // Groups show only what the current page supports, using the same requirement checks the action runner applies;
      // the rest stays reachable, with each reason, in one collapsed group at the end.
      const usable = entries.filter((action) => availability(action).available),
        unusable = entries.filter((action) => !availability(action).available);
      const rows = new Map();
      for (const group of new Set(usable.map((action) => action.group)))
        list.append(groupSection(group, usable, term, rows));
      if (unusable.length) list.append(unavailableSection(unusable, term, rows));
      if (!entries.length) list.append(make('p', 'No matching actions.', 'actions-muted'));
      const action = current.actions?.find((entry) => entry.id === selectedAction);
      if (action && rows.has(action.id)) showDetail(action, rows.get(action.id));
      else detail.remove();
      if (focusKey && !root.activeElement?.isConnected)
        (list.querySelector(`[data-key="${CSS.escape(focusKey)}"]`) ?? search).focus({ preventScroll: true });
    }
    search.addEventListener(
      'input',
      () => {
        actionSearch = search.value;
        draw();
      },
      { signal },
    );
    draw();
  }
  function renderIdentityView() {
    content.append(
      make(
        'p',
        'Pick a user, then Start to send this tab’s Dataverse Web API requests as that user. Server permissions still apply; you stay signed in as yourself.',
        'actions-muted',
      ),
    );
    const users = current.actions?.find((action) => action.id === 'identity:users');
    if (users) actionForm(users, content);
    else content.append(make('p', 'User search is not available in this session.', 'actions-reason'));
    if (selectedUser) {
      const check = current.actions?.find((action) => action.id === 'identity:status'),
        support = check
          ? availability(check)
          : {
              available: false,
              reason: 'This app does not expose the security role privileges of the signed-in user.',
            };
      content.append(make('p', `Selected user: ${selectedUser.label}`));
      const start = button('Start acting as selected user', () => startIdentity(selectedUser.objectId), 'btn');
      start.disabled = busy() || identity.active || !support.available;
      content.append(start);
      if (!support.available)
        content.append(
          make(
            'p',
            support.reason || 'This app does not expose the security role privileges of the signed-in user.',
            'actions-reason',
          ),
        );
      if (identity.active)
        content.append(make('p', 'Stop acting as the current user before you choose another.', 'actions-muted'));
    }
    if (identity.active) content.append(button('Stop acting as another user', () => startIdentity(null)));
  }
  function renderCommands() {
    content.append(
      make(
        'p',
        'Saved in this browser for this environment. Run executes the code in this app; it can use await and Xrm.',
        'actions-muted',
      ),
    );
    const toolbar = make('div', null, 'actions-buttons'),
      chooser = make('select');
    chooser.setAttribute('aria-label', 'Saved custom commands');
    chooser.append(new Option('New command', ''));
    for (const command of commands) chooser.append(new Option(command.label, command.id));
    chooser.value = selectedCommand ?? '';
    chooser.addEventListener(
      'change',
      () => {
        selectedCommand = chooser.value || undefined;
        renderView();
      },
      { signal },
    );
    const command = commands.find((item) => item.id === selectedCommand),
      draftKey = selectedCommand ?? '_new',
      draft = drafts.get(draftKey) ?? { label: command?.label ?? '', code: command?.code ?? '' },
      form = make('form'),
      labelInput = make('input', null, 'actions-label');
    drafts.set(draftKey, draft);
    labelInput.value = draft.label;
    labelInput.required = true;
    labelInput.maxLength = 120;
    labelInput.setAttribute('aria-label', 'Command label');
    labelInput.placeholder = 'Command label';
    const code = make('textarea', null, 'actions-code');
    code.value = draft.code;
    code.maxLength = 65536;
    code.required = true;
    code.spellcheck = false;
    code.setAttribute('aria-label', 'Command JavaScript');
    labelInput.addEventListener(
      'input',
      () => {
        draft.label = labelInput.value;
      },
      { signal },
    );
    code.addEventListener(
      'input',
      () => {
        draft.code = code.value;
      },
      { signal },
    );
    // "New command" in the chooser starts a new command; no second control does the same.
    toolbar.append(chooser);
    // The commands share one row: Run (the view's main button) first, then compact secondary buttons whose
    // accessible names say what they act on.
    const compact = (label, name, title, callback, cls) => {
      const node = button(label, callback, cls);
      node.setAttribute('aria-label', name);
      node.title = title;
      return node;
    };
    const save = compact('Save', 'Save command', 'Save this command in this browser', () => {});
    save.type = 'submit';
    form.addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        try {
          const entry = {
            id: command?.id ?? requestId(),
            label: labelInput.value.trim(),
            description: command?.description ?? '',
            code: code.value,
          };
          const next = command ? commands.map((item) => (item.id === entry.id ? entry : item)) : [...commands, entry];
          commands = validateCommands({ version: 1, commands: next });
          writeStore(commandKey, { version: 1, commands });
          selectedCommand = entry.id;
          status.textContent = 'Command saved in this browser.';
          renderView();
        } catch (error) {
          status.textContent = error.message;
        }
      },
      { signal },
    );
    const actions = make('div', null, 'actions-buttons');
    // Delete asks once in place: the first click turns the button into Confirm delete, which deletes; leaving it
    // (the focus moves on) keeps the command.
    const remove = compact('Delete', 'Delete command', 'Delete this command from this browser', () => {
      if (!command) return;
      if (!remove.dataset.armed) {
        remove.dataset.armed = 'true';
        remove.textContent = 'Confirm delete';
        remove.setAttribute('aria-label', 'Confirm delete');
        status.textContent = `Select Confirm delete to remove ${command.label} from this browser.`;
        return;
      }
      // Disarmed first: the redraw removes this focused button, and its blur must not clear the status below.
      delete remove.dataset.armed;
      commands = commands.filter((item) => item.id !== command.id);
      writeStore(commandKey, { version: 1, commands });
      selectedCommand = undefined;
      status.textContent = `${command.label} deleted.`;
      renderView();
      content.querySelector('select')?.focus();
    });
    remove.disabled = !command;
    remove.addEventListener(
      'blur',
      () => {
        if (!remove.dataset.armed) return;
        delete remove.dataset.armed;
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', 'Delete command');
        status.textContent = '';
      },
      { signal },
    );
    const run = compact(
      'Run',
      'Run command',
      'Run this code in the app',
      () => {
        if (!form.reportValidity() || busy()) return;
        remember(labelInput.value.trim());
        void dispatch('command', labelInput.value.trim(), (id) =>
          host.__paqModelCommands?.token === current.token
            ? host.__paqModelCommands.run({
                id: command?.id ?? 'unsaved',
                code: code.value,
                timeoutMs: 10000,
                requestId: id,
              })
            : undefined,
        );
      },
      'btn',
    );
    run.disabled = busy();
    actions.append(run, save, remove);
    const file = make('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    file.addEventListener(
      'change',
      async () => {
        const selected = file.files?.[0];
        if (!selected) return;
        try {
          if (selected.size > 4 * 1024 * 1024) throw new Error('The import exceeds 4 MiB.');
          const imported = validateCommands(JSON.parse(await selected.text()));
          commands = imported;
          drafts.clear();
          writeStore(commandKey, { version: 1, commands });
          selectedCommand = undefined;
          status.textContent = `Imported ${commands.length} commands. Nothing was executed.`;
          renderView();
        } catch (error) {
          status.textContent = error.message || 'Invalid command JSON.';
        }
      },
      { signal },
    );
    actions.append(
      compact('Import', 'Import JSON', 'Replace the saved commands with a JSON file; nothing runs', () => file.click()),
      compact('Export', 'Export JSON', 'Download the saved commands as JSON', () => {
        const url = URL.createObjectURL(
            new Blob([JSON.stringify({ version: 1, commands }, null, 2)], { type: 'application/json' }),
          ),
          link = make('a');
        link.href = url;
        link.download = 'paqvilo-commands.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
    );
    form.append(labelInput, code, actions, file);
    content.append(toolbar, form);
  }
  function renderView() {
    // Status and results return to the panel foot; the Actions view moves them under the selected action again.
    panel.append(status, waiting, results);
    // A result belongs to the view that ran it; another view does not show it.
    const here = resultView === undefined || resultView === view;
    status.hidden = !here;
    results.hidden = !here || !results.childElementCount;
    waiting.replaceChildren();
    if ([...requests.values()].some((request) => request.kind !== 'identity'))
      waiting.append(
        button('Stop waiting', () => {
          for (const [id, request] of requests) if (request.kind !== 'identity') requests.delete(id);
          host.__paqModelActionState?.cancelPending?.();
          host.__paqModelCommands?.cancelPending?.();
          renderResult(null);
          status.textContent = 'Stopped waiting. The action may still finish in the app.';
          renderView();
        }),
      );
    tabs.replaceChildren();
    for (const [id, label] of [
      ['Actions', 'Built-in'],
      ['Identity', 'Identity'],
      ['Custom', 'Custom'],
    ]) {
      tabs.append(
        toggle(
          label,
          () => {
            view = id;
            renderView();
            [...tabs.children].find((node) => node.textContent === label)?.focus();
          },
          view === id,
          '',
        ),
      );
    }
    content.replaceChildren();
    if (view === 'Actions') renderActions();
    else if (view === 'Identity') renderIdentityView();
    else renderCommands();
    // A Built-in result shows only in the open card of its action, never loose under the list.
    if (view === 'Actions' && !results.closest('.actions-inline')) results.hidden = true;
  }
  // Esc folds the open action card and returns the focus to its row.
  function collapseAction() {
    const id = selectedAction;
    selectedAction = undefined;
    renderView();
    focusRun(id);
  }
  function focusRun(id) {
    content.querySelector(`.actions-run[data-action="${CSS.escape(id)}"]`)?.focus();
  }
  const mount = () => {
    const slot = root.querySelector('[data-panel-actions-host]');
    if (slot) {
      const wasHidden = panel.hidden;
      if (panel.parentNode !== slot) slot.append(panel);
      panel.hidden = false;
      if (wasHidden) renderView();
    } else panel.hidden = true;
    if (!actingBar.isConnected) root.querySelector('.wrap')?.prepend(actingBar);
  };
  host.addEventListener(
    'paqvilo-panel-render',
    (event) => {
      if (event.detail?.token === data.token) mount();
    },
    { signal },
  );
  // Esc folds the open action; with none open it goes on to the panel, which closes. It never switches the tab.
  panel.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || view !== 'Actions' || !content.querySelector('.actions-inline')) return;
      event.preventDefault();
      event.stopPropagation();
      collapseAction();
    },
    { signal },
  );
  host.__paqModelActions = {
    token: data.token,
    receive,
    followup(id, value) {
      if (disposed || !lastResultRequest || id !== lastResultRequest || location.origin !== current.origin) return;
      renderResult(value);
      status.textContent = value?.status === 'ok' ? '' : 'The app reported an error.';
      showResult();
    },
    update(next) {
      current = next;
      if (!panel.hidden) rerender();
    },
    contextChanged() {
      // The status says what was cleared only when there was something: a result, a pending run, typed inputs or a
      // picked user. The first app context of a page clears nothing.
      const pending = [...requests.values()].some((request) => request.kind !== 'identity'),
        typed = [...params].some(([id, values]) => {
          const specs = current.actions?.find((action) => action.id === id)?.inputs ?? [];
          return specs.some(
            (spec) =>
              values[spec.name] !== undefined &&
              values[spec.name] !== (spec.default ?? (spec.type === 'boolean' ? false : '')),
          );
        }),
        cleared = pending || typed || results.childElementCount > 0 || Boolean(selectedUser);
      host.__paqModelCommands?.cancelPending?.();
      // Nothing to clear: the panel stays as it is, open card and focus included (the first context of a page often
      // arrives while the user is already in the panel).
      if (!cleared) return;
      for (const [id, request] of requests) if (request.kind !== 'identity') requests.delete(id);
      params.clear();
      selectedUser = undefined;
      selectedAction = undefined;
      renderResult(null);
      status.textContent = 'The page changed, so results and action inputs were cleared.';
      if (panel.hidden) return;
      const focused = panel.contains(root.activeElement);
      renderView();
      // The redraw removed the focused control; the focus stays in the panel, on the view's first control.
      if (focused && !panel.contains(root.activeElement))
        content.querySelector('input[type=search],button,input,select,textarea')?.focus({ preventScroll: true });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      requests.clear();
      params.clear();
      drafts.clear();
      selectedUser = undefined;
      lastResultRequest = undefined;
      host.__paqModelActionState?.dispose?.();
      host.__paqModelCommands?.dispose?.();
      panel.remove();
      actingBar.remove();
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((item) => item !== sheet);
      if (host.__paqModelActions?.token === data.token) delete host.__paqModelActions;
    },
  };
  renderView();
  mount();
}
