// Find CSS url() dependencies with the same capture choices as the historical matcher.
export function cssUrlDependencies(css) {
  // NOSONAR: preserve state, evaluation order, and lifecycle
  const closers = { '"': [], "'": [] };
  const lines = [];
  for (let i = 0; i < css.length; i++) {
    const char = css[i];
    if (char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029') lines.push(i);
    if (char === '"' || char === "'") {
      let end = i + 1;
      while (end < css.length && /\s/.test(css[end])) end++;
      if (css[end] === ')') closers[char].push({ position: i, end: end + 1 });
    }
  }
  const pointers = { '"': 0, "'": 0 };
  let linePointer = 0;
  const pattern = /(@import\s+)?url\(/gi;
  const result = [];
  let match;
  while ((match = pattern.exec(css))) {
    let valueStart = pattern.lastIndex;
    while (valueStart < css.length && /\s/.test(css[valueStart])) valueStart++;
    const firstClose = css.indexOf(')', valueStart);
    if (firstClose < 0) break;
    let value;
    const quote = css[valueStart];
    if (quote === '"' || quote === "'") {
      const list = closers[quote];
      while (pointers[quote] < list.length && list[pointers[quote]].position <= valueStart) pointers[quote]++;
      while (linePointer < lines.length && lines[linePointer] <= valueStart) linePointer++;
      const candidate = list[pointers[quote]];
      if (candidate && (linePointer === lines.length || candidate.position < lines[linePointer])) {
        value = css.slice(valueStart + 1, candidate.position);
        pattern.lastIndex = candidate.end;
      }
    }
    if (value === undefined) {
      value = css.slice(valueStart, firstClose);
      pattern.lastIndex = firstClose + 1;
    }
    result.push({ value: value.trim(), style: Boolean(match[1]) });
  }
  return result;
}
