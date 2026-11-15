import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

if (process.env.PAQ_TEST_MISSING_DOTNET === '1') {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (command, ...args) =>
    command === 'dotnet'
      ? {
          status: 1,
          stdout: '',
          stderr: 'Invented unavailable .NET SDK',
          error: Object.assign(Error('Invented missing dotnet'), { code: 'ENOENT' }),
        }
      : original(command, ...args);
}
if (process.env.PAQ_TEST_MISSING_PYTHON === '1') {
  const original = fs.existsSync;
  fs.existsSync = (file) =>
    /[/\\]sdk-gates[/\\]python-dataverse[/\\]\.venv[/\\]/.test(String(file)) ? false : original(file);
}
syncBuiltinESMExports();
