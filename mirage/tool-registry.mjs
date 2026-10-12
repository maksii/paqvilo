/** Public CLI tools, their programs and their argument contracts. */
export const MIRAGE_TOOLS = Object.freeze({
  'bootstrap-report': '--config FILE --site ID [--json]',
  'render-sweep': '--config FILE --site ID [--json]',
  'liquid-inventory': '--config FILE --site ID [--json]',
  'webapi-inventory': '--config FILE --site ID [--json]',
  'portal-matrix': '--config FILE [--json]',
  'parity-suite': '--config FILE --site ID [--plan FILE]',
  'liquid-conformance': '[--json]',
  acceptance: '--local LOOPBACK_ORIGIN --plan FILE [--origin HTTPS_ORIGIN --cdp LOOPBACK_URL] [--output DIRECTORY]',
  'enrich-reference': '--state FILE --origin HTTPS_ORIGIN --cdp LOOPBACK_URL --plan FILE',
  'reference-parity': '--local LOOPBACK_ORIGIN --origin HTTPS_ORIGIN --cdp LOOPBACK_URL --plan FILE --output DIRECTORY',
  'query-inventory': '--portal DIRECTORY [--json]',
  verify: '--local LOOPBACK_ORIGIN --origin HTTPS_ORIGIN --cdp LOOPBACK_URL [--path /] --output DIRECTORY',
  'capture-shell': '--config FILE --site ID [--env ID | --all] [--path /] [--cdp LOOPBACK_URL]',
});
export const mirageToolHelp = name => `Usage: paqvilo mirage ${name} ${MIRAGE_TOOLS[name]}\n`;
