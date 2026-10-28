import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dependencyReadiness } from './ensure-dependencies.mjs';

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

export function auditGit(root, args, options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  return spawnSync('git', ['--no-optional-locks', ...args], { cwd: root, env, windowsHide: true, ...options });
}

async function artifactParents(root, file) {
  let directory = root;
  for (const part of path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)) {
    directory = path.join(directory, part);
    await fs.mkdir(directory).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('Audit output parents must be ordinary owned directories.');
  }
}

/** Output is exclusive, under ignored audit storage. Its parents remain trusted owned storage. */
export async function auditOutput(root, requested) {
  const physicalRoot = await fs.realpath(root);
  const logicalAudit = path.join(path.resolve(root), '.paqvilo', 'audit');
  const physicalAudit = path.join(physicalRoot, '.paqvilo', 'audit');
  const candidate = path.resolve(root, requested);
  const base = inside(logicalAudit, candidate) ? logicalAudit : physicalAudit;
  if (!inside(base, candidate) || candidate === base || path.extname(candidate).toLowerCase() !== '.json')
    throw new Error('Benchmark output must be a new JSON file under ignored .paqvilo/audit/.');
  const file = path.join(physicalAudit, path.relative(base, candidate));
  await artifactParents(physicalRoot, file);
  const relative = path.relative(physicalRoot, file);
  const ignored = auditGit(physicalRoot, ['check-ignore', '--quiet', '--', relative]);
  const tracked = auditGit(physicalRoot, ['ls-files', '--error-unmatch', '--', relative], {
    stdio: 'ignore',
  });
  if (ignored.status !== 0 || tracked.status === 0) throw new Error('Benchmark output must be ignored and untracked.');
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { root: physicalRoot, file };
    throw error;
  }
  throw new Error('Benchmark output already exists; use a new report name.');
}

export async function writeAuditOutput(output, content) {
  await artifactParents(output.root, output.file);
  const handle = await fs.open(output.file, 'wx', 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

export async function auditDependencies(root) {
  const readiness = dependencyReadiness(root);
  if (!readiness.ready) throw new Error('Benchmark dependencies are not prepared: ' + readiness.reason);
  const hash = createHash('sha256');
  let packages = 0;
  let files = 0;
  const fingerprint = async (directory, relative = '') => {
    if (!relative && (await fs.lstat(directory)).isSymbolicLink())
      throw new Error('Benchmark qualification cannot certify linked dependency contents.');
    for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === 'node_modules') continue; // Nested packages have their own lock entries.
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('Benchmark qualification cannot certify linked dependency contents.');
      } else if (entry.isDirectory()) await fingerprint(directory, name);
      else if (entry.isFile()) {
        hash.update(JSON.stringify(['file', name]));
        hash.update(
          createHash('sha256')
            .update(await fs.readFile(path.join(directory, name)))
            .digest(),
        );
        files++;
      }
    }
  };
  for (const project of readiness.projects) {
    const directory = path.join(root, project.directory);
    const file = project.directory === '.' ? 'npm-shrinkwrap.json' : 'package-lock.json';
    const bytes = await fs.readFile(path.join(directory, file));
    hash.update(project.directory).update(bytes);
    const lock = JSON.parse(bytes);
    for (const name of Object.keys(lock.packages ?? {})
      .filter((name) => name.startsWith('node_modules/'))
      .sort()) {
      const entry = lock.packages[name];
      const matches = (list, value) =>
        !list || (!list.includes(`!${value}`) && (list.every((item) => item.startsWith('!')) || list.includes(value)));
      if (!matches(entry.os, process.platform) || !matches(entry.cpu, process.arch)) continue;
      try {
        const installed = JSON.parse(await fs.readFile(path.join(directory, name, 'package.json'), 'utf8'));
        hash.update(name).update(String(installed.version));
        await fingerprint(path.join(directory, name));
        packages++;
      } catch (error) {
        if (error.code !== 'ENOENT' || !lock.packages[name].optional) throw error;
      }
    }
  }
  return {
    sha256: hash.digest('hex'),
    packages,
    files,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  };
}
