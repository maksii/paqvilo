import fsp from 'node:fs/promises';
import path from 'node:path';

const lineColumn = (text, index) => {
  const before = text.slice(0, index).split('\n');
  return `line ${before.length}, column ${before.at(-1).length + 1}`;
};
const endOfInput = (error) => /Unexpected end of JSON input/.test(error.message);

/**
 * Where JSON text stops parsing ("line L, column C" or "unexpected end of input"), never quoting the text: parser
 * messages repeat the start of the content, which may be a token. When the message names no position, the first
 * prefix that fails for a reason other than its end is found by bisection (a failing prefix only grows).
 */
export function jsonErrorPosition(text, error) {
  const position = /at position (\d+)/.exec(error.message)?.[1];
  if (position !== undefined) return lineColumn(text, Number(position));
  if (endOfInput(error)) return 'unexpected end of input';
  const fails = (length) => {
    try {
      JSON.parse(text.slice(0, length));
      return false;
    } catch (error_) {
      // A failure at the prefix's own end ("Expected ',' or '}' ... at position <length>") is not yet a failure.
      const at = /at position (\d+)/.exec(error_.message)?.[1];
      return !endOfInput(error_) && (at === undefined || Number(at) < length);
    }
  };
  let low = 1,
    high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (fails(middle)) high = middle;
    else low = middle + 1;
  }
  return lineColumn(text, low - 1);
}

/** A parse error whose message and stack (which quote the parsed text) say only `where`, so it can stay a cause. */
export function withoutContent(error, where) {
  error.message = where;
  error.stack = `${error.name}: ${where}`;
  return error;
}

/** The parsed JSON file of a path option; a missing, unreadable or malformed file is refused in one line. */
export async function readJsonOption(option, file) {
  const resolved = path.resolve(file);
  let text;
  try {
    text = await fsp.readFile(resolved, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(`--${option} file not found: ${resolved}. Pass an existing file.`, { cause: error });
    throw new Error(`--${option} file ${resolved} cannot be read (${error.code ?? error.message}).`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const where = jsonErrorPosition(text, error);
    withoutContent(error, where);
    throw new Error(`--${option} file ${resolved} is not valid JSON (${where}).`, {
      cause: error,
    });
  }
}
