// Adapter for the liquid-render surface: recorded Liquid source -> Mirage portal renderer -> rendered text.
// Only `input` drives the renderer. Its `observed` options are the ones the native capture ran under.
// `templates` (optional) are the web templates, keyed by id, that the native page had available for the
// source to include; they are passed to the renderer as the portal's templates.
import { createPortalRenderer } from '../../../lib/liquid.mjs';

const EMPTY_PORTAL = {
  templates: {},
  snippets: {},
  settings: {},
  pages: [],
  webFiles: [],
  records: [],
  weblinks: {},
  sitemarkers: {},
  website: {},
  pageTemplates: [],
};

const renderers = new Map();

function rendererFor(observed, templates) {
  const key = JSON.stringify([observed ?? {}, templates ?? {}]);
  if (!renderers.has(key)) {
    const portal = structuredClone(EMPTY_PORTAL);
    portal.templates = Object.fromEntries(
      Object.entries(templates ?? {}).map(([id, source]) => [id, { id, name: id, source }]),
    );
    renderers.set(key, createPortalRenderer(portal, { observed: observed ?? {} }));
  }
  return renderers.get(key);
}

/**
 * Renders the recorded source and returns the oracle-shaped output.
 * @param {{ source: string, observed?: object, templates?: Record<string, string> }} input recorded input of one case
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 * @returns {Promise<{ output: string }>} rendered text
 */
export default async function run(input, _context) {
  return { output: await rendererFor(input.observed, input.templates).renderString(input.source, {}) };
}
