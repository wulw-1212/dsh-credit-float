'use strict'
/**
 * Tests for `desktop/skills-apply.cjs`.
 *
 * Run with the Electron-bundled node on this machine:
 *
 *   $el="D:\Programs Data\Dsh\Dsh-home\electron\electron.exe"
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & $el --test "E:\dsh-workstation\dsh-credit-float\dsh-credit-float\test\skills-apply.test.cjs"
 *   Remove-Item Env:\ELECTRON_RUN_AS_NODE
 *
 * Why the tests are built this way:
 *
 * - Every fixture is a **real git repository** under `os.tmpdir()` with a real
 *   local `file://` remote. Nothing reaches the network. Nothing is pointed at
 *   `$DSH_HOME/skills`: the module takes repository paths only from its caller and
 *   has no default skills directory, so a test can only touch what it creates.
 * - Real git rather than a stub, because the safety properties under test *are*
 *   git's behaviour — exit codes, whether a hook fires, whether a bumped gitlink
 *   looks dirty. A stub could only re-assert our own assumptions about those.
 * - The safety claims are checked twice: behaviourally (HEAD moved or did not,
 *   the user's file still says what it said), and structurally — every git command
 *   the module actually exec'd is captured through `GIT_TRACE2_EVENT` and compared
 *   against an allow-list plus a forbidden list. A test that only checks the final
 *   tree cannot catch a future edit that gets there with `reset --hard`.
 * - Fixtures set `core.autocrlf false` deliberately: this machine's *system*
 *   gitconfig (which the module intentionally keeps, for TLS/proxy reasons) sets it
 *   to `true`, and newline conversion would otherwise make content assertions
 *   machine-specific.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const apply = require('../desktop/skills-apply.cjs')
const MODULE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'skills-apply.cjs'), 'utf8')

/**
 * The module with its comments removed.
 *
 * Several assertions here are about what the *code* can do, and the prose in this
 * file deliberately names the things it refuses ("no `reset --hard`", "reads
 * `$DSH_HOME/skills`") — scanning raw text would flag the explanation instead of
 * the behaviour. Stripping first makes those assertions mean what they say.
 */
function codeOnly(source) {
  return source
    .split('\n')
    .filter(line => !/^\s*(\/\/|\/?\*)/.test(line)) // doc blocks and full-line comments
    .map(line => line.replace(/\s+\/\/[^'"\n]*$/, '')) // trailing comments
    .join('\n')
}

/** git for fixture building, resolved once up front so a missing git fails loudly. */
const GIT = (() => {
  for (const candidate of [process.env.DCF_GIT_PATH, 'git', 'D:\\Programs\\Git\\cmd\\git.exe'].filter(Boolean)) {
    const res = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true })
    if (res.status === 0 && /git version/.test(res.stdout || '')) return candidate
  }
  assert.fail('测试需要一个可用的 git 来构造仓库，未找到')
})()

const createdRoots = []

/**
 * Recursively remove, clearing the read-only bits git leaves on Windows.
 *
 * Two attempts: `rmSync` first (fast, and usually enough), then a chmod pass for
 * the `packed-refs`/object files that make the first attempt EBUSY/EACCES. A
 * leftover temp folder is hygiene, not a test failure, so the second failure only
 * logs.
 */
function removeTree(dir) {
  if (!dir) return
  let first
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return
  } catch (error) {
    first = error
  }
  const chmodWalk = current => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      try {
        if (entry.isDirectory()) {
          chmodWalk(full)
          fs.chmodSync(full, 0o755)
        } else {
          fs.chmodSync(full, 0o666)
        }
      } catch {
        /* locked or already gone */
      }
    }
  }
  try {
    chmodWalk(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    console.error(`[fixtures] 临时目录未能删除 ${dir}: ${first?.message} / ${error?.message}`)
  }
}

test.after(() => {
  for (const root of createdRoots.splice(0)) removeTree(root)
})

/**
 * `git …` for fixtures, with an identity so commits work without global config.
 *
 * `.fail(label)` exists because a silently-failing fixture command is how a test
 * starts asserting on a repository that was never built — the most confusing kind
 * of green.
 *
 * `core.autocrlf=false` goes on **every** fixture command, not just into the repo
 * config: this machine's system gitconfig sets it to `true`, so a `clone` that
 * inherits it converts LF→CRLF during its own checkout. Setting the config only
 * afterwards (as an earlier draft of this file did) leaves the working tree
 * differing from the index, and every fixture starts out looking dirty.
 */
function ggit(cwd, ...args) {
  const full = [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    '-c',
    'core.autocrlf=false',
    ...args,
  ]
  const res = spawnSync(GIT, full, { cwd, encoding: 'utf8', windowsHide: true })
  return {
    code: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    fail(label) {
      assert.equal(res.status, 0, `fixture git 「${label}」失败: git ${full.join(' ')}\n${res.stderr}`)
      return this
    },
  }
}

const asUrl = p => 'file:///' + p.replace(/\\/g, '/')
const readHead = dir => ggit(dir, 'rev-parse', 'HEAD').stdout
const statusOf = dir => ggit(dir, 'status', '--porcelain', '--untracked-files=all').stdout
const currentBranch = dir => ggit(dir, 'symbolic-ref', '--quiet', '--short', 'HEAD').stdout
const fileText = (...parts) => {
  try {
    return fs.readFileSync(path.join(...parts), 'utf8')
  } catch {
    return null
  }
}
const tmpRoot = label => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dcf-apply-${label}-`))
  createdRoots.push(root)
  return root
}

/** A repo with one commit and its clean clone, ready to be updated. */
function makeRepoPair(label, { branch = 'main' } = {}) {
  const root = tmpRoot(label)
  const up = path.join(root, 'upstream')
  ggit(root, 'init', `--initial-branch=${branch}`, up).fail('init upstream')
  ggit(up, 'config', 'core.autocrlf', 'false').fail('autocrlf upstream')
  fs.writeFileSync(path.join(up, 'README.md'), '# skill\nfirst commit\n')
  ggit(up, 'add', 'README.md').fail('add README')
  ggit(up, 'commit', '-q', '-m', 'skill: initial').fail('commit initial')
  const shaA = ggit(up, 'rev-parse', 'HEAD').stdout

  const repo = path.join(root, 'repo')
  ggit(root, 'clone', '-q', '--no-local', asUrl(up), repo).fail('clone')
  ggit(repo, 'config', 'core.autocrlf', 'false').fail('autocrlf repo')

  assert.equal(readHead(repo), shaA, 'fixture: the clone must start at the upstream tip')
  assert.equal(statusOf(repo), '', 'fixture: the clone must start clean')
  return { root, up, repo, branch, shaA, snapshot: { name: label, path: repo, branch, localSha: shaA } }
}

/** Commit on the remote; returns the new sha. */
function upstreamCommit(fx, message, files = { 'skill.md': 'updated upstream\n' }) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(fx.up, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  ggit(fx.up, 'add', '--all').fail('add upstream')
  ggit(fx.up, 'commit', '-q', '-m', message).fail('commit upstream')
  return ggit(fx.up, 'rev-parse', 'HEAD').stdout
}

/** Commit in the clone — the user's own work. */
function localCommit(fx, message, files = { 'local-notes.md': 'my own edit\n' }) {
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(fx.repo, name), content)
  ggit(fx.repo, 'add', '--all').fail('add local')
  ggit(fx.repo, 'commit', '-q', '-m', message).fail('commit local')
  return ggit(fx.repo, 'rev-parse', 'HEAD').stdout
}

/** The `updates[]` entry the detector would produce for this fixture. */
function pending(fx, remoteSha) {
  return { ...fx.snapshot, remoteSha: remoteSha ?? ggit(fx.up, 'rev-parse', 'HEAD').stdout }
}

/**
 * git commands the module exec'd, read from `GIT_TRACE2_EVENT`.
 *
 * The env var is set only for the duration of the call, so the record contains
 * the module's own invocations and never the fixture setup — an allow-list over it
 * is a statement about the code under test.
 *
 * `commands` uses `cmd_name` events, which name the subcommand of each process,
 * including git's own plumbing children (upload-pack, rev-list). `argv` uses
 * `start` events, which carry the full argv, so a forbidden *flag* can be caught
 * even when the subcommand is one we allow.
 */
async function runTracked(repos, opts = {}) {
  const traceDir = tmpRoot('trace')
  const trace = path.join(traceDir, 'trace2.jsonl')
  const previous = process.env.GIT_TRACE2_EVENT
  process.env.GIT_TRACE2_EVENT = trace
  try {
    const results = await apply.applySkillUpdates({ git: GIT, repos, log: null, ...opts })
    const events = readEvents(trace)
    const commands = [...new Set(events.filter(e => e.event === 'cmd_name').map(e => e.name))].sort()
    // `start` events cover every git process, including the plumbing children
    // git spawns itself (rev-list gets its own `--all`). Our own invocations are
    // exactly the ones carrying the guard `-c core.fsmonitor=false`, which every
    // read and write command in the module prepends — so filtering on it makes
    // this a statement about the module's argv, not git's internals.
    const ours = events
      .filter(e => e.event === 'start' && Array.isArray(e.argv))
      .map(e => e.argv)
      .filter(args => args.includes('core.fsmonitor=false'))
    return { results, commands, argv: ours }
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previous
    removeTree(traceDir)
  }
}

function readEvents(file) {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

async function run(repos, opts = {}) {
  const { results } = await runTracked(repos, opts)
  return results
}

/** One result, with a readable failure if the batch did not return one. */
function one(results) {
  assert.equal(results.length, 1, `expected exactly one result, got ${results.length}`)
  return results[0]
}

// ── 1. the happy path ────────────────────────────────────────────────────────
test('fast-forwards when upstream has new commits', async () => {
  const fx = makeRepoPair('ff')
  const shaB = upstreamCommit(fx, 'upstream: v2')

  const { results, commands } = await runTracked([pending(fx, shaB)])
  const result = one(results)

  assert.equal(result.ok, true, `expected success, got: ${result.reason} / ${result.detail || ''}`)
  assert.equal(result.from, fx.shaA)
  assert.equal(result.to, shaB)
  assert.equal(readHead(fx.repo), shaB, 'HEAD must be exactly the upstream commit')
  assert.equal(currentBranch(fx.repo), 'main', 'must still be on main, not detached')
  assert.equal(statusOf(fx.repo), '', 'working tree must be clean after the update')
  assert.equal(fileText(fx.repo, 'skill.md'), 'updated upstream\n', 'the new file must be on disk')
  assert.equal(fileText(fx.repo, 'README.md'), '# skill\nfirst commit\n', 'existing files keep their content')
  assert.deepEqual(result.phases, ['start', 'fetch', 'merge', 'done'])
  assert.equal(result.hooksSuppressed, true)
  assert.equal(result.submodulesDirty, false)
  // The remote-tracking ref is what `git log origin/main` will show the user.
  assert.equal(ggit(fx.repo, 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}').stdout, shaB)
  assert.equal(commands.filter(name => name === 'fetch').length, 1, 'exactly one fetch')
  assert.ok(commands.includes('merge'), 'merge must have run')
})

test('lands on the newest upstream commit even when the snapshot is stale', async () => {
  // The user clicked a while after the check and upstream kept working. Refusing
  // here would be pedantic: the ancestry test, not the snapshot, is the guard.
  const fx = makeRepoPair('stale-snapshot')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const shaC = upstreamCommit(fx, 'upstream: v3', { 'skill.md': 'third\n' })

  const result = one(await run([pending(fx, shaB)]))
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.to, shaC, 'must use what our own fetch saw, not the stale sha')
  assert.equal(readHead(fx.repo), shaC)
  assert.equal(statusOf(fx.repo), '')
})

// ── 2. nothing to do ────────────────────────────────────────────────────────
test('skips when the remote has no new commits', async () => {
  const fx = makeRepoPair('uptodate')
  const { results, commands } = await runTracked([pending(fx, fx.shaA)])
  const result = one(results)

  assert.equal(result.ok, false)
  assert.equal(result.skipped, true, 'nothing-new is a skip, not a failure')
  assert.match(result.reason, /已是最新/)
  assert.equal(readHead(fx.repo), fx.shaA, 'HEAD must not move')
  assert.equal(statusOf(fx.repo), '')
  assert.equal(result.phases.at(-1), 'skipped')
  assert.ok(!commands.includes('merge'), `merge must not run when there is nothing to do: ${commands}`)
})

// ── 3. the user's uncommitted work ──────────────────────────────────────────
test('skips a dirty working tree and leaves the edit byte-for-byte intact', async () => {
  const fx = makeRepoPair('dirty')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const mine = '# skill\nMY unfinished edit\n'
  fs.writeFileSync(path.join(fx.repo, 'README.md'), mine)

  const result = one(await run([pending(fx, shaB)]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /未提交/)
  assert.equal(readHead(fx.repo), fx.shaA, 'HEAD must not move')
  // The whole point: the edit is still there.
  assert.equal(fileText(fx.repo, 'README.md'), mine, 'the local edit must survive untouched')
  assert.equal(fileText(fx.repo, 'skill.md'), null, 'upstream content must not have been written')
})

test('updates a repository whose only local content is an untracked file (the picture-skills case)', async () => {
  // `picture-skills` was dirty *only* because its generated `output/picture-books/`
  // is untracked (it is absent from that repository's `.gitignore`), so the old
  // "untracked files count as dirt" rule kept it from ever being updated.
  //
  // This test replaces the previous assertion of that rule. The policy changed on
  // purpose, for the reason recorded in the module header: a fast-forward cannot
  // destroy an untracked file — when upstream adds a colliding path, git refuses the
  // merge by itself (the next test), and otherwise the file is never written. So the
  // picture-skills case must now be a *success* that keeps the file, and the
  // `ok: true` here doubles as the assertion that the post-merge verification no
  // longer reports "an untracked file still exists" as a dirty tree.
  const fx = makeRepoPair('untracked')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const generated = 'page 1 of a generated book\n'
  fs.mkdirSync(path.join(fx.repo, 'output', 'picture-books'), { recursive: true })
  fs.writeFileSync(path.join(fx.repo, 'output', 'picture-books', 'page.txt'), generated)

  const { results, commands } = await runTracked([pending(fx, shaB)])
  const result = one(results)

  assert.equal(
    result.ok,
    true,
    `untracked-only content must not block an update: ${result.reason} / ${result.detail || ''}`,
  )
  assert.equal(result.untracked, 1, 'the kept untracked file must be reported on the result')
  assert.match(result.note || '', /未跟踪/, 'and explained, so a kept file is not read as a clean tree')
  assert.equal(readHead(fx.repo), shaB, 'HEAD must move to the upstream commit')
  assert.equal(fileText(fx.repo, 'skill.md'), 'updated upstream\n', 'the upstream file must be on disk')
  assert.equal(
    fileText(fx.repo, 'output', 'picture-books', 'page.txt'),
    generated,
    'the untracked file must survive byte-for-byte: not deleted, not rewritten',
  )
  assert.equal(
    statusOf(fx.repo),
    '?? output/picture-books/page.txt',
    'and must still be untracked afterwards, not staged and not committed',
  )
  assert.deepEqual(result.phases, ['start', 'fetch', 'merge', 'done'])
  assert.ok(!commands.includes('clean'), `a clean command would delete it: ${commands}`)
})

test('fails honestly when an untracked file collides with a path upstream adds', async () => {
  // The case that makes the relaxed rule safe: git protects the untracked path
  // itself. Measured on git 2.56, `merge --ff-only` exits 1 with "The following
  // untracked working tree files would be overwritten by merge" and leaves the
  // repository exactly as it was. The user asked for an update and git really
  // refused, so this is a *failure* — reporting it as a skip would hide a real
  // conflict behind "nothing to do".
  const fx = makeRepoPair('untracked-collide')
  const mine = 'my generated book\n'
  fs.mkdirSync(path.join(fx.repo, 'output', 'books'), { recursive: true })
  fs.writeFileSync(path.join(fx.repo, 'output', 'books', 'b.md'), mine)
  const shaB = upstreamCommit(fx, 'upstream: v2', { 'output/books/b.md': 'upstream version\n' })
  assert.equal(statusOf(fx.repo), '?? output/books/b.md', 'fixture: the local file must be untracked, not modified')

  const { results, commands } = await runTracked([pending(fx, shaB)])
  const result = one(results)

  assert.equal(result.ok, false, 'a refused merge is not a success')
  assert.ok(!result.skipped, 'git tried and refused, so this is a failure rather than a skip')
  assert.equal(result.collision, true, 'the untracked collision must be named on the result')
  assert.match(result.reason, /未跟踪/, 'the reason must say what collided')
  assert.match(result.reason, /冲突/)
  assert.match(result.detail, /untracked working tree files would be overwritten/, 'git’s own words belong in the detail')
  assert.equal(result.phases.at(-1), 'failed')
  assert.ok(commands.includes('merge'), 'the merge must really have been attempted')
  // No half-updated repository: HEAD unmoved, no merge left in progress, no conflict
  // markers, and the file the user wrote is untouched.
  assert.equal(readHead(fx.repo), fx.shaA, 'HEAD must not move')
  assert.equal(result.headUnchanged, true)
  assert.equal(result.cleanTree, true, 'no *tracked* file was touched, and that is what cleanTree means')
  assert.equal(result.inProgressMarker, null, 'git must not leave a merge in progress')
  assert.ok(!fs.existsSync(path.join(fx.repo, '.git', 'MERGE_HEAD')), 'no MERGE_HEAD may be left behind')
  assert.equal(fileText(fx.repo, 'output', 'books', 'b.md'), mine, 'the user file must be intact')
  assert.equal(statusOf(fx.repo), '?? output/books/b.md', 'and still simply untracked — no conflict markers')
})

test('a file created during the fetch does not stop the update, but an edit to a tracked one does', async () => {
  // The second dirty check runs *after* the fetch (up to 60 s later), so it has to
  // apply the same rule: a generated file appearing in that window must not abandon
  // an update that is already half-way, while an edit to tracked content still must.
  // `onProgress` is called with phase 'fetch' before that re-check runs, which makes
  // the window deterministic instead of a timing race.
  const tolerant = makeRepoPair('recheck-untracked')
  const shaTolerant = upstreamCommit(tolerant, 'upstream: v2')
  const appeared = 'appeared while the fetch ran\n'
  const kept = await apply.applySkillUpdates({
    git: GIT,
    repos: [pending(tolerant, shaTolerant)],
    log: null,
    onProgress: (repo, phase) => {
      if (phase === 'fetch') fs.writeFileSync(path.join(repo.path, 'appeared-later.md'), appeared)
    },
  })
  const tolerantResult = one(kept)
  assert.equal(tolerantResult.ok, true, `the re-check must tolerate untracked dirt: ${tolerantResult.reason}`)
  assert.equal(readHead(tolerant.repo), shaTolerant, 'the update must complete')
  assert.equal(fileText(tolerant.repo, 'appeared-later.md'), appeared, 'and keep the file that appeared')

  const strict = makeRepoPair('recheck-tracked')
  const shaStrict = upstreamCommit(strict, 'upstream: v2')
  const mine = '# skill\nedited while the fetch ran\n'
  const blocked = await apply.applySkillUpdates({
    git: GIT,
    repos: [pending(strict, shaStrict)],
    log: null,
    onProgress: (repo, phase) => {
      if (phase === 'fetch') fs.writeFileSync(path.join(repo.path, 'README.md'), mine)
    },
  })
  const strictResult = one(blocked)
  assert.equal(strictResult.ok, false, 'a tracked edit during the fetch must still stop the update')
  assert.equal(strictResult.skipped, true)
  assert.match(strictResult.reason, /fetch 期间/)
  assert.equal(readHead(strict.repo), strict.shaA, 'HEAD must not move')
  assert.equal(fileText(strict.repo, 'README.md'), mine, 'and the mid-fetch edit must survive untouched')
  assert.equal(fileText(strict.repo, 'skill.md'), null, 'upstream content must not have been written')
})

test('an untracked listing too long to capture cannot hide a tracked change', async () => {
  // `--untracked-files=all` on a repository with thousands of generated files can
  // exceed the module's 256 KB stdout cap, so a listing can arrive cut in half. The
  // module then asks the blocking question again with `--untracked-files=no`, whose
  // answer is small enough that it cannot be cut. This fixture is what proves that
  // path is really taken: `truncated` can only be true if the cap was hit, and the
  // `dirty` answer below is computed from the second, uncut listing. Long names keep
  // the file count (and the test's runtime) sane.
  const fx = makeRepoPair('huge-untracked')
  const generated = path.join(fx.repo, 'output')
  fs.mkdirSync(generated, { recursive: true })
  const name = index => `f${String(index).padStart(4, '0')}-${'x'.repeat(160)}.txt`
  for (let i = 0; i < 1700; i++) fs.writeFileSync(path.join(generated, name(i)), 'g\n')
  const listing = ggit(fx.repo, 'status', '--porcelain', '--untracked-files=all').stdout
  assert.ok(listing.length >= 256 * 1024, `fixture: the listing must exceed the module cap, got ${listing.length}`)
  const status = await apply.porcelainStatus(GIT, fx.repo)
  assert.equal(status.truncated, true, 'fixture: the module’s own porcelain listing must hit the cap')
  assert.equal(status.dirty, false, 'a listing cut inside the untracked block must not read as a tracked change')

  const shaB = upstreamCommit(fx, 'upstream: v2')
  const first = one(await run([pending(fx, shaB)]))
  assert.equal(first.ok, true, `a huge untracked listing must not block: ${first.reason} / ${first.detail || ''}`)
  assert.equal(readHead(fx.repo), shaB)
  assert.equal(fileText(fx.repo, 'output', name(0)), 'g\n', 'the generated files must be left alone')

  // The strictness must survive the oversized listing too: a tracked edit behind it
  // still has to block. (Git happens to list tracked changes before untracked ones, so
  // the ordinary parse would usually see this too; the point of asking twice is that
  // the answer does not depend on that ordering holding.)
  const shaC = upstreamCommit(fx, 'upstream: v3', { 'skill.md': 'third\n' })
  fs.writeFileSync(path.join(fx.repo, 'README.md'), '# skill\nmy own edit\n')
  const second = one(await run([{ ...pending(fx, shaC), localSha: shaB }]))
  assert.equal(second.ok, false, 'a tracked edit must still block even when the listing is truncated')
  assert.equal(second.skipped, true)
  assert.match(second.reason, /未提交/)
  assert.equal(readHead(fx.repo), shaB, 'HEAD must not move')
  assert.equal(fileText(fx.repo, 'README.md'), '# skill\nmy own edit\n', 'and the edit must survive')
})

test('skips a staged change of the user, including a staged submodule pointer', async () => {
  const fx = makeRepoPair('staged')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  fs.writeFileSync(path.join(fx.repo, 'planned.md'), 'I staged this, do not lose it\n')
  ggit(fx.repo, 'add', 'planned.md').fail('stage a file')

  const result = one(await run([pending(fx, shaB)]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /未提交/)
  assert.ok(fs.existsSync(path.join(fx.repo, 'planned.md')), 'the staged file must still exist')
  assert.match(statusOf(fx.repo), /planned\.md/, 'and still be staged')
})

test('skips when the local edit collides with a file upstream also changes', async () => {
  // The case where a checkout really would destroy work, spelled out.
  const fx = makeRepoPair('collide')
  fs.writeFileSync(path.join(fx.up, 'README.md'), '# skill\nupstream rewrite\n')
  ggit(fx.up, 'add', '--all').fail('add upstream')
  ggit(fx.up, 'commit', '-q', '-m', 'upstream: rewrite README').fail('commit upstream')
  const shaB = ggit(fx.up, 'rev-parse', 'HEAD').stdout
  fs.writeFileSync(path.join(fx.repo, 'README.md'), '# skill\nmine, do not overwrite\n')

  const result = one(await run([pending(fx, shaB)]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.equal(fileText(fx.repo, 'README.md'), '# skill\nmine, do not overwrite\n')
})

// ── 4. histories that have separated ────────────────────────────────────────
test('skips when the local branch has its own commits (diverged), keeping them', async () => {
  const fx = makeRepoPair('diverged')
  const shaMine = localCommit(fx, 'local: my own fix')
  const shaB = upstreamCommit(fx, 'upstream: v2')

  const { results, commands } = await runTracked([{ ...pending(fx, shaB), localSha: shaMine }])
  const result = one(results)

  assert.equal(result.ok, false)
  assert.equal(result.skipped, true, 'a divergence is a decision for the user, not a failure')
  assert.match(result.reason, /分叉/)
  assert.match(result.reason, /merge|rebase/, 'the reason must say what it will not do')
  assert.equal(readHead(fx.repo), shaMine, 'HEAD must stay at the local commit')
  assert.match(ggit(fx.repo, 'log', '--format=%s').stdout, /local: my own fix/, 'the local commit must survive in history')
  assert.equal(statusOf(fx.repo), '')
  for (const verb of ['rebase', 'pull', 'cherry-pick']) {
    assert.ok(!commands.includes(verb), `${verb} must never run: ${commands}`)
  }
})

test('skips when upstream rewound (a force-push that dropped history)', async () => {
  const fx = makeRepoPair('rewind')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  // Advance the clone to v2 first, so the only thing that changes below is the
  // remote moving backwards. Without this the call would be rejected as a stale
  // snapshot (localSha != HEAD) and the divergence path would never be exercised.
  ggit(fx.repo, 'fetch', '-q', 'origin', 'refs/heads/main').fail('fetch v2 into the clone')
  ggit(fx.repo, 'merge', '-q', '--ff-only', '--', shaB).fail('fixture: advance the clone to v2')
  assert.equal(readHead(fx.repo), shaB, 'fixture: the clone must be at v2')
  // Now rewind the *remote* back to the first commit, as a force-push would.
  ggit(fx.up, 'checkout', '-q', '--detach', 'HEAD').fail('detach upstream')
  ggit(fx.up, 'branch', '-f', 'main', fx.shaA).fail('rewind upstream branch')
  assert.equal(ggit(fx.up, 'rev-parse', 'refs/heads/main').stdout, fx.shaA)

  const result = one(await run([{ ...fx.snapshot, localSha: shaB, remoteSha: fx.shaA }]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /分叉/, 'a rewind is a divergence: only the user can say which commits survive')
  assert.equal(readHead(fx.repo), shaB, 'the clone must stay at v2, not be dragged backwards')
  assert.equal(statusOf(fx.repo), '')
})

test('skips a stale snapshot whose local sha is no longer HEAD', async () => {
  const fx = makeRepoPair('stale-head')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const shaMine = localCommit(fx, 'local: after the check')

  const result = one(await run([{ ...pending(fx, shaB), localSha: fx.shaA }]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /自检测后已变化/)
  assert.equal(readHead(fx.repo), shaMine)
})

// ── 5. repository shapes we will not act on ─────────────────────────────────
test('skips a detached HEAD', async () => {
  const fx = makeRepoPair('detached')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  ggit(fx.repo, 'checkout', '-q', '--detach', 'HEAD').fail('detach')
  assert.equal(currentBranch(fx.repo), '', 'fixture: the clone must really be detached')
  assert.equal(ggit(fx.repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout, 'HEAD', 'fixture: the old spelling says HEAD')

  const result = one(await run([pending(fx, shaB)]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /游离 HEAD/)
  assert.equal(readHead(fx.repo), fx.shaA)
})

test('skips a shallow clone (the merge base may not be present)', async () => {
  const root = tmpRoot('shallow')
  const up = path.join(root, 'upstream')
  ggit(root, 'init', '--initial-branch=main', up).fail('init upstream')
  ggit(up, 'config', 'core.autocrlf', 'false').fail('autocrlf')
  fs.writeFileSync(path.join(up, 'a.txt'), 'A\n')
  ggit(up, 'add', 'a.txt').fail('add a')
  ggit(up, 'commit', '-q', '-m', 'A').fail('commit A')
  const shaA = ggit(up, 'rev-parse', 'HEAD').stdout
  fs.writeFileSync(path.join(up, 'b.txt'), 'B\n')
  ggit(up, 'add', 'b.txt').fail('add b')
  ggit(up, 'commit', '-q', '-m', 'B').fail('commit B')
  const shaB = ggit(up, 'rev-parse', 'HEAD').stdout

  const repo = path.join(root, 'repo')
  ggit(root, 'clone', '-q', '--depth', '1', '--no-local', asUrl(up), repo).fail('shallow clone')
  assert.equal(ggit(repo, 'rev-parse', '--is-shallow-repository').stdout, 'true', 'fixture must be shallow')
  // Measured on git 2.56: `cat-file -e` for an absent object exits **128**
  // ("fatal: Not a valid object name"), not 1. Asserting a specific non-zero code
  // made the fixture check fail on the very setup it was supposed to prove; the
  // property that matters is only "the base object is not in this clone".
  assert.notEqual(
    ggit(repo, 'cat-file', '-e', `${shaA}^{commit}`).code,
    0,
    'fixture: the merge base must really be missing',
  )

  const result = one(await run([{ name: 'shallow', path: repo, branch: 'main', localSha: shaB, remoteSha: shaB }]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /浅克隆/)
  assert.equal(readHead(repo), shaB)
})

test('skips a folder that is a subdirectory of one repository, not a repo of its own', async () => {
  const fx = makeRepoPair('subdir')
  const shaB = upstreamCommit(fx, 'upstream: v2', { 'data/x.txt': 'x\n' })
  const nested = path.join(fx.repo, 'docs')
  fs.mkdirSync(nested, { recursive: true })

  const result = one(await run([{ ...pending(fx, shaB), name: 'nested', path: nested }]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /不是仓库根目录/)
  assert.equal(readHead(fx.repo), fx.shaA)
})

test('skips a checkout that is itself a submodule', async () => {
  const root = tmpRoot('submodule')
  const sub = path.join(root, 'sub')
  ggit(root, 'init', '--initial-branch=main', sub).fail('init sub')
  fs.writeFileSync(path.join(sub, 's.txt'), 'S\n')
  ggit(sub, 'add', 's.txt').fail('add sub')
  ggit(sub, 'commit', '-q', '-m', 'S').fail('commit sub')

  const sup = path.join(root, 'super')
  ggit(root, 'init', '--initial-branch=main', sup).fail('init super')
  ggit(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', asUrl(sub), 'child').fail('submodule add')
  ggit(sup, 'commit', '-q', '-m', 'add submodule').fail('commit super')

  const child = path.join(sup, 'child')
  assert.ok(ggit(child, 'rev-parse', '--show-superproject-working-tree').stdout, 'fixture: child must have a superproject')

  const result = one(await run([{ name: 'child', path: child, branch: 'main', localSha: readHead(child), remoteSha: readHead(sub) }]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /子模块/)
})

test('skips a repository with an interrupted operation pending', async () => {
  const fx = makeRepoPair('inprogress')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  // Just the marker file git leaves; that is all the module reads.
  fs.writeFileSync(path.join(fx.repo, '.git', 'MERGE_HEAD'), shaB + '\n')
  try {
    const result = one(await run([pending(fx, shaB)]))
    assert.equal(result.ok, false)
    assert.equal(result.skipped, true)
    assert.match(result.reason, /未完成的操作/)
    assert.match(result.reason, /MERGE_HEAD/)
    assert.equal(readHead(fx.repo), fx.shaA)
    assert.ok(fs.existsSync(path.join(fx.repo, '.git', 'MERGE_HEAD')), 'the module must not clear it either')
  } finally {
    fs.rmSync(path.join(fx.repo, '.git', 'MERGE_HEAD'), { force: true })
  }
})

test('skips when origin is missing entirely', async () => {
  const fx = makeRepoPair('noremote')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  ggit(fx.repo, 'remote', 'remove', 'origin').fail('remove origin')

  const result = one(await run([pending(fx, shaB)]))
  assert.equal(result.ok, false)
  assert.match(result.reason, /origin/)
  assert.equal(readHead(fx.repo), fx.shaA)
})

// ── 6. hooks must never execute ────────────────────────────────────────────
test('updates without running the repository hooks', async () => {
  const fx = makeRepoPair('hooks')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const hookDir = path.join(fx.repo, '.git', 'hooks')
  // Hooks that leave evidence, exactly the malicious-or-annoying real case.
  for (const [hook, marker] of [
    ['post-merge', 'POST_MERGE_RAN'],
    ['reference-transaction', 'REF_TX_RAN'],
    ['post-checkout', 'POST_CHECKOUT_RAN'],
  ]) {
    fs.writeFileSync(path.join(hookDir, hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
  }

  const result = one(await run([pending(fx, shaB)]))
  assert.equal(result.ok, true, `the update should succeed: ${result.reason} / ${result.detail || ''}`)
  assert.equal(result.hooksSuppressed, true)
  for (const marker of ['POST_MERGE_RAN', 'REF_TX_RAN', 'POST_CHECKOUT_RAN']) {
    assert.ok(!fs.existsSync(path.join(fx.repo, marker)), `${marker} exists: a repository hook ran`)
  }
  assert.equal(readHead(fx.repo), shaB)
})

test('control: those hooks really do fire when the guard is not applied', async () => {
  // Without this, the test above could be passing because a hook never runs at
  // all, rather than because we suppressed it.
  const fx = makeRepoPair('hooks-control')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  ggit(fx.repo, 'fetch', '-q', '--no-tags', 'origin', 'refs/heads/main').fail('control fetch')
  fs.writeFileSync(path.join(fx.repo, '.git', 'hooks', 'post-merge'), '#!/bin/sh\ntouch POST_MERGE_RAN\n', { mode: 0o755 })
  // Same guard shape as the module, but hooksPath pointed at the real hooks dir.
  const guards = apply.writeGuardArgs(path.join(fx.repo, '.git', 'hooks').replace(/\\/g, '/'))
  const merged = ggit(fx.repo, ...guards, 'merge', '--ff-only', '--', shaB)
  assert.equal(merged.code, 0, `control merge should work: ${merged.stderr}`)
  assert.ok(
    fs.existsSync(path.join(fx.repo, 'POST_MERGE_RAN')),
    'control: a post-merge hook must really run on a fast-forward when hooks are not suppressed',
  )
})

// ── 7. submodules: a bumped pointer is a success, not a failure ────────────
/** Build a superproject fixture whose history moves a gitlink. */
function makeGitlinkFixture(label) {
  const root = tmpRoot(label)
  const sub = path.join(root, 'sub')
  ggit(root, 'init', '--initial-branch=main', sub).fail('init sub')
  ggit(sub, 'config', 'core.autocrlf', 'false').fail('sub autocrlf')
  fs.writeFileSync(path.join(sub, 's.txt'), 'S1\n')
  ggit(sub, 'add', 's.txt').fail('add s1')
  ggit(sub, 'commit', '-q', '-m', 'S1').fail('commit s1')
  const sub1 = readHead(sub)
  fs.writeFileSync(path.join(sub, 's.txt'), 'S2\n')
  ggit(sub, 'add', 's.txt').fail('add s2')
  ggit(sub, 'commit', '-q', '-m', 'S2').fail('commit s2')
  const sub2 = readHead(sub)

  const up = path.join(root, 'upstream')
  ggit(root, 'init', '--initial-branch=main', up).fail('init upstream')
  ggit(up, 'config', 'core.autocrlf', 'false').fail('up autocrlf')
  fs.writeFileSync(path.join(up, 'README.md'), '# skill\n')
  ggit(up, 'add', 'README.md').fail('add readme')
  ggit(up, 'commit', '-q', '-m', 'initial').fail('commit initial')
  const record = (sha, message) => {
    fs.writeFileSync(path.join(up, '.gitmodules'), `[submodule "child"]\n\tpath = child\n\turl = ${asUrl(sub)}\n`)
    ggit(up, 'add', '.gitmodules').fail('add gitmodules')
    fs.mkdirSync(path.join(up, 'child'), { recursive: true })
    ggit(up, 'update-index', '--add', '--cacheinfo', `160000,${sha},child`).fail(`record ${message}`)
    ggit(up, 'commit', '-q', '-m', message).fail(`commit ${message}`)
    return readHead(up)
  }
  const c1 = record(sub1, 'gitlink -> sub1')
  const c2 = record(sub2, 'gitlink -> sub2')

  const repo = path.join(root, 'repo')
  ggit(root, 'clone', '-q', '--no-local', asUrl(up), repo).fail('clone super')
  ggit(repo, 'config', 'core.autocrlf', 'false').fail('repo autocrlf')
  return { root, up, repo, sub, sub1, sub2, c1, c2 }
}

test('treats a submodule pointer bump as a successful update, flagged for syncing', async () => {
  // The probe-11 regression. A fast-forward that bumps a gitlink leaves
  // `status --porcelain` reporting `M child` until someone runs submodule update,
  // which this module never does. With default strictness every successful update
  // of a submodule-bearing skill would be reported as a *failure* — and two of the
  // fifteen real skills folders have a `.gitmodules`.
  const fx = makeGitlinkFixture('gitlink-ok')
  ggit(fx.repo, 'reset', '-q', '--hard', fx.c1).fail('rewind to the pre-bump commit')
  ggit(fx.repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive').fail('submodule init')
  assert.equal(readHead(fx.repo), fx.c1, 'fixture: behind')
  assert.equal(statusOf(fx.repo), '', 'fixture: clean, with the submodule matching the gitlink')
  assert.equal(readHead(path.join(fx.repo, 'child')), fx.sub1)

  const result = one(await run([{ name: 'gitlink', path: fx.repo, branch: 'main', localSha: fx.c1, remoteSha: fx.c2 }]))

  assert.equal(result.ok, true, `a gitlink bump must succeed, got: ${result.reason} / ${result.detail || ''}`)
  assert.equal(readHead(fx.repo), fx.c2, 'HEAD must be at the bumped commit')
  assert.equal(result.to, fx.c2)
  assert.equal(result.submodulesDirty, true, 'the lagging submodule checkout must be reported')
  assert.match(result.note || '', /submodule update/, 'and explained so the UI can offer the command')
  // The measurement the design rests on: strict status looks dirty, relaxed does not.
  assert.equal(statusOf(fx.repo), 'M child')
  assert.equal(ggit(fx.repo, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all').stdout, '')
  // And the module must not have recursed into the submodule.
  assert.equal(readHead(path.join(fx.repo, 'child')), fx.sub1, 'the submodule checkout must be left alone')
})

test('skips when the user staged a submodule pointer of their own', async () => {
  // The mirror image: before merging, submodule drift IS the user's state and
  // must stop us. Different strictness on the two sides is deliberate.
  const fx = makeGitlinkFixture('gitlink-dirty')
  ggit(fx.repo, 'reset', '-q', '--hard', fx.c1).fail('rewind')
  ggit(fx.repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive').fail('submodule init')
  assert.equal(statusOf(fx.repo), '', 'fixture must start clean')
  // The user records a different submodule commit, staged but not committed.
  ggit(fx.repo, 'update-index', '--cacheinfo', `160000,${fx.sub2},child`).fail('stage a gitlink')
  assert.match(statusOf(fx.repo), /child/, 'fixture: a staged gitlink must be visible')

  const result = one(await run([{ name: 'gitlink-dirty', path: fx.repo, branch: 'main', localSha: fx.c1, remoteSha: fx.c2 }]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true, 'a staged gitlink change is user state, so skip')
  assert.match(result.reason, /未提交/)
  assert.equal(readHead(fx.repo), fx.c1)
  assert.match(statusOf(fx.repo), /child/, 'the staged pointer must still be there')
})

// ── 8. broken inputs are reported, not thrown ───────────────────────────────
test('reports failure for a missing directory, a plain directory, a file, and junk paths', async () => {
  const root = tmpRoot('broken')
  const plain = path.join(root, 'plain')
  fs.mkdirSync(plain, { recursive: true })
  fs.writeFileSync(path.join(plain, 'note.txt'), 'not a repo\n')
  const aFile = path.join(root, 'afile.txt')
  fs.writeFileSync(aFile, 'x\n')

  const cases = [
    { label: 'missing', path: path.join(root, 'does-not-exist') },
    { label: 'plain-dir', path: plain },
    { label: 'not-a-directory', path: aFile },
    { label: 'empty-path', path: '' },
    { label: 'null-path', path: null },
    { label: 'number-path', path: 42 },
  ]
  const repos = cases.map(c => ({
    name: c.label,
    path: c.path,
    branch: 'main',
    localSha: 'f'.repeat(40),
    remoteSha: 'e'.repeat(40),
  }))

  const results = await run(repos)
  assert.equal(results.length, cases.length, 'every input must get exactly one result')
  results.forEach((result, index) => {
    assert.equal(result.name, cases[index].label)
    assert.equal(result.ok, false, `${cases[index].label} must not claim success: ${result.reason}`)
    assert.ok(!result.skipped, `${cases[index].label} is genuinely wrong, so a failure rather than a skip`)
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0, `${cases[index].label} must explain itself`)
  })
  assert.equal(fileText(plain, 'note.txt'), 'not a repo\n', 'the plain directory must be untouched')
})

test('reports failure when git cannot be executed', async () => {
  const fx = makeRepoPair('no-git')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const bogus = path.join(tmpRoot('nagit'), 'definitely-not-git.exe')

  const results = await apply.applySkillUpdates({ git: bogus, repos: [pending(fx, shaB)], log: null })
  assert.equal(results.length, 1)
  assert.equal(results[0].ok, false)
  assert.ok(!results[0].skipped)
  assert.match(results[0].reason, /git/)
  assert.equal(readHead(fx.repo), fx.shaA, 'an unusable git must not change anything')
})

test('resolveGit finds git the same way the detector does', async () => {
  const found = await apply.resolveGit(null)
  assert.equal(typeof found, 'string')
  assert.match(found, /git/)
})

// ── 9. remote failures must leave the repository intact ─────────────────────
test('an unreachable remote is a failure, and the repository is verified untouched', async () => {
  // The offline case, spelled out as a path that does not exist: same git error
  // shape as a dead network or a renamed GitHub owner, without needing a network.
  const fx = makeRepoPair('fetchfail')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  ggit(fx.repo, 'remote', 'set-url', 'origin', asUrl(path.join(fx.root, 'no-such-remote'))).fail('point origin at nothing')

  const result = one(await run([pending(fx, shaB)]))
  assert.equal(result.ok, false)
  assert.ok(!result.skipped, 'a broken remote is something the UI should show in red')
  assert.equal(result.untouched, true, 'the module must verify nothing moved, not assume it')
  assert.equal(readHead(fx.repo), fx.shaA, 'HEAD must not move')
  assert.equal(statusOf(fx.repo), '', 'working tree must still be clean')
  assert.equal(result.phases.at(-1), 'failed')
})

test("a branch that no longer exists upstream is a skip, not a failure", async () => {
  // Measured: `fetch origin refs/heads/main` on a deleted remote branch exits 128
  // with "couldn't find remote ref". Nothing about the repository is wrong, so the
  // UI must not report an outage.
  const fx = makeRepoPair('nobranch')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  ggit(fx.up, 'checkout', '-q', '--detach', 'HEAD').fail('detach upstream')
  ggit(fx.up, 'branch', '-D', 'main').fail('delete the upstream branch')
  // `rev-parse --verify` on a deleted ref exits **128** ("fatal: Needed a single
  // revision"), not 1. Same fix as the shallow fixture above: the fixture only has
  // to prove the ref is unresolvable, not what exact non-zero code git picked.
  assert.notEqual(
    ggit(fx.up, 'rev-parse', '--verify', 'refs/heads/main').code,
    0,
    'fixture: main must be gone upstream',
  )

  const result = one(await run([pending(fx, shaB)]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true, `"couldn't find remote ref" means nothing to do, not an outage`)
  assert.match(result.reason, /远端已没有分支|分支/)
  assert.equal(readHead(fx.repo), fx.shaA)
  assert.equal(statusOf(fx.repo), '')
  assert.equal(result.untouched, true)
})

test('a hung git is timed out rather than waited on forever', async () => {
  // The timeout is the one failure mode that could leave a repository mid-write,
  // so `timedOut` has to be observable to the caller instead of a bare -1.
  const started = Date.now()
  const result = await apply.runGit(GIT, ['--version'], process.cwd(), 1)
  const elapsed = Date.now() - started
  assert.equal(result.timedOut, true, 'a 1 ms budget must report a timeout')
  assert.equal(result.code, -1)
  assert.ok(elapsed < 10_000, `the call must not hang, took ${elapsed}ms`)
})

test('a git that cannot be spawned reports a result instead of throwing', async () => {
  const result = await apply.runGit(path.join(os.tmpdir(), 'no-such-git-binary'), ['--version'], process.cwd())
  assert.equal(result.code, -1)
  assert.ok(result.stderr.length > 0, 'the reason must be readable')
})

test('a missing working directory is reported, not thrown', async () => {
  const result = await apply.runGit(GIT, ['status', '--porcelain'], path.join(os.tmpdir(), 'dcf-no-such-cwd-' + process.pid))
  assert.notEqual(result.code, 0)
  assert.equal(result.timedOut, false)
})

test('write budget: 25s for reads, 60s for fetch and merge', () => {
  assert.equal(apply.GIT_TIMEOUT_MS, 25_000)
  assert.equal(apply.FETCH_TIMEOUT_MS, 60_000)
  assert.equal(apply.MERGE_TIMEOUT_MS, 60_000)
})

// ── 10. the batch contract the UI depends on ────────────────────────────────
test('one broken repository does not stop the others, and input order is preserved', async () => {
  const good = makeRepoPair('batch-good')
  const dirty = makeRepoPair('batch-dirty')
  const diverged = makeRepoPair('batch-diverged')
  const shaGood = upstreamCommit(good, 'upstream: v2')
  const shaDirty = upstreamCommit(dirty, 'upstream: v2')
  fs.writeFileSync(path.join(dirty.repo, 'README.md'), 'local edit\n')
  const shaDiverged = upstreamCommit(diverged, 'upstream: v2')
  const shaMine = localCommit(diverged, 'local: mine')

  const repos = [
    { name: 'missing', path: path.join(os.tmpdir(), 'dcf-batch-missing-' + process.pid), branch: 'main' },
    pending(good, shaGood),
    pending(dirty, shaDirty),
    { ...pending(diverged, shaDiverged), localSha: shaMine },
  ]
  const phases = []
  const results = await apply.applySkillUpdates({
    git: GIT,
    repos,
    log: null,
    onProgress: (repo, phase, result) => phases.push([repo.name, phase, result?.ok === true]),
  })

  assert.deepEqual(results.map(r => r.name), ['missing', 'batch-good', 'batch-dirty', 'batch-diverged'])
  assert.equal(results[0].ok, false, 'the missing one is reported as failed')
  assert.equal(results[1].ok, true, 'the healthy one still updated')
  assert.equal(readHead(good.repo), shaGood)
  assert.equal(results[2].skipped, true, 'the dirty one skipped')
  assert.equal(fileText(dirty.repo, 'README.md'), 'local edit\n', 'its local edit survived')
  assert.equal(results[3].skipped, true, 'the diverged one skipped')
  assert.equal(readHead(diverged.repo), shaMine)

  const terminal = phases.filter(([, phase]) => ['done', 'skipped', 'failed'].includes(phase))
  assert.deepEqual(terminal.map(([name]) => name), ['missing', 'batch-good', 'batch-dirty', 'batch-diverged'])
  assert.deepEqual(terminal.map(([, phase]) => phase), ['failed', 'done', 'skipped', 'skipped'])
})

test('onProgress receives the mid-flight phases the UI needs', async () => {
  const fx = makeRepoPair('phases')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const seen = []
  await apply.applySkillUpdates({
    git: GIT,
    repos: [pending(fx, shaB)],
    log: null,
    onProgress: (repo, phase) => seen.push([repo.name, phase]),
  })
  assert.deepEqual(seen.map(([, phase]) => phase), ['start', 'fetch', 'merge', 'done'])
  assert.ok(seen.every(([name]) => name === 'phases'), 'the repo argument must be the entry being worked on')
})

test('a throwing onProgress does not abort the batch or lose results', async () => {
  const a = makeRepoPair('cb-a')
  const b = makeRepoPair('cb-b')
  const shaA = upstreamCommit(a, 'upstream: v2')
  const shaB = upstreamCommit(b, 'upstream: v2')
  const results = await apply.applySkillUpdates({
    git: GIT,
    repos: [pending(a, shaA), pending(b, shaB)],
    log: null,
    onProgress: () => {
      throw new Error('the renderer went away')
    },
  })
  assert.equal(results.length, 2)
  assert.equal(results[0].ok, true)
  assert.equal(results[1].ok, true)
  assert.equal(readHead(a.repo), shaA)
  assert.equal(readHead(b.repo), shaB)
})

test('an empty or absent repos list yields an empty report', async () => {
  assert.deepEqual(await apply.applySkillUpdates({ git: GIT, repos: [], log: null }), [])
  assert.deepEqual(await apply.applySkillUpdates({ git: GIT, log: null }), [])
  assert.deepEqual(await apply.applySkillUpdates({ git: GIT, repos: null, log: null }), [])
  assert.deepEqual(await apply.applySkillUpdates(), [])
})

test('a junk entry is reported as a failed row instead of being dropped', async () => {
  // Deliberate: a caller that hands us `null` or a bare string has a bug, and
  // silently filtering it out would hide that bug behind a batch that "updated
  // nothing". One honest failed row per unusable entry is actionable — the UI can
  // show the reason — while `[null, undefined]` alone carries no repository at all
  // and therefore produces nothing.
  assert.deepEqual(
    await apply.applySkillUpdates({ git: GIT, repos: [null, undefined], log: null }),
    [],
  )

  const results = await apply.applySkillUpdates({ git: GIT, repos: ['junk'], log: null })
  assert.equal(results.length, 1)
  assert.equal(results[0].ok, false)
  assert.equal(results[0].skipped, false)
  assert.match(results[0].reason, /路径/)
})

test('applySkillUpdates resolves git when the caller omits it', async () => {
  const fx = makeRepoPair('autoresolve')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const results = await apply.applySkillUpdates({ repos: [pending(fx, shaB)], log: null })
  assert.equal(results[0].ok, true, `resolution should find git: ${results[0].reason}`)
  assert.equal(readHead(fx.repo), shaB)
})

test('applyOneUpdate works on its own and cleans up its hooks directory', async () => {
  const fx = makeRepoPair('single')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const strayBefore = hooksTempDirs()
  const result = await apply.applyOneUpdate({ git: GIT, repo: pending(fx, shaB) })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.to, shaB)
  assert.equal(readHead(fx.repo), shaB)
  assert.deepEqual(hooksTempDirs(), strayBefore, 'applyOneUpdate must remove the temp dir it created')
})

test('the shared hooks temp directory is removed after a batch', async () => {
  const fx = makeRepoPair('cleanuptemp')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const before = hooksTempDirs()
  await run([pending(fx, shaB)])
  assert.deepEqual(hooksTempDirs().filter(d => !before.includes(d)), [], 'no hooks temp dir may be left behind')
})

test('a failing batch still removes its hooks directory', async () => {
  const fx = makeRepoPair('cleanupfail')
  ggit(fx.repo, 'remote', 'set-url', 'origin', asUrl(path.join(fx.root, 'nowhere'))).fail('break origin')
  const before = hooksTempDirs()
  const results = await run([pending(fx, readHead(fx.up))])
  assert.equal(results[0].ok, false)
  assert.deepEqual(hooksTempDirs().filter(d => !before.includes(d)), [], 'finally must still run')
})

function hooksTempDirs() {
  return fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('dcf-skill-no-hooks-'))
}

// ── 11. structural guarantees: the command allow-list ───────────────────────
test('the module only ever execs the read-only checks plus fetch and merge', async () => {
  // A batch that reaches the interesting paths: one real update, one dirty skip,
  // one broken directory. Everything git exec'd during it must be on the list.
  const good = makeRepoPair('allow-good')
  const dirty = makeRepoPair('allow-dirty')
  const shaGood = upstreamCommit(good, 'upstream: v2')
  const shaDirty = upstreamCommit(dirty, 'upstream: v2')
  fs.writeFileSync(path.join(dirty.repo, 'README.md'), 'local\n')

  const { results, commands } = await runTracked([
    pending(good, shaGood),
    pending(dirty, shaDirty),
    { name: 'missing', path: path.join(os.tmpdir(), 'dcf-allow-missing-' + process.pid), branch: 'main' },
  ])
  assert.equal(results[1].skipped, true, 'fixture: the dirty repo must reach the skip path')

  const ALLOWED = new Set([
    // our read-only guards
    'rev-parse',
    'symbolic-ref',
    'status',
    'merge-base',
    'check-ref-format',
    'remote',
    // the only two writes
    'fetch',
    'merge',
    // git's own plumbing, exec'd inside fetch/merge rather than by us
    'upload-pack',
    'rev-list',
    'pack-objects',
    'index-pack',
    'unpack-objects',
    'diff',
    'diff-index',
    'diff-files',
    'merge-recursive',
    'merge-ort',
    'ls-files',
    'write-tree',
    'read-tree',
    'merge-one-file',
    'checkout', // git's internal entry step of merge/clone, see the argv test
  ])
  const unexpected = commands.filter(name => !ALLOWED.has(name))
  assert.deepEqual(unexpected, [], `commands outside the allow-list ran: ${unexpected.join(', ')}`)

  const FORBIDDEN = [
    'pull',
    'push',
    'reset',
    'switch',
    'restore',
    'stash',
    'clean',
    'rebase',
    'am',
    'apply',
    'cherry-pick',
    'revert',
    'bisect',
    'filter-branch',
    'filter-repo',
    'gc',
    'maintenance',
    'prune',
    'worktree',
    'submodule',
    'update-ref',
    'notes',
    'tag',
    'rm',
    'mv',
    'config',
  ]
  assert.deepEqual(
    commands.filter(name => FORBIDDEN.includes(name)),
    [],
    `forbidden git commands ran: ${commands.filter(n => FORBIDDEN.includes(n)).join(', ')}`,
  )
  assert.ok(commands.includes('fetch') && commands.includes('merge'), 'the two writes should have been used')
})

test('no destructive flag or forced refspec appears in any argv it execs', async () => {
  const fx = makeRepoPair('argv')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const dirty = makeRepoPair('argv-dirty')
  const shaDirty = upstreamCommit(dirty, 'upstream: v2')
  fs.writeFileSync(path.join(dirty.repo, 'README.md'), 'local\n')
  const { argv } = await runTracked([pending(fx, shaB), pending(dirty, shaDirty)])

  assert.ok(argv.length >= 2, 'expected the runs to be traced')
  const BAD_FLAGS = [
    '--force',
    '-f',
    '--hard',
    '--soft',
    '--mixed',
    '--autostash',
    '--recurse-submodules',
    '--prune',
    '--all',
    '--depth',
    '--no-ff',
    '--no-commit',
    '-X',
    '--squash',
  ]
  for (const args of argv) {
    for (const flag of BAD_FLAGS) {
      assert.ok(!args.includes(flag), `argv must not contain ${flag}: ${args.join(' ')}`)
    }
    const joined = args.join(' ')
    if (args.includes('merge')) {
      assert.ok(args.includes('--ff-only'), `merge without --ff-only: ${joined}`)
      assert.match(joined, /core\.hooksPath=/, `merge ran with hooks enabled: ${joined}`)
      assert.match(joined, /core\.hooksPath=[^\s]*dcf-skill-no-hooks/, 'hooksPath must point at our own empty temp dir')
    }
    if (args.includes('fetch')) {
      assert.match(joined, /core\.hooksPath=/, `fetch ran with hooks enabled: ${joined}`)
      assert.ok(args.includes('--no-recurse-submodules'), `fetch must not recurse: ${joined}`)
      assert.ok(args.includes('origin'), 'fetch must target origin and nothing else')
      assert.ok(args.some(a => /^refs\/heads\/[^\s]+$/.test(String(a))), 'fetch must use an explicit plain branch refspec')
      assert.ok(!joined.includes('+refs/heads/'), `no forced refspec: ${joined}`)
      assert.ok(!args.includes('--tags'), 'fetch must not pull tags')
    }
    // `--ff-only` is the only merge mode, and merge must never be given a ref name.
    if (args.includes('merge')) {
      const tail = args.slice(args.indexOf('merge') + 1)
      assert.ok(!tail.includes('--no-ff'))
      assert.ok(!tail.includes('origin'), `merge must name a sha, not a remote ref: ${joined}`)
    }
  }
})

test('merge names the resolved sha, never a ref that could move underneath us', async () => {
  const fx = makeRepoPair('argv-sha')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const { argv } = await runTracked([pending(fx, shaB)])
  const mergeArgs = argv.find(a => a.includes('merge'))
  assert.ok(mergeArgs, 'a merge should have run')
  assert.ok(mergeArgs.includes(shaB), `merge should name ${shaB}: ${mergeArgs.join(' ')}`)
})

test('the source text contains no forbidden git verb outside comments', () => {
  // A behavioural allow-list only covers paths the tests reached. This covers the
  // whole file, so a future edit cannot add `reset --hard` on a branch nothing
  // exercises. Comments are dropped first because the prose deliberately *names*
  // the verbs it refuses.
  const code = codeOnly(MODULE_SOURCE)

  const forbiddenLiterals = [
    "'pull'",
    "'push'",
    "'reset'",
    "'checkout'",
    "'switch'",
    "'restore'",
    "'stash'",
    "'clean'",
    "'rebase'",
    "'am'",
    "'apply'",
    "'cherry-pick'",
    "'revert'",
    "'bisect'",
    "'filter-branch'",
    "'gc'",
    "'maintenance'",
    "'prune'",
    "'worktree'",
    "'update-ref'",
    "'notes'",
    "'tag'",
    "'rm'",
    "'mv'",
    "'--force'",
    "'--hard'",
    "'-f'",
    "'--no-ff'",
    "'--autostash'",
    "'--recurse-submodules'",
    "'--prune'",
    "'--all'",
    '--force-with-lease',
  ]
  for (const literal of forbiddenLiterals) {
    assert.ok(!code.includes(literal), `the module source must not contain ${literal} outside comments`)
  }

  // And the parts that make it safe must actually be spelled out.
  assert.match(code, /'fetch'/, 'fetch should be exec’d')
  assert.match(code, /'merge'/, 'merge should be exec’d')
  assert.match(code, /'--ff-only'/, 'merge must be --ff-only')
  assert.match(code, /core\.hooksPath=/, 'hooks must be redirected')
  assert.match(code, /'--is-ancestor'/, 'the ancestry test must be the is-ancestor form')
  assert.match(code, /'--no-recurse-submodules'/, 'submodules must not be recursed')
  // The assertion here used to read `/'--untracked-files=all'/` with the message
  // "untracked files must count as dirt". That message *was* the old policy and the
  // policy changed deliberately, so it is rewritten rather than dropped: an
  // untracked file cannot be destroyed by a fast-forward — git refuses a colliding
  // upstream path by itself, which the collision test above asserts behaviourally —
  // and treating it as dirt left `picture-skills` permanently un-updatable. The full
  // listing is still requested, but now it exists so a result can *report* untracked
  // files instead of blocking on them.
  assert.match(code, /'--untracked-files=all'/, 'the full listing must still be requested so untracked files can be reported')
  assert.match(code, /'--untracked-files=no'/, 'the over-long-listing fallback must ask the tracked-only question')
  assert.match(code, /startsWith\('\?\?'\)/, 'an entry is untracked only when porcelain marks it ??')
  assert.match(
    code,
    /untracked working tree files\? would be overwritten/i,
    'the untracked-collision refusal must be recognised, so it is reported as a failure rather than a skip',
  )
  assert.match(code, /--ignore-submodules=all/, 'post-merge verification must ignore gitlink lag')
})

// ── 12. it must never be pointed at the real skills folder by itself ────────
test('the module has no default skills directory: it only touches what a caller passes', () => {
  // The detector reads `$DSH_HOME/skills` because listing it is its job. An
  // updater that did the same would be updating folders nobody selected, so the
  // path must come only from `repos[].path`. Scanned without comments: the module
  // explains the contrast in prose, and that explanation is not a default path.
  const code = codeOnly(MODULE_SOURCE)
  assert.doesNotMatch(code, /DSH_HOME/)
  assert.doesNotMatch(code, /DCF_SKILLS_DIR|defaultSkillsDir|skillsDir/)
  assert.equal(apply.defaultSkillsDir, undefined, 'no skills-dir helper may be exported')
  // Guard args must be `-c key=value` pairs and nothing else: a stray positional
  // argument there would be a path reaching git's config layer, and an unpaired
  // `-c` would swallow the next *subcommand* as a config key.
  //
  // The previous formulation ("each arg is first, or follows `-c`, or is not a
  // `-c`") was wrong in a way that had never run: it tripped on every `-c` that
  // followed a value, so a correct array failed it. Check the pairing directly.
  const writes = apply.writeGuardArgs('C:/x/empty')
  assert.equal(writes.length % 2, 0, `config overrides must come in pairs: ${JSON.stringify(writes)}`)
  for (let i = 0; i < writes.length; i += 2) {
    assert.equal(writes[i], '-c', `expected a -c at index ${i}: ${JSON.stringify(writes)}`)
    assert.match(writes[i + 1], /^[\w.]+=/, `expected a key=value right after -c at ${i}: ${JSON.stringify(writes)}`)
  }
})

// ── 13. the exported surface the Lead wires against ─────────────────────────
test('exports the API the desktop helper wires against', async () => {
  assert.equal(typeof apply.applySkillUpdates, 'function')
  assert.equal(typeof apply.applyOneUpdate, 'function')
  assert.equal(typeof apply.resolveGit, 'function')
  assert.equal(typeof apply.runGit, 'function')
  assert.equal(apply.applySkillUpdates.constructor.name, 'AsyncFunction')
  assert.equal(apply.applyOneUpdate.constructor.name, 'AsyncFunction')
  assert.equal(apply.MAX_REPOS, 200)
  // The batch entry point takes exactly one options object. `Function.length` is
  // 0 for a destructured parameter, so arity proves nothing — calling it with a
  // single object (and getting a report back, not a TypeError) does.
  assert.deepEqual(await apply.applySkillUpdates({ git: GIT, repos: [], log: null }), [])
})

test('MISSING_REMOTE_REF matches git’s wording and nothing else', () => {
  assert.ok(apply.MISSING_REMOTE_REF.test("fatal: couldn't find remote ref refs/heads/main"))
  assert.ok(apply.MISSING_REMOTE_REF.test('fatal: could not find remote ref refs/heads/x'))
  assert.ok(!apply.MISSING_REMOTE_REF.test('fatal: early EOF'))
  assert.ok(!apply.MISSING_REMOTE_REF.test('fatal: unable to access URL'))
})

test('samePath normalises separators and case the way Windows needs', () => {
  const isWindows = process.platform === 'win32'
  assert.equal(apply.samePath('C:/a/b', 'C:\\a\\b'), true)
  assert.equal(apply.samePath('C:/a/b/', 'C:/a/b'), true)
  assert.equal(apply.samePath('C:/A/b', 'c:/a/b'), isWindows)
  assert.equal(apply.samePath('C:/a/b', 'C:/a/c'), false)
  assert.equal(apply.samePath('C:/a/b', 'C:/a/bb'), false)
  assert.equal(apply.samePath(null, 'x'), false)
  assert.equal(apply.samePath(undefined, undefined), false)
})

test('read and write guards: writes suppress hooks and every surprising setting', () => {
  assert.deepEqual(apply.readGuardArgs(), ['-c', 'core.fsmonitor=false'])
  const writes = apply.writeGuardArgs('C:/tmp/empty')
  for (const setting of [
    'core.fsmonitor=false',
    'core.hooksPath=C:/tmp/empty',
    'merge.autostash=false',
    'submodule.recurse=false',
    'rerere.enabled=false',
    'commit.gpgsign=false',
    'gc.auto=0',
  ]) {
    assert.ok(writes.includes(setting), `missing ${setting}`)
  }
  // `-c` and its `key=value` must always be separate arguments, never glued.
  for (let i = 0; i < writes.length; i++) {
    if (writes[i] === '-c') assert.match(String(writes[i + 1] ?? ''), /=/, 'each -c needs a following key=value')
    else if (String(writes[i]).includes('=')) assert.equal(writes[i - 1], '-c', `stray assignment: ${writes[i]}`)
  }
})

test('gitEnv keeps the user’s config but forbids every interactive prompt', () => {
  const env = apply.gitEnv()
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GCM_INTERACTIVE, 'never')
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'never')
  assert.equal(env.GIT_CONFIG_NOSYSTEM, undefined, 'system gitconfig must stay: TLS/proxy settings live there')
  assert.ok(env.PATH || env.Path || true)
})

test('a branch recorded by the detector must match the branch actually checked out', async () => {
  const fx = makeRepoPair('branchmismatch')
  const shaB = upstreamCommit(fx, 'upstream: v2')
  const result = one(await run([{ ...pending(fx, shaB), branch: 'no-such-branch' }]))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /当前分支是 main/)
  assert.equal(readHead(fx.repo), fx.shaA)
})

test('a repository with only an empty HEAD (no commits) is failed, not crashed', async () => {
  const root = tmpRoot('empty-repo')
  const repo = path.join(root, 'empty')
  ggit(root, 'init', '--initial-branch=main', repo).fail('init empty')
  const result = one(await run([{ name: 'empty', path: repo, branch: 'main', localSha: 'a'.repeat(40), remoteSha: 'b'.repeat(40) }]))
  assert.equal(result.ok, false)
  assert.match(result.reason, /HEAD/)
})
