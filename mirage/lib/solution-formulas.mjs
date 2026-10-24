import YAML from 'yaml';

export function parseSolutionFormulaDocument(text, info) {
  let document;
  try { document = YAML.parse(text, { maxAliasCount: 100 }); }
  catch { throw new Error('Formula definition YAML is invalid.'); }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error('Formula definition YAML must map column names to expressions.');
  const columns = Object.create(null);
  for (const [name, expression] of Object.entries(document)) {
    if (!/^[a-z]/i.test(name) || /[^a-z0-9_]/i.test(name) || typeof expression !== 'string' || !expression.trim())
      throw new Error('Formula definition YAML contains an unsupported column or expression.');
    const key = name.toLowerCase();
    if (Object.hasOwn(columns, key)) throw new Error('Formula definition YAML repeats a column name.');
    columns[key] = expression;
  }
  return { entityDir: info.entityDir?.toLowerCase() ?? null, file: info.formulaFile.toLowerCase(), columns };
}

export function solutionFormulaResolver(documents, diagnostics) {
  const files = new Map();
  for (const doc of documents) {
    const definitions = doc.facts.formulaDefinitions;
    if (!definitions) continue;
    const key = `${definitions.entityDir ?? '*'}/${definitions.file}`;
    if (files.has(key)) {
      files.set(key, null);
      diagnostics.push({ code: 'SOLUTION_FORMULA_AMBIGUOUS', severity: 'error', source: doc.file,
        message: 'Multiple formula definition files have the same table and filename.' });
    } else files.set(key, { ...definitions, source: doc.file });
  }
  return (entity, attribute, source, entityDir = entity) => {
    const reference = attribute.formulaDefinitionFileName;
    if (!reference || attribute.formulaDefinition) return attribute;
    // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
    const match = typeof reference === 'string' && !/[\x00-\x1f\x7f]/.test(reference)
      ? /^\/?Formulas\/([^/\\:]+\.ya?ml)$/i.exec(reference) : null;
    const scopedKey = match ? `${entityDir.toLowerCase()}/${match[1].toLowerCase()}` : null;
    const definition = match ? (files.has(scopedKey) ? files.get(scopedKey) : files.get(`*/${match[1].toLowerCase()}`)) : null;
    const expression = definition?.columns[attribute.name.toLowerCase()];
    if (expression) return { ...attribute, formulaDefinition: expression, formulaDefinitionSource: definition.source };
    diagnostics.push({ code: !match ? 'SOLUTION_FORMULA_REFERENCE_INVALID' : 'SOLUTION_FORMULA_DEFINITION_MISSING',
      severity: 'warning', entity, attribute: attribute.name, source,
      message: !match ? 'Formula definition references must name a YAML file directly under the table Formulas directory.'
        : 'The referenced formula file does not provide this column expression.' });
    return attribute;
  };
}
