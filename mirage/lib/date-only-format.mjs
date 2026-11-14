// A column's exported Format names a Date Only column as `date` or `dateonly`, in any case.
const DATE_ONLY_FORMAT = /^date(?:only)?$/i;

export function isDateOnlyFormat(format) {
  return DATE_ONLY_FORMAT.test(String(format ?? ''));
}
