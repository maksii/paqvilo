import YAML from 'yaml';

/** Inspect every mapping, retaining duplicate occurrence locations before recovery. */
export function duplicateYamlDiagnostics(text, file) {
  const lines = new YAML.LineCounter();
  const document = YAML.parseDocument(text, { uniqueKeys: false, lineCounter: lines });
  const diagnostics = [];
  YAML.visit(document, {
    Map(_key, mapping) {
      const seen = new Map(),
        duplicates = [];
      for (const pair of mapping.items) {
        const key = String(pair.key?.value ?? '');
        const previous = seen.get(key);
        if (previous) duplicates.push({ key, previous, pair });
        seen.set(key, pair);
      }
      // A damaged record list repeats its identity and fields together. Report each
      // lost record once, with all the repeated keys available for tooling.
      const identities = duplicates.filter((item) => /^(?:adx_|mspp_)?name$/.test(item.key));
      for (const { key, previous, pair } of identities.length ? identities : duplicates) {
        const line = lines.linePos(pair.key.range[0]).line;
        const previousLine = lines.linePos(previous.key.range[0]).line;
        const record = /sitesettings?\.ya?ml$/i.test(file) ? 'site setting' : 'record';
        diagnostics.push({
          code: 'duplicate-yaml-key',
          file,
          line,
          previousLine,
          key,
          recovered: true,
          duplicateKeys: [...new Set(duplicates.map((item) => item.key))],
          duplicateLocations: duplicates.map((item) => ({
            key: item.key,
            line: lines.linePos(item.pair.key.range[0]).line,
            previousLine: lines.linePos(item.previous.key.range[0]).line,
          })),
          message: identities.length
            ? `${record} ${JSON.stringify(previous.value?.value)} (line ${previousLine}) is replaced by ${JSON.stringify(pair.value?.value)} (line ${line}); duplicate YAML keys.`
            : `Duplicate YAML key ${key} at line ${line} replaces line ${previousLine}.`,
        });
      }
    },
  });
  return diagnostics;
}
