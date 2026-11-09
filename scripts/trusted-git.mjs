import fs from 'node:fs';
import path from 'node:path';

/** Automatic POSIX paths must be root-owned and not group/other writable; an absolute override is trusted by its owner. */
export function resolveGitExecutable({ env = process.env, platform = process.platform } = {}) {
  const override = env.PAQVILO_GIT_EXECUTABLE;
  if (override !== undefined) {
    if (typeof override !== 'string' || !path.isAbsolute(override))
      throw new Error('PAQVILO_GIT_EXECUTABLE must be an absolute path to a native Git executable.');
    return executable(override, platform, true);
  }
  let locations = ['/usr/bin/git', '/usr/local/bin/git'];
  if (platform === 'win32')
    locations = [
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe',
    ];
  else if (platform === 'darwin') locations.push('/opt/homebrew/bin/git');
  for (const candidate of locations) {
    const resolved = executable(candidate, platform, false);
    if (resolved && (platform === 'win32' || trustedPosixPath(resolved))) return resolved;
  }
  throw new Error(
    'Git was not found in a trusted system location. Set PAQVILO_GIT_EXECUTABLE to an absolute Git executable path.',
  );
}

function trustedPosixPath(file) {
  try {
    let current = file;
    for (;;) {
      const stat = fs.statSync(current);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
      const parent = path.dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  } catch {
    return false;
  }
}

function executable(candidate, platform, required) {
  try {
    const resolved = fs.realpathSync(candidate);
    if (!path.isAbsolute(resolved) || !fs.statSync(resolved).isFile()) throw new Error('not a regular file');
    if (platform === 'win32' && path.extname(resolved).toLowerCase() !== '.exe') throw new Error('not an executable');
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch {
    if (required) throw new Error('PAQVILO_GIT_EXECUTABLE must name an existing executable regular file.');
    return null;
  }
}
