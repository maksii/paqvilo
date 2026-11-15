// Match /\?.*$/ without crossing a JavaScript line terminator.
export function stripLastLineQuery(text) {
  let start = text.length;
  while (start > 0 && !/[\n\r\u2028\u2029]/.test(text[start - 1])) start--;
  const query = text.indexOf('?', start);
  return query < 0 ? text : text.slice(0, query);
}
