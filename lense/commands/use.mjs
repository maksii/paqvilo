// `paqvilo use [site] [environment]`: remember in .env which site and environment you work on.
import fs from 'node:fs';
import path from 'node:path';
import { loadCatalogue } from '../config.mjs';
import { pickSiteAndEnv } from '../prompt.mjs';

/** Sets KEY=value in .env text: replaces the (possibly commented-out) line, or appends one. */
export function setEnvLine(text, key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error('Invalid setting name or selection');
  const line = `${key}=${value}`;
  const active = new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[^\\r\\n]*`, 'gm');
  if (active.test(text)) return text.replace(active, () => line);
  const commented = new RegExp(`^[\\t ]*#[\\t ]*${key}[\\t ]*=[^\\r\\n]*`, 'm');
  if (commented.test(text)) return text.replace(commented, () => line);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return `${text}${text === '' || text.endsWith('\n') ? '' : eol}${line}${eol}`;
}

export function rememberSelection(text, site, env, previousSite) {
  // A named selection must not keep using a stale one-off target from this same file.
  const disabled = previousSite && previousSite !== site ? ['PAQVILO_URL', 'PAQVILO_SOURCE'] : ['PAQVILO_URL'];
  for (const key of disabled) text = text.replace(new RegExp(`^([\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[^\\r\\n]*)`, 'gm'), '# $1');
  return setEnvLine(setEnvLine(text, 'PAQVILO_SITE', site), 'PAQVILO_ENV', env);
}

export default async function use(_cfg, args, positionals = []) {
  const catalogue = loadCatalogue(args);
  const current = { site: catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite, env: catalogue.settings.values.PAQVILO_ENV };
  const { site, env } = await pickSiteAndEnv(catalogue, { site: positionals[0] ?? args.site, env: positionals[1] ?? args.env }, current);

  const file = catalogue.settings.file;
  const example = path.join(catalogue.configDir, '.env.example');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fs.existsSync(example) ? fs.readFileSync(example, 'utf8') : '';
  const created = !fs.existsSync(file);
  text = rememberSelection(text, site, env, current.site);
  fs.writeFileSync(file, text);

  const e = catalogue.sites[site].environments[env];
  console.log(`\n${created ? 'created' : 'updated'} ${file}`);
  console.log(`now working on ${site} @ ${env}  ${e.url}`);
  if (e.caution) console.log('CAUTION: this environment holds real data; what you do in the browser there is real.');
  for (const key of ['PAQVILO_SITE', 'PAQVILO_ENV', 'PAQVILO_URL', 'PAQVILO_SOURCE']) {
    if (process.env[key]) console.log(`note: ${key} is also set in your shell (${process.env[key]}) and wins over .env`);
  }
  console.log('start with: npm run dev');
  return 0;
}
