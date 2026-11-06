// Inspect registration metadata and paired source presence. Never import the paired JavaScript.
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const booleanHints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
const objectSchema = (value) => object(value) && value.type === 'object';

function identityValid(tool) {
  return (
    object(tool) &&
    typeof tool.name === 'string' &&
    tool.name.trim() !== '' &&
    typeof tool.description === 'string' &&
    tool.description.trim() !== ''
  );
}

function closedSchemaProblem(schema) {
  if (schema.additionalProperties !== false || !Array.isArray(schema.required) || object(schema.patternProperties))
    return false;
  const properties = object(schema.properties) ? schema.properties : {};
  return schema.required.some((name) => typeof name === 'string' && !Object.hasOwn(properties, name));
}

function inspectTool(tool, source, emit) {
  if (
    !identityValid(tool) ||
    !object(tool.annotations) ||
    !booleanHints.every((key) => typeof tool.annotations[key] === 'boolean') ||
    !objectSchema(tool.inputSchema) ||
    !objectSchema(tool.outputSchema)
  ) {
    emit('MCP-META-001', source);
    return;
  }
  if (tool.annotations.readOnlyHint && tool.annotations.destructiveHint) emit('MCP-META-002', source, 'annotations');
  if (tool.annotations.openWorldHint) emit('MCP-META-003', source, 'annotations');
  if (closedSchemaProblem(tool.inputSchema)) emit('MCP-SCHEMA-001', source, 'inputSchema');
  if (Object.hasOwn(tool.outputSchema.properties ?? {}, '_meta')) emit('MCP-SCHEMA-002', source, 'outputSchema');
}

export function inspectMcpTools(entries, emit) {
  const coverage = { files: 0, tools: 0, limited: [] },
    files = new Set(entries.map((entry) => entry.file));
  for (const entry of entries) {
    if (!entry.file.endsWith('.tool.json')) continue;
    coverage.files++;
    const source = { ...entry, exactLocation: false };
    let tool;
    try {
      tool = JSON.parse(entry.text);
    } catch {
      emit('MCP-SOURCE-001', source);
      coverage.limited.push({ file: entry.file, reason: 'mcp-registration-syntax-invalid' });
      continue;
    }
    if (!object(tool) || !Object.hasOwn(tool, 'inputSchema')) {
      emit('MCP-SOURCE-002', source);
      coverage.limited.push({ file: entry.file, reason: 'mcp-registration-host-unrecognized' });
      continue;
    }
    coverage.tools++;
    inspectTool(tool, source, emit);
    if (!files.has(entry.file.slice(0, -5) + '.js')) {
      emit('MCP-PAIR-001', source);
      coverage.limited.push({ file: entry.file, reason: 'mcp-implementation-not-supplied' });
    }
  }
  return coverage;
}
