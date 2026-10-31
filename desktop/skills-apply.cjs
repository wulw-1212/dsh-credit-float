'use strict'
/**
 * Skill-repository updater — the half that actually moves a checkout forward.
 *
 * `skills-update.cjs` answers "which installed skill folder is behind upstream?"
 * without touching disk. This module answers the next question, "make those
 * folders current, now that the user clicked": it performs the update, and
 * refuses whenever an update is not obviously safe.
 *
 * ── The entire vocabulary of writes ─────────────────────────────────────────
 *
 * A repository is advanced by exactly two mutating git commands:
 *
 *   git … fetch origin refs/heads/<branch>   (download objects, move one ref)
 *   git … merge --ff-only <remote sha>       (move HEAD + write working tree)
 *
 * guarded by read-only checks (`rev-parse`, `symbolic-ref`, `status --porcelain`,
 * `merge-base --is-ancestor`, `check-ref-format`, `remote get-url`). Nothing else
 * in git that could change a repository appears in this file: no merge commit, no
 * `pull`, no `reset`, no `checkout -f`, no stash, no `clean`, no `rebase`, no
 * `--force`, no `--prune`, and nothing is ever pushed. Where a repository cannot
 * be fast-forwarded it is reported `skipped` with a reason and left byte-for-byte
 * as it was; the user then decides in a real git client what should happen. (A
 * fast-forward that git itself refuses half-way — the untracked-collision case
 * below — is a *failure*, not a skip: the user asked for an update, git tried, and
 * git said no.)
 *
 * ── What "dirty" means here ─────────────────────────────────────────────────
 *
 * Only a change to a **tracked** file blocks an update: staged, unstaged, renamed,
 * deleted or conflicted content that git has a record of is the user's work sitting
 * on top of the commit we would leave behind, and a fast-forward would either strand
 * it on new code or abort mid-checkout. An **untracked** file is not that. Git
 * protects untracked paths by itself: `merge --ff-only` refuses when upstream adds a
 * path one of them already occupies (measured on git 2.56: exit 1, `error: The
 * following untracked working tree files would be overwritten by merge:`, HEAD
 * unmoved, no `MERGE_HEAD`, the file untouched) and otherwise leaves them exactly as
 * they were. Measured on this machine, the one skill repository with local content
 * (`picture-skills`) was "dirty" only because its generated `output/picture-books/`
 * is untracked, so the older rule kept it from ever being updated. Untracked files
 * that survive an update are reported on the result (`untracked`, plus a `note` when
 * there are any) and are never turned into a skip or a failure.
 *
 * The test suite asserts that claim two ways: behaviourally against `file://`
 * fixtures, and by recording every command git actually exec'd (through
 * `GIT_TRACE2_EVENT`) so the allow-list is a fact about this run, not a promise
 * about this source text.
 *
 * ── Why refusing is the default ─────────────────────────────────────────────
 *
 * `$DSH_HOME/skills` holds third-party repositories the user cloned by hand and
 * may have edited by hand. A lost local edit there is not recoverable through the
 * usual route (those objects were never in any remote the user controls), so the
 * cost of one wrong update is far higher than the cost of declining an update that
 * would have been fine. Every check below encodes one way an "update" could
 * silently become a data loss or a surprise; the list is deliberately longer than
 * git's own documentation requires.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

/** Read-only git calls must not hang the caller. Same budget as the detector. */
const GIT_TIMEOUT_MS = 25_000
/** `fetch` needs the network; 25 s is routinely too short on a cold connection. */
const FETCH_TIMEOUT_MS = 60_000
/**
 * `merge --ff-only` writes every changed file into the working tree, which on
 * Windows with an antivirus scanning each file is slower than a purely local git
 * command has any right to be. Measured on this machine: a fast-forward touching
 * ~1 500 small files takes ~0.4 s and ~3 600 × 64 KB files ~1.7 s, so a real
 * skill repository is minutes at worst rather than an hour. It gets the network
 * budget instead of the 25 s default.
 */
const MERGE_TIMEOUT_MS = 60_000
/** Refuse to touch more folders in one call than the watcher would ever list. */
const MAX_REPOS = 200

const SHA = /^[0-9a-f]{40,64}$/
/** A runaway `git` must not be able to hand the caller a megabyte of noise. */
const MAX_STDOUT = 256 * 1024
const MAX_STDERR = 32 * 1024

/**
 * git's own words for "the branch you asked for does not exist over there".
 *
 * Measured against git 2.56: `fetch origin refs/heads/nope` exits 128 with
 * `fatal: couldn't find remote ref refs/heads/nope`. That is not a failure of the
 * update — the branch was deleted or renamed upstream, or this local branch was
 * never published there. Nothing about the repository is wrong, so it is a skip;
 * calling it a failure would make the UI report an outage where there is none.
 */
const MISSING_REMOTE_REF = /couldn'?t find remote ref|could not find remote ref/i

/**
 * git's own words for "a path this merge must write is occupied by an untracked file".
 *
 * Measured on git 2.56 in a `file://` fixture: `merge --ff-only` then exits **1**
 * with `error: The following untracked working tree files would be overwritten by
 * merge:` followed by the paths, and the repository is left exactly as it was —
 * HEAD unmoved, index untouched, no `MERGE_HEAD`, the untracked file byte-for-byte
 * intact. It is the one failure an untracked file can cause, and it is a genuine
 * refusal rather than a skip, so it gets a reason the user can act on.
 */
const UNTRACKED_COLLISION = /untracked working tree files? would be overwritten/i

const GIT_CANDIDATES = [
  process.env.DCF_GIT_PATH,
  'git',
  process.platform === 'win32'
    ? [
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'cmd', 'git.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'),
      ]
    : undefined,
]
  .flat(Infinity)
  .filter(Boolean)

/**
 * Git environment that keeps an update from ever becoming interactive.
 *
 * Same rules as `gitEnv()` in skills-update.cjs (not imported: that module does
 * not export it, and making the read-only detector depend on the writer would be
 * the wrong direction). `GIT_TERMINAL_PROMPT=0` makes git fail instead of asking
 * for a username, `GCM_INTERACTIVE=never` stops the Windows credential manager
 * from popping a GUI window out of a background helper, and
 * `SSH_ASKPASS_REQUIRE=never` is the ssh equivalent for an encrypted key. Without
 * these, a fetch could block forever on a prompt nobody can see — and this module
 * runs where the user cannot answer it.
 *
 * The *system* and *global* gitconfigs stay in place on purpose: Git for Windows
 * keeps TLS/proxy settings there, and a mirror rewrite (`url.<proxy>.insteadOf`)
 * is how many installs reach GitHub at all. Ignoring them would refuse updates for
 * repositories the user clones daily. Anything from those files that could make a
 * *write* surprising is neutralised per command with `-c` instead — see
 * `writeGuardArgs` — which is a targeted refusal rather than a blinder.
 */
function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    SSH_ASKPASS_REQUIRE: 'never',
    HOME: process.env.HOME || process.env.USERPROFILE || process.cwd(),
  }
}

/**
 * `-c` overrides for commands that *read* state.
 *
 * A filesystem-monitor daemon can cache a dirty working tree as clean; if the
 * clean-tree check lies, the checkout step overwrites the user's files. Turning
 * `core.fsmonitor` off costs a few milliseconds of stat() and makes the answer
 * come from git's own index and files rather than from a helper's memory.
 */
function readGuardArgs() {
  return ['-c', 'core.fsmonitor=false']
}

/**
 * `-c` overrides for the two commands that *write*.
 *
 * Each one closes a door a user's own configuration could open:
 *
 * - `core.hooksPath` → an empty directory. See `makeNoHooksDir`.
 * - `merge.autostash=false` → with autostash enabled git would move local edits
 *   into a stash and leave them there; we already refuse a dirty tree, and this
 *   makes sure a stray setting cannot turn that refusal into a silent move.
 * - `rerere.enabled=false` → conflict resolutions reused from history have no
 *   business deciding what lands in a skill folder.
 * - `submodule.recurse=false` → move this repository's own commit and nothing
 *   else. Recursing would update submodule checkouts we never inspected.
 * - `commit.gpgsign=false` → a fast-forward creates no commit, so this is only
 *   insurance against a signing prompt on a code path we did not foresee.
 * - `gc.auto=0` → an auto-gc started mid-run can outlive our timeout and would
 *   rewrite object storage while we are still relying on it.
 */
function writeGuardArgs(noHooksPath) {
  return [
    ...readGuardArgs(),
    '-c',
    `core.hooksPath=${noHooksPath}`,
    '-c',
    'merge.autostash=false',
    '-c',
    'rerere.enabled=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'gc.auto=0',
  ]
}

/**
 * Create an empty directory to point `core.hooksPath` at, disabling hooks.
 *
 * Third-party repositories ship hooks, and a skill folder is exactly the kind of
 * code that gets cloned from a stranger. Measured on git 2.56 with temp fixtures:
 * `post-merge` **does** fire on a fast-forward merge (and the merge completes only
 * after the hook returns), and `reference-transaction` **does** fire during a
 * plain `git fetch`. So this is not a theoretical worry: clicking "update skills"
 * would otherwise execute arbitrary code from each repository with our privileges,
 * at the moment the user is least watching.
 *
 * The cost of disabling is honest and small: a hook that regenerates something
 * after an update will not run. Nothing in a skills folder is a build, and the
 * result records `hooksSuppressed` so the log shows it happened. A user who wants
 * hooks to run can update by hand in their own terminal.
 *
 * Lives under `os.tmpdir()`, is removed by the caller's `finally`, and is the only
 * path outside a repository this module ever creates.
 */
function makeNoHooksDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcf-skill-no-hooks-'))
  // Forward slashes are accepted on Windows and avoid backslash-escaping
  // questions inside a `-c key=value` argument.
  return process.platform === 'win32' ? dir.replace(/\\/g, '/') : dir
}

function removeNoHooksDir(dir) {
  if (!dir) return
  try {
    // Only ever a directory this module created with mkdtemp, which git must
    // have left empty.
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* an empty temp folder left behind is not worth failing an update over */
  }
}

/**
 * Run git with args, capturing stdout. Never rejects: a non-zero exit is data the
 * caller branches on, not an error to propagate.
 */
function runGit(git, args, cwd, timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(git, args, {
        cwd,
        env: gitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(kill)
      resolve(result)
    }

    const kill = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      // `timedOut` is what lets a caller tell "slow" from "refused": the exit code
      // of a force-killed process on Windows carries no signal information.
      finish({ code: -1, stdout, stderr: stderr || 'git 执行超时', timedOut: true })
    }, timeoutMs)
    kill.unref?.()

    child.stdout?.on('data', chunk => {
      if (stdout.length < MAX_STDOUT) stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      if (stderr.length < MAX_STDERR) stderr += String(chunk)
    })
    child.on('error', error => {
      // ENOENT (git vanished), EACCES, EPERM, and a cwd that stopped existing —
      // all reported as results, none thrown.
      finish({ code: -1, stdout, stderr: String(error?.message ?? error), timedOut: false })
    })
    child.on('close', code => {
      finish({ code: Number.isFinite(code) ? code : -1, stdout, stderr, timedOut: false })
    })
  })
}

/** The first git that answers `--version`, or null. Same search as the detector. */
async function resolveGit(log) {
  for (const candidate of GIT_CANDIDATES) {
    const result = await runGit(candidate, ['--version'], process.cwd())
    if (result.code === 0 && /git version/.test(result.stdout)) {
      log?.debug?.(`[skills-apply] 使用 git: ${candidate}（${result.stdout.trim()}）`)
      return candidate
    }
  }
  return null
}

/**
 * Compare two paths the way a human means it: separator-insensitive, trailing
 * separator-insensitive, and case-insensitive on Windows — because
 * `rev-parse --show-toplevel` answers with forward slashes while callers hand us
 * `path.join` output with backslashes.
 */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const clean = value => {
    const text = value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? text.toLowerCase() : text
  }
  return clean(a) === clean(b)
}

/** Absolute path of a file inside this repository's own git directory. */
async function gitPathFile(git, dir, name) {
  const res = await runGit(git, [...readGuardArgs(), 'rev-parse', '--git-path', name], dir)
  if (res.code !== 0 || !res.stdout.trim()) return ''
  return path.resolve(dir, res.stdout.trim())
}

/**
 * Files that mean "a git operation was interrupted here and is still pending".
 *
 * Advancing HEAD on top of one would either fail confusingly or finish somebody
 * else's half-done operation, so we refuse. We never remove them: clearing a
 * `MERGE_HEAD` is a decision about intent, not a cleanup, and it belongs to the
 * user. The `rebase-*` names appear here purely as *markers we refuse on* — this
 * module never runs that command.
 *
 * `ORIG_HEAD` is deliberately absent: git writes it as a normal artifact of any
 * successful merge, and treating it as damage would refuse every second update.
 */
const IN_PROGRESS_MARKERS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'index.lock',
  'rebase-merge',
  'rebase-apply',
  'sequencer',
]

async function findInProgressMarker(git, dir) {
  for (const marker of IN_PROGRESS_MARKERS) {
    const file = await gitPathFile(git, dir, marker)
    if (!file) continue
    try {
      if (fs.existsSync(file)) return marker
    } catch {
      /* unreadable: treat as absent and let the git command report it */
    }
  }
  return ''
}

/** The commit HEAD resolves to, or '' when it cannot be resolved. */
async function headSha(git, dir) {
  const res = await runGit(git, [...readGuardArgs(), 'rev-parse', '--verify', 'HEAD^{commit}'], dir)
  const sha = res.stdout.trim()
  return res.code === 0 && SHA.test(sha) ? sha : ''
}

/**
 * The branch HEAD is attached to, or '' when detached / unresolvable.
 *
 * `symbolic-ref --quiet --short HEAD` rather than `rev-parse --abbrev-ref HEAD`:
 * measured, `--abbrev-ref` answers the literal string `HEAD` when detached (the
 * shape the brief describes), while `symbolic-ref --quiet` exits non-zero, which
 * is the fact we want and does not depend on a reserved word never colliding with
 * a real branch name.
 */
async function branchName(git, dir) {
  const res = await runGit(git, [...readGuardArgs(), 'symbolic-ref', '--quiet', '--short', 'HEAD'], dir)
  const short = res.stdout.trim()
  return res.code === 0 && short && short !== 'HEAD' ? short : ''
}

/**
 * The non-empty lines of a porcelain listing, without the platform's line ends.
 *
 * Porcelain quotes unusual bytes C-style (`core.quotePath`), so a path containing a
 * newline arrives as the two characters `\` `n` and a listing can still be split on
 * `\n` safely.
 */
function porcelainLines(text) {
  return String(text ?? '')
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line !== '')
}

/**
 * Working-tree state, split into the two kinds of "not clean" porcelain reports.
 *
 * The split is the point, because only one of them blocks anything:
 *
 * - **`??` entries (untracked files) are information, never dirt.** Nothing about
 *   them needs our protection — see the header: git refuses a fast-forward whose
 *   upstream paths collide with them, and otherwise leaves them alone. So they are
 *   counted and handed to the caller for reporting, and `dirty` ignores them.
 * - **Everything else is a tracked change** — staged, unstaged, renamed, deleted,
 *   conflicted, or submodule drift — and every non-`??` line means "do not touch
 *   this repository".
 * - `ignoreSubmodules: false` — the dirty check before merging, and the strict
 *   reading that decides `submodulesDirty` afterwards. Submodule drift is reported
 *   there: a gitlink the user staged, or a submodule checkout they moved, is *their*
 *   state, and a fast-forward would rewrite the recorded pointer over it. Refusing
 *   before the merge is the safe answer.
 * - `ignoreSubmodules: true` — **the verification, after merging** (and the state
 *   reported when a merge fails). Measured: a fast-forward that bumps a gitlink
 *   leaves `status --porcelain` reporting `M child` until somebody runs
 *   `submodule update`, which this module never does (see `submodule.recurse=false`).
 *   With default strictness every successful update of a submodule-bearing skill
 *   would be reported as a *failure* on a repository that is in fact fine. So the
 *   relaxed reading decides success, and the drift is surfaced as the informational
 *   flag `submodulesDirty` instead. Two of the fifteen repositories in this
 *   machine's skills folder have a `.gitmodules`, so this difference is not
 *   hypothetical.
 *
 * `--untracked-files=all` stays even though untracked entries no longer block: the
 * listing is how a result can still say "there are N untracked files here". Asking
 * for `--untracked-files=no` would answer the blocking question just as well and
 * throw that fact away.
 */
async function porcelainStatus(git, dir, { ignoreSubmodules = false } = {}) {
  const args = [...readGuardArgs(), 'status', '--porcelain', '--untracked-files=all']
  if (ignoreSubmodules) args.push('--ignore-submodules=all')
  const res = await runGit(git, args, dir)
  if (res.code !== 0) {
    return {
      ok: false,
      dirty: true,
      text: '',
      truncated: false,
      tracked: [],
      trackedCount: 0,
      untracked: 0,
      untrackedText: '',
      reason: (res.stderr || res.stdout).trim().split('\n')[0] || 'git status 失败',
    }
  }

  const entries = porcelainLines(res.stdout)
  let tracked = entries.filter(line => !line.startsWith('??'))

  // `runGit` stops appending at MAX_STDOUT, and a listing cut in half can hide a
  // tracked entry — the one thing that must never be missed. In that single case,
  // ask the blocking question again with untracked entries left out: that answer is
  // small enough that it cannot itself be cut, and it is exactly "is a tracked file
  // changed?". (The untracked count from a truncated listing is a floor, which is
  // why it is only ever reported, never acted on.)
  const truncated = res.stdout.length >= MAX_STDOUT
  if (truncated) {
    const narrow = [...readGuardArgs(), 'status', '--porcelain', '--untracked-files=no']
    if (ignoreSubmodules) narrow.push('--ignore-submodules=all')
    const again = await runGit(git, narrow, dir)
    if (again.code !== 0) {
      return {
        ok: false,
        dirty: true,
        text: res.stdout,
        truncated: true,
        tracked: [],
        trackedCount: 0,
        untracked: 0,
        untrackedText: '',
        reason: (again.stderr || again.stdout).trim().split('\n')[0] || 'git status 失败（未跟踪列表过长）',
      }
    }
    tracked = porcelainLines(again.stdout)
  }

  const untracked = entries.filter(line => line.startsWith('??'))
  return {
    ok: true,
    // The one reading that blocks anything: is a *tracked* file changed?
    dirty: tracked.length > 0,
    text: res.stdout,
    truncated,
    tracked,
    trackedCount: tracked.length,
    untracked: untracked.length,
    untrackedText: untracked.join('\n'),
  }
}

/**
 * Is `branch` safe to place inside `refs/heads/<branch>`?
 *
 * `git check-ref-format` alone is not enough — measured on git 2.56 it accepts
 * `-x` and `HEAD`. A leading dash cannot in fact be mistaken for an option here
 * (the refspec always goes as a single argv element already prefixed with
 * `refs/heads/`, and never through a shell), but `HEAD` and a name containing
 * whitespace would make the refspec mean something other than "the branch the user
 * is on", which is the one thing this module must not guess at.
 */
async function isUsableBranchName(git, dir, branch) {
  if (typeof branch !== 'string' || branch === '' || branch === 'HEAD') return false
  if (/[\s\u0000-\u001f\u007f]/.test(branch)) return false
  if (branch.startsWith('-') || branch.includes('..')) return false
  const res = await runGit(git, [...readGuardArgs(), 'check-ref-format', `refs/heads/${branch}`], dir)
  return res.code === 0
}

function isSha(value) {
  return typeof value === 'string' && SHA.test(value.trim())
}

/**
 * Everything that has to be true before a single byte is written.
 *
 * Returns `{ ok: true, branch, from, remote, untracked }`, or
 * `{ ok: false, reason, skipped }` where `skipped` separates "this repository is
 * fine, we just will not touch it" from "something is wrong here". `untracked` is
 * the number of untracked files seen, reported but never a reason to refuse. Split
 * out from the write so the refusal reasons stay readable and each one is testable
 * on its own.
 */
async function preflight(git, repo) {
  const dir = typeof repo?.path === 'string' ? repo.path : ''
  if (!dir) return { ok: false, reason: '仓库路径缺失' }

  let stat
  try {
    stat = fs.statSync(dir)
  } catch (error) {
    return { ok: false, reason: `目录不存在或不可访问：${String(error?.code ?? error?.message ?? error)}` }
  }
  if (!stat.isDirectory()) return { ok: false, reason: '路径不是目录' }

  // Must be a repository we can talk to at all.
  const inside = await runGit(git, [...readGuardArgs(), 'rev-parse', '--is-inside-work-tree'], dir)
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return {
      ok: false,
      reason: '不是 git 仓库（rev-parse 未确认工作区）',
      detail: (inside.stderr || inside.stdout).trim().split('\n')[0],
    }
  }

  const from = await headSha(git, dir)
  if (!from) return { ok: false, reason: '本地 HEAD 无法解析（空仓库，或对象库损坏？）' }

  // A submodule checkout belongs to a superproject: moving its HEAD without the
  // superproject knowing leaves a gitlink pointing at a commit the superproject
  // never recorded. The superproject — or the user — should update it.
  //
  // Checked before the repo-root rule below because a submodule checkout fails
  // *both*: its toplevel is itself, and it has a superproject. "This is a
  // submodule" is the truer and more actionable of the two reasons.
  const superproject = await runGit(git, [...readGuardArgs(), 'rev-parse', '--show-superproject-working-tree'], dir)
  if (superproject.code === 0 && superproject.stdout.trim()) {
    return {
      ok: false,
      skipped: true,
      reason: '这是子模块，应由上层仓库（或你）更新，不单独快进',
      detail: superproject.stdout.trim(),
    }
  }

  // The folder we were handed must be the repository root. A skills folder that
  // is a *subdirectory* of one larger repository would otherwise be updated as if
  // it were its own checkout, moving commits across a tree the user never pointed
  // at.
  //
  // `stdout` carries git's trailing newline; `samePath` compares whole strings, so
  // it must be trimmed here — leaving it in would reject every legitimate
  // repository root as "not the root".
  const toplevel = await runGit(git, [...readGuardArgs(), 'rev-parse', '--show-toplevel'], dir)
  const root = toplevel.stdout.trim()
  if (toplevel.code !== 0 || !samePath(root, dir)) {
    return {
      ok: false,
      skipped: true,
      reason: '该目录不是仓库根目录，不在子目录里更新整个仓库',
      detail: `toplevel=${root}`,
    }
  }

  // A shallow clone may not contain the merge base at all, so the ancestry test
  // cannot answer the question we are about to ask it (measured: it exits 128 with
  // "Not a valid commit name"). Deepening a history is the user's decision.
  const shallow = await runGit(git, [...readGuardArgs(), 'rev-parse', '--is-shallow-repository'], dir)
  if (shallow.stdout.trim() === 'true') {
    return { ok: false, skipped: true, reason: '浅克隆仓库判断不了祖先关系，不更新（需要你先加深历史）' }
  }

  // HEAD must name a branch. Detached HEAD has no branch to advance; picking "the
  // latest upstream commit" would invent a branch the user did not choose.
  const branch = await branchName(git, dir)
  if (!branch) return { ok: false, skipped: true, reason: '游离 HEAD（不在任何分支上），不更新' }
  if (typeof repo.branch === 'string' && repo.branch && repo.branch !== branch) {
    return {
      ok: false,
      skipped: true,
      reason: `当前分支是 ${branch}，与检测时记录的 ${repo.branch} 不一致（你可能已经切换了分支），不更新`,
    }
  }
  if (!(await isUsableBranchName(git, dir, branch))) {
    return { ok: false, skipped: true, reason: `分支名 ${branch} 不能安全地用于 refspec，不更新` }
  }

  // The caller's snapshot is a claim about the past. If HEAD moved since the
  // check — the user committed, or switched branches in their own terminal — the
  // remote sha we were handed is not necessarily the right target any more.
  if (isSha(repo.localSha) && repo.localSha.trim() !== from) {
    return {
      ok: false,
      skipped: true,
      reason: `本地 HEAD 自检测后已变化（${repo.localSha.slice(0, 7)} → ${from.slice(0, 7)}），请重新检测`,
    }
  }

  // There must be an `origin` to fetch from. We never take a remote name from the
  // snapshot and never guess among several: "upstream" has exactly one meaning
  // here, the one `git clone` gave it.
  const remoteUrl = await runGit(git, [...readGuardArgs(), 'remote', 'get-url', '--', 'origin'], dir)
  if (remoteUrl.code !== 0 || !remoteUrl.stdout.trim()) {
    return { ok: false, reason: '没有 origin 远端，无法更新' }
  }

  // A pending operation is the user's unfinished business, not ours to complete.
  const marker = await findInProgressMarker(git, dir)
  if (marker) {
    return { ok: false, skipped: true, reason: `仓库有未完成的操作（${marker}），请先由你处理，不更新` }
  }

  // The check that carries the most weight: a *tracked* local change — staged,
  // unstaged, renamed, deleted or conflicted, including submodule drift — stops us.
  // A fast-forward's checkout step refuses to overwrite a tracked modification, but
  // "refuses" there means git aborts in the middle having already written some files
  // — a report we would rather never have to make. Strict here, relaxed after the
  // merge: see `porcelainStatus`.
  //
  // Untracked entries are deliberately *not* part of this: git protects them by
  // itself, and refusing on them made a repository whose only local content is
  // generated output permanently un-updatable. They are counted instead, and the
  // count travels on the result so a skip/failure/success can all still say "there
  // are N untracked files here".
  const status = await porcelainStatus(git, dir)
  if (!status.ok) return { ok: false, reason: `读不到工作区状态：${status.reason}` }
  if (status.dirty) {
    return {
      ok: false,
      skipped: true,
      reason: '本地已跟踪文件有未提交改动（修改/暂存/删除/重命名/冲突），不覆盖你的文件',
      detail:
        status.tracked.slice(0, 8).join('\n') +
        (status.tracked.length > 8 ? `\n…（共 ${status.tracked.length} 项）` : ''),
      untracked: status.untracked,
    }
  }

  return { ok: true, branch, from, remote: 'origin', untracked: status.untracked }
}

/**
 * One repository, start to finish. Never rejects and never throws: whatever
 * happens comes back as a result object, so one broken repository cannot stop the
 * batch or take down the helper's main process.
 *
 * @param {object}   options
 * @param {string}   options.git           git executable (resolved by the caller)
 * @param {object}   options.repo          `{ name, path, branch, remoteSha, localSha }`
 * @param {string}   [options.noHooksPath] shared empty hooks dir; created here if absent
 * @param {object}   [options.log]
 * @param {Function} [options.onPhase]     `(repo, phase, partialResult)` for every
 *                 phase — 'start' | 'fetch' | 'merge' | 'done' | 'skipped' | 'failed'
 * @returns {Promise<object>} `{ name, path, ok, skipped?, reason?, from?, to?, phases, … }`
 */
async function applyOneUpdate({ git, repo, noHooksPath, log, onPhase } = {}) {
  const name = typeof repo?.name === 'string' && repo.name ? repo.name : String(repo?.path ?? '')
  const result = { name, path: typeof repo?.path === 'string' ? repo.path : '' }
  const phases = []
  const report = (phase, partial) => {
    try {
      onPhase?.(repo, phase, partial)
    } catch (error) {
      // A throwing callback is the UI's bug, not this repository's failure.
      log?.warn?.(`[skills-apply] onPhase(${phase}) 失败: ${String(error?.message ?? error)}`)
    }
  }
  /** A mid-flight step: record it and tell the caller. 'start' | 'fetch' | 'merge'. */
  const announce = phase => {
    phases.push(phase)
    result.phase = phase
    report(phase, { ...result, phases: [...phases] })
  }
  /**
   * The outcome: record the terminal phase, announce it with the full result, and
   * hand that result back. The phase is *derived* from the outcome rather than
   * passed in, so it cannot disagree with `ok`/`skipped` — a UI that keys a row's
   * colour off `phase` and its text off `reason` must never see `done` with
   * `ok: false`.
   */
  const done = patch => {
    const final = { ...result, ...patch }
    const phase = final.ok ? 'done' : final.skipped ? 'skipped' : 'failed'
    phases.push(phase)
    final.phase = phase
    final.phases = phases
    report(phase, final)
    return final
  }

  // The hooks directory is created inside the try, before any `return`, so every
  // exit path — including this own failure — announces exactly one terminal phase
  // and the `finally` below still owns the cleanup.
  let ownedHooksDir = ''
  let hooks = noHooksPath || ''
  try {
    if (!noHooksPath) {
      try {
        ownedHooksDir = makeNoHooksDir()
      } catch (error) {
        return done({ ok: false, reason: `无法创建禁用钩子的临时目录：${String(error?.message ?? error)}` })
      }
      hooks = ownedHooksDir
    }
    if (!git) return done({ ok: false, reason: '未找到可用的 git' })
    announce('start')

    const pre = await preflight(git, repo)
    result.from = pre.from || ''
    // Present only when a status listing actually measured it. Untracked files are
    // reported, never acted on: the field exists so a log or a UI can say "updated,
    // N untracked files kept" instead of implying the tree was bare.
    if (typeof pre.untracked === 'number') result.untracked = pre.untracked
    if (!pre.ok) {
      log?.warn?.(`[skills-apply] ${pre.skipped ? '跳过' : '失败'} ${name}：${pre.reason}`)
      return done({
        ok: false,
        skipped: Boolean(pre.skipped),
        reason: pre.reason,
        ...(pre.detail ? { detail: pre.detail } : {}),
      })
    }

    const guards = writeGuardArgs(hooks)

    // ── fetch ────────────────────────────────────────────────────────────────
    // An explicit refspec for the one branch we are on, and nothing else: no
    // `--all`, no `--prune` (deleting refs is deleting), no `--tags` (a tag's
    // objects are not what should land in a working tree), no submodule recursion.
    const refspec = `refs/heads/${pre.branch}`
    const fetched = await runGit(
      git,
      [...guards, 'fetch', '--no-tags', '--no-recurse-submodules', '--', 'origin', refspec],
      repo.path,
      FETCH_TIMEOUT_MS,
    )
    if (fetched.code !== 0) {
      const detail = (fetched.stderr || fetched.stdout).trim().split('\n').slice(-3).join('\n')
      const firstLine = detail.split('\n')[0]
      // Prove rather than assume that nothing moved: a fetch only ever adds
      // objects and advances a remote-tracking ref, so HEAD and the working tree
      // should be untouched even on a timeout or a killed connection. Report what
      // the repository actually says, not what the theory promises.
      const after = await porcelainStatus(git, repo.path, { ignoreSubmodules: true })
      const nowHead = await headSha(git, repo.path)
      const untouched = after.ok && nowHead === pre.from

      if (MISSING_REMOTE_REF.test(fetched.stderr) || MISSING_REMOTE_REF.test(fetched.stdout)) {
        log?.warn?.(`[skills-apply] 跳过 ${name}：远端没有 ${refspec}`)
        return done({
          ok: false,
          skipped: true,
          reason: `远端已没有分支 ${pre.branch}（可能被删除或改名），不更新`,
          detail: firstLine,
          untouched,
          stderr: fetched.stderr,
        })
      }
      log?.warn?.(`[skills-apply] fetch 失败 ${name}：${firstLine}`)
      return done({
        ok: false,
        reason: fetched.timedOut
          ? `fetch 超时（${Math.round(FETCH_TIMEOUT_MS / 1000)}s）${untouched ? '，仓库未被修改' : '，请人工确认仓库状态'}`
          : `fetch 失败：${firstLine || '未知原因'}`,
        detail,
        untouched,
        stdout: fetched.stdout,
        stderr: fetched.stderr,
      })
    }

    // Where the branch now is, according to our own repository after the fetch.
    // Prefer the remote-tracking ref (it is what `git log origin/<branch>` will
    // show the user) and fall back to FETCH_HEAD only if that ref is missing.
    const tracked = await runGit(
      git,
      [...readGuardArgs(), 'rev-parse', '--verify', `refs/remotes/origin/${pre.branch}^{commit}`],
      repo.path,
    )
    let target = tracked.code === 0 && isSha(tracked.stdout) ? tracked.stdout.trim() : ''
    if (!target) {
      const fh = await runGit(git, [...readGuardArgs(), 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], repo.path)
      target = fh.code === 0 && isSha(fh.stdout) ? fh.stdout.trim() : ''
    }
    if (!target) {
      log?.warn?.(`[skills-apply] ${name} fetch 后解析不到 ${refspec}`)
      return done({
        ok: false,
        reason: `fetch 成功但解析不到 ${refspec} 指向的提交`,
        stdout: fetched.stdout,
        stderr: fetched.stderr,
      })
    }
    result.to = target
    announce('fetch')

    if (isSha(repo.remoteSha) && target !== repo.remoteSha.trim()) {
      // Upstream moved between the check and the click. Not a reason to refuse:
      // the ancestry test below is what actually protects the user, and they asked
      // for "up to date". Worth logging which sha we settled on.
      log?.info?.(
        `[skills-apply] ${name} 远端在检测后又前进了（${String(repo.remoteSha).slice(0, 7)} → ${target.slice(0, 7)}），以 fetch 后的 ${target.slice(0, 7)} 为准`,
      )
    }

    if (target === pre.from) {
      log?.debug?.(`[skills-apply] ${name} 已是最新`)
      return done({ ok: false, skipped: true, reason: '已是最新（远端没有新提交）' })
    }

    // ── the one test that decides everything ─────────────────────────────────
    // The local tip must be an ancestor of the remote tip. Exit 0 is the only
    // acceptable answer. Measured on git 2.56: exit 1 means "not an ancestor",
    // exit 128 means "one of these objects is not here". Exit 1 covers both "the
    // user committed locally" and "upstream rewrote history" — from in here they
    // are the same thing: the two lines have separated, and only a human knows
    // which commits should survive. So: report, and do not merge or rebase.
    const ancestor = await runGit(
      git,
      [...readGuardArgs(), 'merge-base', '--is-ancestor', pre.from, target],
      repo.path,
    )
    if (ancestor.code !== 0) {
      const why =
        ancestor.code === 1
          ? '本地与远端已分叉：本地有远端没有的提交，或远端重写过历史。快进会丢掉其中一边，绝不自动 merge/rebase，请你亲自决定怎么合'
          : `判断不了祖先关系（git 退出码 ${ancestor.code}：${(ancestor.stderr || ancestor.stdout).trim().split('\n')[0] || '对象缺失'}），不更新`
      log?.warn?.(`[skills-apply] 跳过 ${name}：${why.split('\n')[0]}`)
      return done({ ok: false, skipped: true, reason: why, detail: (ancestor.stderr || '').trim() })
    }

    // Re-check immediately before writing. The fetch above handed the user up to
    // 60 seconds in which to save a file into this folder or commit in their own
    // terminal; a check that is a minute old is not a check. Same rule as the first
    // one: only a *tracked* change stops us, so a generated file dropped in during
    // the fetch is not a reason to abandon an update that is already half-way.
    const recheck = await porcelainStatus(git, repo.path)
    const nowHead = await headSha(git, repo.path)
    if (!recheck.ok) {
      log?.warn?.(`[skills-apply] ${name} 复查状态失败：${recheck.reason}`)
      return done({ ok: false, reason: `复查工作区状态失败：${recheck.reason}` })
    }
    if (typeof recheck.untracked === 'number') result.untracked = recheck.untracked
    if (recheck.dirty) {
      return done({
        ok: false,
        skipped: true,
        reason: 'fetch 期间已跟踪文件出现未提交改动，不覆盖你的文件',
        detail: recheck.tracked.slice(0, 8).join('\n'),
      })
    }
    if (nowHead !== pre.from) {
      return done({
        ok: false,
        skipped: true,
        reason: `fetch 期间本地 HEAD 变了（${pre.from.slice(0, 7)} → ${(nowHead || '无法解析').slice(0, 7)}），不更新`,
      })
    }

    // ── merge ────────────────────────────────────────────────────────────────
    // `--ff-only` is the second lock behind the ancestry test: if anything we
    // measured is stale or wrong, git refuses instead of creating a merge commit.
    // The sha (never a ref name) removes the last ambiguity about what the branch
    // is being pointed at, and `--` keeps it from being read as a path.
    announce('merge')
    const merged = await runGit(git, [...guards, 'merge', '--ff-only', '--', target], repo.path, MERGE_TIMEOUT_MS)
    if (merged.code !== 0) {
      const detail = (merged.stderr || merged.stdout).trim()
      // What the user needs first is not the git error but whether their
      // repository is still where it was. Say that, from evidence.
      const after = await porcelainStatus(git, repo.path, { ignoreSubmodules: true })
      const afterHead = await headSha(git, repo.path)
      const marker = await findInProgressMarker(git, repo.path)
      const firstLine = detail.split('\n')[0]
      // The one refusal an untracked file can cause, and the reason untracked files
      // are safe to leave alone: git protects the path itself. It is a *failure*
      // rather than a skip — the user asked for an update, we tried, upstream wants
      // a path their file occupies, and only the user can decide which one wins. The
      // measured aftermath is a repository that did not move at all, so the fields
      // below say so instead of leaving the user to guess.
      const collision = UNTRACKED_COLLISION.test(detail)
      log?.warn?.(`[skills-apply] merge --ff-only 失败 ${name}：${firstLine}`)
      return done({
        ok: false,
        reason: collision
          ? `上游新增的文件与你的未跟踪文件冲突，git 已中止合并（HEAD 未移动，未留下半合并状态）：${firstLine}`
          : `merge --ff-only 失败：${firstLine || '未知原因'}`,
        detail,
        // True means "no *tracked* file differs from the commit HEAD still points
        // at": the merge refused before writing, so an untracked file still sitting
        // there is not damage and must not be reported as any.
        headUnchanged: afterHead === pre.from,
        cleanTree: Boolean(after.ok && !after.dirty),
        collision,
        // Deliberately no automatic recovery. `merge --abort` on a merge that
        // already finished exits 128 and changes nothing (measured), so any
        // "cleanup" here would be theatre at best and a new destructive command at
        // worst. We report the state and hand the decision over.
        inProgressMarker: marker || null,
        stdout: merged.stdout,
        stderr: merged.stderr,
      })
    }

    // Prove the outcome instead of trusting the exit code: HEAD at the target, the
    // branch still attached under the same name, and **no tracked change** left over
    // apart from submodule pointers (see `porcelainStatus` for why that one is
    // relaxed). An untracked file that was here before the merge is still here
    // afterwards and is not dirt: git never writes over one, and when upstream adds a
    // colliding path the merge above refuses instead of succeeding (see the
    // collision branch).
    const finalHead = await headSha(git, repo.path)
    const finalBranch = await branchName(git, repo.path)
    const finalStrict = await porcelainStatus(git, repo.path)
    const finalLoose = await porcelainStatus(git, repo.path, { ignoreSubmodules: true })

    if (finalHead !== target) {
      log?.error?.(`[skills-apply] ${name} merge 后 HEAD 不符`)
      return done({
        ok: false,
        reason: `merge 报告成功但 HEAD 是 ${(finalHead || '无法解析').slice(0, 7)}，不是 ${target.slice(0, 7)}，请人工确认`,
        stdout: merged.stdout,
      })
    }
    if (finalBranch !== pre.branch) {
      log?.error?.(`[skills-apply] ${name} merge 后分支名变了`)
      return done({
        ok: false,
        reason: `更新后分支从 ${pre.branch} 变成 ${finalBranch || '游离 HEAD'}，请人工确认`,
        stdout: merged.stdout,
      })
    }
    if (finalLoose.dirty) {
      // Real damage: a *tracked* file still differs from the commit we just merged,
      // or something else the commit does not contain is staged/modified in it.
      log?.error?.(`[skills-apply] ${name} 更新后工作区有已跟踪改动`)
      return done({
        ok: false,
        reason: '更新后仍有已跟踪文件与提交不一致（钩子、smudge 过滤或写入中断？），请人工确认',
        detail: finalLoose.tracked.slice(0, 8).join('\n'),
        stdout: merged.stdout,
      })
    }

    // Success, with honest footnotes rather than an implied clean tree: untracked
    // files that were kept, and submodule pointers that advanced without their
    // checkouts following (this module never recurses). Both are information — the
    // result stays `ok: true`, because neither is damage and neither is a reason to
    // have refused.
    const submodulesDirty = finalStrict.dirty
    const untrackedKept = finalLoose.untracked
    const notes = []
    if (untrackedKept > 0) {
      notes.push(`更新成功，同时保留了 ${untrackedKept} 个未跟踪文件（不属于版本库，未被改动，也不会阻止更新）`)
    }
    if (submodulesDirty) {
      notes.push('子模块指针已随更新前进，但子模块检出未同步；需要时请运行 git submodule update --init --recursive')
    }
    log?.info?.(
      `[skills-apply] ${name} 已更新 ${pre.from.slice(0, 7)} → ${target.slice(0, 7)}（分支 ${pre.branch}，钩子已禁用${submodulesDirty ? '，子模块指针待同步' : ''}${untrackedKept > 0 ? `，保留 ${untrackedKept} 个未跟踪文件` : ''}）`,
    )
    return done({
      ok: true,
      branch: pre.branch,
      from: pre.from,
      to: target,
      hooksSuppressed: true,
      submodulesDirty,
      untracked: untrackedKept,
      ...(notes.length ? { note: notes.join('；') } : {}),
      stdout: merged.stdout,
    })
  } catch (error) {
    // Nothing above should be able to throw (runGit never rejects), but a bug in
    // this function must not take the batch — or the helper's main process — down.
    log?.error?.(`[skills-apply] ${name} 内部异常：${String(error?.stack ?? error?.message ?? error)}`)
    return done({ ok: false, reason: `内部异常：${String(error?.message ?? error)}` })
  } finally {
    if (ownedHooksDir) removeNoHooksDir(ownedHooksDir)
  }
}

/**
 * Update a batch of repositories, one after another.
 *
 * Serial on purpose: parallel fetches to the same host invite rate limiting, and
 * "which folder did it just change?" then has exactly one answer, which is what
 * makes the log and the progress events trustworthy.
 *
 * @param {object}   options
 * @param {string}   [options.git]         git executable; resolved when omitted
 * @param {Array}    options.repos         the detector's `updates` array: items of
 *                     `{ name, path, branch, remoteSha, localSha }`
 * @param {object}   [options.log]         console-shaped object (debug/info/warn/error)
 * @param {Function} [options.onProgress]  `(repo, phase, result)` for **every**
 *                 phase — 'start' | 'fetch' | 'merge' | 'done' | 'skipped' |
 *                 'failed'. The terminal phase carries the full result object (with
 *                 `ok`, `skipped`, `reason`); earlier phases carry what is known so
 *                 far, which is enough for a per-repository progress row.
 * @returns {Promise<Array<object>>} one result per repository, in input order
 */
async function applySkillUpdates({ git, repos, log, onProgress } = {}) {
  const list = Array.isArray(repos) ? repos.filter(Boolean) : []
  if (!Array.isArray(repos)) log?.warn?.(`[skills-apply] repos 不是数组（${typeof repos}），按空列表处理`)
  if (list.length > MAX_REPOS) {
    log?.warn?.(`[skills-apply] 待更新仓库 ${list.length} 个超过上限 ${MAX_REPOS}，只处理前 ${MAX_REPOS} 个`)
  }
  const targets = list.slice(0, MAX_REPOS)
  const nameOf = repo => String(repo?.name ?? repo?.path ?? '')
  const pathOf = repo => String(repo?.path ?? '')

  /**
   * A whole-batch refusal (no git, no temp dir): every repository gets the same
   * result, and each one still gets exactly one terminal phase through
   * `onProgress` — the contract the UI relies on to end a progress row. Announcing
   * here rather than leaving `phases: []` is what stops a row sitting on
   * "updating…" after an answer that was never going to arrive.
   */
  const refuseAll = reason =>
    targets.map(repo => {
      const result = { name: nameOf(repo), path: pathOf(repo), ok: false, phase: 'failed', phases: ['failed'], reason }
      try {
        onProgress?.(repo, 'failed', result)
      } catch (error) {
        log?.warn?.(`[skills-apply] onProgress 失败: ${String(error?.message ?? error)}`)
      }
      return result
    })

  let resolved = typeof git === 'string' && git ? git : null
  if (!resolved) resolved = await resolveGit(log)
  if (!resolved) {
    log?.error?.('[skills-apply] 未找到 git，未做任何修改')
    return refuseAll('未找到可用的 git')
  }

  // One empty hooks directory for the whole batch: cheaper than one per repository
  // and it makes "hooks were off for every command below" a single fact to check.
  let hooks = ''
  try {
    hooks = makeNoHooksDir()
  } catch (error) {
    log?.error?.(`[skills-apply] 无法创建禁用钩子的临时目录，未做任何修改：${String(error?.message ?? error)}`)
    return refuseAll('无法创建禁用钩子的临时目录')
  }

  const results = []
  try {
    for (const repo of targets) {
      let result
      let threw = false
      try {
        // `applyOneUpdate` reports every phase through `onPhase`, including the
        // terminal one with the outcome attached, so the batch does not announce
        // the end of a repository a second time.
        result = await applyOneUpdate({ git: resolved, repo, noHooksPath: hooks, log, onPhase: onProgress })
      } catch (error) {
        // applyOneUpdate swallows its own failures; this is a second net so a bug
        // in it cannot abort the loop and leave the rest unreported. Nothing has
        // been announced for this repository yet, so announce it here.
        threw = true
        result = {
          name: nameOf(repo),
          path: pathOf(repo),
          ok: false,
          phase: 'failed',
          phases: ['failed'],
          reason: `内部异常：${String(error?.message ?? error)}`,
        }
      }
      results.push(result)
      if (threw) {
        try {
          onProgress?.(repo, 'failed', result)
        } catch (error) {
          log?.warn?.(`[skills-apply] onProgress 失败: ${String(error?.message ?? error)}`)
        }
      }
    }
  } finally {
    removeNoHooksDir(hooks)
  }

  const updated = results.filter(item => item.ok).length
  const skipped = results.filter(item => item.skipped).length
  log?.debug?.(
    `[skills-apply] 完成：${updated} 个已更新 / ${skipped} 个跳过 / ${results.length - updated - skipped} 个失败（共 ${results.length}）`,
  )
  return results
}

module.exports = {
  applySkillUpdates,
  applyOneUpdate,
  resolveGit,
  runGit,
  gitEnv,
  makeNoHooksDir,
  removeNoHooksDir,
  // exported for tests
  preflight,
  porcelainStatus,
  readGuardArgs,
  writeGuardArgs,
  isUsableBranchName,
  samePath,
  IN_PROGRESS_MARKERS,
  MISSING_REMOTE_REF,
  MAX_REPOS,
  GIT_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  MERGE_TIMEOUT_MS,
}
