import { randomUUID } from 'node:crypto';
import { siteSetting } from './redirects.mjs';

const INVALID_PLUGIN = 'InvalidPluginExecutionException';
const UNKNOWN_FAILURE = (id) => `An unknown failure has occurred. Error ID # [${id}]`;

/** An InvalidPluginExecutionException: the pipeline's fault identity, else the 0x80040265 code, else a plug-in refusal code. */
function pluginRefusal(error) {
  if (error.traceError?.type) return error.traceError.type === INVALID_PLUGIN;
  const inner = error.details?.innerCode;
  if (typeof inner === 'string') return inner.toLowerCase() === '0x80040265';
  return error.code === 'PluginValidation' || error.pluginFault === INVALID_PLUGIN;
}

const customPluginErrors = (portal) =>
  String(siteSetting(portal ?? {}, 'Site/EnableCustomPluginError') ?? '')
    .trim()
    .toLowerCase() === 'true';

/** A write failed after source-bound controls were validated. Transport and
 * malformed/forged control failures keep their original error response. */
export function formWriteError(error, observed, kind = 'entityform', portal = null) {
  // Advanced forms keep their own failure path; Basic Form.aspx documents use the error MessagePanel postback.
  if (kind !== 'entityform' || error?.nativeFormWriteFailure !== true || error.details?.validationErrors?.length)
    return null;
  const markup = observed?.formSubmissionErrorMarkup ? { markup: observed.formSubmissionErrorMarkup } : {};
  // A plug-in's InvalidPluginExecutionException (observed natively, basic-form create and update): the generic text with
  // an Error ID that is the response's x-ms-request-id, or the plug-in's message when Site/EnableCustomPluginError is true.
  if (pluginRefusal(error)) {
    const requestId = randomUUID();
    return {
      type: 'error',
      ...markup,
      message: customPluginErrors(portal) ? String(error.message) : UNKNOWN_FAILURE(requestId),
      requestId,
    };
  }
  return { type: 'error', ...markup, message: observed?.formSubmissionErrorMessage ?? fallbackErrorMessage(error) };
}

function fallbackErrorMessage(error) {
  if (error.code === 'PermissionDenied') return "You don't have the appropriate permissions.";
  return 'An error occurred while processing your request. Please try again.';
}

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * The basic form's error MessagePanel after a failed save. Bootstrap 5 sites render the
 * platform's close button and a danger paragraph with a warning icon; an observed
 * `formSubmissionErrorMarkup` keeps its recorded shape.
 */
export function formErrorPanel(outcome, { v5 = false, closeButton = '' } = {}) {
  const message = escapeHtml(outcome?.message);
  if (v5 && !outcome?.markup)
    return `<div id="MessagePanel" class="message alert alert-danger" role="alert">${closeButton}<span id="MessageLabel" aria-live="polite" aria-atomic="true"><p class="text-danger"><span class="fa fa-exclamation-triangle" aria-hidden="true"></span> ${message}</p></span></div>`;
  const markup = outcome?.markup === 'paragraph' ? `<p>${message}</p>` : message;
  return `<div id="MessagePanel" class="message alert alert-danger" role="alert"><span id="MessageLabel">${markup}</span></div>`;
}

/**
 * Create-mode table-permission denial inside the form panel: the
 * EntitySecurity/Record/CreateAccessDeniedMessage snippet, by default the lock alert, in an
 * editable-snippet wrapper, followed by an empty actions row.
 */
export function createAccessDeniedForm({ ids, formName, defaultButton = 'InsertButton', snippet }) {
  const message =
    typeof snippet === 'string'
      ? snippet
      : "<div class='alert alert-block alert-danger'><span class='fa fa-lock' aria-hidden='true'></span>You don't have the appropriate permissions.</div>";
  return `<div id="${escapeHtml(ids.wrapper)}"><div id="${escapeHtml(ids.panel)}" class="crmEntityFormView" data-form-name="${escapeHtml(formName)}" onkeypress="javascript:return WebForm_FireDefaultButton(event, '${escapeHtml(defaultButton)}')" role="form" aria-label="Basic Form"><div id="${escapeHtml(ids.view)}" class="entity-form"><div><div class="xrm-editable-html xrm-attribute"><div class="xrm-attribute-value">${message}</div></div></div></div><div class="actions"></div></div></div>`;
}
