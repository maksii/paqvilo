// Small terminal picker, used by `--pick` and `paqvilo use`.
import readline from 'node:readline/promises';

/**
 * @param {string} title
 * @param {Array<{value: string, hint?: string}>} items
 * @param {string} [current] value preselected by pressing Enter
 * @returns {Promise<string>} the chosen value
 */
export async function choose(title, items, current) {
  if (!items.length) throw new Error(`${title}: nothing to choose from`);
  if (items.length === 1) return items[0].value;
  if (!process.stdin.isTTY) {
    throw new Error(`${title}: cannot ask here (no interactive terminal). Name it instead, e.g. --site ${items[0].value}`);
  }
  const width = Math.max(...items.map((i) => i.value.length));
  console.log(`\n${title}`);
  items.forEach((item, i) => {
    console.log(`  ${String(i + 1).padStart(2)}  ${item.value.padEnd(width)}  ${item.hint ?? ''}${item.value === current ? '   (current)' : ''}`);
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const fallback = items.some((i) => i.value === current) ? current : items[0].value;
      const answer = (await rl.question(`number or name [${fallback}]: `)).trim();
      if (!answer) return fallback;
      const byNumber = /^\d+$/.test(answer) ? items[Number(answer) - 1] : null;
      const byName = items.find((i) => i.value.toLowerCase() === answer.toLowerCase());
      if (byNumber || byName) return (byNumber ?? byName).value;
      console.log(`  "${answer}" is not in the list`);
    }
  } finally {
    rl.close();
  }
}

/** Asks for site and environment; values already given (command line) are not asked again. */
export async function pickSiteAndEnv(catalogue, given = {}, current = {}) {
  const sites = Object.entries(catalogue.sites);
  const site =
    given.site ??
    (await choose(
      'Which site?',
      sites.map(([name, s]) => ({ value: name, hint: s.source ?? '' })),
      current.site,
    ));
  const chosen = catalogue.sites[site];
  if (!chosen) throw new Error(`Unknown site "${site}". Known sites: ${sites.map(([n]) => n).join(', ')}`);
  const env =
    given.env ??
    (await choose(
      `Which environment of ${site}?`,
      Object.entries(chosen.environments).map(([name, e]) => ({ value: name, hint: e.url + (e.caution ? '   CAUTION: real data' : '') })),
      current.site === site ? current.env : chosen.defaultEnv,
    ));
  if (!chosen.environments[env]) throw new Error(`Unknown environment "${env}" for site "${site}". Known: ${Object.keys(chosen.environments).join(', ')}`);
  return { site, env };
}
