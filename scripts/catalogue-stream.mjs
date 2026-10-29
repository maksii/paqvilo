/** Consume the complete streamed catalogue without one multi-gigabyte JS string.
 * Each table is parsed intact, including every form/field/provenance definition. */
export async function consumeCatalogue(body, inspect) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let depth = 0,
    quoted = false,
    escaped = false,
    keyText = null,
    keyKind,
    rootKey,
    tableKey;
  let rootExpectKey = true,
    tableExpectKey = true,
    inTables = false,
    foundTables = false;
  let capturing = false,
    pieces = [],
    bytes = 0,
    count = 0,
    rootClosed = false;
  const names = new Set();
  const scan = (text) => {
    let segment = capturing ? 0 : -1;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (keyText !== null) keyText += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') {
          quoted = false;
          if (keyText !== null) {
            const key = JSON.parse(keyText);
            if (keyKind === 'root') {
              rootKey = key;
              rootExpectKey = false;
            } else {
              tableKey = key;
              tableExpectKey = false;
            }
            keyText = null;
          }
        }
        continue;
      }
      if (char === '"') {
        quoted = true;
        if (depth === 1 && rootExpectKey) {
          keyText = '"';
          keyKind = 'root';
        } else if (inTables && depth === 2 && tableExpectKey) {
          keyText = '"';
          keyKind = 'table';
        }
      } else if (char === '{' || char === '[') {
        if (depth === 1 && rootKey === 'tables' && char === '{') {
          if (foundTables) throw Error('Duplicate catalogue tables section');
          foundTables = inTables = true;
          tableExpectKey = true;
        } else if (inTables && depth === 2) {
          if (char !== '{' || tableExpectKey) throw Error('Invalid catalogue table');
          capturing = true;
          segment = index;
        }
        depth++;
      } else if (char === '}' || char === ']') {
        if (capturing && depth === 3) {
          pieces.push(text.slice(segment, index + 1));
          if (names.has(tableKey)) throw Error('Duplicate catalogue table ' + tableKey);
          const value = JSON.parse(pieces.join(''));
          inspect(tableKey, value);
          names.add(tableKey);
          count++;
          capturing = false;
          segment = -1;
          pieces = [];
        } else if (inTables && depth === 2) inTables = false;
        depth--;
        if (depth < 0) throw Error('Unbalanced catalogue JSON');
        if (depth === 0) rootClosed = true;
      } else if (char === ',') {
        if (depth === 1) rootExpectKey = true;
        if (inTables && depth === 2) tableExpectKey = true;
      } else if (rootClosed && !/\s/.test(char)) throw Error('Trailing catalogue data');
    }
    if (capturing) pieces.push(text.slice(segment));
  };
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    scan(decoder.decode(chunk, { stream: true }));
  }
  scan(decoder.decode());
  if (!foundTables || !rootClosed || depth !== 0 || quoted || capturing) throw Error('Incomplete catalogue JSON');
  return { bytes, tables: count };
}
