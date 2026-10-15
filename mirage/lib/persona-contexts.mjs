import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { personaContextSettings } from './persona-context-settings.mjs';

const failure = (message, status = 400, code = 'PersonaContextInvalid') => Object.assign(new Error(message), { status, code });
/** Owns only runtimes it starts. Sharing is explicit by context/scenario and
 * instanceKey; independent tests can request distinct keys. Definitions are
 * fingerprinted, so editing a context never silently mutates an open runtime. */
export function createPersonaContexts({ snapshot, start, maxInstances = 4, directory = path.join(process.cwd(), '.paqvilo', 'persona-runtimes') } = {}) {
  personaContextSettings({maxInstances});
  const entries = new Map(); let queue = Promise.resolve(), closed = false;
  const serialize = fn => { const task = queue.then(fn); queue = task.catch(() => {}); return task; };
  const publicEntry = entry => ({ id: entry.id, context: entry.definition.id ?? null, scenario: entry.scenario ?? null, instanceKey: entry.instanceKey, label: entry.definition.label, origin: entry.runtime.url, createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt, browser: entry.definition.browser ?? {}, isolated: true });
  const stop = async id => {
    const entry = [...entries.values()].find(item => item.id === id);
    if (!entry) throw failure('Persona runtime not found', 404, 'PersonaContextNotFound');
    await entry.runtime.close(); entries.delete(entry.key);
    await fs.rm(entry.directory, { recursive: true, force: true });
    return { stopped: id };
  };
  return {
    list: () => ({ maxInstances, items: [...entries.values()].map(publicEntry) }),
    open: (definition, { scenario, instanceKey = 'shared', preset } = {}) => serialize(async () => {
      if (closed) throw failure('Persona runtime manager is closed', 409);
      if (typeof instanceKey !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(instanceKey)) throw failure('instanceKey must be 1-80 letters, digits, dots, underscores or hyphens');
      const effective = { ...definition, ...(preset ? { preset } : {}) };
      const key = createHash('sha256').update(JSON.stringify([effective, definition.id ? null : scenario, instanceKey])).digest('hex');
      let entry = entries.get(key); const created = !entry;
      if (!entry) {
        if (entries.size >= maxInstances) throw failure(`The limit of ${maxInstances} persona runtimes is reached. Stop an unused runtime or raise personaContexts.maxInstances.`, 409, 'PersonaContextLimit');
        await fs.mkdir(directory, { recursive:true, mode:0o700 });
        const instanceDirectory = await fs.mkdtemp(path.join(directory, 'instance-'));
        try {
          const file = path.join(instanceDirectory, 'state.json');
          await snapshot(file);
          const runtime = await start({ file, definition: effective });
          entry = { id: randomUUID(), key, directory:instanceDirectory, runtime, definition: effective, scenario, instanceKey, createdAt: new Date().toISOString() };
          entries.set(key, entry);
        } catch (cause) { await fs.rm(instanceDirectory, { recursive: true, force: true }); throw cause; }
      }
      entry.scenario = scenario;
      entry.lastUsedAt = new Date().toISOString();
      return { ...publicEntry(entry), created, runtime: entry.runtime };
    }),
    stop: id => serialize(() => stop(id)),
    close: () => serialize(async () => { closed = true; for (const entry of [...entries.values()]) await stop(entry.id); }),
  };
}
