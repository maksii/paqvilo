// Strip the dotnet project suffix from a single compiler output line.
export function stripCsprojSuffix(line) {
  if (!line.endsWith('.csproj]')) return line;
  const suffixStart = line.length - '.csproj]'.length;
  const previousClose = line.lastIndexOf(']', suffixStart - 1);
  const open = line.indexOf('[', previousClose + 1);
  if (open < 0 || open > suffixStart) return line;
  let start = open;
  while (start > 0 && /\s/.test(line[start - 1])) start--;
  return line.slice(0, start);
}
