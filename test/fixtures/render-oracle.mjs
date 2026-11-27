// The Mirage render as the oracle of the live alignment (lense/response-alignment.mjs): a page rendered in process
// with provenance knows which source region or Liquid code wrote each element; its HTML without the provenance marks
// is what a live portal would serve. Each start tag is classified by what the alignment of that HTML answers:
// AGREE (the same source and place), WEAKER (true but less precise: the Liquid code around it, an includer, one of
// identical places), MISS (no source named where the render knows one) or WRONG (another source, another place, a
// difference on an unchanged export).
import { parse } from 'parse5';
import { alignDocument, sourceItems } from '../../lense/response-alignment.mjs';
import { isToolkitElement } from '../../mirage/lib/render-provenance.mjs';
import { runWithSourceDebugging } from '../../mirage/lib/source-debug.mjs';

const MARK = /\sdata-paqvilo-(?:source|script)="[^"]*"/g;

/** The rendered document without provenance marks, and each marked element's binding at its unmarked offset. */
export function oracleOf(html, provenance) {
  const byId = new Map(provenance.bindings.map((binding) => [binding.id, binding]));
  const cuts = [];
  for (const match of html.matchAll(MARK)) cuts.push([match.index, match[0].length]);
  const shift = (offset) => {
    let removed = 0;
    for (const [at, length] of cuts) {
      if (at >= offset) break;
      removed += length;
    }
    return offset - removed;
  };
  const plain = html.replace(MARK, '');
  const elements = [];
  const walk = (node, parent) => {
    for (const child of node.childNodes ?? []) {
      let here = parent;
      if (child.tagName) {
        const location = child.sourceCodeLocation?.startTag;
        const names = child.attrs.map((attribute) => attribute.name);
        if (location && !isToolkitElement(names)) {
          const id = child.attrs.find((attribute) => attribute.name === 'data-paqvilo-source')?.value;
          elements.push({ start: shift(location.startOffset), tag: child.tagName, binding: byId.get(id) ?? null, parent });
          here = elements.at(-1);
        }
      }
      walk(child, here);
      if (child.content) walk(child.content, here);
    }
  };
  walk(parse(html, { sourceCodeLocationInfo: true }), null);
  return { plain, elements };
}

const sameText = (index, a, ra, b, rb) => {
  const x = index.sources.get(a)?.text;
  const y = index.sources.get(b)?.text;
  return x != null && y != null && x.slice(ra.start, ra.end) === y.slice(rb.start, rb.end);
};
const SHELL_KINDS = new Set(['platform-shell', 'web-file', 'platform-asset']);
const COMPONENT_TAGS = new Set(['entityform', 'entitylist', 'webform', 'codecomponent', 'entityview', 'chart', 'powerbi']);
const within = (inner, outer) => inner.start >= outer.start && inner.end <= outer.end;
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

// The source extent of a literal element: from its start tag to its matching end tag in the source.
const extents = new Map();
function extentOf(index, sourceRefId, start) {
  const source = index.sources.get(sourceRefId);
  if (!source) return null;
  let items = extents.get(source);
  if (!items) extents.set(source, (items = sourceItems(source.text).items));
  const at = items.findIndex((item) => item.t === 'start' && item.start === start);
  if (at < 0) return null;
  const close = items[at].close;
  return { start, end: close === undefined ? source.text.length : items[close].start };
}
/** Whether Liquid code at `region` of `sourceRefId` stands inside an element the render bound around this one. */
function writtenByEnclosing(index, element, sourceRefId, region) {
  for (let up = element?.parent; up; up = up.parent) {
    const binding = up.binding;
    if (binding?.mapping !== 'literal' || binding.sourceRefId !== sourceRefId) continue;
    const extent = extentOf(index, sourceRefId, binding.region.start);
    if (extent && region.start >= binding.region.end && region.end <= extent.end) return true;
  }
  return false;
}

/**
 * One element: AGREE, WEAKER, MISS or WRONG, with a reason. `oracle` is the render binding (literal, derived,
 * platform, conflicting), `served` the alignment binding of the same start tag.
 */
export function classify(index, oracle, served, element = null) {
  if (!oracle) return { verdict: 'UNBOUND', reason: 'render left it unbound' };
  const mapping = served?.mapping ?? 'none';
  const contextIds = (binding) => (binding.contexts ?? []).map((context) => context.sourceRefId).filter(Boolean);
  const oracleSources = new Set(
    [oracle.sourceRefId, ...(oracle.sourceRefIds ?? [])].filter(Boolean),
  );
  const oracleChain = new Set([...oracleSources, ...contextIds(oracle)]);
  const kind = oracle.mapping === 'platform' ? oracle.component?.kind : null;
  // The page shell and the elements the shell writes for web files and portal assets: no markup source wrote them.
  if (SHELL_KINDS.has(kind) || (oracle.mapping === 'platform' && !oracleChain.size)) {
    if (mapping === 'shell' || mapping === 'none') return { verdict: 'AGREE', reason: `shell (${kind})` };
    return { verdict: 'WRONG', reason: `render platform ${kind}; served ${mapping}` };
  }
  if (kind === 'webpage-field') {
    // The wrapper an editable tag writes, or the script/style element the portal writes for a field.
    if (mapping === 'generated' && (served.carrier || served.liquid?.some((token) => token.name === 'editable')))
      return { verdict: 'AGREE', reason: 'webpage-field generated by its tag' };
    if (mapping === 'shell' || mapping === 'none') return { verdict: 'MISS', reason: 'webpage-field -> shell' };
    if (mapping === 'generated') return { verdict: 'WEAKER', reason: 'webpage-field generated by enclosing code' };
    return { verdict: 'WRONG', reason: `webpage-field -> ${mapping}` };
  }
  if (kind) {
    // A part of a form, list or code component: the Liquid tag that rendered the component is the answer.
    if (mapping === 'shell' || mapping === 'none') return { verdict: 'MISS', reason: `${kind} -> shell` };
    if (mapping === 'conflict') return { verdict: 'MISS', reason: `${kind} -> conflict` };
    if (mapping === 'generated') {
      const names = (served.liquid ?? []).map((token) => token.name);
      const tags = names.filter((name) => COMPONENT_TAGS.has(name));
      if (names.length === 1 && tags.length === 1) return { verdict: 'AGREE', reason: `${kind} generated by its tag` };
      if (tags.length) return { verdict: 'WEAKER', reason: `${kind} generated by code holding several tags` };
      if (names.length === 1 && (names[0] === 'include' || names[0] === 'render'))
        return { verdict: 'WEAKER', reason: `${kind} generated by an include` };
      return { verdict: 'WRONG', reason: `${kind} generated by code without a component tag [${names}]` };
    }
    return { verdict: 'WRONG', reason: `${kind} -> ${mapping}` };
  }
  if (mapping === 'shell' || mapping === 'none') return { verdict: 'MISS', reason: `${oracle.mapping} -> ${mapping}` };
  if (mapping === 'drift') return { verdict: 'WRONG', reason: 'drift on the same export' };
  if (mapping === 'conflict')
    return served.sourceRefIds.some((id) => oracleChain.has(id))
      ? { verdict: 'MISS', reason: 'conflict incl. right source' }
      : { verdict: 'WRONG', reason: 'conflict of other sources' };
  const id = served.sourceRefId;
  if (oracle.mapping === 'literal') {
    if (mapping === 'aligned') {
      if (id === oracle.sourceRefId) {
        if (served.region.start === oracle.region.start && served.region.end === oracle.region.end)
          return served.oneOf
            ? { verdict: 'WEAKER', reason: 'aligned oneOf (right place among twins)' }
            : { verdict: 'AGREE', reason: 'aligned' };
        if (sameText(index, id, served.region, oracle.sourceRefId, oracle.region))
          return served.oneOf
            ? { verdict: 'WEAKER', reason: 'aligned oneOf' }
            : // The same markup at another place of the file, named as that place: a false line.
              { verdict: 'WRONG', reason: 'aligned at an identical twin without oneOf' };
        // A dynamic tag: the render binds the whole tag region; the alignment its own tag region. Same start.
        if (served.region.start === oracle.region.start) return { verdict: 'AGREE', reason: 'aligned same start' };
        return { verdict: 'WRONG', reason: 'aligned at another place of the source' };
      }
      if (sameText(index, id, served.region, oracle.sourceRefId, oracle.region))
        return { verdict: 'WRONG', reason: 'aligned in another source with the same markup' };
      return { verdict: 'WRONG', reason: 'aligned in another source' };
    }
    if (mapping === 'generated') {
      if (id === oracle.sourceRefId) return { verdict: 'WEAKER', reason: 'generated by its own source' };
      if (oracleChain.has(id)) return { verdict: 'WEAKER', reason: 'generated by an includer' };
      if (writtenByEnclosing(index, element, id, served.region))
        return { verdict: 'WEAKER', reason: 'generated by code inside an enclosing element' };
      return { verdict: 'WRONG', reason: 'generated by an unrelated source' };
    }
  }
  if (oracle.mapping === 'derived' || oracle.mapping === 'platform' || oracle.mapping === 'conflicting') {
    if (mapping === 'aligned') {
      // The render says code wrote it; the alignment that a literal tag of a source is it.
      if (oracleSources.has(id) && oracle.region && within(served.region, oracle.region))
        return { verdict: 'AGREE', reason: 'aligned inside the code region' };
      return { verdict: 'WRONG', reason: `render ${oracle.mapping}; served aligned` };
    }
    if (mapping === 'generated') {
      if (oracleSources.has(id)) {
        if (!oracle.region || overlaps(served.region, oracle.region) || served.carrier)
          return { verdict: 'AGREE', reason: `generated, ${oracle.mapping}` };
        return { verdict: 'WEAKER', reason: `generated elsewhere in the writer, ${oracle.mapping}` };
      }
      if (oracleChain.has(id)) return { verdict: 'WEAKER', reason: `generated by an includer, ${oracle.mapping}` };
      if (writtenByEnclosing(index, element, id, served.region))
        return { verdict: 'WEAKER', reason: `generated by code inside an enclosing element, ${oracle.mapping}` };
      return { verdict: 'WRONG', reason: `generated by an unrelated source, ${oracle.mapping}` };
    }
  }
  return { verdict: 'WRONG', reason: `unhandled ${oracle.mapping} / ${mapping}` };
}

/** Renders `url` with provenance, aligns the same HTML without marks, and classifies every element. */
export async function differential(renderer, url, identity, align = alignDocument) {
  // Without the debugger's source URLs and maps in script bodies: a live portal serves none.
  const rendered = await runWithSourceDebugging(false, () => renderer.renderPage(url, identity ? { user: identity } : {}));
  const traced = renderer.provenanceFor(rendered);
  if (!traced) return null;
  const { plain, elements } = oracleOf(traced.html, traced.provenance);
  const index = renderer.sourceIndex();
  const route = new URL(url, 'http://x.invalid').pathname;
  const aligned = align(plain, index, route);
  const counts = { AGREE: 0, WEAKER: 0, MISS: 0, WRONG: 0, UNBOUND: 0 };
  const rows = [];
  for (const element of elements) {
    const served = aligned.byStart.get(element.start) ?? null;
    const { verdict, reason } = classify(index, element.binding, served, element);
    counts[verdict]++;
    rows.push({ ...element, served, verdict, reason });
  }
  return { url, status: rendered.status, served: rendered.html, plain, rows, counts, index, alignment: aligned, provenance: traced.provenance };
}
