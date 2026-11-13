// Thin git helpers: the baseline version of a source file and the set of files changed against it.
import { execFile, execFileSync } from 'node:child_process';
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
 * Directories whose files change when HEAD or a ref moves: the checkout's own git dir (HEAD of a
 * linked worktree lives there) and the common dir (refs, packed-refs). Null when Git answers that the folder is
 * not in a working tree; rejects when Git gives no answer.
 * @returns {Promise<{gitDir: string, commonDir: string, toplevel: string}|null>}
 */
export async function gitDirectories(sourceDir) {
  sourceDir = path.resolve(sourceDir);
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
  };
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
    try {
      this.refArgs = refArgs(ref);
      this.#acceptCommit(commit ?? git(this.sourceDir, this.refArgs).trim());
    } catch (err) {
      this.#unavailable(err);
      // A repository without commits has no baseline yet (not a broken ref): callers skip baseline checks with a note.
      try {
        this.unborn =
          git(this.sourceDir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true' &&
          !git(this.sourceDir, ['rev-list', '--all', '--max-count=1']).trim();
      } catch (probe) {
        this.unborn = false;
        // Without an answer the folder may be a repository before its first commit; say so instead of the ref error.
        if (!gitAnswered(probe)) this.#unavailable(probe);
      }
    }
  }

  #acceptCommit(commit) {
    const changed = !this.available || this.commit !== commit;
    if (changed) {
      this.baselineVersion++;
      this.cache.clear();
      this.changedSnapshot = null;
    }
    this.commit = commit;
    this.available = true;
    this.error = null;
    return changed;
  }

  #unavailable(err) {
    const changed = this.available;
    this.baselineVersion++;
    this.available = false;
    this.commit = null;
    this.cache.clear();
    this.changedSnapshot = null;
    this.error = `Cannot read baseline ${this.spec}: ${err.message.split('\n')[0]}`;
    return changed;
  }

  /** Non-blocking ref check for the watcher, including merge-base changes and lost/recovered refs. */
  async checkForUpdate() {
    if (!this.refArgs) return false;
    if (this.pendingRefCheck) return this.pendingRefCheck; // NOSONAR: optional pending promise, awaited only when set
    const generation = ++this.refGeneration;
    const pending = (async () => {
      try {
        const commit = (await gitAsync(this.sourceDir, this.refArgs)).trim();
        return generation === this.refGeneration ? this.#acceptCommit(commit) : false;
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
      if (refreshRef) {
        this.refGeneration++;
        this.#acceptCommit(git(this.sourceDir, this.refArgs).trim());
      }
      if (!this.available) return new Set();
      const plan = this.#changePlan(files, this.pendingChanges > 0);
      if (plan.scoped?.length === 0) return new Set(this.changedSnapshot);
      return this.#mergeChanges(
        plan,
        plan.commands.map((args) => git(this.sourceDir, args)),
      );
    } catch (err) {
      this.#unavailable(err);
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
        if (refreshRef) {
          const refGeneration = ++this.refGeneration;
          try {
            const commit = (await gitAsync(this.sourceDir, this.refArgs)).trim();
            if (generation !== this.changeGeneration) return current();
            if (refGeneration === this.refGeneration) this.#acceptCommit(commit);
            else if (this.pendingRefCheck) await this.pendingRefCheck;
          } catch (err) {
            if (generation !== this.changeGeneration) return current();
            if (refGeneration === this.refGeneration) this.#unavailable(err);
            else if (this.pendingRefCheck) await this.pendingRefCheck;
          }
        }
        let attempts = 0;
        while (generation === this.changeGeneration && this.available) {
          const version = this.baselineVersion;
          const plan = this.#changePlan(files, forceFull);
          if (plan.scoped?.length === 0) return current();
          // Wait for both commands even on failure before another queued scan can start.
          const results = await Promise.allSettled(plan.commands.map((args) => gitAsync(this.sourceDir, args)));
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
      } catch (err) {
        if (generation === this.changeGeneration) this.#unavailable(err);
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
