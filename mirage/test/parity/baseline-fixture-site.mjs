// The site the baseline captures were recorded on, rebuilt from the toolkit's invented sources: the demo portal
// (examples/project/portal) with the baseline fixture site (examples/project/baseline/site) uploaded over it, their
// Solution sources and data packs. Shared by the replay adapters whose recordings ran on that site.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT = fileURLToPath(new URL('../../../examples/project/', import.meta.url));

// Portal YAML files that hold a list of records (a top-level sequence) in both the demo portal and the fixture site.
const LIST_FILES = ['sitesetting.yml', 'webrole.yml'];
// The recorded site's own setting outside the fixture: its PAC export sets Site/EnableCustomPluginError to true, which
// is why the recorded form panels show the plug-in's message. The demo portal source does not carry it.
const RECORDED_SITE_SETTINGS = [
  '- adx_name: Site/EnableCustomPluginError',
  '  adx_sitesettingid: 70000000-0000-4000-8000-0000000000a1',
  '  adx_value: true',
  '',
].join('\n');

/** Writes the recorded site's portal source into `directory`, as the fixture site was uploaded over the demo portal. */
export async function writeBaselineFixtureSite(directory) {
  await fs.cp(path.join(PROJECT, 'portal'), directory, { recursive: true });
  // PAC upload adds the fixture's records to the site's own: the record lists both folders hold are joined (their
  // record ids differ), the single website and language records are the fixture's copies of the site's.
  const lists = new Map();
  for (const name of LIST_FILES) lists.set(name, await fs.readFile(path.join(directory, name), 'utf8'));
  await fs.cp(path.join(PROJECT, 'baseline', 'site'), directory, { recursive: true, force: true });
  for (const [name, own] of lists) {
    const fixture = await fs.readFile(path.join(directory, name), 'utf8');
    const extra = name === 'sitesetting.yml' ? RECORDED_SITE_SETTINGS : '';
    const joined = [own, fixture].map((text) => (text.endsWith('\n') ? text : text + '\n'));
    await fs.writeFile(path.join(directory, name), joined.join('') + extra);
  }
}

/** The simulator options of the recorded site for `sourceDir`: its Solution roots, packs and the baseline preset. */
export function baselineFixtureOptions(sourceDir, { packs = ['baseline'] } = {}) {
  const modules = {
    baseline: path.join(PROJECT, 'baseline', 'pack.mjs'),
    example: path.join(PROJECT, 'pack', 'pack.mjs'),
  };
  return {
    sourceDir,
    watch: false,
    port: 0,
    solutionRoots: ['metadata', 'solution', 'baseline/solution'].map((root) => path.join(PROJECT, root)),
    solutionOrder: 'explicit',
    dataPacks: packs.map((id) => ({ id, module: modules[id] })),
    preset: 'baseline',
  };
}
