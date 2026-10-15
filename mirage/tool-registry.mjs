/** Public CLI tools, their programs and their argument contracts. */
import { toolOptionsHelp } from './tool-options.mjs';
export const MIRAGE_TOOLS = Object.freeze({
  'bootstrap-report': '--config FILE --site ID [--json]',
  'render-sweep': toolOptionsHelp('render-sweep'),
  'liquid-inventory': toolOptionsHelp('liquid-inventory'),
  'webapi-inventory': toolOptionsHelp('webapi-inventory'),
  'portal-matrix': toolOptionsHelp('portal-matrix'),
  'parity-suite': '--config FILE --site ID --out DIRECTORY [--scenarios FILE] [--origin HTTPS_ORIGIN --cdp LOOPBACK_URL]',
  'baseline-suite': 'capture|compare --matrix FILE --out DIRECTORY [--side live|mirage] [--config FILE --site ID] [--ids FILE] [--allow-writes] [--allowlist FILE] [--second-live LABEL] [--evidence-changes FILE]',
  'liquid-conformance': '--suite FILE [--rules FILE] [--json | --markdown] [--out FILE] [--timeout MS]',
  acceptance: '--local LOOPBACK_ORIGIN --plan FILE [--origin HTTPS_ORIGIN --cdp LOOPBACK_URL] [--output DIRECTORY]',
  'enrich-reference': '--state FILE --origin HTTPS_ORIGIN --cdp LOOPBACK_URL --plan FILE',
  'reference-parity': '--local LOOPBACK_ORIGIN --origin HTTPS_ORIGIN --cdp LOOPBACK_URL --plan FILE --output DIRECTORY',
  'query-inventory': '--portal DIRECTORY [--json]',
  verify: '--local LOOPBACK_ORIGIN --origin HTTPS_ORIGIN --cdp LOOPBACK_URL [--path /] --output DIRECTORY',
  'capture-shell': '--config FILE [--site ID] [--env ID | --all] [--path /] [--cdp LOOPBACK_URL] [--timeout MILLISECONDS] [--no-rich-text] [--strict] [--json]',
});
export const mirageToolHelp = name => `Usage: paqvilo mirage ${name} ${MIRAGE_TOOLS[name]}\n`;
