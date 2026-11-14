import fs from 'node:fs/promises';
import path from 'node:path';

const invalidSegment = (value) =>
  typeof value !== 'string' ||
  !value ||
  value === '.' ||
  value === '..' ||
  // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
  /[<>:"/\\|?*\u0000-\u001f]/.test(value) ||
  /[. ]$/.test(value) ||
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(value);

export function validateScenarioId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9/._-]{0,160}$/i.test(id) || id.split('/').some(invalidSegment))
    throw new Error('A scenario id must contain safe nonempty relative directory segments.');
  return id;
}
export function validateCaptureLabel(label) {
  if (typeof label !== 'string' || label.length > 160 || invalidSegment(label))
    throw new Error('A capture label must be one portable directory name.');
  return label;
}
function relativeWithin(root, target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('Capture destination is outside its explicit output root.');
  return relative;
}
export function boundedScenarioDirectory(outDir, scenario, label) {
  validateScenarioId(scenario?.id);
  validateCaptureLabel(label);
  const target = path.join(outDir, ...scenario.id.split('/'), label);
  if (!relativeWithin(path.resolve(outDir), path.resolve(target)))
    throw new Error('Capture destination must be below its explicit output root.');
  return target;
}
async function statIfPresent(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** The explicit root is authoritative and may itself be a chosen directory link.
 * Every descendant must be an ordinary directory: a linked child may redirect
 * evidence outside the root even when its lexical path is well formed.
 */
export async function ensureCaptureDestination(outDir, outputRoot = outDir, { create = true, files = [] } = {}) {
  const root = path.resolve(outputRoot),
    target = path.resolve(outDir);
  const relative = relativeWithin(root, target);
  const rootStat = await statIfPresent(root);
  if (!rootStat) {
    if (!create) return;
    await fs.mkdir(root, { recursive: true });
    await fs.lstat(root);
  }
  const realRoot = await fs.realpath(root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Capture output root must be a directory.');
  if (!(await ensureCaptureChildren(root, realRoot, relative, create))) return;
  await validateCaptureFiles(target, files);
}

async function ensureCaptureChildren(root, realRoot, relative, create) {
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let observed = await statIfPresent(cursor);
    if (!observed) {
      if (!create) return false;
      try {
        await fs.mkdir(cursor);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      observed = await fs.lstat(cursor);
    }
    if (observed.isSymbolicLink() || !observed.isDirectory())
      throw new Error('Capture destination contains a linked or non-directory child.');
    relativeWithin(realRoot, await fs.realpath(cursor));
  }
  return true;
}

async function validateCaptureFiles(target, files) {
  for (const file of files) {
    if (typeof file !== 'string' || invalidSegment(file))
      throw new Error('Capture artifact must have one portable file name.');
    const observed = await statIfPresent(path.join(target, file));
    if (observed && (observed.isSymbolicLink() || !observed.isFile() || observed.nlink > 1))
      throw new Error('Capture artifact is a linked or non-file child.');
  }
}
