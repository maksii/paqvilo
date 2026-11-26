// Shared file fixtures of the PCF tests: a map of invented source files written under a root, and the invented
// dataset control tst_Synthetic.Rows (one data set named records) with the bundle a test supplies.
import fs from 'node:fs/promises';
import path from 'node:path';

/** Writes every `relative path -> content` entry of `files` under `root`, creating the folders. */
export async function writeFixtureFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

/** The Solution files of the tst_Synthetic.Rows dataset control, under `solution/Controls/`. */
export const rowsDatasetControl = (bundle) => ({
  'solution/Controls/tst_Synthetic.Rows/ControlManifest.xml':
    '<manifest><control namespace="Synthetic" constructor="Rows" control-type="standard"><data-set name="records"/><resources><code path="bundle.js"/></resources></control></manifest>',
  'solution/Controls/tst_Synthetic.Rows/ControlManifest.xml.data.xml':
    '<CustomControl><Name>tst_Synthetic.Rows</Name></CustomControl>',
  'solution/Controls/tst_Synthetic.Rows/bundle.js': bundle,
});
