/** CSV cells are data, including when Excel opens a native export. Keep ordinary
 * signed numbers numeric; prefix formula-like text before quoting the CSV field.
 */
export function csvCell(value) {
  let text = String(value ?? '');
  const trimmed = text.trimStart();
  if (/^[=+@-]/.test(trimmed) && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
