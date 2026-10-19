const digit = character => character >= '0' && character <= '9';
const hex = character => digit(character) || character >= 'a' && character <= 'f' || character >= 'A' && character <= 'F';

// Called only after JSON.parse rejects a source. This locates the first syntax
// error without constructing values, recursing, or depending on Node's messages.
function errorOffset(text) {
  const string = start => {
    let at = start + 1;
    while (at < text.length) {
      const character = text[at];
      if (character === '"') return { end: at + 1 };
      if (character.charCodeAt(0) < 0x20) return { error: at };
      if (character !== '\\') { at++; continue; }
      at++;
      if (at === text.length) return { error: at };
      if ('"\\/bfnrt'.includes(text[at])) { at++; continue; }
      if (text[at] !== 'u') return { error: at };
      for (let count = 0; count < 4; count++) {
        at++;
        if (at === text.length || !hex(text[at])) return { error: at };
      }
      at++;
    }
    return { error: text.length };
  };
  const number = start => {
    let at = start;
    if (text[at] === '-') at++;
    if (text[at] === '0') at++;
    else {
      if (!(text[at] >= '1' && text[at] <= '9')) return { error: at };
      while (digit(text[at])) at++;
    }
    if (text[at] === '.') {
      at++;
      if (!digit(text[at])) return { error: at };
      while (digit(text[at])) at++;
    }
    if (text[at] === 'e' || text[at] === 'E') {
      at++;
      if (text[at] === '+' || text[at] === '-') at++;
      if (!digit(text[at])) return { error: at };
      while (digit(text[at])) at++;
    }
    return { end: at };
  };
  const stack = [{ kind: 'root', state: 'value' }];
  let at = 0;
  while (stack.length) {
    while (text[at] === ' ' || text[at] === '\t' || text[at] === '\r' || text[at] === '\n') at++;
    const frame = stack.at(-1), character = text[at];
    if (frame.state === 'end') return at;
    if ((frame.state === 'keyOrEnd' && character === '}') || (frame.state === 'valueOrEnd' && character === ']')) { stack.pop(); at++; continue; }
    if (frame.state === 'key' || frame.state === 'keyOrEnd') {
      if (character !== '"') return at;
      const token = string(at);
      if (token.error !== undefined) return token.error;
      at = token.end; frame.state = 'colon'; continue;
    }
    if (frame.state === 'colon') {
      if (character !== ':') return at;
      at++; frame.state = 'value'; continue;
    }
    if (frame.state === 'commaOrEnd') {
      if (character === (frame.kind === 'object' ? '}' : ']')) { stack.pop(); at++; continue; }
      if (character !== ',') return at;
      at++; frame.state = frame.kind === 'object' ? 'key' : 'value'; continue;
    }
    frame.state = frame.kind === 'root' ? 'end' : 'commaOrEnd';
    if (character === '{' || character === '[') {
      stack.push(character === '{' ? { kind: 'object', state: 'keyOrEnd' } : { kind: 'array', state: 'valueOrEnd' }); at++; continue;
    }
    if (character === '"' || character === '-' || digit(character)) {
      const token = character === '"' ? string(at) : number(at);
      if (token.error !== undefined) return token.error;
      at = token.end; continue;
    }
    const literal = character === 't' ? 'true' : character === 'f' ? 'false' : character === 'n' ? 'null' : null;
    if (!literal) return at;
    for (const expected of literal) { if (text[at] !== expected) return at; at++; }
  }
  while (text[at] === ' ' || text[at] === '\t' || text[at] === '\r' || text[at] === '\n') at++;
  return at;
}

/** Syntax location only. Call after JSON.parse fails; no source values are returned. */
export function jsonErrorLocation(source) {
  const text = String(source), offset = errorOffset(text);
  let line = 1, column = 1;
  for (let index = 0; index < offset; index++) {
    if (text[index] === '\r') {
      line++; column = 1;
      if (index + 1 < offset && text[index + 1] === '\n') index++;
    } else if (text[index] === '\n') { line++; column = 1; } else column++;
  }
  return { line, column };
}
