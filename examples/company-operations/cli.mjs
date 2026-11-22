// Shared by this example's scripts: strict arguments, one-line failures and Prettier-stable generated JSON.
// Twin of the other example's cli.mjs: examples/project/cli.mjs and examples/company-operations/cli.mjs are
// byte-identical so each example stays a self-contained package; test/example-cli-twins.test.mjs checks it.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/** An argument problem: reported with a pointer to --help. */
export class UsageError extends Error {}

/**
 * Whether `meta` is the started script's. Node loads it from its real path (macOS /tmp and /var are links into
 * /private), so the started path is compared the same way.
 */
export const isMain = (meta, started = process.argv[1]) =>
  Boolean(started) && fs.existsSync(started) && fs.realpathSync(started) === fileURLToPath(meta.url);

const HINT = ' Run it with --help for usage.';
export function errorLine(error) {
  const message = String(error?.message ?? error);
  const option = /--[\w-]+/.exec(message)?.[0];
  switch (error?.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return `Unknown option ${/'([^']+)'/.exec(message)?.[1] ?? option}.${HINT}`;
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      return `${option} ${message.includes('argument missing') ? 'needs a value' : 'takes no value'}.${HINT}`;
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return `Unexpected argument ${/'([^']+)'/.exec(message)?.[1]}.${HINT}`;
    case 'ENOENT':
      if (error.path) return `File not found: ${error.path}. Check the path.`;
  }
  return message.split('\n')[0] + (error instanceof UsageError ? HINT : '');
}

/** `usage` with each `node <this script>` written as run from the working directory, wherever the script lives. */
export function invocation(usage, script = process.argv[1], cwd = process.cwd()) {
  if (!script) return usage;
  let relative = path.relative(cwd, script).split(path.sep).join('/');
  if (/\s/.test(relative)) relative = `"${relative}"`;
  return usage.replace(/(?<=\bnode )\S+\.mjs\b/g, (named) =>
    path.posix.basename(named) === path.basename(script) ? relative : named,
  );
}

function fail(error) {
  process.stderr.write(`${errorLine(error)}\n`);
  process.exit(1);
}

/**
 * Parses this script's arguments strictly before it reads inputs or connects anywhere. `--help` prints `usage` and
 * exits 0; an argument error, and any later uncaught failure, prints one line to stderr and exits 1.
 * `positionals` is the exact count or a [min, max] range.
 */
export function cli(usage, options = {}, { positionals = 0, args = process.argv.slice(2) } = {}) {
  process.on('uncaughtException', fail);
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { ...options, help: { type: 'boolean', short: 'h' } },
      allowPositionals: positionals !== 0,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    fail(error);
  }
  if (parsed.values.help) {
    process.stdout.write(`${invocation(usage).trim()}\n`);
    process.exit(0);
  }
  const seen = new Set();
  for (const token of parsed.tokens.filter((t) => t.kind === 'option' && !options[t.name]?.multiple)) {
    if (seen.has(token.name)) fail(new UsageError(`--${token.name} may be given only once.`));
    seen.add(token.name);
  }
  const [min, max = min] = [positionals].flat();
  const count = parsed.positionals.length;
  if (count < min) fail(new UsageError(`Missing ${min - count === 1 ? 'an argument' : 'arguments'}.`));
  if (count > max) fail(new UsageError(`Unexpected argument ${parsed.positionals[max]}.`));
  return parsed;
}

// Single-line text of a value, or null when it holds a non-empty object (Prettier keeps those expanded).
function inline(value) {
  if (Array.isArray(value)) {
    const parts = value.map(inline);
    return parts.includes(null) ? null : `[${parts.join(', ')}]`;
  }
  if (value && typeof value === 'object') return Object.keys(value).length ? null : '{}';
  return JSON.stringify(value);
}
const twoOrMore = (item) => (Array.isArray(item) ? item.length : Object.keys(item ?? {}).length) > 1;
// ponytail: width counts code points; Prettier counts East Asian wide characters twice. Generated files are ASCII.
const fits = (text) => [...text].length <= 120;
// Prettier keeps an array expanded, one item per line, when every item is an object or array of two or more entries.
const forcedOpen = (value) =>
  value.length > 1 &&
  value.every(
    (item) => item && typeof item === 'object' && twoOrMore(item) && Array.isArray(item) === Array.isArray(value[0]),
  );
// A number array fills lines; Prettier counts the comma that ends every line but the last one when it fills a line.
function fillNumbers(value, inner) {
  const lines = [inner + value[0]];
  for (const [index, item] of value.slice(1).entries()) {
    const comma = index < value.length - 2 ? ',' : '';
    if (fits(`${lines.at(-1)}, ${item}${comma}`)) lines[lines.length - 1] += `, ${item}`;
    else lines.push(inner + item);
  }
  return lines.map((text, i) => (i < lines.length - 1 ? text + ',' : text));
}
function printArray(value, pad, prefix, suffix) {
  const inner = pad + '  ';
  const line = forcedOpen(value) ? null : inline(value);
  if (line !== null && fits(pad + prefix + line + suffix)) return pad + prefix + line + suffix;
  const items =
    value.length > 1 && value.every((item) => typeof item === 'number')
      ? fillNumbers(value, inner)
      : value.map((item, i) => print(item, inner, '', i < value.length - 1 ? ',' : ''));
  return `${pad}${prefix}[\n${items.join('\n')}\n${pad}]${suffix}`;
}
function print(value, pad, prefix, suffix) {
  if (Array.isArray(value) && value.length) return printArray(value, pad, prefix, suffix);
  if (inline(value) === null) {
    const inner = pad + '  ';
    const keys = Object.keys(value);
    const items = keys.map((key, i) =>
      print(value[key], inner, `${JSON.stringify(key)}: `, i < keys.length - 1 ? ',' : ''),
    );
    return `${pad}${prefix}{\n${items.join('\n')}\n${pad}}${suffix}`;
  }
  return pad + prefix + inline(value) + suffix;
}

/** JSON text exactly as the repository's Prettier configuration formats it, so regeneration leaves no diff. */
export const formatJson = (value) => print(JSON.parse(JSON.stringify(value)), '', '', '') + '\n'; // NOSONAR: JSON round trip semantics differ from structuredClone
