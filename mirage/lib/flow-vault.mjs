// Sealed values at rest for flows and connections: secure action outputs in a run journal (flow-runs.mjs), connection OAuth
// tokens (connector-runtime.mjs) and per-flow HTTP callback keys (flow-triggers.mjs). A value is sealed with AES-256-GCM under
// one key file created once under the runtime's private state directory, readable by the current user only (mode 0600; on
// Windows an ACL without inheritance that grants the current user full control, set with icacls and verified, else the key
// is not created); the key is never written to
// state, configuration, diagnostics or /_sim. Without a state directory (a memory-only runtime) the key lives in this process
// only, so a value sealed before a restart cannot be opened after it.
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VAULT_KEY_FILE = 'mirage-vault.key';
const vaults = new Map();

const aclError = message => Object.assign(new Error('The vault key file cannot be made readable by the current user only: ' + message), { code: 'VaultKeyAclFailed' });
// The System32 tools by full path, so a whoami or icacls earlier on PATH (Git for Windows ships a whoami) is never used.
const run = (command, args) => spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', command + '.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
/** Windows: removes inherited entries and grants the current user (by SID) full control, then verifies that one entry is left. */
export function restrictToCurrentUser(file) {
  const sid = /"(S-1-[\d-]+)"\s*$/m.exec(run('whoami', ['/user', '/fo', 'csv', '/nh']).stdout ?? '')?.[1];
  if (!sid) throw aclError('whoami did not answer the current user SID.');
  const set = run('icacls', [file, '/inheritance:r', '/grant:r', `*${sid}:F`]);
  if (set.status !== 0) throw aclError((set.stdout || set.stderr || 'icacls failed').trim());
  const shown = run('icacls', [file]);
  const entries = (shown.stdout ?? '').split(/\r?\n/).map(line => line.replace(file, '').trim()).filter(line => /:\(.*\)$/.test(line));
  if (shown.status !== 0 || entries.length !== 1 || !entries[0].endsWith(':(F)')) throw aclError('icacls shows ' + (entries.join('; ') || 'no entries') + '.');
  return entries[0];
}

function loadKey(stateDirectory) {
  if (!stateDirectory) return randomBytes(32);
  const file = path.join(stateDirectory, VAULT_KEY_FILE);
  fs.mkdirSync(stateDirectory, { recursive: true });
  if (!fs.existsSync(file)) {
    // Written and restricted under a temporary name, then linked to the key name: the link fails when another creation won,
    // so a concurrent first reader never sees an empty or partial key and the first key is never replaced.
    const key = randomBytes(32), temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, key.toString('base64'), { flag: 'wx', mode: 0o600 });
      if (process.platform === 'win32') restrictToCurrentUser(temporary);
      fs.linkSync(temporary, file);
      return key;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw Object.assign(new Error('The vault key file under the state directory is not a 256-bit key.'), { code: 'VaultKeyInvalid' });
  return key;
}

/** The vault of a state directory (one per directory in this process), or a process-only vault for null. */
export function flowVault(stateDirectory = null) {
  const id = stateDirectory ? path.resolve(stateDirectory) : null;
  if (id && vaults.has(id)) return vaults.get(id);
  let key = null;
  const keyOf = () => (key ??= loadKey(id));
  const vault = {
    persistent: Boolean(id),
    /** { alg, iv, tag, data } (base64) of a JSON value. */
    seal(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyOf(), iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value ?? null), 'utf8'), cipher.final()]);
      return { alg: 'A256GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    /** The value of a sealed record, or undefined when it cannot be opened (another key, tampered, absent). */
    open(sealed) {
      if (!sealed || sealed.alg !== 'A256GCM') return undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', keyOf(), Buffer.from(sealed.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8'));
      } catch { return undefined; }
    },
  };
  if (id) vaults.set(id, vault);
  return vault;
}
