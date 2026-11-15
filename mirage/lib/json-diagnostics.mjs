const digit = (character) => character >= '0' && character <= '9';
const hex = (character) =>
  digit(character) || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F');

function stringToken(text, start) {
  let at = start + 1;
  while (at < text.length) {
    const character = text[at];
    if (character === '"') return { end: at + 1 };
    if (character.charCodeAt(0) < 0x20) return { error: at }; // NOSONAR: UTF-16 code unit semantics are required
    if (character !== '\\') {
      at++;
      continue;
    }
    const escape = stringEscapeEnd(text, at + 1);
    if (escape.error !== undefined) return escape;
    at = escape.at;
  }
  return { error: text.length };
}

function stringEscapeEnd(text, at) {
  if (at === text.length) return { error: at };
  if (String.raw`"\/bfnrt`.includes(text[at])) return { at: at + 1 };
  if (text[at] !== 'u') return { error: at };
  for (let count = 0; count < 4; count++) {
    at++;
    if (at === text.length || !hex(text[at])) return { error: at };
  }
  return { at: at + 1 };
}

function numberFraction(text, at) {
  if (text[at] !== '.') return { at };
  at++;
  if (!digit(text[at])) return { error: at };
  while (digit(text[at])) at++;
  return { at };
}

function numberExponent(text, at) {
  if (text[at] !== 'e' && text[at] !== 'E') return { at };
  at++;
  if (text[at] === '+' || text[at] === '-') at++;
  if (!digit(text[at])) return { error: at };
  while (digit(text[at])) at++;
  return { at };
}

function numberToken(text, start) {
  let at = start;
  if (text[at] === '-') at++;
  if (text[at] === '0') at++;
  else {
    if (!(text[at] >= '1' && text[at] <= '9')) return { error: at };
    while (digit(text[at])) at++;
  }
  const fraction = numberFraction(text, at);
  if (fraction.error !== undefined) return fraction;
  const exponent = numberExponent(text, fraction.at);
  if (exponent.error !== undefined) return exponent;
  at = exponent.at;
  return { end: at };
}

function advanceKey(text, frame, at) {
  if (text[at] !== '"') return { error: at };
  const token = stringToken(text, at);
  if (token.error !== undefined) return token;
  frame.state = 'colon';
  return { at: token.end };
}

function advanceDelimiter(text, frame, stack, at) {
  if (frame.state === 'colon') {
    if (text[at] !== ':') return { error: at };
    frame.state = 'value';
    return { at: at + 1 };
  }
  if (text[at] === (frame.kind === 'object' ? '}' : ']')) {
    stack.pop();
    return { at: at + 1 };
  }
  if (text[at] !== ',') return { error: at };
  frame.state = frame.kind === 'object' ? 'key' : 'value';
  return { at: at + 1 };
}

function advanceValue(text, frame, stack, at) {
  const character = text[at];
  frame.state = frame.kind === 'root' ? 'end' : 'commaOrEnd';
  if (character === '{' || character === '[') {
    stack.push(character === '{' ? { kind: 'object', state: 'keyOrEnd' } : { kind: 'array', state: 'valueOrEnd' });
    return { at: at + 1 };
  }
  if (character === '"' || character === '-' || digit(character)) {
    const token = character === '"' ? stringToken(text, at) : numberToken(text, at);
    return token.error !== undefined ? token : { at: token.end };
  }
  const literal = { t: 'true', f: 'false', n: 'null' }[character] ?? null;
  if (!literal) return { error: at };
  for (const expected of literal) {
    if (text[at] !== expected) return { error: at };
    at++;
  }
  return { at };
}

function closesEmptyFrame(frame, character) {
  return (frame.state === 'keyOrEnd' && character === '}') || (frame.state === 'valueOrEnd' && character === ']');
}

function isKeyState(frame) {
  return frame.state === 'key' || frame.state === 'keyOrEnd';
}

function isDelimiterState(frame) {
  return frame.state === 'colon' || frame.state === 'commaOrEnd';
}

// Called only after JSON.parse rejects a source. This locates the first syntax
// error without constructing values, recursing, or depending on Node's messages.
function errorOffset(text) {
  const stack = [{ kind: 'root', state: 'value' }];
  let at = 0;
  while (stack.length) {
    while (text[at] === ' ' || text[at] === '\t' || text[at] === '\r' || text[at] === '\n') at++;
    const frame = stack.at(-1),
      character = text[at];
    if (frame.state === 'end') return at;
    if (closesEmptyFrame(frame, character)) {
      stack.pop();
      at++;
      continue;
    }
    let result;
    if (isKeyState(frame)) result = advanceKey(text, frame, at);
    else if (isDelimiterState(frame)) result = advanceDelimiter(text, frame, stack, at);
    else result = advanceValue(text, frame, stack, at);
    if (result.error !== undefined) return result.error;
    at = result.at;
  }
  while (text[at] === ' ' || text[at] === '\t' || text[at] === '\r' || text[at] === '\n') at++;
  return at;
}

/** Syntax location only. Call after JSON.parse fails; no source values are returned. */
export function jsonErrorLocation(source) {
  const text = String(source),
    offset = errorOffset(text);
  let line = 1,
    column = 1;
  for (let index = 0; index < offset; index++) {
    if (text[index] === '\r') {
      line++;
      column = 1;
      if (index + 1 < offset && text[index + 1] === '\n') index++;
    } else if (text[index] === '\n') {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}
