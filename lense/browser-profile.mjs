import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Selection metadata only: never reads cookies, browser preferences or stored account details. */
export function browserProfileInfo(cfg, overrideDir) {
  const b = cfg.browser;
  if (overrideDir !== undefined) return { kind: 'temporary', name: null, channel: b.channel, userDataDir: path.resolve(overrideDir), profileDirectory: 'Default' };
  if (b.cdpUrl) return { kind: 'attached', name: null, channel: null, userDataDir: null, profileDirectory: null };
  if (b.userDataDir) return { kind: 'external', name: b.profileDirectory ?? 'Default', channel: b.channel, userDataDir: path.resolve(cfg.configDir, b.userDataDir), profileDirectory: b.profileDirectory ?? 'Default' };
  const base = path.resolve(cfg.configDir, b.profileDir);
  if (b.profile) {
    const name = b.profile.toLowerCase();
    return { kind: 'named', name, channel: b.channel, userDataDir: path.join(base, 'named', b.channel, name), profileDirectory: 'Default' };
  }
  // Several local Mirages (mirage dev with portals=all) keep their own browser profile,
  // so they can run beside a catalogue dev session.
  const name = cfg.portals === 'all' ? (cfg.mirage ? 'mirage' : 'catalogue') : `${cfg.siteName}-${cfg.envName}`;
  // Keep migrated Edge identities at their historical paths. Other channels must never open
  // that same browser database: switching Edge/Chrome otherwise mutates a shared profile.
  const userDataDir = b.channel && b.channel !== 'msedge' ? path.join(base, 'default', b.channel, name) : path.join(base, name);
  return { kind: 'legacy', name, channel: b.channel, userDataDir, profileDirectory: 'Default' };
}

/** The same user-data root is used by dev and verify --signed-in. */
export function browserProfileDir(cfg) {
  return browserProfileInfo(cfg).userDataDir;
}

const canonical = (dir) => {
  let value;
  try { value = fs.realpathSync.native(dir); } catch { value = path.resolve(dir); }
  return process.platform === 'win32' ? value.toLowerCase() : value;
};

/** Chrome 136+ refuses remote-debugging pipe/port on its standard user-data directory. */
export function defaultChromeDataDirs({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome SxS'].map((edition) => path.join(local, 'Google', edition, 'User Data')).concat(path.join(local, 'Chromium', 'User Data'));
  }
  if (platform === 'darwin') return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary', 'Chromium'].map((edition) => path.join(home, 'Library', 'Application Support', edition));
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium'].map((edition) => path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), edition));
}

export function defaultEdgeDataDirs({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'win32') return ['Edge', 'Edge Beta', 'Edge Dev', 'Edge SxS'].map((edition) => path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', edition, 'User Data'));
  if (platform === 'darwin') return ['Microsoft Edge', 'Microsoft Edge Beta', 'Microsoft Edge Dev', 'Microsoft Edge Canary'].map((edition) => path.join(home, 'Library', 'Application Support', edition));
  return ['microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev'].map((edition) => path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), edition));
}

/** Fail before creating or opening anything when a requested existing profile cannot be used. */
export function validateBrowserProfile(profile) {
  if (profile.kind !== 'external') return;
  const root = profile.userDataDir;
  if (profile.channel === 'msedge' && defaultEdgeDataDirs().some((dir) => canonical(dir) === canonical(root))) {
    throw new Error('Edge cannot be automated through launch flags in its normal user-data directory. Use --profile work for a dedicated persistent profile, or enable remote debugging in a running Edge instance and use --cdp-url with its active endpoint. No profile data has been copied.');
  }
  if (['chrome', 'chromium'].includes(profile.channel) && defaultChromeDataDirs().some((dir) => canonical(dir) === canonical(root))) {
    throw new Error('Chrome does not support automation of its normal user-data directory. Use --profile work for a separate persistent profile, an existing profile in a non-standard --user-data-dir, or --cdp-url for a browser that already exposes a debugging endpoint. No profile data has been copied.');
  }
  const folder = path.join(root, profile.profileDirectory);
  for (const [dir, label] of [[root, 'user-data directory'], [folder, 'profile directory']]) {
    let exists = false;
    try { exists = fs.statSync(dir).isDirectory(); } catch { /* report the selected directory */ }
    if (!exists) throw new Error(`Existing browser ${label} not found: ${dir}. --user-data-dir must be the parent of the Profile Path shown in edge://version or chrome://version; --profile-directory selects its child (for example "Profile 1"). Use --profile work to create a new toolkit profile.`);
  }
  const relative = path.relative(canonical(root), canonical(folder));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('The selected browser profile must be a child directory inside its user-data root');
}
