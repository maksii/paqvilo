// Thin git helpers: the baseline version of a source file and the set of files changed against it.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GIT_ARGS = ['-c', 'core.quotepath=off', '-c', 'core.longpaths=true'];

// Hang guard for one Git command. A command that outlasts it has given no answer and is reported as a failure.
export const GIT_HANG_GUARD_MS = 120_000;

/**
 * Whether a failed Git command was answered by Git: it ran and exited with a status (`code` of an execFile error,
 * `status` of an execFileSync one). A command that could not start, was killed or outlasted its hang guard gave
 * no answer, which callers never read as a negative one.
 */
export const gitAnswered = (error) => Number.isInteger(error?.code) || Number.isInteger(error?.status);

/**
 * Whether a Git command could not start because no `git` program was found: Git is not installed or not on PATH.
 * It is one way of giving no answer, and asking again cannot change it, so callers say so instead of "retry".
 */
export const gitMissing = (error) => error?.code === 'ENOENT';
export const GIT_MISSING_MESSAGE = 'Git was not found. Install Git or add it to PATH, then try again.';

function gitOptions(cwd, { buffer = false, input } = {}) {
  // Variables a Git hook sets would point the command at another repository. The ceiling stays: it is the
  // user's own limit on how far up Git looks for a repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG.*)$/i.test(
          key,
        ),
    ),
  );
  return {
    cwd,
    encoding: buffer ? 'buffer' : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    windowsHide: true,
    input: typeof input === 'string' ? Buffer.from(input) : input,
    timeout: GIT_HANG_GUARD_MS,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  };
}

const git = (cwd, args, options) => execFileSync('git', [...GIT_ARGS, ...args], gitOptions(cwd, options)); // NOSONAR: fixed tool name resolved through PATH by developer tooling
const gitAsync = (cwd, args, options) =>
  new Promise((resolve, reject) => {
    const { input, ...settings } = gitOptions(cwd, options);
    /* NOSONAR */ const child = execFile('git', [...GIT_ARGS, ...args], settings, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
    // A Git process that exits early reports through the callback; an unread stdin is no crash.
    if (input !== undefined) child.stdin.on('error', () => {}).end(input);
  });

/**
 * Where HEAD of the checkout points right now: its commit and branch (null when detached or in an
 * unborn repository). Read-only and asynchronous; null when Git answers that there is no HEAD (outside a Git
 * working tree, or before the first commit). Rejects when Git gives no answer.
 * @returns {Promise<{commit: string, branch: string|null, detached: boolean}|null>}
 */
export async function gitHead(sourceDir) {
  let output;
  try {
    output = await gitAsync(path.resolve(sourceDir), ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']);
  } catch (error) {
    if (gitAnswered(error)) return null;
    throw error;
  }
  const [commit, name] = output.trim().split(/\r?\n/);
  if (!/^[0-9a-f]{40,64}$/.test(commit ?? '')) return null;
  const branch = name && name !== 'HEAD' ? name : null;
  return { commit, branch, detached: branch === null };
}

/**
 * The nearest `.git` entry of the folder or of one of its parents, or null. Git finds a working tree's repository
 * only through that entry (the variables that would name a repository elsewhere are removed from Git's environment
 * here), so which repository a folder is in can change only when this path, or the file it names, changes.
 */
function nearestGitMarker(sourceDir) {
  for (let dir = path.resolve(sourceDir); ; dir = path.dirname(dir)) {
    const marker = path.join(dir, '.git');
    if (fs.existsSync(marker)) return marker;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Whether the folder or one of its parents holds a `.git` entry: without one it is in no repository. */
export const gitMarkerExists = (sourceDir) => nearestGitMarker(sourceDir) !== null;

/**
 * Directories whose files change when HEAD or a ref moves: the checkout's own git dir (HEAD of a
 * linked worktree lives there) and the common dir (refs, packed-refs). `marker` is the `.git` entry Git found them
 * through (null when it changed while Git was answering). Null when Git answers that the folder is not in a working
 * tree; rejects when Git gives no answer.
 * @returns {Promise<{gitDir: string, commonDir: string, toplevel: string, sourceDir: string, marker: string|null}|null>}
 */
export async function gitDirectories(sourceDir) {
  sourceDir = path.resolve(sourceDir);
  const marker = nearestGitMarker(sourceDir);
  let output;
  try {
    output = await gitAsync(sourceDir, ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel']);
  } catch (error) {
    if (gitAnswered(error)) return null;
    throw error;
  }
  const [gitDir, commonDir, toplevel] = output.trim().split(/\r?\n/);
  if (!gitDir || !commonDir || !toplevel) return null;
  return {
    gitDir: path.resolve(sourceDir, gitDir),
    commonDir: path.resolve(sourceDir, commonDir),
    toplevel: path.resolve(toplevel),
    sourceDir,
    marker: marker === nearestGitMarker(sourceDir) ? marker : null,
  };
}

// Where Git looks for a short ref name, in its order (gitrevisions: <refname>).
const refCandidates = (name) => [
  name,
  `refs/${name}`,
  `refs/tags/${name}`,
  `refs/heads/${name}`,
  `refs/remotes/${name}`,
  `refs/remotes/${name}/HEAD`,
];

/** The text of a ref file; 'absent' or 'directory' when there is no such file. Any other failure throws. */
function readRefFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > 1024) throw new Error('not a ref file');
    return text;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'absent';
    if (error.code === 'EISDIR') return 'directory';
    throw error;
  }
}

/**
 * The value of a symbolic ref line that starts with `prefix`, without its trailing whitespace; undefined for any other
 * text. Trailing whitespace is removed by trimEnd rather than a lazy match, which backtracks quadratically on long
 * values; a value spanning lines does not match, as `.` does not match a line terminator.
 */
function symbolicRefValue(text, prefix = 'ref: ') {
  if (!text.startsWith(prefix)) return undefined;
  const value = text.slice(prefix.length).trimEnd();
  return /[\n\r\p{Zl}\p{Zp}]/u.test(value) ? undefined : value;
}

const fileStamp = (file) => {
  const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : 'absent';
};

/**
 * Everything in the repository's files that decides which commits `names` resolve to: the text of every loose ref
 * file Git would read for them (in the checkout's own git dir and in the common dir, following symbolic refs), and
 * the identity of packed-refs, of the shallow and grafts files and of the replace refs. Two equal states resolve to
 * the same commits, so a Git answer read between two equal states stays true until the state differs. Null when the
 * files cannot show it (no repository known, another `.git` entry now decides which repository the folder is in, the
 * reftable backend, a file that cannot be read, a symbolic ref that leaves refs/): the caller asks Git then.
 */
function repositoryRefState(directories, names) {
  if (!directories?.marker || !names) return null;
  const { gitDir, commonDir, sourceDir, marker } = directories;
  const roots = [...new Set([gitDir, commonDir])];
  const parts = [];
  const seen = new Set();
  const follow = (name) => {
    if (seen.has(name)) return true;
    if (seen.size >= 64) return false;
    seen.add(name);
    for (const root of roots) {
      const text = readRefFile(path.join(root, name));
      parts.push(`${root}\0${name}\0${text}`);
      const target = symbolicRefValue(text);
      if (target === undefined) continue;
      if (!/^refs\/[\w./-]+$/.test(target) || target.includes('..') || !follow(target)) return false;
    }
    return true;
  };
  try {
    if (nearestGitMarker(sourceDir) !== marker) return null;
    // A linked worktree and a submodule name their repository in a `.git` file.
    parts.push(`marker\0${readRefFile(marker)}`);
    if (fs.existsSync(path.join(commonDir, 'reftable'))) return null;
    if (!names.every(follow)) return null;
    for (const name of ['packed-refs', 'shallow', 'info/grafts'])
      parts.push(`${name}\0${fileStamp(path.join(commonDir, name))}`);
    const replace = path.join(commonDir, 'refs', 'replace');
    if (fs.existsSync(replace))
      for (const name of fs.readdirSync(replace).sort())
        parts.push(`replace\0${name}\0${fileStamp(path.join(replace, name))}`);
  } catch {
    return null;
  }
  return parts.join('\n');
}

/** The ref names a baseline spec is resolved from, or null when only Git can tell (revision syntax, object ids). */
function specRefNames(spec) {
  const target = spec.startsWith('merge-base:') ? spec.slice('merge-base:'.length) : null;
  const name = target ?? spec;
  if (name !== 'HEAD') {
    if (!/^\w[\w./-]*$/.test(name) || name.includes('..')) return null;
    // An abbreviated object id and a describe name (v1-3-gabc) are resolved from the object store, not from refs.
    if (/^[0-9a-f]{4,}$/i.test(name) || /-g[0-9a-f]+$/i.test(name)) return null;
  }
  const names = name === 'HEAD' ? ['HEAD'] : refCandidates(name);
  return target === null ? names : ['HEAD', ...names]; // a merge base also depends on HEAD
}

/**
 * The repository state that decides gitHead(): HEAD, the branch it names and every ref that could make the short
 * branch name ambiguous. Null when files cannot show it; see repositoryRefState.
 * @param {{gitDir: string, commonDir: string}|null} directories from gitDirectories()
 */
export function gitHeadState(directories) {
  if (!directories) return null;
  let head;
  try {
    head = readRefFile(path.join(directories.gitDir, 'HEAD'));
  } catch {
    return null;
  }
  const branch = symbolicRefValue(head, 'ref: refs/heads/');
  return repositoryRefState(directories, branch ? ['HEAD', ...refCandidates(branch)] : ['HEAD']);
}

/** Blob contents (null for a missing path or a non-blob) of a `cat-file --batch` response, in request order. */
function parseBatch(entries, output) {
  let offset = 0;
  const loaded = new Map();
  for (const { file } of entries) {
    const newline = output.indexOf(10, offset);
    if (newline < 0) throw new Error('incomplete git batch response');
    const header = output.toString('utf8', offset, newline);
    offset = newline + 1;
    if (header.endsWith(' missing')) {
      loaded.set(file, null);
      continue;
    }
    const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!match) throw new Error('invalid git batch response');
    const size = Number(match[2]);
    if (offset + size >= output.length || output[offset + size] !== 10) throw new Error('incomplete git blob');
    loaded.set(file, match[1] === 'blob' ? output.toString('utf8', offset, offset + size) : null);
    offset += size + 1;
  }
  return loaded;
}

/** The read-only command that resolves a baseline ref to its commit; throws for an unsafe ref. */
function refArgs(ref) {
  if (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-') || /[\0\r\n]/.test(ref))
    throw new Error('invalid baseline ref');
  const target = ref.startsWith('merge-base:') ? ref.slice('merge-base:'.length) : null;
  if (target !== null && (!target || target.startsWith('-'))) throw new Error('invalid merge-base ref');
  return target === null
    ? ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]
    : ['merge-base', 'HEAD', target];
}

// All paths go to git relative to sourceDir (and come back that way), so it does not matter how the
// folder is spelled (8.3 short names, symlinks, drive letter case).
export class GitBaseline {
  /**
   * Like the constructor, but resolves the ref without blocking the event loop, so startup can
   * read sources meanwhile. An unresolvable ref takes the constructor's synchronous diagnosis.
   */
  static async create(sourceDir, ref) {
    let commit;
    try {
      commit = (await gitAsync(path.resolve(sourceDir), refArgs(ref))).trim();
    } catch {
      commit = undefined;
    }
    return new GitBaseline(sourceDir, ref, commit);
  }

  /**
   * @param {string} sourceDir
   * @param {string} ref a git ref, or `merge-base:<ref>` for the commit the current branch forked from
   * @param {string} [commit] the ref's commit, already resolved by create()
   */
  constructor(sourceDir, ref, commit) {
    this.sourceDir = path.resolve(sourceDir);
    this.spec = ref;
    this.ref = ref;
    this.available = false;
    this.cache = new Map();
    this.refGeneration = 0;
    this.changeGeneration = 0;
    this.baselineVersion = 0;
    this.pendingChanges = 0;
    this.changeQueue = Promise.resolve(); // NOSONAR: constructor timing must not change
    this.pendingRefCheck = null;
    this.repository = null;
    this.noRepository = false;
    this.resolvedRefState = null;
    this.tree = null;
    this.treeLoad = null;
    try {
      this.refArgs = refArgs(ref);
      this.#acceptCommit(commit ?? git(this.sourceDir, this.refArgs).trim());
    } catch (err) {
      this.#unavailable(err);
      // A repository without commits has no baseline yet (not a broken ref): callers skip baseline checks with a note.
      let inRepository = false;
      try {
        const worktree = git(this.sourceDir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
        inRepository = true;
        this.unborn = worktree && !git(this.sourceDir, ['rev-list', '--all', '--max-count=1']).trim();
        if (this.unborn) this.error = `Cannot read baseline ${this.spec}: the repository has no commits yet`;
      } catch (error) {
        this.unborn = false;
        // Without an answer the folder may be a repository before its first commit; say so instead of the ref error.
        if (!gitAnswered(error)) this.#unavailable(error);
        // rev-parse failing with an answer is Git saying the folder is in no repository: name that, not the command.
        else if (!inRepository) {
          this.outsideRepository = true;
          this.error = `Cannot read baseline ${this.spec}: not a Git repository; baseline comparison skipped`;
        }
      }
    }
  }

  /**
   * Tells the baseline where the repository keeps its refs (gitDirectories()). From then on a change scan asks Git
   * for the baseline commit only when the files that decide it differ from the state Git last answered for; see
   * repositoryRefState for what that state covers and when it is unknown. Null is Git's answer that the folder is in
   * no repository: the baseline then stays unavailable, unasked, until a `.git` entry appears (gitMarkerExists).
   */
  followRepository(directories) {
    this.repository = directories ?? null;
    this.noRepository = directories === null;
    this.resolvedRefState = null;
  }

  #refState() {
    return this.repository ? repositoryRefState(this.repository, specRefNames(this.spec)) : null;
  }

  /** Keeps `before` as the state of the commit just accepted, unless the refs moved while Git was answering. */
  #recordRefState(before) {
    this.resolvedRefState = before !== null && before === this.#refState() ? before : null;
  }

  /** Whether the accepted commit is still what the ref resolves to, without asking Git. */
  #refIsCurrent() {
    if (!this.available) return this.noRepository && !gitMarkerExists(this.sourceDir);
    if (this.spec === this.commit) return true; // a full commit id names that commit for good
    return this.resolvedRefState !== null && this.resolvedRefState === this.#refState();
  }

  #acceptCommit(commit) {
    const changed = !this.available || this.commit !== commit;
    if (changed) {
      this.baselineVersion++;
      this.cache.clear();
      this.changedSnapshot = null;
      this.tree = null;
      this.treeLoad = null;
    }
    this.commit = commit;
    this.available = true;
    this.error = null;
    this.outsideRepository = false;
    this.unborn = false;
    return changed;
  }

  #unavailable(err) {
    const changed = this.available;
    this.baselineVersion++;
    this.available = false;
    this.commit = null;
    this.cache.clear();
    this.changedSnapshot = null;
    this.tree = null;
    this.treeLoad = null;
    this.resolvedRefState = null;
    // A later check that Git answers the same way keeps the reason found at start (no repository, no commits yet)
    // instead of the command line it failed with; a `.git` that appeared since makes the folder a repository again.
    if (this.outsideRepository && (!gitAnswered(err) || gitMarkerExists(this.sourceDir))) {
      this.outsideRepository = false;
      // A repository created since (git init) has no commits until its first one; the probe below checks.
      if (gitAnswered(err)) this.unborn = true;
    }
    // A repository that had no commits may have one now: its ref then fails for its own reason, not "no commits yet".
    if (this.unborn && gitAnswered(err))
      try {
        this.unborn = !git(this.sourceDir, ['rev-list', '--all', '--max-count=1']).trim();
      } catch {
        this.unborn = false;
      }
    let reason = err.message.split('\n')[0];
    if (this.outsideRepository) reason = 'not a Git repository; baseline comparison skipped';
    else if (this.unborn && gitAnswered(err)) reason = 'the repository has no commits yet';
    this.error = `Cannot read baseline ${this.spec}: ${reason}`;
    return changed;
  }

  /** Non-blocking ref check for the watcher, including merge-base changes and lost/recovered refs. */
  async checkForUpdate() {
    if (!this.refArgs) return false;
    // Git answered that the folder is in no repository: it is asked again once a `.git` entry could make it one.
    if (!this.available && this.#refIsCurrent()) return false;
    if (this.pendingRefCheck) return this.pendingRefCheck; // NOSONAR: optional pending promise, awaited only when set
    const generation = ++this.refGeneration;
    const pending = (async () => {
      const before = this.#refState();
      try {
        const commit = (await gitAsync(this.sourceDir, this.refArgs)).trim();
        if (generation !== this.refGeneration) return false;
        const changed = this.#acceptCommit(commit);
        this.#recordRefState(before);
        return changed;
      } catch (err) {
        return generation === this.refGeneration ? this.#unavailable(err) : false;
      } finally {
        if (this.pendingRefCheck === pending) this.pendingRefCheck = null;
      }
    })();
    this.pendingRefCheck = pending;
    return pending;
  }

  #relative(file) {
    const rel = path.relative(this.sourceDir, path.resolve(file));
    return !rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
      ? null
      : rel.replaceAll('\\', '/');
  }

  #batch(files) {
    const entries = this.available
      ? [...new Set(files.map((file) => path.resolve(file)))]
          .filter((file) => !this.cache.has(file))
          .map((file) => ({ file, rel: this.#relative(file) }))
          .filter(({ rel }) => rel && !/[\r\n]/.test(rel))
      : [];
    return { entries, input: entries.map(({ rel }) => `${this.commit}:./${rel}\n`).join('') };
  }

  /** Read many baseline blobs in one process. Each batch response is framed by its byte length. */
  preload(files) {
    const { entries, input } = this.#batch(files);
    if (!entries.length) return;
    let output;
    try {
      output = git(this.sourceDir, ['cat-file', '--batch'], { buffer: true, input });
    } catch (err) {
      // A Git that gave no answer is not asked again per file: the baseline is unavailable until a ref check
      // gets an answer. A failed batch leaves show() as an individual-file fallback.
      if (!gitAnswered(err)) this.#unavailable(err);
      return;
    }
    try {
      for (const [file, content] of parseBatch(entries, output)) this.cache.set(file, content);
    } catch {
      // An incomplete response leaves show() as the individual-file fallback.
    }
  }

  /** preload() without blocking the event loop; a result read for a superseded commit is dropped. */
  async preloadAsync(files) {
    const { entries, input } = this.#batch(files);
    if (!entries.length) return;
    const version = this.baselineVersion;
    let output;
    try {
      output = await gitAsync(this.sourceDir, ['cat-file', '--batch'], { buffer: true, input });
    } catch (err) {
      // As preload(): no answer makes the baseline unavailable, a failed batch leaves show() as the fallback.
      if (version === this.baselineVersion && !gitAnswered(err)) this.#unavailable(err);
      return;
    }
    if (version !== this.baselineVersion) return;
    try {
      for (const [file, content] of parseBatch(entries, output))
        if (!this.cache.has(file)) this.cache.set(file, content);
    } catch {
      // As preload(): an incomplete response leaves show() as the fallback.
    }
  }

  /**
   * Content of `file` at the baseline ref; null when Git answers that it does not exist there (a new file), or
   * when the baseline is unavailable. A Git that gives no answer makes the baseline unavailable (with the error)
   * instead of recording the file as new; the next ref check that gets an answer makes it available again.
   */
  show(file) {
    if (!this.available) return null;
    file = path.resolve(file);
    if (this.cache.has(file)) return this.cache.get(file);
    let content = null;
    try {
      const rel = this.#relative(file);
      if (rel) content = git(this.sourceDir, ['show', `${this.commit}:./${rel}`], { buffer: true }).toString('utf8');
    } catch (err) {
      if (!gitAnswered(err)) {
        this.#unavailable(err);
        return null;
      }
    }
    this.cache.set(file, content);
    return content;
  }

  #changePlan(files, forceFull = false) {
    const rootChanged = files?.some((file) => path.relative(this.sourceDir, path.resolve(file)) === '');
    let scoped =
      !forceFull && this.changedSnapshot && files?.length && !rootChanged
        ? [...new Set(files.map((file) => this.#relative(file)).filter(Boolean))]
        : null;
    // Large save batches are cheaper as one full scan and must fit Windows' argument limit.
    if (scoped && (scoped.length > 128 || scoped.join(' ').length > 16_000)) scoped = null;
    const targets = scoped ? scoped.map((file) => `./${file}`) : ['.'];
    return {
      scoped,
      previous: this.changedSnapshot,
      commands: [
        [
          '--literal-pathspecs',
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--name-only',
          '--relative',
          '-z',
          this.commit,
          '--',
          ...targets,
        ],
        ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', ...targets],
      ],
    };
  }

  /**
   * The paths of the baseline commit below sourceDir, read once per commit (a commit's tree never changes). Null
   * when Git did not list them.
   * @returns {Set<string>|null|Promise<Set<string>|null>}
   */
  #treePaths() {
    if (this.tree) return this.tree;
    const version = this.baselineVersion;
    this.treeLoad ??= gitAsync(this.sourceDir, ['ls-tree', '-r', '--name-only', '-z', this.commit]).then(
      (output) => {
        if (version !== this.baselineVersion) return null;
        this.treeLoad = null;
        this.tree = new Set(output.split('\0').filter(Boolean));
        return this.tree;
      },
      () => {
        if (version === this.baselineVersion) this.treeLoad = null;
        return null;
      },
    );
    return this.treeLoad;
  }

  /**
   * Whether the untracked-files listing can add anything for these saved paths. It cannot for a path that is a
   * file of the baseline commit: while it is tracked, `diff` compares it; once it is removed from the index, `diff`
   * reports it as deleted. A directory on disk can hold untracked files whatever the commit has under that name.
   */
  #untrackedPossible(scoped, tree) {
    if (!tree) return true;
    return scoped.some(
      (rel) =>
        !tree.has(rel) || fs.statSync(path.resolve(this.sourceDir, rel), { throwIfNoEntry: false })?.isDirectory(),
    );
  }

  /** Runs the commands of a change plan; settled results in the order [diff, untracked]. */
  async #scan({ scoped, commands: [diff, untracked] }) {
    const run = (args) => gitAsync(this.sourceDir, args);
    if (!scoped) return Promise.allSettled([run(diff), run(untracked)]);
    const known = this.#treePaths();
    if (known instanceof Set)
      return Promise.allSettled([run(diff), this.#untrackedPossible(scoped, known) ? run(untracked) : '']);
    // First scoped scan of this commit: its paths are listed alongside the diff, and the untracked listing runs
    // afterwards only when a saved path needs it.
    const [changed, tree] = await Promise.allSettled([run(diff), known]);
    const [others] = await Promise.allSettled([this.#untrackedPossible(scoped, tree.value) ? run(untracked) : '']);
    return [changed, others];
  }

  #mergeChanges({ scoped, previous }, lists) {
    const out = new Set();
    for (const list of lists) {
      for (const rel of list.split('\0')) if (rel) out.add(path.resolve(this.sourceDir, rel));
    }
    if (scoped) {
      const key = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
      const roots = scoped.map((file) => key(path.resolve(this.sourceDir, file)));
      for (const file of previous) {
        const candidate = key(file);
        if (!roots.some((root) => candidate === root || candidate.startsWith(root + path.sep))) out.add(file);
      }
    }
    this.changedSnapshot = out;
    return new Set(out);
  }

  /**
   * Absolute paths under sourceDir that differ from the baseline ref (modified, added, untracked).
   * `files` updates those saved paths in a prior full snapshot. Call without it after structural
   * changes or when the caller cannot provide every changed path. Returned sets are independent.
   * `refreshRef: false` reuses the current resolved commit, e.g. immediately after construction.
   * @returns {Set<string>}
   */
  changedFiles({ files, refreshRef = true } = {}) {
    this.changeGeneration++;
    if (!this.refArgs) return new Set();
    try {
      if (refreshRef && !this.#refIsCurrent()) {
        this.refGeneration++;
        const before = this.#refState();
        this.#acceptCommit(git(this.sourceDir, this.refArgs).trim());
        this.#recordRefState(before);
      }
      if (!this.available) return new Set();
      const plan = this.#changePlan(files, this.pendingChanges > 0);
      if (plan.scoped?.length === 0) return new Set(this.changedSnapshot);
      return this.#mergeChanges(
        plan,
        plan.commands.map((args) => git(this.sourceDir, args)),
      );
    } catch (error) {
      this.#unavailable(error);
      return new Set();
    }
  }

  /* NOSONAR: preserve await boundaries and concurrent scan ordering */ changedFilesAsync({
    files,
    refreshRef = true,
  } = {}) {
    const generation = ++this.changeGeneration;
    const forceFull = this.pendingChanges++ > 0;
    const current = () => new Set(this.changedSnapshot ?? []);
    const previous = this.changeQueue;
    const pending = (async () /* NOSONAR */ => {
      // NOSONAR: preserve state, evaluation order, and lifecycle
      // Only one scan owns subprocesses; a save burst skips superseded queued work.
      await previous;
      if (generation !== this.changeGeneration || !this.refArgs) return current();
      try {
        if (refreshRef && !this.#refIsCurrent()) {
          const refGeneration = ++this.refGeneration;
          const before = this.#refState();
          try {
            const commit = (await gitAsync(this.sourceDir, this.refArgs)).trim();
            if (generation !== this.changeGeneration) return current();
            if (refGeneration === this.refGeneration) {
              this.#acceptCommit(commit);
              this.#recordRefState(before);
            } else if (this.pendingRefCheck) await this.pendingRefCheck;
          } catch (error) {
            if (generation !== this.changeGeneration) return current();
            if (refGeneration === this.refGeneration) this.#unavailable(error);
            else if (this.pendingRefCheck) await this.pendingRefCheck;
          }
        }
        let attempts = 0;
        while (generation === this.changeGeneration && this.available) {
          const version = this.baselineVersion;
          const plan = this.#changePlan(files, forceFull);
          if (plan.scoped?.length === 0) return current();
          // Wait for every command even on failure before another queued scan can start.
          const results = await this.#scan(plan);
          if (generation !== this.changeGeneration) return current();
          // A ref poll changed the baseline during the scan. Recompute against its new commit.
          if (version !== this.baselineVersion) {
            if (++attempts >= 3)
              throw new Error(
                'Baseline changed during three consecutive change scans; retry after local Git activity settles',
              );
            continue;
          }
          const failed = results.find((result) => result.status === 'rejected');
          if (failed) throw failed.reason;
          return this.#mergeChanges(
            plan,
            results.map((result) => result.value),
          );
        }
        return current();
      } catch (error) {
        if (generation === this.changeGeneration) this.#unavailable(error);
        return current();
      }
    })().finally(() => {
      this.pendingChanges--;
    });
    this.changeQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}
