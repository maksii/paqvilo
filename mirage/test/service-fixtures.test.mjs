// Service fixtures (lib/service-fixtures.mjs): resolution order, the disabled default, pack validation, describe and list.
import test from "node:test";
import assert from "node:assert/strict";
import { createServiceFixtureRegistry, validateServiceFixtures } from "../lib/service-fixtures.mjs";

const pack = (id, serviceFixtures) => ({ id, serviceFixtures });

test("resolution order: pack fixture beats a registered handle, a handle beats the fallback", () => {
  const registry = createServiceFixtureRegistry({ packs: [pack("invented-a", { dynamics: { quote: () => ({ from: "pack" }) } })] });
  registry.register({ service: "dynamics", operation: "quote", handle: () => ({ from: "handle" }), fallback: () => ({ from: "fallback" }) });
  registry.register({ service: "dynamics", operation: "price", handle: () => ({ from: "handle" }) });
  registry.register({ service: "dynamics", operation: "stock" });

  const fixture = registry.resolve("dynamics", "quote");
  assert.equal(fixture.level, "fixture");
  assert.equal(fixture.source, "pack:invented-a");
  assert.deepEqual(fixture.run({}), { from: "pack" });

  const behaviour = registry.resolve("dynamics", "price");
  assert.equal(behaviour.level, "behaviour");
  assert.equal(behaviour.source, "core");
  assert.deepEqual(behaviour.run({}), { from: "handle" });

  assert.equal(registry.resolve("dynamics", "stock").level, "disabled");
});

test("a pack fixture answers an operation that no module registered", () => {
  const registry = createServiceFixtureRegistry({ packs: [pack("invented-a", { dynamics: { recalc: () => ({ ok: true }) } })] });
  const resolved = registry.resolve("dynamics", "recalc");
  assert.equal(resolved.level, "fixture");
  assert.deepEqual(resolved.run({}), { ok: true });
});

test("the disabled default answers ServiceDisabled and reports once per service and operation", () => {
  const diagnostics = [];
  const registry = createServiceFixtureRegistry({ diagnostic: (entry) => diagnostics.push(entry) });

  const first = registry.resolve("powerBi", "embed");
  assert.equal(first.level, "disabled");
  assert.equal(first.source, "core");
  assert.deepEqual(first.run({ path: "invented" }), { error: { code: "ServiceDisabled", service: "powerBi", operation: "embed" } });
  assert.deepEqual(first.run({}), { error: { code: "ServiceDisabled", service: "powerBi", operation: "embed" } });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "SERVICE_FIXTURE_DISABLED");
  assert.equal(diagnostics[0].service, "powerBi");
  assert.equal(diagnostics[0].operation, "embed");

  registry.resolve("copilot", "ask").run({});
  assert.equal(diagnostics.length, 2);
});

test("an operation never registered resolves to the disabled default", () => {
  const diagnostics = [];
  const registry = createServiceFixtureRegistry({ diagnostic: (entry) => diagnostics.push(entry) });
  const resolved = registry.resolve("dynamics", "unknownThing");
  assert.equal(resolved.level, "disabled");
  assert.deepEqual(resolved.run({}), { error: { code: "ServiceDisabled", service: "dynamics", operation: "unknownThing" } });
  assert.equal(diagnostics.length, 1);
});

test("two packs registering the same service operation fail with the ambiguity error", () => {
  const twin = (id) => pack(id, { aiBuilder: { predict: () => ({}) } });
  assert.throws(
    () => createServiceFixtureRegistry({ packs: [twin("invented-a"), twin("invented-b")] }),
    { name: "Error", message: "Ambiguous serviceFixtures registration for aiBuilder.predict in packs invented-a and invented-b" },
  );
});

test("register rejects duplicates and malformed arguments", () => {
  const registry = createServiceFixtureRegistry();
  registry.register({ service: "dynamics", operation: "once" });
  assert.throws(() => registry.register({ service: "dynamics", operation: "once" }), /already registered/);
  assert.throws(() => registry.register({ service: "", operation: "x" }), /needs a service and an operation/);
  assert.throws(() => registry.register({ service: "dynamics", operation: "x", handle: "not a function" }), /handle must be a function/);
});

test("validateServiceFixtures accepts objects of functions and rejects other shapes", () => {
  const fn = () => ({});
  assert.deepEqual(validateServiceFixtures(undefined), {});
  assert.deepEqual(validateServiceFixtures({ powerBi: { embed: fn }, invented: {} }), { powerBi: { embed: fn }, invented: {} });
  assert.throws(() => validateServiceFixtures([]), /must map service names/);
  assert.throws(() => validateServiceFixtures({ powerBi: fn }), /serviceFixtures\.powerBi must map operation names/);
  assert.throws(() => validateServiceFixtures({ powerBi: { embed: "text" } }), /serviceFixtures\.powerBi\.embed must be a function/);
  assert.throws(() => validateServiceFixtures({ powerBi: { embed: async () => ({}) } }), /must be a synchronous function/);
});

test("a pack with an invalid serviceFixtures names the pack in the error", () => {
  assert.throws(
    () => createServiceFixtureRegistry({ packs: [pack("invented-bad", { copilot: { ask: 1 } })] }),
    /Data pack invented-bad: serviceFixtures\.copilot\.ask must be a function/,
  );
});

test("describe reports one record per service with the lowest operation level", () => {
  const registry = createServiceFixtureRegistry({
    packs: [pack("invented-a", { powerBi: { embed: () => ({ html: "<p>x</p>" }) }, dynamics: { quote: () => ({}) } })],
  });
  registry.register({ service: "dynamics", operation: "price", handle: () => ({}) });
  const records = registry.describe();
  const byName = Object.fromEntries(records.map((record) => [record.name, record]));

  assert.deepEqual(Object.keys(byName).sort(), ["service:aiBuilder", "service:copilot", "service:dynamics", "service:powerBi"]);
  assert.equal(byName["service:powerBi"].level, "fixture");
  assert.equal(byName["service:aiBuilder"].level, "disabled");
  assert.equal(byName["service:copilot"].level, "disabled");
  assert.equal(byName["service:dynamics"].level, "fixture");
  assert.deepEqual(byName["service:dynamics"].operations, [
    { name: "price", level: "behaviour" },
    { name: "quote", level: "fixture" },
  ]);
  assert.deepEqual(
    { kind: byName["service:copilot"].kind, principal: byName["service:copilot"].principal, stateOwner: byName["service:copilot"].stateOwner, lifecycle: byName["service:copilot"].lifecycle, version: byName["service:copilot"].version },
    { kind: "provider", principal: "none", stateOwner: "none", lifecycle: "in-process", version: 1 },
  );
});

test("describe marks a service behaviour only when every operation is behaviour", () => {
  const registry = createServiceFixtureRegistry();
  registry.register({ service: "dynamics", operation: "a", handle: () => ({}) });
  registry.register({ service: "dynamics", operation: "b", handle: () => ({}) });
  const [record] = registry.describe().filter((item) => item.name === "service:dynamics");
  assert.equal(record.level, "behaviour");
});

test("list returns each effective service operation once, sorted, with its level and source", () => {
  const registry = createServiceFixtureRegistry({ packs: [pack("invented-a", { dynamics: { recalc: () => ({}) }, aiBuilder: { predict: () => ({}) } })] });
  registry.register({ service: "dynamics", operation: "price", handle: () => ({}) });
  assert.deepEqual(registry.list(), [
    { service: "aiBuilder", operation: "predict", level: "fixture", source: "pack:invented-a" },
    { service: "copilot", operation: "ask", level: "disabled", source: "core" },
    { service: "dynamics", operation: "price", level: "behaviour", source: "core" },
    { service: "dynamics", operation: "recalc", level: "fixture", source: "pack:invented-a" },
    { service: "powerBi", operation: "embed", level: "disabled", source: "core" },
  ]);
});
