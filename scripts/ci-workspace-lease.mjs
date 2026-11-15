import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { processIdentity } from '../lense/process-identity.mjs';

const variable = 'PAQ_CI_WORKSPACE_LEASE';
// Errors other than "no such process" count as alive: a process that cannot be signalled may still own its workers.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};
// A member (or the owner) still owns the lease while its PID runs the process that joined. An identity that cannot be
// read now keeps the lease: an unread identity is never taken for a reused PID.
const memberAlive = (member) => {
  if (!Number.isSafeInteger(member?.pid) || member.pid < 1) return true;
  if (!alive(member.pid)) return false;
  if (typeof member.identity !== 'string') return true;
  const current = processIdentity(member.pid);
  return current === null || current === member.identity;
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
const membersAlive = (members) => {
  let files;
  try {
    files = fs.readdirSync(members);
  } catch {
    return false;
  }
  return files.some((file) => memberAlive(read(path.join(members, file))));
};

/** The owner record of a lease whose owner and every member have ended; null while any of them may still run. */
function endedOwner(directory) {
  const owner = read(path.join(directory, 'owner.json'));
  if (!valid(owner) || memberAlive(owner) || membersAlive(path.join(directory, 'members'))) return null;
  return owner;
}

/** Removes a claim whose recorded process has ended or whose PID now names another process; false while it is held (a
 * live process with the recorded start identity, or a record that cannot be read). The claim is checked, moved aside
 * and checked again, so two runs that both see a stale claim cannot remove a claim that a third run has just made. */
function removeEndedClaim(claim) {
  if (memberAlive(read(path.join(claim, 'owner.json')))) return false;
  const aside = `${claim}.stale-${randomUUID()}`;
  try {
    fs.renameSync(claim, aside);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  // A live claim made in the gap before the move goes back; a rename that fails here surfaces as an error.
  if (memberAlive(read(path.join(aside, 'owner.json')))) {
    fs.renameSync(aside, claim);
    return false;
  }
  fs.rmSync(aside, { recursive: true, force: true });
  return true;
}

/** Takes the takeover claim, recording this process as its owner; false while another run holds it. The claim is
 * written aside and moved into place, so a claim never exists without its owner record: a directory that holds a file
 * cannot be replaced by a move. */
function takeClaim(claim) {
  const staged = `${claim}.new-${randomUUID()}`;
  fs.mkdirSync(staged);
  try {
    fs.writeFileSync(
      path.join(staged, 'owner.json'),
      JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) }),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.renameSync(staged, claim);
        return true;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code) || !fs.existsSync(claim)) throw error;
        if (!removeEndedClaim(claim)) return false;
      }
    }
    return false;
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

/** Moves an ended lease out of the way so the caller can create its own. A claim directory serialises takeovers: two
 * runs that both see an ended lease cannot move the lease the first one just created. A claim whose recorded process
 * has ended is removed and the takeover proceeds; a live claim, or one with no readable record, blocks the takeover. */
function retireEndedLease(directory) {
  const owner = endedOwner(directory);
  if (!owner) return;
  const claim = `${directory}.takeover`;
  if (!takeClaim(claim)) return;
  try {
    if (!endedOwner(directory)) return;
    const retired = `${directory}.retired-${randomUUID()}`;
    fs.renameSync(directory, retired);
    fs.rmSync(retired, { recursive: true, force: true });
    console.log(`[ci] Taking over the workspace lease of PID ${owner.pid}, which has ended.`);
  } finally {
    fs.rmSync(claim, { recursive: true, force: true });
  }
}

/** True in the process that acquired the lease, not in a member that inherited its marker. Only the acquirer reaps the
 * lanes of the run it owns; an inherited marker names the owner's PID. */
export function leaseAcquiredHere(environment = process.env) {
  try {
    return JSON.parse(environment[variable] ?? 'null')?.pid === process.pid;
  } catch {
    return false;
  }
}

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

/** A lease whose owner has ended is taken over by a run that is not a member, once no member is still running; a lease
 * whose owner or a member still runs is refused. A killed owner can leave live worker processes, which keep the lease
 * for inspection until they have stopped. */
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
  const busy = () => {
    const owner = valid(prior) ? ` (PID ${prior.pid})` : '';
    return new Error(
      `Validation or dependency preparation already owns this checkout${owner}. Finish that run first. If it stopped unexpectedly, verify its workers have stopped before removing ${directory}.`,
    );
  };
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
    const member = path.join(members, `${process.pid}-${randomUUID()}.json`),
      identity = processIdentity(process.pid);
    await membership(() => {
      if (read(ownerFile)?.token !== prior.token) throw busy();
      fs.writeFileSync(member, JSON.stringify({ pid: process.pid, identity }), { flag: 'wx' });
    });
    let released = false;
    return async () => {
      if (released) return;
      await membership(() => fs.unlinkSync(member));
      released = true;
    };
  }
  // Only a run that is not a member takes over: a member of an ended owner must not claim its checkout.
  if (!inherit) retireEndedLease(directory);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error.code === 'EEXIST') throw busy();
    throw error;
  }
  const owner = { root, pid: process.pid, token: randomUUID(), identity: processIdentity(process.pid) };
  fs.mkdirSync(members);
  fs.writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx' });
  const previous = environment[variable];
  environment[variable] = JSON.stringify(owner);
  let released = false;
  return async () => {
    if (released) return;
    await membership(() => {
      if (read(ownerFile)?.token !== owner.token) throw new Error('CI workspace lease ownership changed.');
      if (fs.readdirSync(members).some((file) => memberAlive(read(path.join(members, file)))))
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
