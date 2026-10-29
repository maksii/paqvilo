/** Public CLI tools, their programs and their argument contracts. */
import { toolOptionsHelp } from './tool-options.mjs';
export const MIRAGE_TOOLS = Object.freeze({
  'bootstrap-report':
    '(--site ID [--config FILE --env ID --repo DIR] | --source DIR | --project FILE [--portal ID]) [--solution-root DIR ...] [--solution-order derived|explicit] [--deployment-profile NAME] [--data-model standard|enhanced] [--lcid N] [--json] [--output FILE] [--no-cache] [--all-fields]',
  'render-sweep': toolOptionsHelp('render-sweep'),
  'liquid-inventory': toolOptionsHelp('liquid-inventory'),
  'webapi-inventory': toolOptionsHelp('webapi-inventory'),
  'portal-matrix': toolOptionsHelp('portal-matrix'),
  'parity-suite':
    '((--local LOOPBACK_ORIGIN | --source DIR | --site ID) --out DIR | --reclassify FILE) [--config FILE] [--env ID] [--repo DIR] [--state FILE] [--preset NAME] [--origin HTTPS_ORIGIN] [--cdp LOOPBACK_URL] [--local-owned] [--anonymous-browser owned|cdp] [--scenarios FILE] [--core | --no-core] [--pack ID ...] [--packs auto|all|none] [--pack-module FILE ...] [--only IDS] [--tags TAGS] [--exclude-tags TAGS] [--label NAME] [--delay-ms N] [--work-dir DIR] [--persona-contact ID] [--no-persona] [--browser NAME] [--ids FILE] [--deployment-profile NAME]',
  'baseline-suite':
    'capture|compare --matrix FILE --out DIRECTORY [--side live|mirage] [--config FILE --site ID] [--ids FILE] [--allow-writes] [--allowlist FILE] [--second-live LABEL] [--evidence-changes FILE] [--label NAME] [--only IDS] [--env ID] [--source DIR] [--state FILE] [--headed] [--work-dir DIR] [--live DIR] [--mirage DIR]',
  'liquid-conformance': '--suite FILE [--rules FILE] [--json | --markdown] [--out FILE] [--timeout MS]',
  acceptance:
    '--local LOOPBACK_ORIGIN --plan FILE [--origin HTTPS_ORIGIN --cdp LOOPBACK_URL] [--output DIRECTORY] [--requires NAME ...] [--strict]',
  'enrich-reference': '--state FILE --origin HTTPS_ORIGIN --cdp LOOPBACK_URL --plan FILE',
  'reference-parity':
    '--local LOOPBACK_ORIGIN --origin HTTPS_ORIGIN --cdp LOOPBACK_URL --plan FILE --output DIRECTORY [--local-contact ID | --local-configured-persona] [--local-role NAME ...]',
  'query-inventory': '--portal DIRECTORY [--json]',
  verify: '--local LOOPBACK_ORIGIN --origin HTTPS_ORIGIN --cdp LOOPBACK_URL [--path /] --output DIRECTORY',
  'verify-storage': '[--json] (disposable 600,000-row storage/performance check; about 2 GiB free memory)',
  'capture-shell':
    '--config FILE [--site ID] [--env ID | --all] [--path /] [--cdp LOOPBACK_URL] [--timeout MILLISECONDS] [--no-rich-text] [--strict] [--json]',
  trace: `list|show TRACE_ID|spans|stats|settings|clear|export|watch ${toolOptionsHelp('trace')}`,
});
export const mirageToolHelp = (name) => `Usage: paqvilo mirage ${name} ${MIRAGE_TOOLS[name]}\n`;
export const MIRAGE_LIFECYCLE = Object.freeze(['init', 'dev', 'start', 'status', 'stop']);
export const MIRAGE_CORE_COMMANDS = Object.freeze([
  'serve',
  'inspect',
  'render',
  'capture-shell',
  'capture-stylesheets',
  'capture-snippet-composition',
  'verify',
  'data',
  'preflight',
]);
export const MIRAGE_COMMANDS = Object.freeze([
  ...new Set(['demo', ...MIRAGE_LIFECYCLE, ...MIRAGE_CORE_COMMANDS, ...Object.keys(MIRAGE_TOOLS)]),
]);
export function unknownMirageCommand(command) {
  const distance = (candidate) => {
    let previous = Array.from({ length: candidate.length + 1 }, (_, i) => i);
    for (let i = 1; i <= command.length; i++) {
      const row = [i];
      for (let j = 1; j <= candidate.length; j++)
        row[j] = Math.min(
          row[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + Number(command[i - 1] !== candidate[j - 1]),
        );
      previous = row;
    }
    return previous[candidate.length];
  };
  const closest = [...MIRAGE_COMMANDS].sort((a, b) => distance(a) - distance(b))[0];
  // At most two edits, and at most half of the longer word. Adjacent transpositions
  // count as two edits (for example strat -> start).
  const threshold = Math.min(2, Math.floor(Math.max(command.length, closest.length) / 2));
  const suggestion = distance(closest) <= threshold ? ` Closest command: ${closest}.` : '';
  return `Unknown command: ${command}. Choose ${MIRAGE_COMMANDS.join(', ')}.${suggestion} Run paqvilo mirage --help for options.`;
}
