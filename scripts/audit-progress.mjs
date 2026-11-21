import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const key = (name, source) => `security-advisory:${name}:${source}`;
const advisoryId = (name, source) =>
  createHash('sha512')
    .update(JSON.stringify([name, source]))
    .digest('base64');
const packageName = (location, entry) => entry.name ?? location.slice(location.lastIndexOf('node_modules/') + 13);
const dependencies = (entry) =>
  new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}),
  ]);
function resolveNode(nodes, from, name) {
  let base = from;
  while (true) {
    const prefix = base ? `${base}/` : '';
    const target = `${prefix}node_modules/${name}`;
    if (nodes.has(target)) return target;
    if (!base) return undefined;
    const marker = base.lastIndexOf('/node_modules/');
    base = marker < 0 ? '' : base.slice(0, marker);
  }
}

// Edges retain installed node-instance identity: separate installed versions are separate credits.
export function auditInventory(lock) {
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object') throw new Error('Audit requires a package-lock inventory.');
  const nodes = new Map(
    Object.entries(packages)
      .filter(([location]) => location)
      .map(([location, entry]) => [location, packageName(location, entry)]),
  );
  const edges = [];
  for (const [from, entry] of Object.entries(packages)) {
    if (!from) continue; // Top-level inbound edges choose a remediation hint, not a metadata calculation.
    for (const name of dependencies(entry)) {
      const to = resolveNode(nodes, from, name);
      if (to) edges.push({ from, to });
    }
  }
  return { nodes, edges };
}

function reachableInventory(inventory, seeds) {
  const reached = new Set([...inventory.nodes].filter(([, name]) => seeds.has(name)).map(([location]) => location));
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of inventory.edges) {
      if (reached.has(edge.to) && !reached.has(edge.from)) {
        reached.add(edge.from);
        changed = true;
      }
    }
  }
  return {
    names: new Set([...reached].map((location) => inventory.nodes.get(location))),
    edges: inventory.edges.filter((edge) => reached.has(edge.to)),
  };
}

const exactKeys = (object, expected) =>
  Object.keys(object).length === expected.length && expected.every((keyName) => Object.hasOwn(object, keyName));
const packetIs = (packet, type, extra = []) =>
  packet.type === type && exactKeys(packet, ['v', 'nonce', 'seq', 'type', ...extra]);

// This clock is monotonic and independent of the risk-acceptance policy's real UTC clock.
export function createAuditProgress({
  inventory,
  nonce,
  timeout,
  clock = performance,
  schedule = setTimeout,
  cancel = clearTimeout,
  fail,
  launched = clock.now(),
}) {
  let wholeDeadline = launched + timeout;
  let sequence = 0;
  let hello = false;
  let bulk;
  let complete = false;
  let timer;
  let stopped = false;
  let paused = 0;
  let load;
  let idleSince = launched;
  const calculations = new Map();
  const cacheIds = new Map();
  const sourceIds = new Map();
  const packuments = new Map();
  const io = new Map();
  const phases = new Set();
  const unblocked = (now) => now - paused - (load ? now - load.started : 0);
  const violation = (message) => {
    throw new Error(`Audit progress: ${message}`);
  };
  function check(now) {
    if (now >= wholeDeadline) violation('finite whole-audit deadline exceeded.');
    if (load && now - load.started >= timeout) violation('synchronous metadata load stalled.');
    for (const operation of io.values())
      if (unblocked(now) - operation.started >= timeout) violation(`${operation.kind} stalled.`);
    if (!load && io.size === 0 && unblocked(now) - idleSince >= timeout)
      violation('no bounded work completed before the stall deadline.');
  }
  function arm() {
    cancel(timer);
    if (stopped) return;
    const now = clock.now();
    let deadline = wholeDeadline;
    if (load) deadline = Math.min(deadline, load.started + timeout);
    else {
      for (const operation of io.values())
        deadline = Math.min(deadline, now + timeout - (unblocked(now) - operation.started));
      if (io.size === 0) deadline = Math.min(deadline, now + timeout - (unblocked(now) - idleSince));
    }
    timer = schedule(
      () => {
        try {
          check(clock.now());
          arm();
        } catch (error) {
          stopped = true;
          fail(error);
        }
      },
      Math.max(0, deadline - now),
    );
  }
  function seedInventory(seeds, now) {
    if (bulk || !Array.isArray(seeds)) violation('duplicate or invalid fresh inventory.');
    const credits = new Map();
    for (const seed of seeds) {
      if (
        !exactKeys(seed, ['name', 'source']) ||
        typeof seed.name !== 'string' ||
        seed.name.length > 214 ||
        !(
          (typeof seed.source === 'number' && Number.isSafeInteger(seed.source)) ||
          (typeof seed.source === 'string' && seed.source.length <= 512)
        )
      )
        violation('invalid advisory identity.');
      const identity = key(seed.name, seed.source);
      if (credits.has(identity)) violation('ambiguous or duplicate advisory identity.');
      credits.set(identity, seed);
    }
    const reachable = reachableInventory(inventory, new Set(seeds.map((seed) => seed.name)));
    const calculationBudget = seeds.length + reachable.edges.length;
    const duration = timeout * (1 + calculationBudget);
    if (!Number.isSafeInteger(duration) || duration <= 0) violation('invalid finite inventory budget.');
    bulk = { credits, ...reachable, limit: calculationBudget };
    wholeDeadline = launched + duration;
    check(now);
    idleSince = unblocked(now);
  }
  function calculation(packet) {
    const identity = key(packet.name, packet.source);
    if (packet.action === 'end') {
      const current = calculations.get(hash(identity));
      if (
        !current ||
        current.ended ||
        !current.loaded ||
        [...io.values()].some((operation) => operation.calculation === current)
      )
        violation('unbalanced calculation end.');
      current.ended = true;
      return;
    }
    if (packet.action !== 'start' || calculations.has(hash(identity)) || calculations.size >= bulk.limit)
      violation('duplicate or excessive calculation.');
    let source = bulk.credits.get(identity)?.source;
    if (source === undefined) {
      const parent = sourceIds.get(String(packet.source));
      const edgeIndex = bulk.edges.findIndex(
        (edge) => inventory.nodes.get(edge.to) === parent?.name && inventory.nodes.get(edge.from) === packet.name,
      );
      if (!parent?.ended || edgeIndex < 0)
        violation('calculation is not admitted by a completed source and reachable installed edge.');
      bulk.edges.splice(edgeIndex, 1);
      source = String(packet.source);
    } else bulk.credits.delete(identity);
    const current = { name: packet.name, id: hash(identity), loaded: false, cached: false, ended: false };
    const derived = advisoryId(packet.name, source);
    calculations.set(current.id, current);
    sourceIds.set(derived, current);
    cacheIds.set(hash(key(packet.name, derived)), current);
  }
  function workIdentity(packet) {
    const current = packet.kind === 'load' ? calculations.get(packet.id) : cacheIds.get(packet.id);
    if (packet.kind === 'packument') {
      if (packet.id !== hash(packet.name) || ![...calculations.values()].some((entry) => entry.name === packet.name))
        violation('unregistered packument.');
    } else if (!current || current.name !== packet.name || current.ended) violation('unknown work identity.');
    return current;
  }
  function startIO(packet, current, phaseKey, now) {
    if (packet.kind === 'cache:put' && !current.loaded) violation('cache write before completed load.');
    if (packet.kind === 'packument') {
      if (packuments.has(packet.name) || !bulk.names.has(packet.name)) violation('excessive packument.');
      packuments.set(packet.name, 'started');
    }
    io.set(phaseKey, { started: unblocked(now), kind: packet.kind, calculation: current });
  }
  function startWork(packet, current, phaseKey, now) {
    if (phases.has(phaseKey)) violation('duplicate work start.');
    phases.add(phaseKey);
    if (packet.kind !== 'load') return startIO(packet, current, phaseKey, now);
    if (load) violation('overlapping synchronous loads.');
    if (!current.cached || packuments.get(packet.name) !== 'ended')
      violation('load before completed cache and packument inputs.');
    load = { started: now, id: packet.id, current };
  }
  function endWork(packet, current, phaseKey, now) {
    if (packet.kind === 'load') {
      if (!load || load.id !== packet.id) violation('unbalanced load end.');
      paused += now - load.started;
      load.current.loaded = true;
      load = undefined;
    } else {
      if (!io.delete(phaseKey)) violation('unbalanced work end.');
      if (packet.kind === 'packument') packuments.set(packet.name, 'ended');
      if (packet.kind === 'cache:get') current.cached = true;
    }
    idleSince = unblocked(now);
  }
  function work(packet, now) {
    const phaseKey = `${packet.kind}:${packet.id}`;
    const current = workIdentity(packet);
    if (packet.action === 'start') startWork(packet, current, phaseKey, now);
    else if (packet.action === 'end') endWork(packet, current, phaseKey, now);
    else violation('unknown work action.');
  }
  function accept(packet) {
    const now = clock.now();
    check(now); // A queued late end must never forgive an already expired operation.
    if (stopped || !packet || packet.nonce !== nonce || packet.seq !== sequence + 1 || packet.v !== 1 || complete)
      violation('invalid nonce, sequence or lifecycle.');
    sequence++;
    if (packetIs(packet, 'hello') && !hello) hello = true;
    else if (!hello) violation('missing observer hello.');
    else if (packetIs(packet, 'inventory', ['seeds'])) seedInventory(packet.seeds, now);
    else if (!bulk) violation('work before fresh bulk inventory.');
    else if (packetIs(packet, 'calculation', ['action', 'name', 'source'])) calculation(packet);
    else if (
      packetIs(packet, 'work', ['action', 'kind', 'name', 'id']) &&
      ['load', 'packument', 'cache:get', 'cache:put'].includes(packet.kind)
    )
      work(packet, now);
    else if (packetIs(packet, 'complete')) {
      if (load || io.size || bulk.credits.size || [...calculations.values()].some((entry) => !entry.ended))
        violation('completion with open or unadmitted work.');
      complete = true;
      idleSince = unblocked(now);
    } else violation('unknown progress packet.');
    arm();
  }
  arm();
  return {
    accept,
    finish() {
      check(clock.now());
      if (!hello || !bulk || !complete) violation('missing fresh observer completion.');
    },
    stop() {
      stopped = true;
      cancel(timer);
    },
  };
}
