import fs from 'node:fs';
import path from 'node:path';

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Index trusted source links. Resolve each path once per report, never per occurrence. */
export function annotateRuntimeSources(report, { sourceDir, roots, realpath = fs.realpathSync.native }) {
  const files = new Map(), references = new Map();
  if (!Array.isArray(roots) || !roots.length) return files;
  const reference = file => {
    if (typeof file !== 'string' || !file) return null;
    if (references.has(file)) return references.get(file);
    let absolute;
    try { absolute = realpath(file); } catch { absolute = path.resolve(file); }
    let ref = null;
    if (inside(roots[0], absolute)) ref = path.relative(roots[0], absolute).replaceAll('\\', '/');
    else {
      const index = roots.findIndex((root, index) => index > 0 && inside(root, absolute));
      if (index >= 0) {
        const name = path.basename(roots[index]);
        const duplicate = roots.slice(0, index).some(root => path.basename(root) === name);
        ref = `@${name}${duplicate ? `~${index}` : ''}/${path.relative(roots[index], absolute).replaceAll('\\', '/')}`;
      }
    }
    const found = ref ? { ref, path: absolute } : null;
    if (ref) files.set(ref, absolute);
    references.set(file, found);
    return found;
  };
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 8) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    const file = typeof value.sourceFile === 'string' ? value.sourceFile
      : typeof value.file === 'string' ? value.file
        : typeof value.relativePath === 'string' ? path.resolve(sourceDir, value.relativePath)
          : typeof value.rel === 'string' ? path.resolve(sourceDir, value.rel) : null;
    const found = reference(file);
    if (found) Object.assign(value, found);
    if (Array.isArray(value.sourceFiles)) value.sourceRefs = value.sourceFiles.map(reference).filter(Boolean);
    for (const [key, child] of Object.entries(value)) if (key !== 'sourceRefs' && child && typeof child === 'object') visit(child, depth + 1);
  };
  visit(report, 0);
  return files;
}
