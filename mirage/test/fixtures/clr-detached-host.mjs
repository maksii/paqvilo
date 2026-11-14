// A preload (NODE_OPTIONS --import, which also runs in worker threads) for a Node process that owns CLR hosts: each
// host is spawned detached, so it is outside Node's kill-on-close job object and only the host's own reaction to its
// parent's death can end it.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const { spawn } = childProcess;
childProcess.spawn = (file, ...rest) =>
  /paqvilo-plugin-host\.exe$/i.test(String(file))
    ? spawn(file, rest[0], { ...rest[1], detached: true })
    : spawn(file, ...rest);
syncBuiltinESMExports();
