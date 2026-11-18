// @test-kind contract: Paqvilo Mirage CLI design: every direct command has its own help, and help lists exactly the options the parser accepts (docs/cli.md)
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIRAGE_COMMAND_OPTIONS, runMirageCommand } from '../cli-command.mjs';
import { MIRAGE_CORE_COMMANDS } from '../tool-registry.mjs';

async function mirage(args) {
  let stdout = '',
    stderr = '';
  const code = await runMirageCommand(args, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { code, stdout, stderr };
}
const optionsIn = (text) => [...new Set([...text.matchAll(/--([a-z][a-z-]*)/g)].map(([, name]) => name))].sort();

test('the option registry names every direct command', () => {
  assert.deepEqual(Object.keys(MIRAGE_COMMAND_OPTIONS).sort(), [...MIRAGE_CORE_COMMANDS].sort());
});

for (const command of MIRAGE_CORE_COMMANDS)
  test(`mirage ${command} --help is its own help and lists exactly the options it accepts`, async () => {
    const help = await mirage([command, '--help']);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, new RegExp(`^paqvilo mirage ${command}: `));
    assert.doesNotMatch(help.stdout, /Power Pages local mirage/, 'not the generic help');
    assert.deepEqual(optionsIn(help.stdout), [...MIRAGE_COMMAND_OPTIONS[command], 'help'].sort());
    // Every listed option is accepted: an unlisted one is refused by the same parser.
    const refused = await mirage([command, '--invented-option']);
    assert.notEqual(refused.code, 0);
  });

test('mirage --help lists exactly the options the direct commands accept, --state-dir included', async () => {
  const help = await mirage(['--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /^Power Pages local mirage/);
  const accepted = [...new Set([...Object.values(MIRAGE_COMMAND_OPTIONS).flat(), 'help'])].sort();
  assert.deepEqual(optionsIn(help.stdout), accepted);
  assert.match(help.stdout, /--state-dir DIR /);
});

// @test-kind contract: mirage/lib/data-generation.mjs writes the merged state to --out (default --state) for both actions and prints the report
test('mirage data --help says what each data option does in generate and scaffold', async () => {
  for (const action of ['generate', 'scaffold']) {
    const help = await mirage(['data', action, '--help']);
    assert.equal(help.code, 0, help.stderr);
    assert.match(
      help.stdout,
      /^ {2}--out FILE {2}State file generate or scaffold writes the merged state to \(default: --state/m,
    );
    assert.doesNotMatch(help.stdout, /Report file/);
    assert.match(help.stdout, /^ {2}--state FILE {2}Runtime state file \(data generate and scaffold read it/m);
    for (const option of ['pack', 'count', 'materialize-persona-memberships'])
      assert.match(help.stdout, new RegExp(`^  --${option}\\b.*\\(generate only`, 'm'), option);
    assert.match(help.stdout, /^ {2}--rows N {2}.*\(scaffold only\)/m);
  }
});

test('mirage data --help marks --profile optional: both actions have a default profile', async () => {
  const help = await mirage(['data', '--help']);
  assert.match(help.stdout, /data generate --pack PACK_ID \[--profile PROFILE\] --state FILE/);
  assert.match(help.stdout, /data scaffold \[--profile smoke\|dev\] --state FILE/);
});

test('baseline-suite help names --live and --mirage values as capture labels, not directories', async () => {
  const { mirageToolHelp } = await import('../tool-registry.mjs');
  const help = mirageToolHelp('baseline-suite');
  assert.match(help, /\[--live LABEL\] \[--mirage LABEL\]/);
  assert.doesNotMatch(help, /--(?:live|mirage) DIR/);
  assert.match(help, /LABEL: the label a capture was saved under; compare reads live and mirage by default/);
});
