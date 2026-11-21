#!/usr/bin/env node
import { runMirageCommand } from './cli-command.mjs';

const code = await runMirageCommand(process.argv.slice(2), { processEntry: true });
if (code !== null) process.exitCode = code;
