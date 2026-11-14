// Bounded lexical checks only. This is not a complete WDL parser or evaluator.
const opening = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);
const closing = new Set(opening.values());
const identifier = (character) => character !== undefined && /\w/.test(character);

function quotedEnd(text, start) {
  let at = start + 1;
  while (at < text.length) {
    if (text[at] !== "'") {
      at++;
      continue;
    }
    if (text[at + 1] === "'") {
      at += 2;
      continue;
    }
    return at + 1;
  }
  return -1;
}

function referenceAt(text, index, name, names) {
  if (!['body', 'outputs', 'actions', 'items'].includes(name.toLowerCase())) return false;
  let at = index;
  while (/\s/.test(text[at] ?? '') && at < text.length) at++;
  if (text[at++] !== '(') return false;
  while (/\s/.test(text[at] ?? '') && at < text.length) at++;
  if (text[at] !== "'") return false;
  const end = quotedEnd(text, at);
  if (end < 0) return false;
  const value = text.slice(at + 1, end - 1).replaceAll("''", "'");
  return !names.has(value);
}

function* expressionTokens(text) {
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === "'") {
      const end = quotedEnd(text, index);
      if (end < 0) {
        yield { kind: 'invalid' };
        return;
      }
      index = end;
    } else if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (identifier(text[index])) index++;
      yield { kind: 'word', text: text.slice(start, index), end: index };
    } else {
      yield { kind: 'symbol', text: char };
      index++;
    }
  }
}

function checkExpression(text, names) {
  const stack = [];
  let missing = false;
  for (const token of expressionTokens(text)) {
    if (token.kind === 'invalid') return { invalid: true, missing };
    if (token.kind === 'word') missing ||= referenceAt(text, token.end, token.text, names);
    else if (opening.has(token.text)) stack.push(opening.get(token.text));
    else if (closing.has(token.text) && stack.pop() !== token.text) return { invalid: true, missing };
  }
  return { invalid: stack.length > 0, missing };
}

function interpolationEnd(value, start) {
  let quoted = false;
  for (let at = start + 2; at < value.length; at++) {
    if (value[at] === "'") {
      if (quoted && value[at + 1] === "'") {
        at++;
        continue;
      }
      quoted = !quoted;
    } else if (value[at] === '}' && !quoted) return at;
  }
  return value.length;
}

export function expressionSegments(value) {
  if (value.startsWith('@') && !value.startsWith('@{') && !value.startsWith('@@')) return [value.slice(1)];
  if (!value.includes('@{')) return [];
  const segments = [];
  let from = 0;
  while (from < value.length) {
    const start = value.indexOf('@{', from);
    if (start < 0) break;
    if (start > 0 && value[start - 1] === '@') {
      from = start + 2;
      continue;
    }
    const at = interpolationEnd(value, start);
    if (at >= value.length) {
      segments.push(value.slice(start + 1));
      break;
    }
    segments.push(value.slice(start + 2, at));
    from = at + 1;
  }
  return segments;
}

function childRole(role, key) {
  if (role === 'collection') return 'declaration';
  if (role === 'cases') return 'branch';
  if (role === 'definition' && ['actions', 'triggers'].includes(key)) return 'collection';
  if (['branch', 'declaration'].includes(role) && key === 'actions') return 'collection';
  if (role === 'declaration' && key === 'cases') return 'cases';
  if (role === 'declaration' && ['else', 'default'].includes(key)) return 'branch';
  return 'value';
}

function addMembers(pending, value, depth, role) {
  for (const [key, member] of Object.entries(value)) {
    if (['definition', 'declaration'].includes(role) && ['metadata', 'description', 'summary'].includes(key)) continue;
    pending.push({ value: member, depth: depth + 1, role: childRole(role, key) });
  }
}

function inspectString(value, names, source, emit) {
  for (const expression of expressionSegments(value)) {
    const result = checkExpression(expression, names);
    if (result.invalid) emit('FLOW-EXPR-001', source, 'expression');
    if (result.missing) emit('FLOW-EXPR-002', source, 'expression');
  }
}

/** Only delimiter balance and literal references are asserted; unknown functions/types remain outside scope. */
export function inspectFlowExpressions(definition, names, source, emit, limited) {
  const pending = [{ value: definition, depth: 0, role: 'definition' }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth, role } = pending.pop();
    if (++nodes > 100000 || depth > 64) {
      emit('FLOW-SOURCE-003', source);
      limited.push({ file: source.file, reason: 'flow-expression-tree-budget' });
      break;
    }
    if (typeof value === 'string') {
      inspectString(value, names, source, emit);
    } else if (value !== null && typeof value === 'object') {
      addMembers(pending, value, depth, role);
    }
  }
}
