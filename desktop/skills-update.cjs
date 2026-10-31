/**
 * Skill-repository remote update watcher.
 *
 * `$DSH_HOME/skills` holds third-party skill folders installed as *git clones*
 * (each with its own `origin`). Nothing in DSH notices when one of them falls
 * behind upstream, so the user keeps using stale skill instructions and only
 * finds out much later.
 *
 * This module answers exactly one question — "does any installed skill folder
 * have commits on its remote that the local checkout does not have?" — and
 * reports it, for **every configured skills root** (see `resolveSkillsDirs`).
 * It never writes to the skill folders: no fetch, no pull, no
 * checkout. Detection is `git ls-remote` (a single ref advertisement over the
 * network) plus local object lookups, so nothing on disk changes and no
 * credential is ever entered on our behalf.
 *
 * The update itself stays the user's decision, taken in whatever tool they
 * installed the skill with.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

/** How often to re-check once the first pass is done. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Let the window finish loading before the first network round. */
const FIRST_DELAY_MS = 15_000
/**
 * How often the multi-directory config file is re-statted while the watcher runs.
 *
 * `skills-dirs.json` is re-read at the start of every pass — but a pass is up to
 * six hours apart, so a folder the user just added could sit unnoticed for that
 * long and the panel would look inert ("I changed the config and nothing
 * happened"). Something has to notice the change, and one `stat` of one file per
 * second is cheap enough to be that something. Polling the path also survives how
 * editors actually save (write a temp file, rename it over the target): a watch
 * handle on the old inode would go quiet, while the path always holds the new
 * file.
 */
const CONFIG_POLL_MS = 1000
/**
 * One save can be several writes, so at most one extra pass per window. A change
 * inside the window is remembered, not dropped — and `check()` coalesces
 * concurrent callers anyway.
 */
const CONFIG_DEBOUNCE_MS = 700
/** A hung `git` (auth prompt, dead proxy) must not wedge the watcher. */
const GIT_TIMEOUT_MS = 25_000
/** Repos checked at the same time. `ls-remote` is cheap but it is still HTTPS. */
const CONCURRENCY = 4
/** Refuse to scan a folder with more candidates than this. */
const MAX_REPOS = 200

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
 * Git env that keeps a check from ever becoming interactive.
 *
 * `GIT_TERMINAL_PROMPT=0` makes git fail instead of asking for a username on a
 * private/rotated-token remote, and `GCM_INTERACTIVE=never` does the same for
 * the Windows credential manager (which would otherwise pop a GUI window from a
 * hidden helper process). Without these a check could block forever on a prompt
 * nobody can see.
 *
 * The *system* and *global* gitconfigs are deliberately left in place. Git for
 * Windows ships TLS/proxy settings in the system config (notably the schannel
 * revocation-check option), and `GIT_CONFIG_NOSYSTEM=1` was measured to turn
 * every single `ls-remote` into `CRYPT_E_NO_REVOCATION_CHECK` on this machine —
 * a watcher that reports all repos unreachable is worse than one trusting the
 * user's own git config. Global config is kept for the same reason: a mirror
 * rewrite (`url.<proxy>.insteadOf`) is how many installs reach GitHub at all,
 * and ignoring it would report "unreachable" for repos the user pulls daily.
 */
function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    HOME: process.env.HOME || process.env.USERPROFILE || process.cwd(),
  }
}

/**
 * Run git with args, capturing stdout. Never rejects: a non-zero exit is data.
 */
function runGit(git, args, cwd) {
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
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) })
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
      finish({ code: -1, stdout, stderr: stderr || 'git 执行超时' })
    }, GIT_TIMEOUT_MS)
    kill.unref?.()

    child.stdout?.on('data', chunk => {
      // A ref advertisement is small; anything huge is a runaway and gets cut.
      if (stdout.length < 256 * 1024) stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      if (stderr.length < 32 * 1024) stderr += String(chunk)
    })
    child.on('error', error => {
      finish({ code: -1, stdout, stderr: String(error?.message ?? error) })
    })
    child.on('close', code => {
      finish({ code: Number.isFinite(code) ? code : -1, stdout, stderr })
    })
  })
}

/** The first git that answers `--version`, or null. */
async function resolveGit(log) {
  for (const candidate of GIT_CANDIDATES) {
    const result = await runGit(candidate, ['--version'], process.cwd())
    if (result.code === 0 && /git version/.test(result.stdout)) {
      log?.debug?.(`[skills] 使用 git: ${candidate}（${result.stdout.trim()}）`)
      return candidate
    }
  }
  return null
}

/** `$DSH_HOME/skills`, overridable for other layouts. */
function defaultSkillsDir(env = process.env) {
  const home =
    env.DSH_HOME ||
    path.join(env.USERPROFILE || env.HOME || '', '.dsh')
  return path.join(home, 'skills')
}

/**
 * ── Which folders count as "the skills directories" ─────────────────────────
 *
 * Semantics, fixed here because every caller depends on it (and because the
 * obvious alternative — letting a config file *replace* the defaults — silently
 * loses `$DSH_HOME/skills`, the one folder everyone has):
 *
 *   1. Sources are **merged, never overridden**, in this order:
 *        a. `DCF_SKILLS_DIRS` (separator: `;` — the Windows habit — also `,`),
 *           then the legacy single-dir alias `DCF_SKILLS_DIR`.
 *        b. `skills-dirs.json` (`{"dirs": [...]}`) next to the helper's state
 *           file, i.e. the plugin folder when no `DCF_STATE_FILE` was given.
 *        c. The default root, `$DSH_HOME/skills`.
 *   2. The **default root always participates**, even when (a)/(b) are set; a
 *      configuration that *does* name it explicitly just dedups to one entry.
 *      Explicit roots come first, the default last, so the order is stable and
 *      the folder nobody configured is the one that sorts to the bottom.
 *   3. Dedup happens on the **resolved absolute path**, with separators unified
 *      and, on case-insensitive filesystems (Windows/macOS), case folded. So
 *      `D:\a\b`, `D:/a/b/` and `d:\A\B` are one root.
 *   4. The config file is **re-read on every pass** (the user may have just
 *      edited it). A missing file is not configured yet, not an error. A file
 *      that exists but cannot be read or parsed produces a *warning* and the
 *      rest of the sources still apply — it never blanks the list and never
 *      throws.
 */

/** Name of the multi-directory config file, next to the helper's state file. */
const SKILLS_DIRS_CONFIG = 'skills-dirs.json'

/** Absolute path of `skills-dirs.json` for a given config directory. */
function skillsDirsConfigPath(configDir) {
  return path.resolve(configDir || path.resolve(__dirname, '..'), SKILLS_DIRS_CONFIG)
}

/** Display name of a root: the last path segment, tolerant of a trailing slash. */
function skillsDirBasename(dir) {
  const text = String(dir ?? '')
  return path.basename(text.replace(/[\\/]+$/, '')) || text
}

/** Split a `DCF_SKILLS_DIRS` value on `;` and `,`. Empty pieces are dropped. */
function parseSkillsDirsEnv(value) {
  // A non-string (an unset env var, a stray number) simply means "nothing here".
  if (typeof value !== 'string') return []
  return value
    .split(/[;,]/)
    .map(piece => piece.trim())
    .filter(Boolean)
}

/** Absolute, separator-normalised form of one configured path. */
function normalizeSkillsDir(dir) {
  const trimmed = String(dir).trim()
  if (!trimmed) throw new Error('empty path')
  // Trailing separators are noise (`D:\a\b\` === `D:\a\b`), except when the whole
  // value *is* a drive/root — stripping `D:\` down to `D:` would make `resolve`
  // reinterpret it as "cwd on drive D", a different folder entirely.
  const isBareRoot = /^[a-zA-Z]:[\\/]$/.test(trimmed) || trimmed === '/'
  const stripped = isBareRoot ? trimmed : trimmed.replace(/[\\/]+$/, '')
  // `path.resolve` folds `..`/`.`, accepts either separator on Windows, and makes
  // a relative entry absolute against the helper's cwd — which is the plugin dir.
  return path.resolve(stripped || '.')
}

/** Case-insensitive filesystems treat two spellings of a path as one folder. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

/** Comparison key for a root: unified separators, folded case where relevant. */
function skillsDirKey(dir) {
  const unified = path.resolve(dir).split(path.sep).join('/')
  return CASE_INSENSITIVE_FS ? unified.toLowerCase() : unified
}

/** `JSON.parse` as data: a broken file is an expected outcome here, not a throw. */
function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error }
  }
}

/** The string entries of `parsed.dirs`, or null when there is no dirs array. */
function configStringDirs(parsed) {
  const list = Array.isArray(parsed?.dirs) ? parsed.dirs : null
  return list === null ? null : list.filter(entry => typeof entry === 'string')
}

/**
 * A control character inside a configured path: `\u0000`-`\u001f`.
 *
 * Such a path is the fingerprint of the hand-written backslash mistake — see
 * `readSkillsDirsConfig`. A real folder name has no business containing one.
 */
const CONTROL_CHAR = /[\u0000-\u001f]/

/**
 * Repair hand-written Windows paths: every backslash that is not already part of
 * a valid escape (`\\`, `\"`, `\/`) gets one of its own.
 *
 * Scanning character by character — rather than one backslash at a time with a
 * regex — is what makes the repair safe to apply to a whole file. A regex would
 * look at the second backslash of a correctly written `"C:\\good"`, see a
 * backslash followed by `g`, escape it, and turn a valid file into an invalid
 * one. Consuming a valid pair as a single unit leaves correct escapes untouched
 * and only touches the bare ones.
 */
function escapeBareBackslashes(text) {
  const source = String(text)
  let out = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = source[i + 1]
    if (next === '\\' || next === '"' || next === '/') {
      out += ch + next
      i += 1
      continue
    }
    out += '\\\\'
  }
  return out
}

/**
 * Read `skills-dirs.json`. Never throws: any problem degrades to "no dirs from
 * here" plus one warning string (path-free — this reaches the renderer).
 *
 * ── The hand-written backslash ──────────────────────────────────────────────
 *
 * Windows paths in JSON are a trap users fall into twice, so the file is read
 * leniently in exactly one direction, and only when it is provably wrong:
 *
 *   1. Strict `JSON.parse` first. When it succeeds and the paths are clean, they
 *      are used verbatim — no rewriting, no warning.
 *   2. When it fails, one repair retry: bare backslashes get escaped, then the
 *      result is parsed strictly again. `"D:\Programs Data\..."` (`\P` is not an
 *      escape) is the mistake; the old behaviour was to call the whole file
 *      invalid and skip every configured root, which is indistinguishable from
 *      "adding a directory did nothing". A successful retry is used and reported
 *      as a warning, so the user learns the file needs fixing without losing the
 *      folders in the meantime. A retry that still fails keeps the old behaviour:
 *      skip this layer, one warning.
 *   3. A strict parse that *succeeds* can still be the same mistake:
 *      `"C:\new\table"` is valid JSON (`\n` and `\t` are escapes) and parses into
 *      a path containing a newline and a tab. A control character in a path is
 *      therefore treated as the same unescaped-backslash bug: repair and re-parse,
 *      use the repaired paths with a warning when they come out clean, otherwise
 *      keep the original value and say so rather than silently using a path no
 *      filesystem can open.
 *
 * Anything else (an unterminated string, a missing comma) stays a broken file: it
 * is skipped with a warning, exactly as before.
 */
function readSkillsDirsConfig(file, warnings) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    // Absent simply means the feature is not configured: stay quiet.
    if (error?.code !== 'ENOENT') {
      warnings.push(`技能目录配置文件无法读取（${path.basename(file)}），本层已跳过`)
    }
    return []
  }
  // Windows tooling (Notepad, PowerShell's `-Encoding utf8`, some editors'
  // "UTF-8 with BOM") prepends U+FEFF, and `JSON.parse` rejects it. A file the
  // user hand-edited is exactly where that is most likely, so the BOM is
  // stripped before parsing instead of being reported as a broken config.
  const text = raw.replace(/^\uFEFF/, '')
  const name = path.basename(file)

  const strict = tryParseJson(text)
  let parsed = null
  let repaired = false
  if (strict.ok) {
    parsed = strict.value
    const entries = configStringDirs(parsed)
    if (entries !== null && entries.some(entry => CONTROL_CHAR.test(entry))) {
      const fixed = tryParseJson(escapeBareBackslashes(text))
      const fixedEntries = fixed.ok ? configStringDirs(fixed.value) : null
      if (fixedEntries !== null && !fixedEntries.some(entry => CONTROL_CHAR.test(entry))) {
        parsed = fixed.value
        repaired = true
      } else {
        warnings.push(
          `技能目录配置文件中有路径包含控制字符（${name}），可能是反斜杠未转义，已保留原值，请检查后重写`,
        )
      }
    }
  } else {
    const fixed = tryParseJson(escapeBareBackslashes(text))
    if (fixed.ok) {
      parsed = fixed.value
      repaired = true
    } else {
      warnings.push(`技能目录配置文件不是合法 JSON（${name}），本层已跳过`)
      return []
    }
  }
  if (repaired) {
    warnings.push(`技能目录配置文件中的反斜杠未转义，已按 Windows 路径自动修正（${name}）`)
  }

  const list = Array.isArray(parsed?.dirs) ? parsed.dirs : null
  if (!list) {
    warnings.push(`技能目录配置文件缺少 dirs 数组（${name}），本层已跳过`)
    return []
  }
  const dirs = list.filter(entry => typeof entry === 'string' && entry.trim())
  if (dirs.length !== list.length) {
    warnings.push(`技能目录配置文件中有 ${list.length - dirs.length} 条不是路径字符串，已忽略`)
  }
  return dirs
}

/**
 * Persist the configured directories.
 *
 * Only the **explicitly configured** roots belong in this file: the default root
 * is always added by `resolveSkillsDirs`, and writing it here would pin a machine
 * specific path into a config that is meant to say "the user asked for this".
 *
 * The write is atomic — a temporary file in the same folder, then `rename` — so a
 * crash, a full disk or a permission error can never leave `skills-dirs.json`
 * half written (which would make the next pass warn about broken JSON and drop
 * every configured root). Paths are normalised and deduped here, so the file is
 * canonical no matter what the caller passed.
 *
 * Returns `{ ok: true, dirs, file }` or `{ ok: false, error }` — never throws for
 * an I/O problem, because the caller reports it to the renderer. `error` carries a
 * basename-level sentence only (the renderer must never learn a path).
 */
function writeSkillsDirsConfig(configDir, dirs) {
  const file = skillsDirsConfigPath(configDir)
  const list = []
  const seen = new Set()
  for (const entry of Array.isArray(dirs) ? dirs : []) {
    let resolved
    try {
      resolved = normalizeSkillsDir(entry)
    } catch {
      continue
    }
    const key = skillsDirKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    list.push(resolved)
  }

  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify({ dirs: list }, null, 2)}\n`, 'utf8')
    // Same-directory rename: atomic on NTFS and POSIX, so a reader either sees
    // the previous complete file or the new complete file.
    fs.renameSync(tmp, file)
    return { ok: true, dirs: list, file }
  } catch (error) {
    // A half-written temp file must not linger next to the real config.
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* best effort */
    }
    return {
      ok: false,
      error: `技能目录配置写入失败（${path.basename(file)}）`,
      detail: String(error?.message ?? error),
    }
  }
}

/**
 * Merge the sources described above. Pure apart from reading one file, so the
 * whole priority/dedup story is testable without git or the network.
 *
 * Returns `dirs` (absolute paths, the shape every older caller expects) **and**
 * `roots` — the same list annotated with `index`, `basename` and `source`
 * (`env` | `config` | `default`). `source` is what the panel needs to know which
 * root may be removed: only a `config` root can be dropped from the file.
 * Dedup keeps the *first* source that named a path, so a folder that is both in
 * `DCF_SKILLS_DIRS` and the config file reports `env` — it cannot be removed by
 * editing the file, because the environment would add it straight back.
 */
function resolveSkillsDirs({ env = process.env, configDir, defaultDirs } = {}) {
  const warnings = []
  const ordered = []

  const push = (dir, source) => {
    let resolved
    try {
      resolved = normalizeSkillsDir(dir)
    } catch {
      warnings.push(`技能目录配置中有无法解析的路径，已忽略`)
      return
    }
    const key = skillsDirKey(resolved)
    if (ordered.some(entry => skillsDirKey(entry.dir) === key)) return
    ordered.push({ dir: resolved, source })
  }

  // a. Environment, newest spelling first, legacy alias kept working.
  for (const dir of parseSkillsDirsEnv(env.DCF_SKILLS_DIRS)) push(dir, 'env')
  for (const dir of parseSkillsDirsEnv(env.DCF_SKILLS_DIR)) push(dir, 'env')

  // b. The config file, re-read per pass.
  const configFile = skillsDirsConfigPath(configDir)
  for (const dir of readSkillsDirsConfig(configFile, warnings)) push(dir, 'config')

  // c. The default root(s) — always in, dedup handles the case where the config
  //    named them explicitly.
  const defaults =
    defaultDirs === undefined || defaultDirs === null
      ? [defaultSkillsDir(env)]
      : Array.isArray(defaultDirs)
        ? defaultDirs
        : [defaultDirs]
  for (const dir of defaults) push(dir, 'default')

  return {
    dirs: ordered.map(entry => entry.dir),
    roots: ordered.map((entry, index) => ({
      index,
      dir: entry.dir,
      basename: skillsDirBasename(entry.dir),
      source: entry.source,
    })),
    warnings,
    configFile,
  }
}

/**
 * Drop one path from a list of configured dirs (pure).
 *
 * Comparison is on `skillsDirKey`, so whatever spelling the file holds — mixed
 * separators, different case on Windows — removes the same real folder. A path
 * that is not in the list leaves it **unchanged**: `removed: false` lets the
 * caller say "this one is not in the config" instead of silently rewriting it.
 */
function removeSkillsDir(dirs, target) {
  const list = Array.isArray(dirs) ? [...dirs] : []
  let key
  try {
    key = skillsDirKey(target)
  } catch {
    return { removed: false, dirs: list }
  }
  const kept = list.filter(entry => {
    try {
      return skillsDirKey(entry) !== key
    } catch {
      return true
    }
  })
  return { removed: kept.length !== list.length, dirs: kept }
}

/**
 * Why one resolved root may not be removed, or `null` when it may (pure).
 *
 * The three sources differ in what "remove" could even mean:
 *   - `env`: `DCF_SKILLS_DIRS` lives in the user's environment; editing the JSON
 *     file would not help, the env entry would just be merged back in.
 *   - `default`: `$DSH_HOME/skills` is where DSH itself installs skills and it is
 *     always merged in, so it can never be absent.
 *   - `config`: the user named it, so the user can unname it.
 */
function skillsRootRemovalBlocker(source) {
  if (source === 'env') {
    return {
      code: 'env',
      reason: '该目录来自环境变量 DCF_SKILLS_DIRS，请修改环境变量（不能在此移除）',
    }
  }
  if (source === 'default') {
    return {
      code: 'default',
      reason: '默认技能目录 $DSH_HOME/skills 始终参与检查，无法移除',
    }
  }
  return null
}

/**
 * Work out what removing one root would mean, purely.
 *
 * There is no longer a UI for this — folders are configured in
 * `skills-dirs.json` / `DCF_SKILLS_DIRS` (see README) — but the rules are kept
 * because tooling around the config needs them: an `env` root cannot be removed
 * by editing the file (the env value would simply merge back), and the DSH
 * default is always merged in. `policyDirRemoval`-style callers get the same
 * "removable? which entry?" answer the panel used to compute.
 *
 * `roots` is `resolveSkillsDirs().roots` / `watcher.getRoots()`; the path
 * considered is the one this module resolved, and only if it is *exactly* what
 * the config file holds (by `skillsDirKey`) — nothing is taken from an index
 * without checking it against the resolved list.
 */
function planSkillsDirRemoval({ roots, index, configDirs } = {}) {
  const list = Array.isArray(roots) ? roots : []
  const at = Number(index)
  if (!Number.isFinite(at) || at < 0 || at >= list.length) {
    return { ok: false, code: 'index', reason: '没有这个技能目录（索引无效或已失效，请重查后再试）' }
  }
  const root = list[at]
  const blocked = skillsRootRemovalBlocker(root?.source)
  if (blocked !== null) return { ok: false, ...blocked }

  const current = Array.isArray(configDirs) ? [...configDirs] : []
  const { removed, dirs } = removeSkillsDir(current, root?.dir)
  if (!removed) {
    return { ok: false, code: 'missing', reason: '该目录不在配置文件里，无法移除' }
  }
  return { ok: true, code: 'removed', dirs, root: { index: at, basename: root.basename } }
}

/**
 * Display names for repos collected from several roots.
 *
 * Two roots can contain folders with the same name, and the reminder must tell
 * them apart — otherwise the dedup key collides and installing/updating one
 * silences the other's alert. A name that occurs under more than one root gets
 * `name (rootBasename)`; a single occurrence keeps the bare name so the panel
 * looks exactly like it did before multi-root existed.
 *
 * `key` is the stable identity (dedup + announcement state), `display` is what
 * the user reads. Both are unique across the list.
 */
function assignSkillDisplays(repos) {
  const occurrences = new Map()
  for (const repo of repos) occurrences.set(repo.name, (occurrences.get(repo.name) || 0) + 1)

  const used = new Set()
  return repos.map(repo => {
    let display = occurrences.get(repo.name) > 1 && repo.root ? `${repo.name} (${repo.root})` : repo.name
    // Same repo name under two roots whose basenames are identical (`skills\a`
    // twice in the config, different drives): the suffix does not disambiguate,
    // so fall back to a numeric one rather than ship a duplicate key.
    if (used.has(display)) {
      let n = 2
      while (used.has(`${display} #${n}`)) n += 1
      display = `${display} #${n}`
    }
    used.add(display)
    return { ...repo, display, key: display }
  })
}

/**
 * Git repositories directly under one root: the root **itself** when it is a
 * repository, plus every immediate subdirectory that is one.
 *
 * A configured directory is very often a clone in its own right — the user points
 * at the skill repository they installed, not at a folder full of them — and
 * looking only at subdirectories made such a root contribute nothing at all. The
 * folder was configured, and the panel said nothing about it, which reads exactly
 * like "adding it did nothing". The root is therefore a candidate like any other.
 *
 * Depth is still capped at one level (root + its direct children): a configured
 * folder must never turn into a full disk walk.
 *
 * `name` is the folder name to show — the root's own basename for its repository,
 * the entry name for a subdirectory — and `dir` is the absolute path. The caller
 * dedups on `dir`, because "root A itself" and "a subdirectory of root B" can be
 * the same real folder.
 */
function listGitRepoEntries(dir) {
  // Absolute throughout: a candidate's `dir` is what git is spawned in, and the
  // caller dedups on `skillsDirKey`, which resolves anyway.
  const root = path.resolve(dir)
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    // A missing root is normal on a fresh install or a dangling config entry.
    return { repos: [], missing: true }
  }
  const repos = []
  // The root's own repository comes first: it is the one the user named.
  if (isGitRepo(root)) repos.push({ name: skillsDirBasename(root), dir: root })
  const children = entries
    .filter(entry => {
      try {
        return entry.isDirectory() && isGitRepo(path.join(root, entry.name))
      } catch {
        return false
      }
    })
    .map(entry => ({ name: entry.name, dir: path.join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  repos.push(...children)
  return { repos, missing: false }
}

/** Names-only view of `listGitRepoEntries`, kept for older callers and tests. */
function listGitRepos(dir) {
  const { repos, missing } = listGitRepoEntries(dir)
  return { names: repos.map(repo => repo.name), missing }
}

function isGitRepo(dir) {
  try {
    // A `.git` *file* is also valid (worktree / submodule), hence existsSync.
    return fs.existsSync(path.join(dir, '.git'))
  } catch {
    return false
  }
}

/**
 * Flatten configured roots into candidate repositories: one entry per real
 * folder, each already carrying its root index, root basename and absolute path.
 *
 * Two roots can reach the same folder (one root *is* a subdirectory of another, or
 * the config names a folder and its parent). Checking such a path twice would
 * double its network cost and show the user two rows for one repository, so the
 * first root in configured order owns it — a stable choice, since the root order
 * is itself stable. Identity is `skillsDirKey`, i.e. `path.resolve` plus
 * separator/case normalisation, so Windows spellings of one folder collapse.
 *
 * Returns `{ repos, missing, truncated }`: `missing` counts roots that could not
 * be listed at all, `truncated` says the per-pass cap was hit.
 */
function collectSkillRepos(dirs) {
  const list = Array.isArray(dirs) ? dirs : []
  const repos = []
  const seen = new Set()
  let missing = 0
  let truncated = false
  for (let rootIndex = 0; rootIndex < list.length; rootIndex += 1) {
    const dir = list[rootIndex]
    const { repos: found, missing: gone } = listGitRepoEntries(dir)
    if (gone) {
      missing += 1
      continue
    }
    const root = skillsDirBasename(dir)
    for (const entry of found) {
      let key
      try {
        key = skillsDirKey(entry.dir)
      } catch {
        continue
      }
      if (seen.has(key)) continue
      // The cap is per pass, not per root: the network cost is what it limits.
      if (repos.length >= MAX_REPOS) {
        truncated = true
        break
      }
      seen.add(key)
      repos.push({ name: entry.name, rootIndex, root, dir: entry.dir })
    }
  }
  return { repos, missing, truncated }
}

const SHA = /^[0-9a-f]{40,64}$/

/**
 * Which remote ref stands for "upstream" for this checkout.
 *
 * `ls-remote origin <ref>` needs a ref name, so resolve one in order of how
 * much the user clearly meant it: the branch they are on (when not detached),
 * then the remote HEAD the clone recorded, then the bare `HEAD` advertisement.
 */
async function resolveUpstreamRef(git, dir) {
  const branch = await runGit(git, ['rev-parse', '--abbrev-ref', 'HEAD'], dir)
  const name = branch.stdout.trim()
  if (branch.code === 0 && name && name !== 'HEAD') {
    return { kind: 'branch', value: `refs/heads/${name}`, label: name }
  }
  // Detached HEAD: fall back to whatever origin advertises as its default.
  const symref = await runGit(git, ['ls-remote', '--symref', 'origin', 'HEAD'], dir)
  const match = symref.stdout.match(/ref:\s*(refs\/heads\/\S+)\s+HEAD/)
  if (symref.code === 0 && match) {
    return { kind: 'branch', value: match[1], label: match[1].replace('refs/heads/', '') }
  }
  return { kind: 'head', value: 'HEAD', label: 'HEAD' }
}

/**
 * Parse `git status --porcelain=v2 --branch` output into plain counts.
 *
 * One call answers both local questions the panel shows: what is uncommitted, and
 * how far the branch is from its upstream. The `--branch` header carries the
 * ahead/behind numbers, so this stays a single process per repository.
 *
 * `ahead`/`behind` are `null` when the branch has no upstream — "unknown" is not
 * "zero", and the UI must be able to tell those apart.
 */
function parseLocalStatus(text) {
  const out = {
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
    detached: false,
    modified: 0,
    untracked: 0,
    conflicted: 0,
  }
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      out.detached = head === '(detached)'
      out.branch = out.detached ? null : head
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice('# branch.upstream '.length).trim()
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /^\+(\d+) -(\d+)$/.exec(line.slice('# branch.ab '.length).trim())
      if (match) {
        out.ahead = Number(match[1])
        out.behind = Number(match[2])
      }
      continue
    }
    if (line.startsWith('#')) continue
    if (line.startsWith('? ')) {
      out.untracked += 1
      continue
    }
    if (line.startsWith('u ')) {
      // Unmerged entry: conflicted files are the most urgent kind of dirty.
      out.conflicted += 1
      out.modified += 1
      continue
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      out.modified += 1
      continue
    }
  }
  return out
}

/**
 * Local state of one repository, or `null` when it cannot be read.
 *
 * Read-only and local: no fetch, no lock. Submodule gitlink lag is ignored — a
 * submodule pointing at a different commit than the index is not the user's edit
 * and would otherwise mark repositories with submodules permanently dirty.
 */
async function readLocalStatus(git, dir) {
  const res = await runGit(
    git,
    ['status', '--porcelain=v2', '--branch', '--ignore-submodules=all'],
    dir,
  )
  if (res.code !== 0) return null
  return parseLocalStatus(res.stdout)
}

/**
 * The local-work flags the panel shows, derived from the raw status counts.
 *
 * `unpushed` is measured against the *remote-tracking* ref, i.e. exactly what
 * `git status` tells the user in a terminal. It can be stale (nothing here
 * fetches), which is why the UI says "未推送" and never claims a relationship with
 * the live remote — that comparison comes from `ls-remote` separately.
 *
 * `dirty` means **tracked** content changed — modified, staged, renamed, deleted
 * or conflicted. Untracked files are counted, never dirt: git protects them by
 * itself during a fast-forward (it refuses only when upstream adds a colliding
 * path), so they neither make an update unusable nor deserve a row of their own.
 * This is the same rule `skills-apply.cjs` blocks on (see "What 'dirty' means
 * here" there): the panel must not promise a skip the updater would not make, nor
 * hide a skip it would. `untrackedOnly` is the derived case that used to be mixed
 * into `dirty` — a repository whose only local content is untracked files — kept
 * as an explicit flag so the two can never be confused again.
 */
function localFlags(local) {
  if (local === null || local === undefined) return null
  const modified = Number(local.modified) || 0
  const untracked = Number(local.untracked) || 0
  const conflicted = Number(local.conflicted) || 0
  const ahead = Number.isFinite(local.ahead) ? Number(local.ahead) : null
  const behind = Number.isFinite(local.behind) ? Number(local.behind) : null
  return {
    // Conflicts are counted in `modified` by `parseLocalStatus`, so this covers
    // them too. Untracked entries deliberately do not.
    dirty: modified > 0,
    untrackedOnly: modified === 0 && untracked > 0,
    modified,
    untracked,
    conflicted,
    ahead,
    behind,
    unpushed: ahead !== null && ahead > 0,
    detached: local.detached === true,
    upstream: local.upstream ?? null,
  }
}

/**
 * Does this repository have anything the user should look at?
 *
 * Remote updates are the original reminder; uncommitted **tracked** work and
 * unpushed commits are added because both make a one-click update unusable on
 * that repository (it would be skipped), and silently skipping is worse than
 * saying why up front.
 *
 * Untracked files are not a reason for a row: a repository holding nothing but a
 * generated `output/` (the `picture-skills` case) is updatable, so a row with a
 * lone "未跟踪 N" chip and no button told the user something was wrong when
 * nothing was. When such a repository *does* get a row — the remote moved, or it
 * has unpushed commits — the untracked count is still shown as a chip: there it is
 * useful context ("this update will leave those files alone").
 */
function needsAttention(item) {
  if (item?.state === 'update') return true
  const flags = item?.flags
  if (!flags) return false
  return flags.dirty || flags.unpushed
}

/**
 * One repo's *remote* status. `state` is what the UI branches on:
 *   up-to-date | update | unreachable | unknown | skipped
 */
async function checkRemote(git, dir, name) {
  const local = await runGit(git, ['rev-parse', 'HEAD'], dir)
  if (local.code !== 0 || !SHA.test(local.stdout.trim())) {
    return { name, state: 'skipped', reason: '本地 HEAD 无法解析' }
  }
  const localSha = local.stdout.trim()

  const upstream = await resolveUpstreamRef(git, dir)
  const remote = await runGit(git, ['ls-remote', 'origin', upstream.value], dir)
  if (remote.code !== 0) {
    // Network/auth/ref-missing all land here; the message says which.
    const detail = remote.stderr.trim().split('\n')[0] || 'ls-remote 失败'
    return { name, state: 'unreachable', reason: detail, branch: upstream.label }
  }
  const first = remote.stdout.split('\n').map(line => line.trim()).find(Boolean) || ''
  const remoteSha = first.split(/[\s\t]+/)[0] || ''
  if (!SHA.test(remoteSha)) {
    // `kind: 'head'` returns the advertisement without a sha we can compare.
    return {
      name,
      state: 'unknown',
      reason: upstream.kind === 'head' ? '游离 HEAD，且远端未提供可比较的默认分支' : '远端未返回该分支',
      branch: upstream.label,
    }
  }
  if (remoteSha === localSha) {
    return { name, state: 'up-to-date', branch: upstream.label, localSha, remoteSha }
  }

  // Different sha. If the remote commit is already in the object store (a
  // previous fetch put it there) we can say exactly how far behind we are; if
  // not, we must not claim a number, only that upstream moved.
  const known = await runGit(git, ['cat-file', '-e', `${remoteSha}^{commit}`], dir)
  if (known.code !== 0) {
    return {
      name,
      state: 'update',
      behind: null,
      branch: upstream.label,
      localSha,
      remoteSha,
      reason: '远端有新提交（数量需 fetch 后才可知）',
    }
  }
  const behindResult = await runGit(git, ['rev-list', '--count', `${localSha}..${remoteSha}`], dir)
  const behind = Number(behindResult.stdout.trim())
  return {
    name,
    // A sha mismatch with `behind === 0` means the remote moved sideways or
    // backwards (force-push, local ahead). Not an update to offer.
    state: Number.isFinite(behind) && behind > 0 ? 'update' : 'diverged',
    behind: Number.isFinite(behind) ? behind : null,
    branch: upstream.label,
    localSha,
    remoteSha,
  }
}

/**
 * Everything known about one repository: the remote comparison plus the local
 * work state.
 *
 * Both probes are read-only and independent, so they run together — a slow
 * `ls-remote` no longer delays the "you have uncommitted work here" answer, and a
 * failed remote lookup still reports the local half instead of returning a bare
 * "unreachable".
 */
async function checkRepo(git, dir, name) {
  const [remote, local] = await Promise.all([
    checkRemote(git, dir, name),
    readLocalStatus(git, dir),
  ])
  const flags = localFlags(local)
  const item = { ...remote, flags }
  // `diverged` is the one state whose explanation depends on the local side: a
  // sha mismatch with nothing to pull means either "my commits are not pushed" or
  // "the remote rewrote history", and those want different words.
  if (item.state === 'diverged') {
    item.reason = flags?.unpushed
      ? '本地有远端没有的提交（也可能同时被改写过历史），不自动合并'
      : '远端与本地已分叉（远端可能重写过或回退过历史），需你亲自处理'
  }
  return item
}

/** Run `tasks` with at most `limit` in flight; never rejects. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      try {
        results[index] = await task(items[index], index)
      } catch (error) {
        results[index] = { state: 'unreachable', reason: String(error?.message ?? error) }
      }
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * The watcher.
 *
 * `emit(snapshot)` is called whenever the picture changes (check started,
 * finished, failed) so the UI can show a spinner and a timestamp. `onChange`
 * fires only when the *set of updatable skills* changes — that is the edge that
 * deserves a popup, not every periodic pass.
 *
 * It scans **every configured root** (see `resolveSkillsDirs` above), re-reading
 * the configuration at the start of each pass so a folder the user just added is
 * picked up without a restart. `snapshot.roots` describes the roots by basename
 * only and carries an `index`; the absolute paths stay here in `watcher.rootDirs`
 * because the renderer and the HTTP endpoint must never learn the layout.
 */
function createSkillsWatcher({
  log,
  emit,
  onChange,
  intervalMs,
  // Legacy single-root pin, kept working for callers that pass it.
  skillsDir,
  // Explicit list pin (tests, embedding). When set, the env/file/default merge
  // is skipped: a caller that says exactly which folders to scan means it.
  skillsDirs,
  configDir,
  env = process.env,
  stateDir,
}) {
  const pinned = (Array.isArray(skillsDirs) ? skillsDirs : [skillsDir || '']).filter(Boolean)
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS

  /**
   * Resolved roots for the current pass, index-aligned with `snapshot.roots`.
   * Each entry keeps the absolute `dir` (main process only) plus the `source` the
   * panel needs in order to know which roots are removable. `snapshot.roots` is
   * the path-free projection of the same list.
   */
  let rootList = []
  const asRoot = (dir, index, source) => ({
    index,
    dir,
    basename: skillsDirBasename(dir),
    source: source || 'config',
  })
  const toPublicRoots = list =>
    list.map((root, index) => ({ index, basename: root.basename, source: root.source }))

  /**
   * Resolve once for this pass. A pinned watcher (tests, embedding) means the
   * caller named exactly which folders to scan; those are reported as `config`
   * because from the panel's point of view they are someone's explicit choice.
   */
  const resolveRoots = () => {
    if (!pinned.length) return resolveSkillsDirs({ env, configDir })
    const dirs = [...new Set(pinned.map(dir => path.resolve(dir)))]
    return { dirs, roots: dirs.map((dir, index) => asRoot(dir, index, 'config')), warnings: [] }
  }

  /**
   * A number that changes exactly when the set of resolved roots changes.
   *
   * The panel has to be able to say "your edit to skills-dirs.json took effect",
   * and it never sees a path — while basenames are not unique (`D:\a\skills` and
   * `E:\b\skills` look identical from over there). This counter is the path-free
   * answer: it is bumped here, in the process that owns the paths, whenever the
   * resolved root list differs from the previous pass.
   */
  let rootsRevision = 0
  let rootsKey = null
  const adoptRoots = resolved => {
    const key = resolved.dirs.map(skillsDirKey).join('|')
    if (key !== rootsKey) {
      rootsKey = key
      rootsRevision += 1
    }
    rootList = resolved.roots
    return resolved
  }

  // A first snapshot needs *some* answer for the UI, so resolve once up front.
  const initial = adoptRoots(resolveRoots())

  let snapshot = {
    // First root, for the callers that predate multi-root.
    skillsDir: rootList[0]?.dir || '',
    roots: toPublicRoots(rootList),
    rootsRevision,
    warnings: initial.warnings,
    checking: false,
    // Until the first pass ends, the UI shows nothing rather than "0 updates",
    // which would read as a verified-clean answer we never gave.
    checked: false,
    items: [],
    updates: [],
    attention: [],
    lastCheckedAt: 0,
    error: null,
  }
  let git = null
  let gitResolved = false
  let running = null
  let firstTimer
  let loopTimer
  let stopped = false

  /**
   * The config file whose changes this watcher reacts to. Empty for a pinned
   * watcher: the caller named the folders, so no file can change what is scanned.
   */
  const watchFile = pinned.length ? '' : skillsDirsConfigPath(configDir)
  /**
   * "Did the user touch the file?" identity: mtime plus size, so an edit in place
   * and a rename-over-the-top are both seen. A missing file is a state of its own,
   * which is what lets the watcher notice the file being *created* later.
   */
  const configFingerprint = () => {
    if (!watchFile) return ''
    try {
      const stat = fs.statSync(watchFile)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return 'absent'
    }
  }
  let configTimer
  let configSeen = ''
  let configChanged = false
  let lastConfigCheckAt = 0

  const publish = patch => {
    snapshot = { ...snapshot, ...patch }
    try {
      emit?.(snapshot)
    } catch (error) {
      log?.warn?.(`[skills] emit 失败: ${String(error?.message ?? error)}`)
    }
    return snapshot
  }

  /**
   * Every git folder under every configured root, flattened — root-itself
   * repositories included, one entry per real path (`collectSkillRepos`).
   * Returns `{ repos, roots, warnings, allMissing }` — `repos` items already
   * carry their root index, display name and absolute `dir`.
   */
  const collectRepos = () => {
    const resolved = adoptRoots(resolveRoots())
    const { dirs, warnings } = resolved

    const { repos, missing: missingCount, truncated } = collectSkillRepos(dirs)
    if (truncated) {
      warnings.push(`技能仓库数量超过 ${MAX_REPOS} 个，其余未检查`)
      log?.warn?.(`[skills] 超过 ${MAX_REPOS} 个候选仓库，其余本轮跳过`)
    }
    // Unique per root; the display name (with the `(root)` suffix on a clash) is
    // assigned only after the *whole* multi-root list exists, otherwise two same
    // names in different roots would both claim the bare name.
    const decorated = assignSkillDisplays(repos)
    return {
      repos: decorated,
      roots: toPublicRoots(rootList),
      rootsRevision,
      warnings,
      allMissing: dirs.length > 0 && missingCount === dirs.length,
    }
  }

  /** Full pass. Concurrent callers share one in-flight pass. */
  const check = () => {
    if (running) return running
    const task = (async () => {
      if (!gitResolved) {
        git = await resolveGit(log)
        gitResolved = true
      }
      if (git === null) {
        // Roots are resolved even here: the user may have just edited the config,
        // and the panel has to show the folders it now holds whether or not git
        // could be found. Stale rows are cleared with them.
        const resolved = adoptRoots(resolveRoots())
        publish({
          checking: false,
          checked: true,
          roots: toPublicRoots(rootList),
          rootsRevision,
          warnings: resolved.warnings,
          lastCheckedAt: Date.now(),
          error: '未找到 git，无法检查技能仓库更新',
          items: [],
          updates: [],
          attention: [],
        })
        return snapshot
      }

      const { repos, roots, warnings, allMissing } = collectRepos()
      if (repos.length === 0) {
        // Nothing to scan. A missing root is named by its basename only — the
        // full path stays in the log, never in the UI payload.
        // (`dirs` is local to collectRepos; the basenames come from `roots`.)
        if (allMissing) log?.warn?.(`[skills] 技能目录均不存在: ${roots.map(r => r.basename).join(' | ')}`)
        publish({
          checking: false,
          checked: true,
          roots,
          rootsRevision,
          warnings,
          lastCheckedAt: Date.now(),
          error: allMissing
            ? roots.length === 1
              ? `技能目录不存在：${roots[0].basename}`
              : `${roots.length} 个技能目录都不存在（${roots.map(r => r.basename).join('、')}）`
            : null,
          items: [],
          // Empty on purpose: after a config edit removes the last root there is
          // no repository left to keep a row for, and a stale row would outlive
          // the folder it names.
          updates: [],
          attention: [],
        })
        return snapshot
      }

      publish({ checking: true, error: null, roots, rootsRevision, warnings })
      log?.debug?.(
        `[skills] 检查 ${repos.length} 个技能仓库（${roots.length} 个目录: ${roots.map(r => r.basename).join(' | ')}）`,
      )

      const results = await mapLimit(repos, CONCURRENCY, repo =>
        checkRepo(git, repo.dir, repo.name).then(status => ({
          ...status,
          name: repo.name,
          display: repo.display,
          key: repo.key,
          root: repo.root,
          rootIndex: repo.rootIndex,
          path: repo.dir,
        })),
      )

      const updates = results
        .filter(item => item.state === 'update')
        .sort((a, b) => (b.behind ?? 0) - (a.behind ?? 0) || a.display.localeCompare(b.display))
      // Everything worth showing a row for: remote updates (the original reminder)
      // plus repositories carrying uncommitted or unpushed work — the two states
      // that make an automatic update skip, so they are exactly what the user
      // needs to see *before* clicking. `updates` stays the narrower list that
      // 「全部更新」 acts on.
      const attention = results
        .filter(needsAttention)
        .sort((a, b) => {
          const rank = item => (item.state === 'update' ? 0 : item.flags?.conflicted ? 1 : item.flags?.dirty ? 2 : 3)
          return rank(a) - rank(b) || a.display.localeCompare(b.display)
        })
      const failed = results.filter(item => item.state === 'unreachable' || item.state === 'diverged')

      const next = publish({
        checking: false,
        checked: true,
        roots,
        rootsRevision,
        items: results,
        updates,
        attention,
        lastCheckedAt: Date.now(),
        error:
          failed.length === results.length && results.length > 0
            ? `全部 ${results.length} 个技能仓库都连不上远端（离线或凭据失效）`
            : null,
      })
      log?.debug?.(
        `[skills] 完成：${updates.length} 个可更新 / ${attention.length} 个待处理 / ${results.length} 个仓库` +
          (failed.length ? `，${failed.length} 个异常` : '') +
          (warnings.length ? `，${warnings.length} 条配置警告` : ''),
      )
      try {
        onChange?.(next)
      } catch (error) {
        log?.warn?.(`[skills] onChange 失败: ${String(error?.message ?? error)}`)
      }
      return next
    })()

    running = task
    const clear = () => {
      running = null
    }
    task.then(clear, clear)
    return task
  }

  /**
   * Notice a change to `skills-dirs.json` and start a pass for it.
   *
   * Without this the file was only read when a pass happened, and passes are six
   * hours apart: the user edited the config, looked at the panel, and saw nothing
   * — which reads as "adding that folder did nothing". One 1 Hz `stat` closes the
   * gap within about a second, and because the fingerprint is taken from the
   * *path*, an editor's atomic replace is seen like any other write. A file that
   * does not exist yet is remembered as `absent`, so creating it later counts as
   * a change too.
   */
  const pollConfigFile = () => {
    if (stopped || !watchFile) return
    const fingerprint = configFingerprint()
    if (fingerprint !== configSeen) {
      configSeen = fingerprint
      configChanged = true
      log?.debug?.('[skills] skills-dirs.json 有变动，稍后重查')
    }
    if (!configChanged) return
    const now = Date.now()
    // Debounce, not a drop: a suppressed change stays pending until the window
    // passes, so a burst of writes still produces exactly one pass.
    if (now - lastConfigCheckAt < CONFIG_DEBOUNCE_MS) return
    configChanged = false
    lastConfigCheckAt = now
    void check()
  }

  const start = () => {
    if (stopped) return
    firstTimer = setTimeout(() => {
      firstTimer = undefined
      void check()
      loopTimer = setInterval(() => void check(), period)
      loopTimer.unref?.()
    }, FIRST_DELAY_MS)
    firstTimer.unref?.()
    if (watchFile) {
      // Baseline before the first tick: a file that is already there and has not
      // changed must not trigger anything, only a change (or a first appearance)
      // afterwards.
      configSeen = configFingerprint()
      configTimer = setInterval(pollConfigFile, CONFIG_POLL_MS)
      // Never hold the process open: this is a background convenience, not a
      // reason for Electron to stay alive.
      configTimer.unref?.()
    }
  }

  const stop = () => {
    stopped = true
    if (firstTimer !== undefined) clearTimeout(firstTimer)
    if (loopTimer !== undefined) clearInterval(loopTimer)
    if (configTimer !== undefined) clearInterval(configTimer)
    firstTimer = undefined
    loopTimer = undefined
    configTimer = undefined
    configChanged = false
  }

  return {
    start,
    stop,
    check,
    getSnapshot: () => snapshot,
    // Root metadata with absolute `dir` — main-process only. The renderer and
    // HTTP get `roots` (index/basename/source) from the snapshot, never these.
    getRoots: () => rootList.map(root => ({ ...root })),
    // Absolute paths — main-process only. The renderer and HTTP get `roots`
    // (basenames) from the snapshot, never these.
    get rootDirs() {
      return rootList.map(root => root.dir)
    },
    /** Legacy accessor: the first configured root. */
    get skillsDir() {
      return rootList[0]?.dir || ''
    },
    /** Absolute path of the multi-dir config file, for logs only. */
    configFile: watchFile,
    stateFile: stateDir ? path.join(stateDir, '.dsh-credit-float-skills.json') : '',
  }
}

/** Read the persisted "already told the user about" record, or null. */
function readState(watcher) {
  if (!watcher.stateFile) return null
  try {
    const raw = JSON.parse(fs.readFileSync(watcher.stateFile, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return raw
  } catch {
    return null
  }
}

function writeState(watcher, value) {
  if (!watcher.stateFile) return
  try {
    // The helper's state folder may not exist yet on a first run, and a failed
    // write here only costs a duplicate popup — never a crash.
    fs.mkdirSync(path.dirname(watcher.stateFile), { recursive: true })
    fs.writeFileSync(watcher.stateFile, JSON.stringify(value), 'utf8')
  } catch {
    /* best-effort dedup: losing it means at most one duplicate popup */
  }
}

/**
 * A pass may re-announce the same pending update forever, so the cadence needs
 * a rule rather than a flag.
 *
 * The distinction that matters to the user is *new information*: a skill that
 * just became updatable is worth interrupting for, while the same set of skills
 * merely having more commits upstream is not — that is the state they already
 * chose to live with, and re-toasting an active repository every few hours is
 * how reminders get disabled outright. So: announce on a new name, otherwise
 * wait out the quiet period.
 */
const RE_ANNOUNCE_MS = 24 * 60 * 60 * 1000

/**
 * The display identity of one update: `name (root)` when two roots carry the same
 * folder name, the bare folder name otherwise (see `assignSkillDisplays`). Every
 * reminder decision is keyed on this, so two same-named repos in different roots
 * cannot silence each other.
 */
function skillKey(item) {
  return item?.key || item?.display || item?.name || ''
}

function shouldAnnounce({ stored, snapshot, now = Date.now(), quietMs = RE_ANNOUNCE_MS }) {
  const updates = snapshot?.updates ?? []
  if (updates.length === 0) return false
  const names = updates.map(skillKey).sort().join('|')
  if (!stored || typeof stored.names !== 'string') return true
  if (stored.names !== names) return true
  const at = Number(stored.at)
  if (!Number.isFinite(at)) return true
  return now - at >= quietMs
}

function describeAnnouncement(snapshot) {
  const updates = snapshot?.updates ?? []
  const shown = updates.slice(0, 4).map(skillKey)
  const known = updates.reduce((sum, item) => sum + (Number.isFinite(item.behind) ? item.behind : 0), 0)
  return {
    title: `${updates.length} 个技能仓库有远端更新`,
    body:
      shown.join('、') +
      (updates.length > shown.length ? ` 等 ${updates.length} 个` : '') +
      (known > 0 ? `：本地共落后 ${known} 个提交` : '：远端有新提交'),
  }
}

module.exports = {
  createSkillsWatcher,
  readState,
  writeState,
  shouldAnnounce,
  describeAnnouncement,
  defaultSkillsDir,
  // Directory configuration (pure, tested in test/skills-dirs.test.cjs and
  // test/skills-dirs-ui.test.cjs).
  parseSkillsDirsEnv,
  normalizeSkillsDir,
  skillsDirKey,
  skillsDirBasename,
  readSkillsDirsConfig,
  writeSkillsDirsConfig,
  skillsDirsConfigPath,
  resolveSkillsDirs,
  removeSkillsDir,
  skillsRootRemovalBlocker,
  planSkillsDirRemoval,
  assignSkillDisplays,
  skillKey,
  listGitRepos,
  listGitRepoEntries,
  collectSkillRepos,
  SKILLS_DIRS_CONFIG,
  // exported for tests
  checkRepo,
  checkRemote,
  parseLocalStatus,
  localFlags,
  needsAttention,
  readLocalStatus,
  resolveUpstreamRef,
  runGit,
  escapeBareBackslashes,
}
