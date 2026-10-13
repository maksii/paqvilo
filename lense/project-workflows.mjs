/** Avoid collisions with project-wide picker/debug scripts without restricting site IDs. */
export const siteWorkflowName = (product, site) => ['pick', 'debug'].includes(site)
  ? `${product}:site:${site}:dev` : `${product}:${site}`;

/** Shared CLI arguments for npm shortcuts and catalogue-derived editor development tasks. */
export function developmentWorkflows({ sites, browser, config = './paqvilo.config.yml' }) {
  const workflows = {};
  for (const [product, namespace, profile, port] of [['dev', 'lense', 'lense', 9222], ['mirage:dev', 'mirage', 'mirage', 9223]]) {
    const common = [namespace, 'dev', '--config', config, '--headed', '--browser', browser, '--profile', profile];
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
