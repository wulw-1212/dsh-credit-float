/**
 * Local git status → panel chips.
 *
 * `parseLocalStatus` / `localFlags` / `needsAttention` are pure, so they are
 * tested against captured `git status --porcelain=v2 --branch` text rather than
 * against a live repository: the point of these functions is exactly how they read
 * that format, and every branch (detached, no upstream, conflicted, CRLF) is
 * easier to pin down as text than to reproduce with real clones.
 *
 * The captured samples below are verbatim from git 2.56 on Windows.
 */
const test = require('node:test')
const assert = require('node:assert')

const detector = require('../desktop/skills-update.cjs')

const CLEAN = [
  '# branch.oid 1111111111111111111111111111111111111111',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +0 -0',
  '',
].join('\n')

const AHEAD_AND_DIRTY = [
  '# branch.oid 2222222222222222222222222222222222222222',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -3',
  '1 .M N... 100644 100644 100644 aaaa bbbb src/app.js',
  '1 M. N... 100644 100644 100644 cccc dddd README.md',
  '2 R. N... 100644 100644 100644 eeee ffff R100 new-name.js',
  '',
  '? scratch/',
  '? notes.txt',
].join('\n')

const NO_UPSTREAM = [
  '# branch.oid 3333333333333333333333333333333333333333',
  '# branch.head feature/local-only',
  '',
].join('\r\n')

const DETACHED = [
  '# branch.oid 4444444444444444444444444444444444444444',
  '# branch.head (detached)',
  '',
].join('\n')

const CONFLICTED = [
  '# branch.oid 5555555555555555555555555555555555555555',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +0 -0',
  'u UU N... 100644 100644 100644 100644 a1 a2 a3 a4 conflicted.txt',
  '',
].join('\n')

/**
 * The `picture-skills` case: a repository whose only local content is generated
 * output that was never added to the repository.
 */
const UNTRACKED_ONLY = [
  '# branch.oid 6666666666666666666666666666666666666666',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +0 -0',
  '? output/',
  '? output/picture-books/',
  '? notes.txt',
  '',
].join('\n')

test('a clean branch with an upstream parses to zeroes', () => {
  const parsed = detector.parseLocalStatus(CLEAN)
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.upstream, 'origin/main')
  assert.equal(parsed.ahead, 0)
  assert.equal(parsed.behind, 0)
  assert.equal(parsed.detached, false)
  assert.equal(parsed.modified, 0)
  assert.equal(parsed.untracked, 0)
  assert.equal(parsed.conflicted, 0)
})

test('modified, renamed and untracked entries are counted separately', () => {
  const parsed = detector.parseLocalStatus(AHEAD_AND_DIRTY)
  assert.equal(parsed.ahead, 2)
  assert.equal(parsed.behind, 3)
  // Two `1` lines and one `2` (rename) entry.
  assert.equal(parsed.modified, 3)
  assert.equal(parsed.untracked, 2)
  assert.equal(parsed.conflicted, 0)
})

test('a branch without upstream reports unknown, not zero', () => {
  const parsed = detector.parseLocalStatus(NO_UPSTREAM)
  assert.equal(parsed.branch, 'feature/local-only')
  assert.equal(parsed.upstream, null)
  // The distinction matters: "no upstream" must not read as "nothing to push".
  assert.equal(parsed.ahead, null)
  assert.equal(parsed.behind, null)
  const flags = detector.localFlags(parsed)
  assert.equal(flags.ahead, null)
  assert.equal(flags.unpushed, false)
})

test('CRLF output parses the same as LF', () => {
  const parsed = detector.parseLocalStatus(NO_UPSTREAM.replace(/\n/g, '\r\n'))
  assert.equal(parsed.branch, 'feature/local-only')
})

test('a detached HEAD is reported as detached with no branch name', () => {
  const parsed = detector.parseLocalStatus(DETACHED)
  assert.equal(parsed.detached, true)
  assert.equal(parsed.branch, null)
  assert.equal(detector.localFlags(parsed).detached, true)
})

test('an unmerged entry counts as both conflicted and modified', () => {
  const parsed = detector.parseLocalStatus(CONFLICTED)
  assert.equal(parsed.conflicted, 1)
  assert.equal(parsed.modified, 1)
  assert.equal(detector.localFlags(parsed).dirty, true)
})

test('localFlags turns counts into the chips the panel shows', () => {
  const flags = detector.localFlags(detector.parseLocalStatus(AHEAD_AND_DIRTY))
  assert.equal(flags.dirty, true)
  assert.equal(flags.modified, 3)
  assert.equal(flags.untracked, 2)
  assert.equal(flags.unpushed, true)
  assert.equal(flags.ahead, 2)
  assert.equal(flags.behind, 3)
  assert.equal(flags.upstream, 'origin/main')
})

test('localFlags is null when the status could not be read', () => {
  assert.equal(detector.localFlags(null), null)
  assert.equal(detector.localFlags(undefined), null)
})

test('needsAttention covers remote updates and local work only', () => {
  const clean = { state: 'up-to-date', flags: detector.localFlags(detector.parseLocalStatus(CLEAN)) }
  assert.equal(detector.needsAttention(clean), false)

  const update = { state: 'update', flags: clean.flags }
  assert.equal(detector.needsAttention(update), true, 'a remote update is always worth a row')

  const dirty = { state: 'up-to-date', flags: detector.localFlags(detector.parseLocalStatus(AHEAD_AND_DIRTY)) }
  assert.equal(detector.needsAttention(dirty), true)

  const unpushedOnly = {
    state: 'up-to-date',
    flags: detector.localFlags({ ...detector.parseLocalStatus(CLEAN), ahead: 1 }),
  }
  assert.equal(detector.needsAttention(unpushedOnly), true)

  const unknown = { state: 'up-to-date', flags: null }
  assert.equal(detector.needsAttention(unknown), false, 'no status read must not invent attention')

  const unreachable = { state: 'unreachable', flags: null }
  assert.equal(
    detector.needsAttention(unreachable),
    false,
    'an unreachable remote is reported through counts/error, not as a per-repo row',
  )
})

test('a repository behind and dirty produces both chips worth of facts', () => {
  const item = {
    state: 'update',
    behind: 3,
    flags: detector.localFlags(detector.parseLocalStatus(AHEAD_AND_DIRTY)),
  }
  assert.equal(detector.needsAttention(item), true)
  assert.equal(item.flags.dirty, true)
  assert.equal(item.flags.unpushed, true)
})

test('untracked files are not dirt and do not earn a row of their own', () => {
  const parsed = detector.parseLocalStatus(UNTRACKED_ONLY)
  assert.equal(parsed.untracked, 3)
  assert.equal(parsed.modified, 0)

  const flags = detector.localFlags(parsed)
  assert.equal(flags.dirty, false, 'untracked content is not tracked dirt')
  assert.equal(flags.untrackedOnly, true, 'the old `dirty` case is still nameable')
  assert.equal(flags.untracked, 3, 'the count itself survives for the chips')

  // The picture-skills case: no remote update, nothing tracked changed. It used to
  // produce a row whose only chip was 未跟踪 N and which had no button at all.
  assert.equal(detector.needsAttention({ state: 'up-to-date', flags }), false)

  // Untracked files never *remove* a row that something else earned, and the count
  // is still there for the 未跟踪 N chip on it. `state === 'update'` is also what
  // gives the row its 更新 button.
  const behind = { state: 'update', behind: 2, flags }
  assert.equal(detector.needsAttention(behind), true)
  assert.equal(behind.state, 'update', 'the update row keeps its button condition')
  assert.equal(behind.flags.untracked, 3, '…and still says 未跟踪 3')

  const unpushed = {
    state: 'up-to-date',
    flags: detector.localFlags({ ...parsed, ahead: 1 }),
  }
  assert.equal(detector.needsAttention(unpushed), true)
  assert.equal(unpushed.flags.untrackedOnly, true)
})

test('a tracked change is still dirt, and dirty never means "untracked only"', () => {
  const flags = detector.localFlags(detector.parseLocalStatus(AHEAD_AND_DIRTY))
  assert.equal(flags.dirty, true)
  assert.equal(flags.untrackedOnly, false, 'a real tracked change is not the untracked-only case')
  assert.equal(detector.needsAttention({ state: 'up-to-date', flags }), true)

  // A conflict is tracked dirt too (`parseLocalStatus` folds it into `modified`),
  // so it keeps its row and its 冲突 chip.
  const conflicted = detector.localFlags(detector.parseLocalStatus(CONFLICTED))
  assert.equal(conflicted.dirty, true)
  assert.equal(conflicted.untrackedOnly, false)
  assert.equal(detector.needsAttention({ state: 'up-to-date', flags: conflicted }), true)
})
