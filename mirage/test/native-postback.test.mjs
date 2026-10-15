import test from "node:test";
import assert from "node:assert/strict";
import {
  compactNativeControlId,
  nativeFormControlIds,
  nativeFormPostbackDescriptor,
  parseNativePostback,
} from "../lib/native-postback.mjs";

const firstId = "10000000-0000-0000-0000-000000000001";
const secondId = "10000000-0000-0000-0000-000000000002";
const descriptor = (formId, options = {}) => nativeFormPostbackDescriptor({
  kind: "entityform", formId,
  fields: [{ name: "description" }],
  actions: [{ button: "UpdateButton", action: "submit" }],
  ...options,
});
const post = (form, fields = []) => new URLSearchParams([
  ["__EVENTTARGET", form.actions[0].target],
  ["__EVENTARGUMENT", ""],
  ...fields,
]);

test("shared native IDs retain GUID and schema-only source name rules", () => {
  assert.equal(compactNativeControlId("{ABCDEF00-0000-0000-0000-000000000001}"), "abcdef00000000000000000000000001");
  assert.equal(compactNativeControlId("Invented form/path"), "invented_form_path");
  assert.deepEqual(nativeFormControlIds("entityform", firstId), {
    wrapper: "EntityFormControl_10000000000000000000000000000001",
    panel: "EntityFormPanel",
    view: "EntityFormControl_10000000000000000000000000000001_EntityFormView",
    names: "ctl00$ContentContainer$EntityFormControl_10000000000000000000000000000001$EntityFormControl_10000000000000000000000000000001_EntityFormView$",
    buttons: "ctl00$ContentContainer$EntityFormControl_10000000000000000000000000000001$",
  });
});

test("legacy ASPX, modal and Liquid forms keep distinct source control prefixes", () => {
  const pagePrefix = "ctl00$ContentContainer$MainContent$EntityControls$";
  assert.equal(nativeFormControlIds("entityform", firstId, { pageControl: true }).names, pagePrefix + "EntityFormControl$EntityFormControl_EntityFormView$");
  assert.equal(nativeFormControlIds("entityform", firstId, { modal: true }).names, "ctl00$ContentContainer$MainContent$EntityFormControl$EntityFormControl_EntityFormView$");
  assert.equal(nativeFormControlIds("webform", firstId, { pageControl: true }).names, pagePrefix + "WebFormControl$EntityFormView$");
  assert.equal(nativeFormControlIds("webform", firstId).names, "ctl00$ContentContainer$WebFormControl_10000000000000000000000000000001$EntityFormView$");
  assert.throws(() => nativeFormControlIds("unknown", firstId), /Unknown native form kind/);
});

test("two forms sharing button IDs and columns decode only the exact full target", () => {
  const first = descriptor(firstId), second = descriptor(secondId);
  const result = parseNativePostback(post(second, [
    [first.fields[0].wireName, "first record"],
    [second.fields[0].wireName, "Second α<&>\"' 😀\r\nline"],
    ["__VIEWSTATE", "opaque-state-sentinel"],
    ["__RequestVerificationToken", "opaque-token-sentinel"],
    [second.ids.names + "unbound", "unbound-value-sentinel"],
  ]), [first, second]);
  assert.equal(result.formId, secondId);
  assert.deepEqual(result.body, { action: "submit", values: { description: "Second α<&>\"' 😀\r\nline" } });
  assert.equal(result.ignoredEntryCount, 4);
  assert(!JSON.stringify(result).includes("sentinel"));
  assert(!JSON.stringify(result).includes("first record"));
});

test("unknown, duplicated or ambiguous targets fail instead of selecting a first form", () => {
  const form = descriptor(firstId);
  for (const entries of [new URLSearchParams(), new URLSearchParams({ __EVENTTARGET: "UpdateButton" }), new URLSearchParams([["__EVENTTARGET", form.actions[0].target], ["__EVENTTARGET", form.actions[0].target]])]) {
    assert.throws(() => parseNativePostback(entries, [form]), { code: "InvalidNativePostback", status: 400 });
  }
  const a = descriptor(firstId, { pageControl: true }), b = descriptor(secondId, { pageControl: true });
  assert.throws(() => parseNativePostback(post(a), [a, b]), /unknown or ambiguous/);
});

test("declared repeated values are preserved and repeated scalar values are rejected", () => {
  const scalar = descriptor(firstId);
  assert.throws(() => parseNativePostback(post(scalar, [[scalar.fields[0].wireName, "one"], [scalar.fields[0].wireName, "two"]]), [scalar]), /Ambiguous scalar/);
  const repeated = descriptor(firstId, { fields: [{ name: "choices", multiple: true }] });
  assert.deepEqual(parseNativePostback(post(repeated, [[repeated.fields[0].wireName, "one"], [repeated.fields[0].wireName, "two"]]), [repeated]).body.values, { choices: ["one", "two"] });
  // A column placed twice renders once (live form warning), so it is declared once.
  assert.deepEqual(descriptor(firstId, { fields: [{ name: "same" }, { name: "same" }] }).fields.map(field => field.name), ["same"]);
});

test("read-only and absent controls are not manufactured as submitted values", () => {
  const form = descriptor(firstId, { fields: [{ name: "description" }, { name: "locked", readOnly: true }, { name: "disabled", disabled: true }, { name: "owner", ownerHidden: true }, { name: "checked" }] });
  const result = parseNativePostback(post(form, [[form.ids.names + "description", ""], [form.ids.names + "locked", "tampered"]]), [form]);
  assert.deepEqual(result.body.values, { description: "" });
  assert.equal(result.ignoredEntryCount, 1);
});

test("action index and arguments come from the selected declared action", () => {
  const form = descriptor(firstId, { actions: [{ button: "DeactivateButton", action: "deactivate", actionIndex: 2 }] });
  const entries = post(form); entries.set("__EVENTARGUMENT", "declared argument"); entries.set("actionIndex", "999"); entries.set("recordId", secondId);
  const result = parseNativePostback(entries, [form]);
  assert.deepEqual(result.body, { action: "deactivate", actionIndex: 2, values: {} });
  assert.equal(result.eventArgument, "declared argument");
  assert.equal(result.ignoredEntryCount, 2);
});

test("malformed descriptors and nontextual entries fail without prototype mutation", () => {
  const form = descriptor(firstId);
  for (const fields of [[null], [{ name: "__proto__" }], [{ name: "constructor" }]]) assert.throws(() => descriptor(firstId, { fields }), { code: "InvalidNativePostback" });
  for (const actions of [[null], [{ button: "UpdateButton", action: "unknown" }], [{ button: "UpdateButton", action: "submit", actionIndex: -1 }]]) assert.throws(() => descriptor(firstId, { actions }), { code: "InvalidNativePostback" });
  assert.throws(() => parseNativePostback([["__EVENTTARGET", {}]], [form]), /textual entries/);
  assert.throws(() => parseNativePostback(post(form), [{ ...form, fields: [null] }]), { code: "InvalidNativePostback" });
  assert.throws(() => parseNativePostback(post(form), [{ ...form, fields: [form.fields[0], { ...form.fields[0], wireName: "another-name" }] }]), /ambiguous native postback field/);
  assert.throws(() => parseNativePostback(post(form), [{ ...form, actions: [null] }]), { code: "InvalidNativePostback" });
  assert.equal({}.polluted, undefined);
});

test("a WebForms submit button posts its own name with an empty __EVENTTARGET", () => {
  const first = descriptor(firstId), second = descriptor(secondId);
  const entries = new URLSearchParams([["__EVENTTARGET", ""], ["__EVENTARGUMENT", ""], [second.fields[0].wireName, "typed"], [second.actions[0].target, "Next"]]);
  const result = parseNativePostback(entries, [first, second]);
  assert.equal(result.formId, secondId);
  assert.deepEqual(result.body, { action: "submit", values: { description: "typed" } });
  assert.equal(result.ignoredEntryCount, 0);
  // No posted button, or two, is no target.
  assert.throws(() => parseNativePostback(new URLSearchParams([["__EVENTTARGET", ""], [second.fields[0].wireName, "typed"]]), [first, second]), /target required/);
  assert.throws(() => parseNativePostback(new URLSearchParams([["__EVENTTARGET", ""], [first.actions[0].target, "A"], [second.actions[0].target, "B"]]), [first, second]), /target required/);
});
