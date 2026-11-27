// Adapter for the page-layout surface: a recorded page path of a portal -> Mirage portal renderer -> the breadcrumb
// the rewrite page layout writes above the page title.
// Only `input` drives the renderer: the site settings, the chain of pages from the home page down to the rendered one
// (title, partial URL, whether it is hidden from the site map, and its page template's rewrite address) and the web
// templates the site had (its own Breadcrumbs template among them, which the layout may or may not use).
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
// Invented record ids: the recorded input names pages by their place in the path only.
const id = (group, index) => `0000000${group}-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** The portal the recorded input describes, and the address of its last page. */
function portalOf(input) {
  const portal = structuredClone(EMPTY_PORTAL);
  portal.settings = { ...input.settings };
  portal.templates = Object.fromEntries(
    Object.entries(input.templates ?? {}).map(([name, source], index) => [
      name,
      { id: id(3, index), name, source, metadata: { kind: 'webtemplate', id: id(3, index), name } },
    ]),
  );
  let url = '/';
  input.pages.forEach((page, index) => {
    if (index) url += `${page.partialUrl}/`;
    const template = page.rewriteUrl ?? (index === input.pages.length - 1 ? input.rewriteUrl : null);
    if (template && !portal.pageTemplates.some((item) => item.rewriteUrl === template))
      portal.pageTemplates.push({
        id: id(2, portal.pageTemplates.length),
        name: `Rewrite ${portal.pageTemplates.length}`,
        webTemplateId: null,
        useHeaderFooter: true,
        rewriteUrl: template,
        metadata: { kind: 'pagetemplate', id: id(2, portal.pageTemplates.length) },
      });
    portal.pages.push({
      id: id(1, index),
      name: `Page ${index}`,
      title: page.title,
      url,
      parentId: index ? id(1, index - 1) : null,
      pageTemplateId: template ? portal.pageTemplates.find((item) => item.rewriteUrl === template).id : null,
      html: '',
      css: '',
      js: '',
      summary: '',
      formId: null,
      advancedFormId: null,
      listId: null,
      metadata: { kind: 'webpage', id: id(1, index), adx_hiddenfromsitemap: Boolean(page.hiddenFromSitemap) },
    });
  });
  return { portal, url };
}

/**
 * Renders the last page of the recorded path and returns its breadcrumb list as the response holds it.
 * @param {{ settings: object, rewriteUrl: string, pages: object[], templates?: Record<string, string> }} input
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 * @returns {Promise<{ breadcrumb: string | null }>} the `<ul class="breadcrumb">` element, or null when the page has none
 */
export default async function run(input, _context) {
  const { portal, url } = portalOf(input);
  const rendered = await createPortalRenderer(portal, {}).renderPage(url, {});
  const html = String(rendered.html ?? '');
  const start = html.indexOf('<ul class="breadcrumb">');
  const end = start < 0 ? -1 : html.indexOf('</ul>', start);
  return { breadcrumb: end < 0 ? null : html.slice(start, end + '</ul>'.length) };
}
