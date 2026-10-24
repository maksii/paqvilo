// Sealed values at rest for flows and connections: secure action outputs in a run journal (flow-runs.mjs), connection OAuth
// tokens (connector-runtime.mjs) and per-flow HTTP callback keys (flow-triggers.mjs). A value is sealed with AES-256-GCM under
// one key file created once under the runtime's private state directory, readable by the current user only (mode 0600; on
// Windows an ACL without inheritance that grants the current user full control, set with Windows ACL APIs and verified, else the key
// is not created); the key is never written to
// state, configuration, diagnostics or /_sim. Without a state directory (a memory-only runtime) the key lives in this process
// only, so a value sealed before a restart cannot be opened after it.
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VAULT_KEY_FILE = 'mirage-vault.key';
const vaults = new Map();

const aclError = (message) =>
  Object.assign(new Error('The vault key file cannot be made readable by the current user only: ' + message), {
    code: 'VaultKeyAclFailed',
  });
// Use an exact private DACL rather than preserving explicit grants inherited from a
// runner's process defaults. One native ACL update publishes the new DACL atomically.
const restrictScript = String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($env:PAQVILO_VAULT_FILE, $acl)
$actual = [System.IO.File]::GetAccessControl($env:PAQVILO_VAULT_FILE)
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'The resulting ACL is not private to the current user.' }
Write-Output ('private-acl-verified:' + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
`;
/** Windows: replace all inherited and explicit entries with one verified current-user grant. */
export function restrictToCurrentUser(file) {
  const executable = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const result = spawnSync(
    executable,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(restrictScript, 'utf16le').toString('base64')],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      env: { ...process.env, PAQVILO_VAULT_FILE: path.resolve(file) },
    },
  );
  const output = result.stdout?.trim() ?? '',
    marker = 'private-acl-verified:';
  if (result.status !== 0 || !output.startsWith(marker) || /[\r\n]/.test(output))
    throw aclError((result.stderr || result.error?.message || 'Private ACL verification failed.').trim());
  return output.slice(marker.length) + ':(F)';
}

function loadKey(stateDirectory) {
  if (!stateDirectory) return randomBytes(32);
  const file = path.join(stateDirectory, VAULT_KEY_FILE);
  fs.mkdirSync(stateDirectory, { recursive: true });
  if (!fs.existsSync(file)) {
    // Written and restricted under a temporary name, then linked to the key name: the link fails when another creation won,
    // so a concurrent first reader never sees an empty or partial key and the first key is never replaced.
    const key = randomBytes(32),
      temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try {
        if (process.platform === 'win32') restrictToCurrentUser(temporary);
        // No key bytes exist until the temporary file's final ACL is verified.
        fs.writeFileSync(descriptor, key.toString('base64'));
      } finally {
        fs.closeSync(descriptor);
      }
      fs.linkSync(temporary, file);
      return key;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32)
    throw Object.assign(new Error('The vault key file under the state directory is not a 256-bit key.'), {
      code: 'VaultKeyInvalid',
    });
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
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', keyOf(), iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value ?? null), 'utf8'), cipher.final()]);
      return {
        alg: 'A256GCM',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      };
    },
    /** The value of a sealed record, or undefined when it cannot be opened (another key, tampered, absent). */
    open(sealed) {
      if (!sealed || sealed.alg !== 'A256GCM') return undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', keyOf(), Buffer.from(sealed.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        return JSON.parse(
          Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8'),
        );
      } catch {
        return undefined;
      }
    },
  };
  if (id) vaults.set(id, vault);
  return vault;
}
