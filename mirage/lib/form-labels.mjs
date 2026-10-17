import sanitizeHtml from 'sanitize-html';

/** FormXml/portal metadata labels are authored markup, never record values. */
export function renderFormLabel(value) {
  return sanitizeHtml(String(value ?? ''), {
    allowedTags: ['span', 'strong', 'em', 'b', 'i', 'br', 'small', 'p', 'div', 'h2', 'h3', 'h4', 'h5', 'h6', 'a'],
    allowedAttributes: { '*': ['class', 'id', 'title', 'role', 'aria-label', 'aria-hidden'], a: ['href', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  });
}
