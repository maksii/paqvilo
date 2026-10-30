// Shared setup of the staff-host trace suites (trace-canvas, trace-code-apps, trace-model-driven and the model-driven
// browser suite): invented source files written under a temporary project, and a dry-run simulator whose Dataverse
// listener has one System Administrator and one Basic User, with a staff session per user. Loopback only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSimulator } from '../../api.mjs';

// Writes { relative path: text } under dir, creating the folders.
export async function writeFiles(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
}

// The simulator over <root>/solution (options add the runtime kind, packs, apps and connections), its close registered in
// closers, tracing at level full; admin and basic are the two users' object ids. Resolves to { sim, admin, basic }, each
// user as { id, cookie } with the staff session cookie /_sim/api/dataverse/session set for it.
export async function staffSimulator({ root, admin, basic, closers, ...options }) {
  const sim = await createSimulator({
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    ...options,
    dataverse: {
      enabled: true,
      tls: false,
      tds: { enabled: false },
      users: [
        {
          objectId: admin,
          domainname: 'admin@example.test',
          fullname: 'Invented Admin',
          roles: ['System Administrator'],
        },
        { objectId: basic, domainname: 'basic@example.test', fullname: 'Invented Basic', roles: ['Basic User'] },
      ],
    },
    trace: { level: 'full' },
  });
  closers.push(() => sim.close());
  const { users } = await (await fetch(sim.url + '/_sim/api/dataverse/session')).json();
  const select = async (name) => {
    const user = users.find((item) => item.name === name);
    const response = await fetch(sim.url + '/_sim/api/dataverse/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify({ userId: user.id }),
    });
    await response.text();
    return { id: user.id, cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  return { sim, admin: await select('Invented Admin'), basic: await select('Invented Basic') };
}
