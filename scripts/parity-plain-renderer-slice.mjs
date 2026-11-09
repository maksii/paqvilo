// Compose the existing strict single-parent isolation certificate without widening it.
// This is source provenance only; semantic review and native parity remain caller responsibilities.
import { analyzeUnselectedFixtureSlice } from './parity-generated-fixtures.mjs';

const empty = () => ({
  recognizedIdentifiers: new Set(),
  recognizedBuiltinImports: new Set(),
  handledInputSources: new Set(),
  dependencies: [],
  fixtures: [],
  isolatedIdentifiers: new Set(),
});
const sameSet = (left, right) => left.size === right.size && [...left].every((value) => right.has(value));

/** Require each distinct selected parent to pass the same singleton certificate and isolation boundary. */
export function analyzePlainRendererSlice(options) {
  const { selected } = options;
  if (!Array.isArray(selected) || selected.length === 0) return empty();
  const rows = selected.map((entry) => entry?.old);
  if (
    rows.some((row) => !row?.callback || typeof row.id !== 'string' || row.parent || row.loops?.length) ||
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    new Set(rows.map((row) => row.callback)).size !== rows.length
  )
    return empty();
  const parts = rows.map((row) => analyzeUnselectedFixtureSlice({ ...options, selected: [{ old: row }] }));
  if (
    parts.some(
      (part, i) =>
        part.fixtures.length !== 1 || part.fixtures[0].baselineId !== rows[i].id || !part.isolatedIdentifiers.size,
    )
  )
    return empty();
  const first = parts[0];
  const fields = ['recognizedIdentifiers', 'recognizedBuiltinImports', 'handledInputSources', 'isolatedIdentifiers'];
  const core = ({ baselineId: _baselineId, ...fixture }) => JSON.stringify(fixture);
  if (
    parts.some(
      (part) =>
        fields.some((field) => !sameSet(first[field], part[field])) ||
        JSON.stringify(first.dependencies) !== JSON.stringify(part.dependencies) ||
        core(first.fixtures[0]) !== core(part.fixtures[0]),
    )
  )
    return empty();
  return {
    recognizedIdentifiers: new Set(first.recognizedIdentifiers),
    recognizedBuiltinImports: new Set(first.recognizedBuiltinImports),
    handledInputSources: new Set(first.handledInputSources),
    dependencies: first.dependencies.map((dependency) => ({ ...dependency })),
    fixtures: parts.flatMap((part) => part.fixtures),
    isolatedIdentifiers: new Set(first.isolatedIdentifiers),
    requiresAllRegistrations: true,
    requiresModuleIsolationProof: true,
  };
}
