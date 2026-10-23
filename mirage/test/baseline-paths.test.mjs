import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateMatrix,
  scenarioDir,
  captureMatrix,
} from "../baseline-suite.mjs";
const scenario = (id) => ({ id, steps: [{ goto: "/invented/" }] }),
  matrix = (id) => ({ version: 1, scenarios: [scenario(id)] });
for (const id of [
  "a/../../outside",
  "a/../outside",
  "a/./b",
  "a//b",
  "a/",
  "/absolute",
  "C:/absolute",
  "C:relative",
  "a\\..\\outside",
  "\\\\server\\share",
  "a/.../b",
  "a/.. /b",
  "a/CON/b",
])
  test("refuse invalid scenario id " + JSON.stringify(id), () => {
    assert.throws(() => validateMatrix(matrix(id)));
    assert.throws(() => scenarioDir("root", scenario(id), "native"));
  });
for (const label of [
  "../outside",
  "..",
  ".",
  "a/b",
  "a\\b",
  "/absolute",
  "C:/absolute",
  "C:relative",
  "\\\\server\\share",
  ".. ",
  "trailing.",
  "NUL",
])
  test("refuse invalid CLI label " + JSON.stringify(label), () => {
    assert.throws(() => scenarioDir("root", scenario("valid/nested"), label));
  });
test("genuine nested IDs and authored labels retain original paths", () => {
  assert.equal(
    scenarioDir(
      "root",
      scenario("form/test_case.v2/render"),
      "native current-2",
    ),
    path.join("root", "form", "test_case.v2", "render", "native current-2"),
  );
});
test("whole matrix and label fail before capture callbacks or output writes", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paqvilo-case-boundary-"),
  );
  let calls = 0;
  const side = {
    persona: async () => {
      calls++;
    },
    reset: async () => {
      calls++;
    },
    capture: async () => {
      calls++;
      return { status: "captured" };
    },
  };
  try {
    await assert.rejects(
      captureMatrix({
        matrix: {
          version: 1,
          scenarios: [scenario("valid"), scenario("a/../../outside")],
        },
        side,
        outDir: path.join(root, "out"),
        label: "native",
      }),
    );
    await assert.rejects(
      captureMatrix({
        matrix: matrix("valid"),
        side,
        outDir: path.join(root, "out"),
        label: "../outside",
      }),
    );
    assert.equal(calls, 0);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    assert.ok(
      path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("CLI label rejection precedes browser/runtime setup and any evidence write", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paqvilo-label-boundary-"),
  );
  try {
    const file = path.join(root, "matrix.json");
    await fs.writeFile(file, JSON.stringify(matrix("valid/nested")));
    const result = spawnSync(
      process.execPath,
      [
        new URL(
          "../baseline-suite.mjs",
          import.meta.url,
        ).pathname.slice(process.platform === "win32" ? 1 : 0),
        "capture",
        "--matrix",
        file,
        "--out",
        path.join(root, "out"),
        "--side",
        "mirage",
        "--label",
        "../outside",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /capture label/);
    assert.deepEqual(await fs.readdir(root), ["matrix.json"]);
  } finally {
    assert.ok(
      path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
});
