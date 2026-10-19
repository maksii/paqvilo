/** Avoid collisions with project-wide picker/debug scripts without restricting site IDs. */
export const siteWorkflowName = (product, site) => ['pick', 'debug'].includes(site)
  ? `${product}:site:${site}:dev` : `${product}:${site}`;

// These proposals must be portable between npm's cmd.exe and POSIX sh. Refuse
// interpolation/control characters instead of pretending JSON escaping is shell escaping.
const scriptArgument = value => typeof value === 'string' && /^[a-z0-9_./: -]+$/i.test(value)
  ? value.includes(' ') ? `"${value}"` : value : null;
export const developmentScript = (name, workflow) => {
  const args = name.endsWith(':debug') ? ['npm', 'run', name.slice(0, -6), '--', '--debug-port', workflow.args.at(-1)] : ['paqvilo', ...workflow.args];
  const quoted = args.map(scriptArgument);
  if (quoted.some(value => value === null)) throw new Error('Development shortcut arguments require manual portable shell quoting.');
  return quoted.join(' ');
};

/** Shared CLI arguments for npm shortcuts and catalogue-derived editor development tasks. */
export function developmentWorkflows({ sites, browser, config = './paqvilo.config.yml' }) {
  const workflows = {};
  for (const [product, namespace, profile, port] of [['dev', 'lense', 'lense', 9222], ['mirage:dev', 'mirage', 'mirage', 9223]]) {
    const common = [namespace, 'dev', '--config', config, '--headed'];
    if (browser !== undefined) common.push('--browser', browser);
    common.push('--profile', profile);
    if (namespace === 'mirage') common.push('--preset-mode', 'bootstrap');
    const add = (name, args) => {
      workflows[name] = { args, background: true };
      workflows[`${name}:debug`] = { args: [...args, '--debug-port', String(port)], background: true };
    };
    add(product, [...common, '--portals', 'all']);
    for (const site of sites) add(siteWorkflowName(product, site), [...common, '--site', site, '--portals', 'selected']);
    if (namespace === 'lense') workflows['dev:pick'] = { args: [...common, '--pick', '--portals', 'selected'], background: false };
  }
  return workflows;
}

/** Recognize only exact scaffold commands; project-authored commands remain owned by the project. */
export function generatedDevelopmentScripts(scripts = {}, sites = [], configs = ['./paqvilo.config.yml']) {
  const previousSites = Object.values(scripts).flatMap(command => typeof command === 'string'
    ? command.match(/ --site ([a-zA-Z0-9][a-zA-Z0-9_-]*) --portals selected$/)?.[1] ?? [] : []);
  const generated = new Set();
  for (const browser of [undefined, 'msedge', 'chrome', 'chromium']) for (const config of configs) {
    if (scriptArgument(config) === null) continue;
    for (const [name, workflow] of Object.entries(developmentWorkflows({ sites: [...new Set([...sites, ...previousSites])], browser, config }))) {
      if (Object.hasOwn(scripts, name) && scripts[name] === developmentScript(name, workflow)
        && (!name.endsWith(':debug') || generated.has(name.slice(0, -6)))) generated.add(name);
    }
  }
  return generated;
}

/** Read-only reconciliation proposals. Applying/removing any custom script requires project review. */
export function developmentScriptDrift({ scripts = {}, sites, config = './paqvilo.config.yml' }) {
  const workflows = developmentWorkflows({ sites, config });
  const generated = generatedDevelopmentScripts(scripts, sites, ['./paqvilo.config.yml', config]), changes = [];
  if (scriptArgument(config) === null) {
    for (const name of Object.keys(workflows)) changes.push({ action: Object.hasOwn(scripts, name) ? 'update' : 'add', name,
      reason: 'Selected catalogue path requires manual portable shell quoting; reconcile the command manually without an executable proposal.', custom: Object.hasOwn(scripts, name) && !generated.has(name), requiresReview: true });
    return changes;
  }
  const expected = Object.fromEntries(Object.entries(workflows).map(([name, workflow]) => [name, developmentScript(name, workflow)]));
  for (const [name, proposed] of Object.entries(expected)) {
    if (!Object.hasOwn(scripts, name)) changes.push({ action: 'add', name, proposed, reason: 'Configured development shortcut is missing.', custom: false, requiresReview: false });
    else if (scripts[name] !== proposed) {
      const custom = !generated.has(name);
      changes.push({ action: 'update', name, current: scripts[name], proposed,
        reason: custom ? 'Project-authored shortcut differs; retain it or reconcile manually.' : 'Generated shortcut pins an earlier browser/configuration choice.', custom, requiresReview: custom });
    }
  }
  for (const name of generated) if (!Object.hasOwn(expected, name)) changes.push({ action: 'remove', name, current: scripts[name], reason: 'Generated shortcut targets a site no longer configured.', custom: false, requiresReview: false });
  return changes;
}
