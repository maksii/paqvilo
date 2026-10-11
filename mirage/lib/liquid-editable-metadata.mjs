import { httpUtilityUrlEncode } from './liquid-dotnet.mjs';

const attr = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const base64 = value => Buffer.from(String(value), 'utf8').toString('base64');

/**
 * Observed non-editor metadata only. The caller supplies the source's distinct root/content IDs
 * and the captured working flag explicitly; this does not install authoring endpoints.
 */
export function editableMetadataAttributes({ observed, websiteId, rootId, contentId, key, requestPath, encoded = false, liquid = true, label = '', workingFlag }) {
  if (observed?.liquidEditableMetadata !== 'observed') return '';
  if (![websiteId, rootId, contentId, key, requestPath, workingFlag].every(value => value != null && value !== '')) return '';
  const record = '/_services/portal/' + websiteId + '/adx_webpage/' + contentId;
  const path = httpUtilityUrlEncode(base64(requestPath));
  const attributes = {
    'data-cmstemplate-render-url': record + '/__templates/live-preview/' + path,
    'data-cmstemplate-url': record + '/__templates/all/' + path,
    'data-editable-title': key,
    'data-editable-url': record + '/' + key,
    'data-encoded': String(encoded).toLowerCase(),
    'data-filebrowser-dialog-url': '~/xrm-adx/filebrowser.html',
    'data-filebrowser-url': '/_services/portal/' + websiteId + '/elFinder/connector?working=' + base64('adx_webpage:' + rootId + ':' + workingFlag),
    'data-label': label,
    'data-liquid': String(liquid).toLowerCase(),
    'data-xrm-base': '/xrm-adx/',
  };
  return Object.keys(attributes).sort().map(name => ' ' + name + '="' + attr(attributes[name]) + '"').join('');
}
