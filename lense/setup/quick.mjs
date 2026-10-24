// Quick setup (/_setup/, default view): set up and run a project in plain language, without knowing the configuration
// format. Pure string builders and edit builders; app.mjs owns state, requests and events. Every choice saves through
// the same validated configuration operations as All settings, and every value stays editable there.

// What a project runs, chosen together. The runtime kind follows from the choice (kindFor); the other parts are the
// runtime's own switches: dataverse.enabled, modelDriven.enabled and canvas.enabled.
export const PARTS = Object.freeze({
  website: { title: 'Power Pages website', text: 'The website your visitors use, built from your website export.' },
  modelDriven: {
    title: 'Model-driven apps',
    text: 'The apps staff use to work with records, built from your exported Solutions.',
  },
  canvas: {
    title: 'Canvas apps',
    text: 'Apps made in Power Apps Studio, from your exported Solutions. Their formulas and data run so you can check them; their screens are not drawn.',
  },
  api: {
    title: 'Dataverse Web API',
    text: 'A local Dataverse API at its own address, for scripts, integrations and automated tests.',
  },
});
export const LEVELS = Object.freeze({
  'dry-run': [
    'Keep changes only while it runs',
    'Records you add or edit reset when the preview restarts. Your project files never change.',
  ],
  simulation: [
    'Save changes into the project data files',
    'Records you add or edit are written to the sample data files of your project.',
  ],
  deep: [
    'Save data and table changes',
    'Also writes table and column changes into the declared data files. For advanced use.',
  ],
});
// Findings in plain words and the step that fixes them; other findings link to All settings.
const PLAIN = Object.freeze({
  'missing-source': ['The website export folder was not found.', 'files'],
  'source-layout': ['The chosen folder does not hold a website export.', 'files'],
  'missing-solution': ['A Solution folder was not found.', 'files'],
  'missing-project': ['A linked project file was not found.', null],
  'missing-pack': ['The sample data module was not found.', 'data'],
  'duplicate-port': ['Two targets use the same port; change one in All settings.', null],
  'placeholder-origin': [
    'The live site address is still the example placeholder. Only live previews (Lense) use it.',
    null,
  ],
  'no-sites': ['Nothing is configured to run yet.', 'kind'],
  'missing-config': ['There is no project configuration yet.', 'kind'],
});
const LOCAL = 'http://127.0.0.1:';
export const normalPath = (value) =>
  String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase() || '.';
const samePath = (a, b) => normalPath(a) === normalPath(b);
// A path inside the project folder, shown from that folder.
const shortPath = (directory, file) => {
  const base = String(directory ?? '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, ''),
    value = String(file ?? '').replace(/\\/g, '/');
  return base && value.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? `.${value.slice(base.length)}` : value;
};
export const slugName = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'my-project';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The runtime kind of a choice of parts: a website needs the Power Pages host; apps without one the standalone app host. */
export const kindFor = (parts) =>
  parts.website ? 'power-pages' : parts.modelDriven || parts.canvas ? 'model-driven' : 'dataverse-api';
const partsOf = (kind, settings) => ({
  website: kind === 'power-pages',
  modelDriven: kind !== 'dataverse-api' && settings.modelDriven?.enabled !== false,
  canvas: kind !== 'dataverse-api' && settings.canvas?.enabled !== false,
  api: kind === 'dataverse-api' || settings.dataverse?.enabled === true,
});
const needsSolutions = (parts) => parts.modelDriven || parts.canvas;

/** The values Quick setup shows for one target: a catalogue site, or the project file of a standalone project. */
export function targetOf(state, siteId) {
  if (state.kind === 'project') {
    const settings = state.settings ?? {},
      portal = state.sites?.[0],
      kind = settings.runtime?.kind ?? 'power-pages';
    const switches = {
      modelDriven: settings.modelDriven,
      canvas: settings.mirage?.canvas ?? settings.canvas,
      dataverse: settings.dataverse,
    };
    return {
      id: portal?.id ?? null,
      project: true,
      kind,
      parts: partsOf(kind, switches),
      switches,
      source: portal?.source ?? null,
      sourceStatus: portal?.sourceStatus ?? null,
      solutionRoots: (settings.solutions ?? []).map((item) => item.path),
      solutions: state.solutions ?? [],
      packs: state.packs ?? [],
      preset: null,
      presetMode: null,
      level: settings.simulation?.level ?? null,
      port: null,
    };
  }
  const site = (state.sites ?? []).find((item) => item.id === siteId) ?? (state.sites ?? [])[0];
  if (!site) return null;
  const mirage = site.mirage ?? {},
    effective = site.effectiveMirage ?? mirage,
    kind = site.runtime?.kind ?? 'power-pages';
  const switches = { modelDriven: effective.modelDriven, canvas: effective.canvas, dataverse: effective.dataverse };
  return {
    id: site.id,
    project: false,
    kind,
    parts: partsOf(kind, switches),
    switches,
    source: site.source,
    sourceStatus: site.sourceStatus,
    solutionRoots: mirage.solutionRoots ?? [],
    solutions: site.solutions ?? [],
    packs: site.packs ?? [],
    preset: mirage.preset ?? null,
    presetMode: mirage.presetMode ?? null,
    level: effective.simulation?.level ?? null,
    port: mirage.port ?? null,
    environments: site.environments ?? {},
  };
}

/** Quick steps with their state: done, current (the first open one) or todo. */
export function quickSteps(state, target, session) {
  const created = state.layers?.shared?.exists === true;
  const filesReady =
    Boolean(target) &&
    (!target.parts.website || Boolean(target.sourceStatus?.format)) &&
    target.solutions.every((item) => item.exists) &&
    (!needsSolutions(target.parts) || target.solutionRoots.length > 0);
  const running = Boolean(session?.ready) || state.runtime?.product === 'Lense';
  const steps = [
    { id: 'kind', title: created ? 'What you want to run' : 'Create your project', done: created && Boolean(target) },
    { id: 'files', title: 'Your exported files', done: created && filesReady },
    {
      id: 'data',
      title: 'Data',
      done:
        created &&
        Boolean(target) &&
        target.packs.every((item) => item.exists) &&
        (!target.packs.length || Boolean(target.preset)),
      optional: true,
    },
    { id: 'run', title: 'Run it', done: running },
    { id: 'check', title: 'Check', done: running && !(state.findings ?? []).length },
  ];
  const current = steps.find((step) => !step.done && !step.optional) ?? null;
  return steps.map((step) => ({ ...step, status: step.done ? 'done' : step === current ? 'current' : 'todo' }));
}

const linkOf = (session, key, fallback) => {
  // A link the preview reports wins, also when it is null (a surface switched off).
  const value = session?.links && Object.hasOwn(session.links, key) ? session.links[key] : fallback;
  if (!value || !session?.url) return null;
  try {
    return new URL(value, session.url).href;
  } catch {
    return null;
  }
};

/** The whole Quick setup view. `checking` is true until the first preview status arrived. */
export function quickView(ctx) {
  const { state, esc, target, session, quick, editing } = ctx;
  const steps = quickSteps(state, target, session);
  const created = state.layers?.shared?.exists === true;
  const sites = state.kind === 'catalogue' ? (state.sites ?? []) : [];
  const picker =
    sites.length > 1
      ? `<label class="quick-target">Target <select id="quick-site" class="compact-select">${sites.map((site) => `<option value="${esc(site.id)}" ${site.id === target?.id ? 'selected' : ''}>${esc(site.id)}</option>`).join('')}</select></label>`
      : '';
  const body = {
    kind: () => kindStep(ctx, created),
    files: () => filesStep(ctx),
    data: () => dataStep(ctx),
    run: () => runStep(ctx),
    check: () => checkStep(ctx),
  };
  const head = `<div class="quick-head"><div><h2>Set up and run your project</h2><p class="muted">Paqvilo runs a copy of your Power Platform project on this computer, from files you exported. It never changes your live environment. Each answer below is saved straight away, and you can change it later.</p></div>${picker}</div>`;
  if (!quick && created) return `${head}<p class="muted">Looking for your project files…</p>`;
  return `${head}<ol class="quick-steps">${steps
    .map((step, index) => {
      const open =
        editing === step.id || (editing == null && step.status === 'current') || ['run', 'check'].includes(step.id);
      const summary = summaryOf(ctx, step);
      const locked = !created && step.id !== 'kind';
      const change =
        step.done && !open && ['kind', 'files', 'data'].includes(step.id)
          ? `<button type="button" class="button quiet small" data-quick-edit="${step.id}" aria-label="Change ${esc(step.title.toLowerCase())}">Change</button>`
          : '';
      return (
        `<li class="quick-step is-${step.status}${locked ? ' is-locked' : ''}" id="quick-${step.id}"><div class="quick-step-head"><span class="quick-num" aria-hidden="true">${step.done ? '✓' : index + 1}</span>` +
        `<div class="quick-title"><h3>${esc(step.title)}${step.optional ? ' <span class="muted small">(optional)</span>' : ''}</h3>${summary && !(open && ['kind', 'files', 'data'].includes(step.id)) ? `<p class="quick-summary">${summary}</p>` : ''}</div>` +
        `<span class="ui-sr-only">${step.done ? 'done' : step.status === 'current' ? 'next step' : 'to do'}</span>${change}</div>` +
        (open && !locked
          ? `<div class="quick-step-body">${body[step.id]()}</div>`
          : locked
            ? '<p class="quick-locked muted small">Available after you create the project.</p>'
            : '') +
        '</li>'
      );
    })
    .join('')}</ol>`;
}

const partsText = (parts) =>
  Object.entries(PARTS)
    .filter(([key]) => parts[key])
    .map(([, item]) => item.title)
    .join(', ');
function summaryOf({ state, esc, target, session, operation, checking, presets = [] }, step) {
  if (!target) return '';
  if (step.id === 'kind')
    return (
      esc(partsText(target.parts) || 'Nothing chosen') +
      (state.kind === 'catalogue' ? ` · <span class="muted">project ${esc(target.id)}</span>` : '')
    );
  if (step.id === 'files') {
    const website = target.parts.website
      ? target.sourceStatus?.format
        ? `Website: <code>${esc(target.source)}</code>`
        : '<span class="quick-warn">Website export not chosen yet</span>'
      : '';
    const apps = target.solutionRoots.length
      ? `Solutions: ${target.solutionRoots.map((item) => `<code>${esc(item)}</code>`).join(', ')}`
      : needsSolutions(target.parts)
        ? '<span class="quick-warn">No Solution chosen yet</span>'
        : 'No Solutions';
    return [website, apps].filter(Boolean).join(' · ');
  }
  if (step.id === 'data') {
    const data = target.packs.length
      ? target.preset
        ? `Starts with: ${esc(presets.find(([id]) => id === target.preset)?.[1] ?? target.preset)}`
        : 'Sample data module added; choose its starting data once the preview runs'
      : 'No sample data';
    return `${data} · ${esc(LEVELS[target.level]?.[0] ?? 'Changes are kept in a local state file')}`;
  }
  if (step.id === 'run' && state.runtime?.product === 'Lense')
    return `Lense preview running${state.runtime.site ? ` · ${esc(state.runtime.site)}` : ''}`;
  if (step.id === 'run')
    return checking
      ? 'Checking…'
      : operation?.state === 'running'
        ? 'Working…'
        : session?.ready
          ? `Running at <code>${esc(session.url)}</code>`
          : session
            ? 'Starting…'
            : 'Not running';
  if (step.id === 'check')
    return (state.findings ?? []).length
      ? `${plural(state.findings.length, 'thing')} to fix`
      : session?.ready
        ? 'Running'
        : 'Setup looks complete';
  return '';
}

const choiceBox = (esc, name, value, checked, title, text, type = 'checkbox') =>
  `<label class="quick-choice"><input type="${type}" name="${esc(name)}" value="${esc(value)}" ${checked ? 'checked' : ''}><span><strong>${esc(title)}</strong><span class="muted">${esc(text)}</span></span></label>`;
export function partsFieldset(esc, parts, found = {}) {
  return `<fieldset class="quick-choices"><legend>What do you want to run? <span class="muted">Choose one or more.</span></legend>${Object.entries(
    PARTS,
  )
    .map(([key, item]) =>
      choiceBox(esc, 'part', key, parts[key], item.title, `${item.text}${found[key] ? ` ${found[key]}` : ''}`),
    )
    .join('')}</fieldset>`;
}
/** With several website exports found, each is a project of its own: the person ticks which ones to set up. */
export function websitesFieldset(esc, portals = []) {
  if (portals.length < 2) return '';
  return `<fieldset class="quick-group"><legend>Websites to set up <span class="muted">Each one becomes a project of its own, with its own local address.</span></legend>${portals.map((item) => `<label class="quick-choice compact"><input type="checkbox" name="website-pick" value="${esc(item.value)}" checked><span><strong>${esc(item.name ?? item.path)}</strong><span class="muted"><code>${esc(item.path)}</code>${item.profiles?.length ? ` · ${item.profiles.length} deployment profile(s)` : ''}</span></span></label>`).join('')}</fieldset>`;
}
/** The websites ticked in a create form, or null (all found) when the form offered no choice. */
export const chosenWebsites = (data, candidates) =>
  (candidates?.portals ?? []).length > 1 ? data.getAll('website-pick').map(String) : null;
// Why a part is ticked: what was found for it.
const foundText = (found) => ({
  website: found.portals.length ? `Found: ${found.portals.map((item) => item.name ?? item.path).join(', ')}.` : '',
  modelDriven: found.solutions.some((item) => item.apps?.modelDriven) ? 'Found in your Solutions.' : '',
  canvas: found.solutions.some((item) => item.apps?.canvas) ? 'Found in your Solutions.' : '',
});
// Default choice for a new project: what the found exports can run (a Solution's AppModules and CanvasApps folders).
export const foundParts = (found) => {
  const parts = {
    website: found.portals.length > 0,
    modelDriven: found.solutions.some((item) => item.apps?.modelDriven),
    canvas: found.solutions.some((item) => item.apps?.canvas),
    api: false,
  };
  if (!parts.website && !parts.modelDriven && !parts.canvas)
    parts[found.solutions.length ? 'modelDriven' : 'website'] = true;
  return parts;
};
function kindStep({ state, esc, target, quick }, created) {
  if (created)
    return (
      `<form data-form="quick-kind" class="quick-form">${partsFieldset(esc, target?.parts ?? {})}` +
      '<div class="toolbar"><button type="submit" class="button primary">Save</button><button type="button" class="button quiet" data-quick-edit="">Cancel</button></div></form>'
    );
  const found = quick?.candidates ?? { portals: [], solutions: [], packs: [] };
  const seen = [
    found.portals.length && plural(found.portals.length, 'website export'),
    found.solutions.length && plural(found.solutions.length, 'Solution'),
    found.packs.length && 'a sample data module',
  ].filter(Boolean);
  const parts = foundParts(found);
  const folder = String(state.directory ?? '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  return (
    `<form data-form="quick-create" class="quick-form"><p>${seen.length ? `In this project folder we found ${esc(seen.join(', '))}. We ticked what they contain and will use those folders; you can check or change them in step 2.` : 'No exported files were found in this project folder yet. Choose what you want to run; in the next step you point to your exported files.'}</p>` +
    partsFieldset(esc, parts, foundText(found)) +
    websitesFieldset(esc, found.portals) +
    `<label class="quick-field">Project name <span class="muted small">The name of this setup in its settings file and in the simulator. Keep the suggestion if unsure: letters, numbers, - and _.</span><input name="name" value="${esc(slugName(folder))}" required pattern="[A-Za-z0-9][A-Za-z0-9_\\-]*"></label>` +
    `<div class="toolbar"><button type="submit" class="button primary">Create project</button></div><p class="muted small">Creates the settings file <code>${esc(
      String(state.layers?.shared?.file ?? '')
        .split(/[\\/]/)
        .pop() || 'paqvilo.config.yml',
    )}</code> in <code>${esc(state.directory ?? '')}</code>.</p></form>`
  );
}

// A chosen folder: its path, a hidden input the form submits, and a remove button.
const folderRow = (esc, name, value, label = value) =>
  `<li class="quick-folder"><input type="hidden" name="${esc(name)}" value="${esc(value)}"><code>${esc(label)}</code><button type="button" class="button quiet small" data-folder-remove aria-label="Remove ${esc(label)}">Remove</button></li>`;
export const folderRowHtml = folderRow;
function filesStep({ esc, target, quick }) {
  const found = quick?.candidates ?? { portals: [], solutions: [], packs: [] };
  if (target.project)
    return '<p class="muted">Change the folders of a standalone project file in <a href="#runtime-configuration" data-quick-all>All settings → Runtime configuration</a>.</p>';
  const website = !target.parts.website
    ? ''
    : (() => {
        const known = found.portals.some((item) => samePath(item.value, target.source));
        const other = known ? '' : (target.source ?? '');
        const options = found.portals
          .map(
            (item) =>
              `<label class="quick-choice compact"><input type="radio" name="website" value="${esc(item.value)}" ${samePath(item.value, target.source) ? 'checked' : ''}><span><strong>${esc(item.name ?? item.path)}</strong><span class="muted"><code>${esc(item.path)}</code> · ${esc(item.kind)}</span></span></label>`,
          )
          .join('');
        return (
          `<fieldset class="quick-group"><legend>Website export</legend><p class="muted small">The folder your website was downloaded into from Power Pages (with the Power Platform CLI: <code>pac pages download</code>).</p>${options || '<p class="quick-warn">No website export was found in this project folder. Choose its folder below.</p>'}` +
          `<label class="quick-choice compact"><input type="radio" name="website" value="" ${known ? '' : 'checked'}><span><strong>${options ? 'Another folder' : 'Website export folder'}</strong><span class="quick-picked" data-picked="website">${other ? `<code>${esc(other)}</code>` : '<span class="muted">No folder chosen</span>'}</span>` +
          `<input type="hidden" name="website-other" value="${esc(other)}"><button type="button" class="button small" data-pick-folder="website">Choose folder…</button></span></label></fieldset>`
        );
      })();
  const chosen = new Set(target.solutionRoots.map(normalPath));
  const solutions = found.solutions
    .map(
      (item) =>
        `<label class="quick-choice compact"><input type="checkbox" name="solution" value="${esc(item.value)}" ${chosen.has(normalPath(item.value)) ? 'checked' : ''}><span><strong>${esc(item.name ?? item.path)}</strong><span class="muted"><code>${esc(item.path)}</code></span></span></label>`,
    )
    .join('');
  const others = target.solutionRoots.filter((root) => !found.solutions.some((item) => samePath(item.value, root)));
  const why = needsSolutions(target.parts)
    ? 'Needed for your apps: your tables, forms, views and apps come from here.'
    : 'Optional: add one to include your own tables, forms and apps.';
  return (
    `<form data-form="quick-files" class="quick-form">${website}<fieldset class="quick-group"><legend>Solutions</legend><p class="muted small">${why} A Solution folder is a Solution exported from your environment and unpacked (with <code>pac solution unpack</code>).</p>` +
    `${solutions || `<p class="${needsSolutions(target.parts) ? 'quick-warn' : 'muted'}">No exported Solution was found in this project folder.</p>`}` +
    `<ul class="quick-folders" data-folder-list="solution">${others.map((root) => folderRow(esc, 'solution', root)).join('')}</ul><button type="button" class="button small" data-pick-folder="solution">Add a Solution folder…</button></fieldset>` +
    '<div class="toolbar"><button type="submit" class="button primary">Save</button><button type="button" class="button quiet" data-quick-edit="">Cancel</button></div></form>'
  );
}

// Data sets of the project's own modules first, then the built-in examples; with none chosen, the project's first is selected.
export function presetGroups(esc, presets, chosen, suggest = true) {
  if (suggest) chosen ||= presets.find((item) => item[2])?.[0];
  const option = ([id, name]) =>
    `<option value="${esc(id)}" ${id === chosen ? 'selected' : ''}>${esc(name === id ? id : `${name} (${id})`)}</option>`;
  const own = [...new Set(presets.filter((item) => item[2]).map((item) => item[2]))];
  return (
    own
      .map(
        (pack) =>
          `<optgroup label="${esc(`From your project: ${pack}`)}">${presets
            .filter((item) => item[2] === pack)
            .map(option)
            .join('')}</optgroup>`,
      )
      .join('') +
    (presets.some((item) => !item[2])
      ? `<optgroup label="Built-in examples (general test setups, not your project's data)">${presets
          .filter((item) => !item[2])
          .map(option)
          .join('')}</optgroup>`
      : '')
  );
}
function dataStep({ state, esc, target, quick, presets }) {
  const found = quick?.candidates?.packs ?? [];
  const intro =
    '<p class="muted small">Your tables start empty unless the project has a sample data module: a file in your project that fills tables with example records.</p>';
  const packs = target.packs.length
    ? `<p>Sample data module: ${target.packs.map((item) => `<code>${esc(shortPath(state.directory, item.module))}</code>${item.exists ? '' : ' <span class="quick-warn">(file not found)</span>'}`).join(', ')}</p>` +
      (presets.length
        ? `<label class="quick-field">Start with <span class="muted small">The example records your tables start with. A change takes effect when you restart the preview.</span><select name="preset"><option value="">No starting data</option>${presetGroups(esc, presets, target.preset)}${target.preset && !presets.some(([id]) => id === target.preset) ? `<option value="${esc(target.preset)}" selected>${esc(target.preset)}</option>` : ''}</select></label>`
        : target.preset
          ? `<p>Starts with the data set <code>${esc(target.preset)}</code>. Start the preview to choose another.</p>`
          : '<p class="muted">The data sets this module offers are listed here once the preview runs (step 4). Until then the preview starts with empty tables.</p>')
    : found.length
      ? `<fieldset class="quick-group"><legend>Sample data</legend>${found.map((item) => `<label class="quick-choice compact"><input type="checkbox" name="pack" value="${esc(item.value)}"><span><strong>Use the data module in <code>${esc(item.path)}</code></strong><span class="muted">Only use a module you trust: its code runs when the preview starts.</span></span></label>`).join('')}</fieldset>`
      : '<p class="muted">No sample data module was found. The preview starts with empty tables; you can add records while it runs.</p>';
  const level = target.level ?? 'dry-run';
  const levels = Object.entries(LEVELS)
    .filter(([value]) => value !== 'deep' || level === 'deep')
    .map(([value, [title, text]]) =>
      choiceBox(esc, 'level', value, value === level, title, text, 'radio').replace(
        'class="quick-choice"',
        'class="quick-choice compact"',
      ),
    )
    .join('');
  return (
    `<form data-form="quick-data" class="quick-form">${intro}${packs}<fieldset class="quick-group"><legend>When you add or change records in the preview</legend>${levels}</fieldset>` +
    '<div class="toolbar"><button type="submit" class="button primary">Save</button><button type="button" class="button quiet" data-quick-edit="">Cancel</button></div></form>'
  );
}

// What each Open button shows.
const OPENS = Object.freeze({
  website: [
    'Open website',
    'Your Power Pages site. You arrive as an anonymous visitor; use Sign in on the site to pick a test person.',
  ],
  apps: ['Open apps', 'Model-driven apps as staff see them.'],
  canvas: ['Open canvas apps', 'Your canvas apps.'],
  simulator: ['Open simulator', 'Sign in as test users, see and reset records, and check what is running.'],
});
export function runStep({
  state,
  esc,
  target,
  session,
  operation,
  restartHint,
  previewError,
  checking,
  presets,
  apps = [],
}) {
  if (!target) return '<p class="muted">Create your project first.</p>';
  // A Lense preview overlays your sources on a live portal in its own browser; setup does not start or stop it.
  if (state.runtime?.product === 'Lense')
    return (
      `<p>Lense preview running${state.runtime.site ? ` · ${esc(state.runtime.site)}` : ''}: your local sources are shown on the live portal in the Lense browser window.</p>` +
      `${state.runtime.restartRequired === true ? '<p class="quick-warn">You changed settings. Restart Lense to use them.</p>' : ''}${state.runtime.restartCommand ? `<p class="muted small">To restart it, stop it in its terminal (Ctrl+C) and run <code>${esc(state.runtime.restartCommand)}</code>.</p>` : ''}`
    );
  if (checking)
    return '<p class="quick-busy" role="status"><span class="quick-spinner" aria-hidden="true"></span>Checking whether your project is running…</p>';
  if (operation?.state === 'running')
    return `<p class="quick-busy" role="status"><span class="quick-spinner" aria-hidden="true"></span>${esc(operation.step === 'stop' ? 'Stopping the preview…' : 'Starting the preview… this can take a minute.')}</p>`;
  // A failed start shows its reason without the startup log lines; the full message stays one click away.
  const reason = String(operation?.message ?? '')
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(/See startup log:\s*\S+/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const failed =
    operation?.state === 'failed' && operation.site === (target.project ? null : target.id)
      ? `<div class="quick-error" role="alert"><p>The preview could not ${operation.step === 'stop' ? 'stop' : 'start'}. ${esc(reason)}</p>${reason !== operation.message ? `<details><summary>Technical details</summary><pre>${esc(operation.message)}</pre></details>` : ''}</div>`
      : '';
  const error = previewError ? kitNotice(esc, previewError) : '';
  if (!session)
    return `${failed}${error}<p>Start runs your project on this computer, at an address only you can open. It never changes your live environment.</p><div class="toolbar"><button type="button" class="button primary" data-preview="start">Start preview</button></div>`;
  const parts = target.parts;
  // Each model-driven app of the project opens by itself; without a list yet, the app host opens.
  const appLinks =
    parts.modelDriven && linkOf(session, 'modelDriven', '/main.aspx')
      ? apps.length
        ? apps.map(([id, name]) => [
            `app:${name || id}`,
            `${linkOf(session, 'modelDriven', '/main.aspx')}?appid=${encodeURIComponent(id)}`,
          ])
        : [['apps', linkOf(session, 'modelDriven', '/main.aspx')]]
      : [];
  const opens = [
    parts.website && ['website', linkOf(session, 'powerPages', '/')],
    ...appLinks,
    parts.canvas && ['canvas', linkOf(session, 'canvas', '/_apps/canvas/')],
    ['simulator', linkOf(session, 'administration', '/_sim/')],
  ].filter((item) => item && item[1]);
  const restart = restartHint || state.runtime?.restartRequired === true;
  const text = (key) =>
    key.startsWith('app:')
      ? [`Open ${key.slice(4)}`, 'A model-driven app of your project, as staff see it.']
      : OPENS[key];
  const controls = session.owned
    ? `<div class="toolbar"><button type="button" class="button${restart ? ' primary' : ''}" data-preview="restart">Restart</button><button type="button" class="button quiet" data-preview="stop">Stop</button></div>`
    : `<p class="muted small">This preview was started from a terminal: stop it there (Ctrl+C)${state.runtime?.restartCommand ? ` and start it again with <code>${esc(state.runtime.restartCommand)}</code>` : ''}.</p>`;
  return (
    `${failed}${error}${restart ? '<p class="quick-warn">You changed settings. Restart the preview to use them.</p>' : ''}` +
    `<p>${session.ready ? `Your preview is running on this computer at <code>${esc(session.url)}</code>.` : 'Your preview is starting…'}</p>` +
    (session.ready && target.packs.length && !target.preset && presets.some((item) => item[2])
      ? `<p class="quick-hint">Your sample data module offers ${plural(presets.filter((item) => item[2]).length, 'data set')}. <button type="button" class="button small" data-quick-edit="data">Choose starting data</button></p>`
      : '') +
    (parts.api && session.links?.dataverseApi
      ? `<p>Dataverse Web API for your scripts and tests: <code>${esc(new URL('/api/data/v9.2/', session.links.dataverseApi).href)}</code> <span class="muted small">It answers programs that send a sign-in token, as the real API does, so a browser shows an empty page. Test users and app secrets are under Organization identity &amp; API in the <a href="${esc(linkOf(session, 'administration', '/_sim/'))}" target="_blank" rel="noopener">simulator</a>.</span></p>`
      : '') +
    `<ul class="quick-opens">${opens.map(([key, href], index) => `<li><a class="button${index === 0 && !restart ? ' primary' : ''}" href="${esc(href)}" target="_blank" rel="noopener">${esc(text(key)[0])} ↗</a><span class="muted small">${esc(text(key)[1])}</span></li>`).join('')}</ul>${controls}`
  );
}
const kitNotice = (esc, text) => `<p class="quick-error" role="alert">${esc(text)}</p>`;

export function checkStep({ state, esc, session, dashboard, productName, mapHtml, mapOpen }) {
  const findings = (state.findings ?? []).map((item) => {
    const [text, step] = PLAIN[item.code] ?? [item.message, null];
    return `<li><span>${esc(text)}</span>${step ? `<button type="button" class="button quiet small" data-quick-edit="${step}">Fix</button>` : `<a href="${esc(item.section ?? '#overview')}" data-quick-all>Fix in All settings</a>`}</li>`;
  });
  let health;
  if (session?.ready && dashboard?.nodes) {
    const nodes = dashboard.nodes,
      by = (status) => nodes.filter((node) => node.status === status);
    const bad = [...by('missing'), ...by('error')],
      ready = nodes.filter((node) => ['ready', 'listening'].includes(node.status)).length,
      stand = by('placeholder').length;
    health =
      `<p>${bad.length ? 'Your preview runs, with things to look at.' : 'Your preview runs and everything it needs answered.'} <span class="muted">${ready} parts ready${stand ? `, ${stand} run as simplified local stand-ins for cloud services (fine for trying things out)` : ''}.</span></p>` +
      (bad.length
        ? `<ul class="quick-list">${bad.map((node) => `<li><span><strong>${esc(productName(node))}</strong> ${String(node.id).startsWith('external:') ? 'is an outside service you start yourself; it is only needed if your project uses it.' : 'is not available.'}</span></li>`).join('')}</ul>`
        : '');
  } else if (session?.ready) health = '<p class="muted">Reading the running preview…</p>';
  else
    health = `<p class="muted">${findings.length ? 'Fix these, then start the preview.' : 'Your setup looks complete. Start the preview to check it live.'}</p>`;
  return (
    `${findings.length ? `<ul class="quick-list">${findings.join('')}</ul>` : ''}${health}` +
    (mapHtml
      ? `<details class="disclosure quick-map" data-section-key="quick-map"${mapOpen ? ' open' : ''}><summary>See how everything connects</summary>${mapHtml}</details>`
      : '')
  );
}

// The runtime switches of a choice of parts; a switch the runtime has on by default is only written to turn it off.
export const switchesFor = (parts) => {
  const kind = kindFor(parts);
  return {
    ...(parts.api ? { dataverse: { enabled: true } } : {}),
    ...(!parts.modelDriven && kind !== 'dataverse-api' ? { modelDriven: { enabled: false } } : {}),
    ...(!parts.canvas && kind !== 'dataverse-api' ? { canvas: { enabled: false } } : {}),
  };
};
// Deployment profiles found in a website export, registered by name with no default, so none applies until one is chosen.
const profilesFor = (portal) =>
  portal?.profiles?.length
    ? {
        deploymentProfiles: {
          profiles: Object.fromEntries(portal.profiles.map((item) => [item.name, { pages: { source: item.file } }])),
        },
      }
    : {};
/** Project names for the chosen websites: one website takes `name`; several are each named after their website or folder. */
export function websiteNames(name, portals) {
  const used = new Set(),
    own = (portal) =>
      slugName(
        portal?.name ??
          String(portal?.value ?? '')
            .split('/')
            .pop(),
      );
  return portals.map((portal) => {
    const base = portals.length > 1 ? own(portal) : name;
    let id = base;
    for (let counter = 2; used.has(id); counter++) id = `${base}-${counter}`;
    used.add(id);
    return id;
  });
}
/**
 * The configuration document Quick setup and All settings create: one project per chosen website export (each with its own
 * local address and the deployment profiles found in it), or one app or API project without a website; the found Solutions
 * and sample data module, and dry run. `websites` lists the chosen website exports (default: all found).
 */
export function createDocument({
  parts,
  name,
  project,
  candidates,
  port = 8787,
  ports = [],
  apiPort = null,
  websites = null,
}) {
  const kind = kindFor(parts),
    found = candidates?.portals ?? [],
    solutions = (candidates?.solutions ?? []).map((item) => item.value),
    packs = (candidates?.packs ?? []).slice(0, 1);
  const chosen =
    kind === 'power-pages' ? (websites ? found.filter((item) => websites.includes(item.value)) : found) : [];
  // A data module is registered by its path, so the runtime uses the id the module declares.
  const dataPacks = packs.map((item) => item.value),
    switches = switchesFor(parts);
  // The API keeps one address across restarts, so scripts and tests can be pointed at it once.
  if (switches.dataverse && apiPort) switches.dataverse.port = apiPort;
  const names = websiteNames(name, chosen.length ? chosen : [null]);
  if (project)
    return {
      version: 2,
      runtime: { kind },
      simulation: { level: 'dry-run' },
      ...(chosen.length
        ? {
            defaultPortal: names[0],
            portals: chosen.map((portal, index) => ({ id: names[index], path: portal.value, ...profilesFor(portal) })),
          }
        : {}),
      solutions: solutions.map((path, index) => ({ id: `solution-${index + 1}`, path })),
      ...(dataPacks.length ? { dataPacks } : {}),
      ...switches,
    };
  const site = (portal, index) => {
    const local = ports[index] ?? port + index;
    // Only the first project keeps the fixed Web API port; the others pick a free one at every start.
    const own = index && switches.dataverse ? { dataverse: { ...switches.dataverse, port: 0 } } : {};
    return {
      ...(kind === 'power-pages'
        ? { source: portal?.value ?? '.', defaultEnv: 'local', environments: { local: `${LOCAL}${local}` } }
        : {}),
      mirage: {
        port: local,
        runtime: { kind },
        simulation: { level: 'dry-run' },
        ...(solutions.length ? { solutionRoots: solutions } : {}),
        ...(dataPacks.length ? { dataPacks } : {}),
        ...switches,
        ...own,
        ...profilesFor(portal),
      },
    };
  };
  return {
    sourceRoot: '.',
    defaultSite: names[0],
    sites: Object.fromEntries(
      (chosen.length ? chosen : [null]).map((portal, index) => [names[index], site(portal, index)]),
    ),
  };
}

const set = (path, value) => ({ op: 'set', path, value });
const remove = (path) => ({ op: 'delete', path });
/** Edits for a new choice of parts: the runtime kind and its switches; a new website gets a source and a local address. */
export function partsEdits(target, parts, candidates) {
  const kind = kindFor(parts),
    prefix = target.project ? [] : ['sites', target.id, 'mirage'],
    edits = [];
  if (kind !== target.kind) edits.push(set([...prefix, 'runtime', 'kind'], kind));
  const api = target.switches?.dataverse?.enabled === true;
  if (parts.api && !api) edits.push(set([...prefix, 'dataverse', 'enabled'], true));
  if (!parts.api && api) edits.push(set([...prefix, 'dataverse', 'enabled'], false));
  for (const key of ['modelDriven', 'canvas']) {
    const off = !parts[key] && kind !== 'dataverse-api',
      wasOff = target.switches?.[key]?.enabled === false;
    if (off && !wasOff) edits.push(set([...prefix, key, 'enabled'], false));
    if (!off && wasOff) edits.push(remove([...prefix, key, 'enabled']));
  }
  if (kind === 'power-pages' && !target.project) {
    const site = ['sites', target.id];
    if (!target.source) edits.push(set([...site, 'source'], candidates?.portals?.[0]?.value ?? '.'));
    if (!Object.keys(target.environments ?? {}).length)
      edits.push(
        set([...site, 'defaultEnv'], 'local'),
        set([...site, 'environments', 'local'], `${LOCAL}${target.port || 8787}`),
      );
  }
  return edits;
}
/** Edits for the chosen website export and Solution folders. */
export function filesEdits(target, { website, solutions }) {
  const prefix = ['sites', target.id],
    edits = [];
  if (target.parts.website && website && !samePath(website, target.source))
    edits.push(set([...prefix, 'source'], website));
  const unique = [...new Map(solutions.filter(Boolean).map((item) => [normalPath(item), item])).values()];
  if (unique.map(normalPath).join('\n') !== target.solutionRoots.map(normalPath).join('\n'))
    edits.push(
      unique.length
        ? set([...prefix, 'mirage', 'solutionRoots'], unique)
        : remove([...prefix, 'mirage', 'solutionRoots']),
    );
  return edits;
}
/** Edits for the starting data, newly registered data modules and how record changes are kept. */
export function dataEdits(target, { preset, packs = [], level }) {
  const prefix = target.project ? [] : ['sites', target.id, 'mirage'],
    edits = [];
  if (!target.project && preset !== undefined && preset !== (target.preset ?? '')) {
    edits.push(preset ? set([...prefix, 'preset'], preset) : remove([...prefix, 'preset']));
    if (preset && !target.presetMode) edits.push(set([...prefix, 'presetMode'], 'bootstrap'));
  }
  if (packs.length) edits.push(set([...prefix, 'dataPacks'], packs));
  if (level && level !== target.level) edits.push(set([...prefix, 'simulation'], { level }));
  return edits;
}
