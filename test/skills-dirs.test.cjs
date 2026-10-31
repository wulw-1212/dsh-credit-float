/**
 * Tests for the multi-directory skills configuration.
 *
 * Scope on purpose: **parsing, merging, dedup, and the same-name clash rule.**
 * Nothing here touches the network or the real `$DSH_HOME/skills` — a live scan
 * needs a machine with actual clones and is checked by hand. The folders created
 * here are throw-away directories under `os.tmpdir()` holding an empty `.git`
 * each, which is all `listGitRepos` looks at.
 *
 * Run with the Electron-bundled node (see the task notes):
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "<electron.exe>" --test test/skills-dirs.test.cjs
 *   Remove-Item Env:\ELECTRON_RUN_AS_NODE
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const mod = require('../desktop/skills-update.cjs')
const {
  parseSkillsDirsEnv,
  normalizeSkillsDir,
  skillsDirKey,
  resolveSkillsDirs,
  assignSkillDisplays,
  shouldAnnounce,
  describeAnnouncement,
  skillKey,
  listGitRepos,
  defaultSkillsDir,
  SKILLS_DIRS_CONFIG,
  createSkillsWatcher,
} = mod

const IS_WIN = process.platform === 'win32'

// One scratch tree for the whole file, removed on exit. A `process.on('exit')`
// hook rather than a test-suite hook: it works on every node the Electron builds
// we run under ship, and it still fires when a test throws.
const SPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dcf-skills-'))
process.on('exit', () => {
  try {
    fs.rmSync(SPACE_ROOT, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

/** A fresh, isolated folder per test so no configuration bleeds between them. */
function tmpSpace(name) {
  const dir = path.join(SPACE_ROOT, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Make `<root>/<name>/.git` so `listGitRepos` sees an installed clone. */
function fakeRepo(root, name) {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  return dir
}

/**
 * Env carrying only the keys under test. Without this the developer's own
 * `DSH_HOME` / `DCF_SKILLS_DIR` would decide what the assertions see.
 */
function cleanEnv(extra = {}) {
  return { DSH_HOME: undefined, DCF_SKILLS_DIR: undefined, DCF_SKILLS_DIRS: undefined, ...extra }
}

/** Write the multi-dir config file into `dir` and return its path. */
function writeConfig(dir, contents) {
  const file = path.join(dir, SKILLS_DIRS_CONFIG)
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  return file
}

test('DCF_SKILLS_DIRS splits on ; and , and drops empty pieces', () => {
  assert.deepEqual(parseSkillsDirsEnv('A;B;C'), ['A', 'B', 'C'])
  assert.deepEqual(parseSkillsDirsEnv('A; B , C'), ['A', 'B', 'C'])
  assert.deepEqual(parseSkillsDirsEnv(''), [])
  assert.deepEqual(parseSkillsDirsEnv(';;'), [])
  assert.deepEqual(parseSkillsDirsEnv(undefined), [])
  assert.deepEqual(parseSkillsDirsEnv(42), [])
})

test('paths normalise: separators, trailing slash, dot segments', () => {
  const a = normalizeSkillsDir(IS_WIN ? 'D:\\Prog\\one' : '/tmp/prog/one')
  const b = normalizeSkillsDir(IS_WIN ? 'D:/Prog/one/' : '/tmp/prog/one/')
  assert.equal(a, b, 'mixed separators and a trailing separator are the same folder')

  const dotted = normalizeSkillsDir(IS_WIN ? 'D:\\Prog\\two\\..\\one' : '/tmp/prog/two/../one')
  assert.equal(dotted, a, 'a .. detour resolves to the same root')

  // A bare drive/root must keep exactly one trailing separator: stripping it to
  // `D:` would make `resolve` reinterpret it as "cwd on drive D", a different
  // folder on most machines.
  if (IS_WIN) {
    assert.equal(normalizeSkillsDir('D:\\'), 'D:\\')
    assert.equal(normalizeSkillsDir('D:\\\\'), 'D:\\')
    assert.equal(normalizeSkillsDir('d:/'), 'd:\\')
  } else {
    assert.equal(normalizeSkillsDir('/'), '/')
    assert.equal(normalizeSkillsDir('///'), '/')
  }

  // A relative entry becomes absolute against the cwd, and nothing is left blank.
  assert.equal(normalizeSkillsDir('.'), process.cwd())
  assert.ok(path.isAbsolute(normalizeSkillsDir(IS_WIN ? 'sub\\dir' : 'sub/dir')))
  assert.throws(() => normalizeSkillsDir('   '), /empty path/)
})

test('skillsDirKey unifies separators, and folds case only where the fs does', () => {
  const key = skillsDirKey(IS_WIN ? 'D:\\a\\b' : '/a/b')
  assert.match(key, /\/a\/b$/)
  if (IS_WIN) {
    assert.equal(skillsDirKey('D:/A/B/'), key, 'Windows is case-insensitive')
    assert.equal(skillsDirKey('d:\\a\\b'), key)
  } else {
    assert.notEqual(skillsDirKey('/A/B/'), key, 'POSIX stays case-sensitive')
  }
})

test('no configuration at all → only the default root, no warnings', () => {
  const space = tmpSpace('default')
  const home = path.join(space, 'dsh-home')
  const expected = path.join(home, 'skills')

  const result = resolveSkillsDirs({ env: cleanEnv({ DSH_HOME: home }), configDir: space })
  assert.deepEqual(result.dirs, [expected])
  assert.deepEqual(result.warnings, [])

  // The same answer through the module-level helper (unchanged behaviour).
  assert.equal(defaultSkillsDir(cleanEnv({ DSH_HOME: home })), expected)
})

test('env (2 dirs) + config file (1 dir) merge into three roots, in a stable order', () => {
  const space = tmpSpace('merge')
  const one = path.join(space, 'one')
  const two = path.join(space, 'two')
  const three = path.join(space, 'three')
  const home = path.join(space, 'dsh-home')
  const fallback = path.join(home, 'skills')

  // The second file entry is a path this test never created: it still has to
  // appear, because a configured-but-missing root is reported by the scan, not
  // silently dropped here.
  writeConfig(space, {
    dirs: [three, IS_WIN ? 'D:\\never\\configured' : '/never/configured'],
  })
  const env = cleanEnv({ DSH_HOME: home, DCF_SKILLS_DIRS: `${one};${two}` })

  const first = resolveSkillsDirs({ env, configDir: space })
  assert.deepEqual(first.dirs.slice(0, 3), [one, two, three], 'env first, then file, order preserved')
  assert.equal(
    first.dirs[first.dirs.length - 1],
    fallback,
    'the default root always participates, last',
  )
  assert.deepEqual(first.warnings, [])

  // A second read proving the order is a property of the config, not of an
  // iteration order we happen to get.
  assert.deepEqual(resolveSkillsDirs({ env, configDir: space }).dirs, first.dirs)
})

test('the same folder spelled differently across sources dedupes to one root', () => {
  const space = tmpSpace('dedup')
  const target = path.join(space, 'Shared', 'Skills')
  const other = path.join(space, 'other')
  // Same folder, three spellings: opposite separators, a trailing separator, and
  // (on Windows) a different case.
  const variants = [
    target,
    IS_WIN ? target.replace(/^\w:/, m => m.toLowerCase()) : target,
    IS_WIN ? target.split('\\').join('/') + '\\' : target + '//',
  ]

  writeConfig(space, { dirs: [variants[1], other, variants[2]] })
  const env = cleanEnv({ DSH_HOME: space, DCF_SKILLS_DIRS: variants.join(';') })
  const { dirs, warnings } = resolveSkillsDirs({ env, configDir: space })

  assert.deepEqual(warnings, [])
  assert.equal(
    dirs.filter(d => skillsDirKey(d) === skillsDirKey(target)).length,
    1,
    'one entry per real folder, no matter how it was spelled',
  )
  assert.ok(dirs.some(d => skillsDirKey(d) === skillsDirKey(other)))
  assert.equal(new Set(dirs.map(skillsDirKey)).size, dirs.length, 'no duplicate key survives')

  // Naming the default explicitly (a fresh space, so no config file adds to it)
  // must not produce a second copy of it.
  const namedSpace = path.join(SPACE_ROOT, 'dedup-named')
  fs.mkdirSync(namedSpace, { recursive: true })
  const named = resolveSkillsDirs({
    env: cleanEnv({ DSH_HOME: namedSpace, DCF_SKILLS_DIRS: path.join(namedSpace, 'skills') }),
    configDir: namedSpace,
  })
  assert.deepEqual(named.dirs, [path.join(namedSpace, 'skills')], 'explicit default dedupes')

  // And on a case-insensitive filesystem the *other* spelling of it dedupes too.
  const cased = resolveSkillsDirs({
    env: cleanEnv({
      DSH_HOME: namedSpace,
      DCF_SKILLS_DIRS: IS_WIN
        ? path.join(namedSpace, 'skills').replace(/^\w:/, m => m.toLowerCase())
        : path.join(namedSpace, 'SKILLS'),
    }),
    configDir: namedSpace,
  })
  assert.equal(cased.dirs.length, 1, 'one root, whichever spelling arrived first')
})

test('DCF_SKILLS_DIR keeps working as the legacy single-dir alias', () => {
  const space = tmpSpace('alias')
  const legacy = path.join(space, 'legacy')
  const env = cleanEnv({ DSH_HOME: space, DCF_SKILLS_DIR: legacy })
  const { dirs } = resolveSkillsDirs({ env, configDir: space })
  assert.equal(dirs[0], legacy, 'the alias is honoured and comes first')
  assert.ok(dirs.includes(path.join(space, 'skills')), 'the default is still in the list')
})

test('a broken config file degrades to the other sources plus one warning', () => {
  const space = tmpSpace('bad')
  const env = cleanEnv({ DSH_HOME: space })
  const good = path.join(space, 'good')
  const fallback = path.join(space, 'skills')

  writeConfig(space, '{ this is not json')
  const bad = resolveSkillsDirs({ env, configDir: space })
  assert.deepEqual(bad.dirs, [fallback], 'the default root survives a broken file')
  assert.equal(bad.warnings.length, 1)
  assert.match(bad.warnings[0], /JSON/)

  writeConfig(space, { nope: [] })
  const shape = resolveSkillsDirs({ env, configDir: space })
  assert.equal(shape.warnings.length, 1)
  assert.match(shape.warnings[0], /dirs/)

  writeConfig(space, { dirs: [good, 7, '', null] })
  const partial = resolveSkillsDirs({ env, configDir: space })
  assert.deepEqual(partial.dirs, [good, fallback], 'the valid entries are still used')
  assert.equal(partial.warnings.length, 1)
  assert.match(partial.warnings[0], /3 条/)

  // A config file that simply is not there means "not configured yet", which is
  // not worth a warning on every pass.
  const missing = resolveSkillsDirs({ env, configDir: path.join(space, 'nowhere') })
  assert.deepEqual(missing.warnings, [])
  assert.deepEqual(missing.dirs, [fallback])
})

test('warnings are safe to show: never an absolute path', () => {
  const space = tmpSpace('leak')
  writeConfig(space, 'not json')
  const { warnings } = resolveSkillsDirs({ env: cleanEnv({ DSH_HOME: space }), configDir: space })
  assert.ok(warnings.length > 0, 'the setup does produce a warning')
  for (const text of warnings) {
    assert.ok(!text.includes(space), `warning leaks the folder path: ${text}`)
    assert.ok(!path.isAbsolute(text), `warning is a path: ${text}`)
  }
})

test('same repo name under two roots → display carries the root, keys stay unique', () => {
  const space = tmpSpace('clash')
  const rootA = path.join(space, 'skillsA')
  const rootB = path.join(space, 'skillsB')
  fakeRepo(rootA, 'office')
  fakeRepo(rootA, 'genui')
  fakeRepo(rootB, 'office')
  fs.mkdirSync(path.join(rootB, 'not-a-repo'), { recursive: true })

  assert.deepEqual(listGitRepos(rootA).names, ['genui', 'office'], 'sorted, git folders only')
  assert.deepEqual(listGitRepos(path.join(space, 'does-not-exist')), { names: [], missing: true })

  const listed = [rootA, rootB].flatMap((dir, rootIndex) =>
    listGitRepos(dir).names.map(name => ({ name, rootIndex, root: path.basename(dir) })),
  )
  const decorated = assignSkillDisplays(listed)
  const byKey = new Map(decorated.map(item => [item.key, item]))

  assert.equal(
    decorated.find(item => item.name === 'genui').display,
    'genui',
    'a name unique to one root keeps the bare folder name',
  )
  const clash = decorated.filter(item => item.name === 'office')
  assert.equal(clash.length, 2)
  assert.equal(clash[0].display, 'office (skillsA)')
  assert.equal(clash[1].display, 'office (skillsB)')
  assert.notEqual(clash[0].key, clash[1].key, 'two roots cannot share a reminder key')
  assert.equal(byKey.size, decorated.length, 'every key is unique')

  // The display name is what the toast says and what the state file remembers.
  const snapshot = { updates: clash.map(item => ({ ...item, state: 'update', behind: 1 })) }
  assert.equal(skillKey(clash[0]), 'office (skillsA)')
  const { title, body } = describeAnnouncement(snapshot)
  assert.match(title, /^2 个技能仓库有远端更新$/)
  assert.ok(body.includes('office (skillsA)') && body.includes('office (skillsB)'))
  assert.match(body, /落后 2 个提交/)

  // Announcing both, then losing one, is new information again; the same set is
  // not. And a stored record from the pre-multi-root format (bare names) simply
  // differs → announce once, then the new keys are persisted.
  const stored = { names: clash.map(skillKey).sort().join('|'), at: Date.now() }
  assert.equal(shouldAnnounce({ stored, snapshot }), false, 'same set within the quiet period → silent')
  assert.equal(shouldAnnounce({ stored, snapshot: { updates: [clash[0]] } }), true)
  assert.equal(shouldAnnounce({ stored: { names: 'office', at: Date.now() }, snapshot }), true)
  assert.equal(
    shouldAnnounce({ stored: { names: 'office (skillsA)|office (skillsB)', at: Date.now() }, snapshot }),
    false,
    'the persisted key round-trips',
  )
})

test('two roots whose basenames match still get unique keys', () => {
  const repos = assignSkillDisplays([
    { name: 'office', rootIndex: 0, root: 'skills' },
    { name: 'office', rootIndex: 1, root: 'skills' },
    { name: 'office', rootIndex: 2, root: 'skills' },
  ])
  assert.deepEqual(repos.map(r => r.display), [
    'office (skills)',
    'office (skills) #2',
    'office (skills) #3',
  ])
  assert.equal(new Set(repos.map(r => r.key)).size, 3)
})

test('the watcher resolves every configured root and reports roots by basename', async () => {
  const space = tmpSpace('watcher')
  const rootA = path.join(space, 'skillsA')
  const rootB = path.join(space, 'nested', 'skillsB')
  fakeRepo(rootA, 'office')
  fakeRepo(rootB, 'office')
  fakeRepo(rootB, 'solo')

  // Pin the roots explicitly: the machine's own env and config file must not
  // decide what this test observes.
  const snapshots = []
  const watcher = createSkillsWatcher({
    log: { debug() {}, warn() {}, error() {} },
    skillsDirs: [rootA, rootB],
    emit: snapshot => snapshots.push({ ...snapshot }),
  })

  assert.deepEqual(watcher.rootDirs, [path.resolve(rootA), path.resolve(rootB)])
  assert.equal(watcher.skillsDir, path.resolve(rootA), 'legacy accessor = first root')
  assert.equal(watcher.configFile, '', 'a pinned watcher does not claim a config file')

  const first = watcher.getSnapshot()
  assert.deepEqual(first.roots.map(root => root.basename), ['skillsA', 'skillsB'])
  assert.equal(first.roots[0].index, 0)
  assert.deepEqual(first.items, [], 'nothing is known before the first pass')
  assert.deepEqual(first.warnings, [])

  // Whatever this machine has or has not got (a git binary, network access), the
  // answer must be honest: `checked` with a reason, never a silent clean bill.
  const result = await watcher.check()
  assert.equal(result.checked, true)
  assert.equal(result.checking, false)
  assert.deepEqual(result.roots.map(root => root.basename), ['skillsA', 'skillsB'])

  const names = result.items.map(item => item.display).sort()
  if (result.error === null && names.length > 0) {
    // A real git was available and parsed the fake repos: the multi-root identity
    // must be complete on every item, since the dedup key depends on it.
    assert.deepEqual(names, ['office (skillsA)', 'office (skillsB)', 'solo'])
    for (const item of result.items) {
      assert.equal(typeof item.root, 'string')
      assert.ok(Number.isFinite(item.rootIndex))
      assert.equal(item.key, item.display)
      assert.ok(item.path.startsWith(path.resolve(space)), 'the path stayed on this side of the line')
    }
  }

  // No absolute path may leak into anything the UI shape exposes: `roots` is
  // basename-only, and the snapshot is what publicSkills() filters.
  assert.ok(!JSON.stringify(result.roots).includes(space), 'roots leaked a path')

  watcher.stop()
})

test('assignSkillDisplays handles the empty and single-root cases', () => {
  assert.deepEqual(assignSkillDisplays([]), [])
  const alone = assignSkillDisplays([{ name: 'office', rootIndex: 0, root: 'skills' }])
  assert.deepEqual(alone.map(item => item.display), ['office'], 'single root → zero visual change')
})
