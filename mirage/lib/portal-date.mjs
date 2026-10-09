/** Translate the portal's .NET date formats without interpreting quoted literals. */
export function portalDateFormat(format) {
  const source = String(format ?? "");
  // Retain existing strftime compatibility for authored exports that use it.
  if (source.includes("%")) return source;
  const standard = {
    d: "M/d/yyyy",
    D: "dddd, MMMM d, yyyy",
    f: "dddd, MMMM d, yyyy h:mm tt",
    F: "dddd, MMMM d, yyyy h:mm:ss tt",
    g: "M/d/yyyy h:mm tt",
    G: "M/d/yyyy h:mm:ss tt",
    M: "MMMM d",
    m: "MMMM d",
    s: "yyyy-MM-dd'T'HH:mm:ss",
    t: "h:mm tt",
    T: "h:mm:ss tt",
    y: "MMMM yyyy",
    Y: "MMMM yyyy",
  };
  const tokens = {
    yyyy: "%Y",
    yyy: "%Y",
    yy: "%y",
    y: "%-y",
    MMMM: "%B",
    MMM: "%b",
    MM: "%m",
    M: "%-m",
    dddd: "%A",
    ddd: "%a",
    dd: "%d",
    d: "%-d",
    HH: "%H",
    H: "%-H",
    hh: "%I",
    h: "%-I",
    mm: "%M",
    m: "%-M",
    ss: "%S",
    s: "%-S",
    tt: "%p",
  };
  return (standard[source] ?? source).replace(
    /'([^']*)'|"([^"]*)"|\\(.)|yyyy|yyy|yy|y|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|tt/g,
    (token, single, double, escaped) => {
      if (single !== undefined || double !== undefined || escaped !== undefined)
        return String(single ?? double ?? escaped).replaceAll("%", "%%");
      return tokens[token];
    },
  );
}
