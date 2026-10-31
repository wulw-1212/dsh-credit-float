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
