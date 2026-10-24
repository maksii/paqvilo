import { DataError } from './data-error.mjs';

const escape = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function portalFetchTransportSizes(xml) {
  const once = escape(xml),
    twice = escape(once);
  return { escapedXmlBytes: once.length, doubleEscapedXmlBytes: twice.length };
}
const httpSysBody = (status) =>
  [
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN""http://www.w3.org/TR/html4/strict.dtd">',
    '<HTML><HEAD><TITLE>' + (status === 414 ? 'Request URL Too Long' : 'Bad Request') + '</TITLE>',
    '<META HTTP-EQUIV="Content-Type" Content="text/html; charset=us-ascii"></HEAD>',
    '<BODY><h2>' + (status === 414 ? 'Request URL Too Long' : 'Bad Request - Request Too Long') + '</h2>',
    '<hr><p>HTTP Error ' +
      status +
      '. ' +
      (status === 414 ? 'The request URL is too long.' : 'The size of the request headers is too long.') +
      '</p>',
    '</BODY></HTML>',
    '',
  ].join('\r\n');

/** A per-site backend GET transport, distinct from FetchXML join admission.
 * Limits are effective encoded-XML budgets after the deployment's fixed URI
 * and header overhead; neither tokens nor captured query responses are inputs. */
export function assertPortalFetchXmlTransport(xml, profile) {
  if (!profile) return;
  const sizes = portalFetchTransportSizes(xml),
    bytes = sizes.doubleEscapedXmlBytes;
  if (bytes > profile.maxConstructedXmlBytes)
    throw new DataError(
      'The permission-expanded backend URI cannot be constructed.',
      500,
      'PortalQueryAdmissionFailure',
      {
        phase: 'native-api-admission',
        reason: 'uri-construction',
        ...sizes,
      },
    );
  const status = bytes > profile.maxUrlXmlBytes ? 414 : bytes > profile.maxHeaderXmlBytes ? 400 : null;
  if (status)
    throw new DataError(
      status === 414
        ? 'The permission-expanded backend URL is too long.'
        : 'The permission-expanded backend request exceeds its header budget.',
      status,
      'PortalFetchTransportFailure',
      {
        phase: 'native-api-transport',
        innerCode: '9004010D',
        innerMessage: httpSysBody(status),
        ...sizes,
      },
    );
  return sizes;
}
