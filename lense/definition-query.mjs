/** Read definition hints only. Never enumerate query values: a frame URL can
 * also contain record identifiers, credentials and unrelated application data.
 * Self-contained so browser entry points can embed the same reader.
 * `step` also admits `stepid`, the multistep (advanced) form step the platform
 * puts in the page address when it moves to a step. */
export function definitionQuery(url, { formName = false, step = false } = {}) {
  const allowed = ['entityformid', 'formid', 'entityname', 'tablename', 'etn', 'typename'];
  if (formName) allowed.push('formname');
  if (step) allowed.push('stepid');
  return [...new Set(url.searchParams.keys())]
    .filter((key) => allowed.includes(key.toLowerCase()))
    .flatMap((key) => url.searchParams.getAll(key).map((value) => [key.toLowerCase(), value]));
}
