import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Explicitly configured developer bridge. Credentials remain in memory and
 * never enter returned evidence, thrown transport errors or source files. */
export async function openNativeBrowser(config) {
  const firstLine = (await readFile(config.extensionTokenFile, 'utf8')).split(/\r?\n/)[0];
  const token =
    firstLine.match(/PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*[:=]\s*["']?([^\s"'`]+)/)?.[1] ??
    firstLine.match(/token[^:=]*[:=]\s*["']?([^\s"'`]+)/i)?.[1] ??
    firstLine.match(/`([^`]+)`/)?.[1];
  if (!token) throw new Error('Configured browser credential is unavailable; file contents withheld.');
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(config.sdkClientModule).href),
    import(pathToFileURL(config.sdkTransportModule).href),
  ]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      config.cliPath,
      '--extension',
      '--browser',
      'msedge',
      '--profile-dir-name',
      config.profileName,
      '--timeout-action',
      '60000',
      '--timeout-navigation',
      '45000',
    ],
    env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'company-native-regression-campaign', version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch {
    await client.close().catch(() => {});
    throw new Error('Configured native browser connection failed; transport details withheld.');
  }
  return {
    async run(code, timeout = 60000) {
      let result;
      try {
        result = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code } }, undefined, {
          timeout,
        });
      } catch {
        throw new Error('Native browser operation failed; extension transport details withheld.');
      }
      const text =
        result.content
          ?.filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n') ?? '';
      const match = text.match(/### Result\s*([\s\S]*?)(?:\n### |$)/);
      try {
        return JSON.parse(match?.[1]);
      } catch {
        const diagnostic = /timeout/i.test(text)
          ? 'BROWSER_TIMEOUT'
          : /dialog/i.test(text)
            ? 'BROWSER_DIALOG'
            : /error/i.test(text)
              ? 'BROWSER_ERROR'
              : 'BROWSER_RESULT';
        throw Object.assign(new Error('Native browser result unavailable; extension output withheld.'), {
          code: diagnostic,
        });
      }
    },
    async acceptDialog() {
      const available = await client.listTools();
      if (!available.tools.some((tool) => tool.name === 'browser_handle_dialog'))
        throw new Error('Native browser dialog control is unavailable.');
      const result = await client.callTool({ name: 'browser_handle_dialog', arguments: { accept: true } });
      if (result.isError)
        throw new Error('Native browser confirmation could not be accepted; extension output withheld.');
      return { accepted: true };
    },
    close: () => client.close(),
  };
}
