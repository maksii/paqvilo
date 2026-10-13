import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareProject } from '../project-scaffold.mjs';
import { checkProject } from '../project-check.mjs';
import { refreshEditor } from '../project-editor.mjs';
import { choose } from '../prompt.mjs';

export const INIT_HELP = `Usage: paqvilo init [dir] [options]

Create an empty consumer project. Pure file generation: no install, browser or network.
Unlike mirage init, this creates the catalogue, project scripts, packs and tests.

  --name <slug>          Package/pack name (default: target folder basename)
  --site <id>            Repeat for several sites (default: portal)
  --pack <id>            Repeat for several packs (default: project name)
  --no-pack              Omit pack modules and the bound runtime adapter
  --default-env <name>   Placeholder environment (default: dev)
  --source-root <path>   Export/Solution root (default: ./sources)
  --browser <channel>    msedge (default), chrome or chromium
  --toolkit <spec>       Paqvilo dependency specification (default: ^installed-version)
  --no-vscode            Omit editor/workspace files
  --into-existing        Add only missing files; never overwrite
  --interactive          Ask for the browser in an interactive terminal
  --check                Read-only completion diagnostics, file:line; exits 1 if unfinished
  --refresh-editor       Refresh generated editor files from the resolved catalogue
  --workspace-only       With refresh, update only the ignored workspace file
  --config <file>        Catalogue for check/refresh (default: ./paqvilo.config.yml)
  --json                 Machine-readable schemaVersion: 1 report
  --help, -h             Show this help

Edited editor files are preserved; refresh writes *.generated.json alternatives.
Use TODO(paqvilo-init) markers for values the project owner must fill in.
`;

export async function runInit(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    name: { type: 'string' }, site: { type: 'string', multiple: true }, pack: { type: 'string', multiple: true },
    'no-pack': { type: 'boolean' }, 'default-env': { type: 'string' }, 'source-root': { type: 'string' },
    browser: { type: 'string' }, toolkit: { type: 'string' }, 'no-vscode': { type: 'boolean' },
    'into-existing': { type: 'boolean' }, interactive: { type: 'boolean' }, check: { type: 'boolean' },
    'refresh-editor': { type: 'boolean' }, 'workspace-only': { type: 'boolean' }, config: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(INIT_HELP); return 0; }
  if (positionals.length > 1) throw new Error('init accepts at most one target directory');
  if (values.check && values['refresh-editor']) throw new Error('--check and --refresh-editor are separate operations');
  if (values['workspace-only'] && !values['refresh-editor']) throw new Error('--workspace-only requires --refresh-editor');
  const generationOptions = ['name', 'site', 'pack', 'no-pack', 'default-env', 'source-root', 'browser', 'toolkit', 'no-vscode', 'into-existing', 'interactive'];
  if ((values.check || values['refresh-editor']) && generationOptions.some(key => values[key] !== undefined)) throw new Error('Generation options cannot be combined with check/editor refresh');
  if (values.config && !values.check && !values['refresh-editor']) throw new Error('--config applies only to --check and --refresh-editor');
  if (values.interactive && values.json) throw new Error('--interactive cannot be combined with --json');
  const directory = path.resolve(positionals[0] ?? '.');
  let report;
  if (values.check) report = checkProject(directory, { config: values.config });
  else if (values['refresh-editor']) report = await refreshEditor(directory, { config: values.config, workspaceOnly: values['workspace-only'] });
  else {
    if (values.interactive) values.browser ??= await choose('Browser for this project?', ['msedge', 'chrome', 'chromium'].map(value => ({ value })), 'msedge');
    report = await prepareProject(directory, { name: values.name, sites: values.site, packs: values.pack, noPack: values['no-pack'],
      defaultEnv: values['default-env'], sourceRoot: values['source-root'], browser: values.browser, toolkit: values.toolkit,
      noVscode: values['no-vscode'], intoExisting: values['into-existing'] });
  }
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else if (values.check) {
    for (const item of report.todo) console.log(`${item.file}:${item.line}: ${item.severity ?? 'error'} [${item.kind}] ${item.text}`);
    console.log(report.ok ? 'Project scaffold is complete.' : `${report.todo.length} unfinished scaffold item(s).`);
  } else {
    console.log(`Project: ${report.directory}\nCreated ${report.created.length}, updated ${report.updated?.length ?? 0}, skipped ${report.skipped.length} file(s).`);
    for (const file of report.skipped) console.log(`Kept existing: ${file}`);
    for (const item of report.conflicts ?? []) console.log(`Kept edited ${item.file}; review ${item.generated}.`);
    if (report.next) console.log(`Next: ${report.next.join(' → ')}`);
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInit().then(code => { process.exitCode = code; }).catch(error => {
    if (process.argv.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: error.code ?? 'INIT_FAILED', message: error.message } }));
    else console.error(`paqvilo init: ${error.message.replace(/[\r\n]+/g, ' ')}`);
    process.exitCode = 1;
  });
}
