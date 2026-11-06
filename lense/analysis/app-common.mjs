import path from 'node:path';

export const appPath = (entry) => String(entry.relativeFile ?? entry.file).replaceAll('\\', '/');
export const appDirectory = (entry) => path.posix.dirname(appPath(entry));
export const appRoot = (entry) => entry.rootId ?? 'source';
export const appObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const appJson = (entry) => {
  try {
    const value = JSON.parse(entry.text);
    return appObject(value) ? value : null;
  } catch {
    return null;
  }
};
export function appEntryIndex(entries) {
  return new Map(entries.map((entry) => [`${appRoot(entry)}\0${appPath(entry)}`, entry]));
}
export function appPeer(index, entry, name) {
  const file = path.posix.join(appDirectory(entry), name);
  return index.get(`${appRoot(entry)}\0${file}`);
}
export function appRule(id, title, severity, category, message, remediation, references, confidence = 'high') {
  return { id, title, severity, category, confidence, message, remediation, references };
}
export function appCoverage(files, limitations) {
  return { files, recognized: files > 0, limitations };
}
export const atNode = (node) => node?.region?.start ?? node?.range?.[0] ?? 0;
