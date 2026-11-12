import { parseArgs } from 'node:util';

/**
 * Refuses a string option that is given twice unless its table entry is `multiple: true`, so a duplicated
 * `--env` cannot silently replace the value the reader saw first. Reads the `tokens` parseArgs reports.
 */
function refuseRepeatedOptions(tokens, options) {
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    const declared = options[token.name];
    if (declared?.type !== 'string' || declared.multiple) continue;
    if (seen.has(token.name))
      throw Object.assign(new Error(`--${token.name} may be given only once`), { code: 'invalid_argument' });
    seen.add(token.name);
  }
}

/** node:util parseArgs with the repeated-option check; takes and returns the same shapes. */
export function parseOptions(config) {
  const parsed = parseArgs({ ...config, tokens: true });
  refuseRepeatedOptions(parsed.tokens, config.options);
  return parsed;
}
