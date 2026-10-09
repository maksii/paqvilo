import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inventoryPortalQueries } from "../query-inventory.mjs";

test("query inventory accepts any portal source path and reports static bounds plus unresolved Liquid", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-query-inventory-"));
  try {
    const templates = join(root, "web-templates");
    await fs.mkdir(templates, { recursive: true });
    await fs.writeFile(
      join(templates, "one.webtemplate.yml"),
      "adx_name: One\nadx_webtemplateid: 10000000-0000-0000-0000-000000000001\n",
    );
    await fs.writeFile(
      join(templates, "one.webtemplate.source.html"),
      `{% fetchxml a %}<fetch><entity name="account"><link-entity name="contact"><attribute name="fullname"/></link-entity></entity></fetch>{% endfetchxml %}`,
    );
    await fs.mkdir(join(templates, "nested"));
    await fs.writeFile(
      join(templates, "nested", "two.webtemplate.yml"),
      "adx_name: Two\nadx_webtemplateid: 20000000-0000-0000-0000-000000000002\n",
    );
    await fs.writeFile(
      join(templates, "nested", "two.webtemplate.source.html"),
      `{% fetchxml b %}<fetch><entity name="sample_item"><link-entity name="{{ dynamicLink }}" from="id" to="id" /></entity></fetch>{% endfetchxml %}`,
    );
    const inventory = await inventoryPortalQueries(root);
    assert.equal(inventory.sourceFiles, 2);
    assert.equal(inventory.format, "standard");
    assert.match(inventory.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.ok(inventory.sources.every((source) => source.relativePath));
    assert.equal(inventory.literalFetchXmlBlocks, 2);
    assert.equal(inventory.literalRootEntities, 2);
    assert.equal(inventory.maxLiteralLinkEntitiesPerBlock, 1);
    assert.equal(inventory.maxLiteralNestedLinkDepth, 1);
    assert.equal(inventory.unresolvedOrDynamicBlocks, 1);
    assert.equal(inventory.staticInventoryComplete, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("query inventory imports enhanced solution template components with source provenance", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-query-inventory-enhanced-"));
  try {
    const templateDir = join(root, "web-templates", "sample");
    await fs.mkdir(templateDir, { recursive: true });
    const component = {
      adx_name: "Enhanced Template",
      adx_webtemplateid: "30000000-0000-0000-0000-000000000003",
      adx_source: `{% fetchxml q %}<fetch><entity name="contact"/></fetch>{% endfetchxml %}`,
    };
    await fs.writeFile(
      join(templateDir, "powerpagecomponent.xml"),
      `<powerpagecomponent powerpagecomponentid="${component.adx_webtemplateid}"><powerpagecomponenttype>8</powerpagecomponenttype><name>Enhanced Template</name><content>${JSON.stringify(component).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</content></powerpagecomponent>`,
    );
    const result = await inventoryPortalQueries(root);
    assert.equal(result.format, "enhanced");
    assert.equal(result.sourceFiles, 1);
    assert.equal(result.literalFetchXmlBlocks, 1);
    assert.equal(result.literalRootEntities, 1);
    assert.equal(result.sources[0].relativePath, "web-templates/sample/powerpagecomponent.xml");
    assert.match(result.sourceFingerprint, /^[a-f0-9]{64}$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an existing empty portal source returns an honest zero-template inventory", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-query-inventory-empty-"));
  try {
    const result = await inventoryPortalQueries(root);
    assert.equal(result.sourceFiles, 0);
    assert.equal(result.literalFetchXmlBlocks, 0);
    assert.equal(result.literalRootEntities, 0);
    assert.equal(result.staticInventoryComplete, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
