import { createSimulator } from 'paqvilo/mirage';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const sim = await createSimulator({
  projectRoot: root,
  solutionRoots: [fileURLToPath(new URL('./solution/', import.meta.url))],
  runtime: { kind: 'dataverse-api' },
  simulation: { level: 'dry-run' },
  dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  codeApps: [
    { name: 'invented-items', dir: 'code-app', localAppUrl: `http://127.0.0.1:${process.env.CODE_APP_PORT || 5199}/` },
  ],
  port: Number(process.env.MIRAGE_PORT || 8787),
  watch: false,
});
console.log(`Mirage: ${sim.origin ?? sim.url}/_sim/`);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await sim.close();
    process.exit(0);
  });
