import fs from 'node:fs/promises';
import path from 'node:path';

/** Check every existing path component; never traverse a symbolic link/junction. */
export async function assertScaffoldPath(file, { directory = false } = {}) {
  const target = path.resolve(file);
  const parts = [];
  for (let current = target; ; current = path.dirname(current)) {
    parts.unshift(current);
    if (path.dirname(current) === current) break;
  }
  for (const current of parts) {
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink() || ((current !== target || directory) && !info.isDirectory())) {
      throw new Error(`Scaffold path must be a regular directory without symbolic links: ${current}`);
    }
    if (current === target && !directory && !info.isFile())
      throw new Error(`Scaffold output must be a regular file: ${current}`);
  }
  return target;
}

export async function prepareScaffoldDirectory(directory, { intoExisting = false } = {}) {
  const target = await assertScaffoldPath(directory, { directory: true });
  let entries = [];
  try {
    entries = await fs.readdir(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (entries.length && !intoExisting)
    throw new Error(`Folder is not empty: ${target}. Use --into-existing to add missing files. No files were changed.`);
  await fs.mkdir(target, { recursive: true });
  return target;
}

/** Preflight the complete plan, then create exclusively; existing files are never replaced. */
export async function writeScaffold(directory, files, options = {}) {
  await assertScaffoldPath(directory, { directory: true });
  for (const name of Object.keys(files)) {
    const file = path.resolve(directory, name);
    if (!file.startsWith(path.resolve(directory) + path.sep)) throw new Error(`Invalid scaffold path: ${name}`);
    await assertScaffoldPath(file);
  }
  const target = await prepareScaffoldDirectory(directory, options);
  const created = [],
    skipped = [];
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(target, name);
    await assertScaffoldPath(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(file, body, { flag: 'wx' });
      created.push(name);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      skipped.push(name);
    }
  }
  return { directory: target, created, skipped };
}
