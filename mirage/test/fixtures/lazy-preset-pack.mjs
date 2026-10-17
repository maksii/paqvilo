export const presetId = "tiny-builtin";

export const presetBody = () => ({
  tables: { item: [{ itemid: "seed", name: "Generated item" }] },
  mappings: { item: { entitySet: "items", idColumn: "itemid" } },
  permissions: [{ id: "read-items", entity: "item", scope: "global", operations: ["read"] }],
  plugins: [],
  settings: { permissionMode: "enforce" },
});

/** Count loads rather than generating a large library to prove laziness. */
export function syntheticPresetPack() {
  let loads = 0;
  return {
    loads: () => loads,
    pack: {
      id: "tiny-pack",
      name: "Synthetic pack",
      description: "Small persistence fixture",
      matches: () => true,
      presets: () => ({
        [presetId]: {
          name: "Tiny builtin",
          description: "One generated row",
          load: () => { loads++; return presetBody(); },
        },
      }),
    },
  };
}
