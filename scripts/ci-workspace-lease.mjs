import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const variable = 'PAQ_CI_WORKSPACE_LEASE';
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};
const valid = (owner) =>
  owner &&
  typeof owner.root === 'string' &&
  Number.isSafeInteger(owner.pid) &&
  owner.pid > 0 &&
  typeof owner.token === 'string' &&
  owner.token.length > 0;
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** CI output must belong to this checkout; only the verified tool cache is shared. */
export function assertOwnedCiState(checkout, ...descendants) {
  const root = fs.realpathSync(checkout);
  let directory = root;
  for (const part of ['.paqvilo', 'ci', ...descendants]) {
    if (typeof part !== 'string' || !part || part === '.' || part === '..' || /[\\/]/.test(part))
      throw new Error('CI state components must be plain directory names.');
    directory = path.join(directory, part);
    try {
      fs.mkdirSync(directory);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const physical = fs.realpathSync(directory);
    if (path.relative(directory, physical) !== '')
      throw new Error('CI state must stay inside its checkout; shared .paqvilo/ci junctions are unsupported.');
    directory = physical;
  }
  return directory;
}

/** Never retire an abandoned lease automatically: a killed owner can leave live
 * worker processes. Keep it for inspection until those workers have been stopped. */
export async function acquireCiWorkspaceLease(checkout, environment = process.env, { inherit = false } = {}) {
  const root = fs.realpathSync(checkout),
    directory = path.join(assertOwnedCiState(root), 'workspace.lock');
  const ownerFile = path.join(directory, 'owner.json'),
    members = path.join(directory, 'members');
  let inherited;
  try {
    inherited = JSON.parse(environment[variable] ?? 'null');
  } catch {
    /* Invalid markers cannot bypass acquisition. */
  }
  const prior = read(ownerFile);
  const busy = () =>
    new Error(
      `Validation or dependency preparation already owns this checkout${valid(prior) ? ` (PID ${prior.pid})` : ''}. Finish that run first. If it stopped unexpectedly, verify its workers have stopped before removing ${directory}.`,
    );
  const membership = async (operation) => {
    const guard = path.join(directory, 'membership'),
      deadline = Date.now() + 3000;
    for (;;) {
      try {
        fs.mkdirSync(guard);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw busy();
        await setTimeout(10);
      }
    }
    const generation = read(ownerFile)?.token;
    try {
      return operation();
    } finally {
      // The owner may have moved its entire directory during a successful release.
      if (read(ownerFile)?.token === generation && fs.existsSync(guard)) fs.rmdirSync(guard);
    }
  };
  if (
    inherit &&
    valid(inherited) &&
    valid(prior) &&
    inherited.root === root &&
    inherited.pid === prior.pid &&
    inherited.token === prior.token &&
    alive(prior.pid)
  ) {
    const member = path.join(members, `${process.pid}-${randomUUID()}.json`);
    await membership(() => {
      if (read(ownerFile)?.token !== prior.token) throw busy();
      fs.writeFileSync(member, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
    });
    let released = false;
    return async () => {
      if (released) return;
      await membership(() => fs.unlinkSync(member));
      released = true;
    };
  }
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error.code === 'EEXIST') throw busy();
    throw error;
  }
  const owner = { root, pid: process.pid, token: randomUUID() };
  fs.mkdirSync(members);
  fs.writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx' });
  const previous = environment[variable];
  environment[variable] = JSON.stringify(owner);
  let released = false;
  return async () => {
    if (released) return;
    await membership(() => {
      if (read(ownerFile)?.token !== owner.token) throw new Error('CI workspace lease ownership changed.');
      if (
        fs.readdirSync(members).some((file) => {
          const member = read(path.join(members, file));
          return !Number.isSafeInteger(member?.pid) || member.pid < 1 || alive(member.pid);
        })
      )
        throw new Error('CI workspace workers still own their lease; retaining it for inspection.');
      const retired = `${directory}.released-${owner.token}`;
      fs.renameSync(directory, retired);
      fs.rmSync(retired, { recursive: true, force: true });
    });
    released = true;
    if (previous === undefined) delete environment[variable];
    else environment[variable] = previous;
  };
}
