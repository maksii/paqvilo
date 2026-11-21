// This example's folders and the documented Dataverse connection location, shared by its scripts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
export const toolkitRoot = path.resolve(exampleRoot, '../..');
// The documented connection location; resolved from the toolkit checkout whatever the working directory is.
export const defaultConnection = path.join(toolkitRoot, '.paqvilo', 'dataverse', 'provisioning.connection.json');
// The --connection help entry; `option` is the entry's option column, e.g. '  --connection FILE  ', so every
// continuation line starts under the description.
export const connectionHelp = (option) =>
  option +
  [
    'connection with organisationId; default:',
    '<toolkit checkout>/.paqvilo/dataverse/provisioning.connection.json;',
    'a relative path resolves from the working directory',
  ].join('\n' + ' '.repeat(option.length));
