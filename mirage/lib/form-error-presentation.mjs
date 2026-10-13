/** A write failed after source-bound controls were validated. Transport and
 * malformed/forged control failures keep their original error response. */
export function formWriteError(error, observed, kind = 'entityform') {
  // Advanced forms have an existing LiquidServerControl inline save-error
  // contract. Basic Form.aspx documents use the error MessagePanel postback.
  if (kind !== 'entityform' || error?.nativeFormWriteFailure !== true) return null;
  return { type: 'error', message: observed?.formSubmissionErrorMessage ??
    (error.code === 'PluginValidation' && error.details?.declaredValidationMessage === true ? error.message :
      error.code === 'PermissionDenied' ? "You don't have the appropriate permissions." :
      'An error occurred while processing your request. Please try again.') };
}
