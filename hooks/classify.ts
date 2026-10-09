// Reads a shell command line and names what ask-first cares about in it.
//
// The segment splitter, prefix stripping and git option walk are ported from
// the blast-radius mod (Apache-2.0), trimmed to what this mod gates. Like
// there, the split is crude on purpose: it also cuts inside quotes, so a
// command sent over `ssh host 'a && b'` is read segment by segment too.

export type Finding =
  | { kind: 'git-commit' }
  | { kind: 'git-push'; isForce: boolean }
  | { kind: 'gh-pr-create'; base: string | null }
  | { kind: 'gh-pr-merge' }
  | { kind: 'settings-write'; path: string }
  | { kind: 'access-deny'; reason: string }
  | { kind: 'access-hold'; reason: string }

export const SETTINGS_PATH = /(^|\/)\.claude\/settings(\.local)?\.json$/
export const ACCESS_PATH = /\/etc\/sudoers(\.d\/[^\s'"]*)?|authorized_keys|\/etc\/ssh\/sshd_config(\.d\/[^\s'"]*)?/


// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
// Words that can come before the real command without changing what it does.
const PREFIXES: ReadonlySet<string> = new Set(['command', 'exec', 'env', 'nohup', 'time', 'then', 'do', 'else', '!'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Commands that write the file they are given.
const FILE_WRITERS: ReadonlySet<string> = new Set(['tee', 'cp', 'mv', 'rm', 'truncate', 'install', 'ed', 'visudo'])
const INPLACE_EDITORS: ReadonlySet<string> = new Set(['sed', 'perl'])
// Of those, the ones that take an access file away outright, and the ones that edit it in place.
const FILE_REMOVERS: ReadonlySet<string> = new Set(['rm', 'mv', 'truncate', 'cp', 'install'])
const FILE_EDITORS: ReadonlySet<string> = new Set(['ed', 'visudo'])
const USER_REMOVERS: ReadonlySet<string> = new Set(['deluser', 'userdel'])
const SSH_ALLOW = /\ballow\b[^&|;\n]*\b(22|ssh|openssh)\b/i

/**
 * Every finding in `command`, in the order its segments run; `users` are the
 * accounts whose access must never be removed.
 */
export function classify(command: string, users: readonly string[]): readonly Finding[] {
  const segments = command.split(/&&|\|\||;|\||\n/)
  const found = segments.flatMap(segment => classifySegment(segment, command, users))
  return dedupe(found)
}

function dedupe(findings: readonly Finding[]): readonly Finding[] {
  const seen = new Set<string>()
  return findings.filter(f => {
    const key = JSON.stringify(f)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function classifySegment(raw: string, whole: string, users: readonly string[]): readonly Finding[] {
  const trimmed = raw.trim().replace(/^[({]+\s*/, '').replace(/\s*[)}]+$/, '')
  const words = stripPrefixes(tokenize(trimmed))
  const [first, ...args] = words
  if (first === undefined) return []
  const cmd = first.replace(/^\\/, '').replace(/^.*\//, '')
  const nested = nestedCommand(cmd, args)
  if (nested !== null) return classify(nested, users)
  return [
    ...gitFindings(cmd, args),
    ...ghFindings(cmd, args),
    ...settingsFindings(cmd, args, raw),
    ...accessFindings(cmd, args, raw, whole, users),
  ]
}

// ssh options that take a value, so the value isn't read as the host.
const SSH_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-p', '-l', '-i', '-o', '-J', '-F', '-L', '-R', '-D', '-W', '-b', '-c', '-e', '-m', '-O', '-Q', '-S', '-E', '-B', '-I', '-w'])
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

/** The command a `ssh host '...'` or `bash -c '...'` runs, so it is read like a local one; null otherwise. */
function nestedCommand(cmd: string, args: readonly string[]): string | null {
  if (cmd === 'ssh') {
    let i = 0
    while (i < args.length && (args[i] ?? '').startsWith('-')) {
      i += SSH_VALUE_OPTIONS.has(args[i] ?? '') ? 2 : 1
    }
    const remote = args.slice(i + 1)
    return remote.length === 0 ? null : remote.join(' ')
  }
  if (SHELLS.has(cmd)) {
    const at = args.findIndex(a => a === '-c' || /^-[a-zA-Z]*c$/.test(a))
    const script = at === -1 ? undefined : args[at + 1]
    return script === undefined ? null : script
  }
  return null
}

/** Drops VAR=value, sudo and its options, and the wrapper words before the command. */
function stripPrefixes(words: readonly string[]): readonly string[] {
  let rest = [...words]
  while (rest.length > 0 && ASSIGNMENT.test(rest[0] ?? '')) rest = rest.slice(1)
  if (rest[0] === 'sudo') {
    rest = rest.slice(1)
    while (rest.length > 0 && (rest[0] ?? '').startsWith('-')) {
      const option = rest[0] ?? ''
      rest = rest.slice(SUDO_VALUE_OPTIONS.has(option) ? 2 : 1)
    }
  }
  while (rest.length > 0 && (PREFIXES.has(rest[0] ?? '') || ASSIGNMENT.test(rest[0] ?? ''))) rest = rest.slice(1)
  return rest
}

/** `git commit`, `git push`; `-C dir` and `-c k=v` before the subcommand are skipped. */
function gitFindings(cmd: string, args: readonly string[]): readonly Finding[] {
  if (cmd !== 'git') return []
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    const option = args[i] ?? ''
    i += option === '-C' || option === '-c' ? 2 : 1
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (sub === 'commit') return [{ kind: 'git-commit' }]
  if (sub === 'push') {
    const isForce = rest.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || /^\+/.test(a))
    return [{ kind: 'git-push', isForce }]
  }
  return []
}

/** `gh pr create [--base X]` and `gh pr merge`. */
function ghFindings(cmd: string, args: readonly string[]): readonly Finding[] {
  if (cmd !== 'gh' || args[0] !== 'pr') return []
  if (args[1] === 'merge') return [{ kind: 'gh-pr-merge' }]
  if (args[1] !== 'create') return []
  return [{ kind: 'gh-pr-create', base: baseOf(args.slice(2)) }]
}

function baseOf(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? ''
    if (a === '--base' || a === '-B') return args[i + 1] ?? null
    if (a.startsWith('--base=')) return a.slice('--base='.length)
  }
  return null
}

/** A write to a `.claude/settings*.json`: by redirect, by a writing command, or by an in-place editor. */
function settingsFindings(cmd: string, args: readonly string[], raw: string): readonly Finding[] {
  const target = redirectTarget(raw)
  if (target !== null && SETTINGS_PATH.test(target)) return [{ kind: 'settings-write', path: target }]
  const named = args.find(a => SETTINGS_PATH.test(a))
  if (named === undefined) return []
  if (FILE_WRITERS.has(cmd)) return [{ kind: 'settings-write', path: named }]
  if (INPLACE_EDITORS.has(cmd) && args.some(a => /^-[a-zA-Z]*i/.test(a))) return [{ kind: 'settings-write', path: named }]
  return []
}

/** The file a `>` or `>>` in the segment writes to, or null. */
function redirectTarget(raw: string): string | null {
  const m = /(?:^|[^<>&\d])\d?>{1,2}\s*([^\s&|;]+)/.exec(raw)
  return m?.[1] ?? null
}

function isTruncatingRedirect(raw: string): boolean {
  return /(?:^|[^<>&\d])\d?>(?!>)\s*[^\s&|;]+/.test(raw)
}

/**
 * Changes that could drop the owner's own root, sudo or SSH access on a box:
 * removal, truncation or in-place editing of sudoers, authorized_keys or
 * sshd_config is refused; an append to them, or a firewall rule that may close
 * port 22, is held for a Proceed / Cancel.
 */
function accessFindings(cmd: string, args: readonly string[], raw: string, whole: string, users: readonly string[]): readonly Finding[] {
  const findings: Finding[] = []
  const accessFile = [...args, redirectTarget(raw) ?? ''].find(a => ACCESS_PATH.test(a))
  if (accessFile !== undefined) {
    // Removal and truncation cannot be undone from a locked-out box: refused.
    // An edit in place, a tee or an append may still be the asked-for work
    // (adding a key, turning off password auth): held for a Proceed / Cancel.
    const removes = FILE_REMOVERS.has(cmd)
    const redirectTruncates = isTruncatingRedirect(raw) && ACCESS_PATH.test(redirectTarget(raw) ?? '')
    const teeTruncates = cmd === 'tee' && !args.some(a => a === '-a' || a === '--append')
    const edits = (INPLACE_EDITORS.has(cmd) && args.some(a => /^-[a-zA-Z]*i/.test(a))) || FILE_EDITORS.has(cmd) || cmd === 'tee'
    const appends = /(?:^|[^>])>>\s*\S/.test(raw)
    if (removes || redirectTruncates || teeTruncates) {
      findings.push({ kind: 'access-deny', reason: `${cmd} removes or empties ${accessFile}` })
    } else if (edits || appends) {
      findings.push({ kind: 'access-hold', reason: `${edits ? 'edit' : 'append to'} ${accessFile}` })
    }
  }
  const user = users.find(u => args.includes(u) || args.some(a => a.endsWith(`:${u}`) || a.startsWith(`${u}:`)))
  if (user !== undefined) {
    if (USER_REMOVERS.has(cmd)) findings.push({ kind: 'access-deny', reason: `${cmd} on ${user}` })
    if (cmd === 'gpasswd' && args.includes('-d')) findings.push({ kind: 'access-deny', reason: `gpasswd -d on ${user}` })
    if (cmd === 'passwd' && args.some(a => a === '-l' || a === '--lock')) findings.push({ kind: 'access-deny', reason: `passwd lock on ${user}` })
    if (cmd === 'chage' && args.some(a => a === '-E' || a === '--expiredate')) findings.push({ kind: 'access-deny', reason: `chage -E on ${user}` })
    if (cmd === 'usermod' && usermodRemovesAccess(args)) findings.push({ kind: 'access-deny', reason: `usermod removes access from ${user}` })
    if (cmd === 'chsh' && args.some(a => /nologin|\/bin\/false/.test(a))) findings.push({ kind: 'access-deny', reason: `chsh to a no-login shell for ${user}` })
  }
  if (cmd === 'ufw' && !SSH_ALLOW.test(whole)) {
    const joined = args.join(' ')
    if (/^(--force\s+)?(reset|enable)\b|\bdeny\b[^&]*\b(22|ssh|openssh)\b|\bdelete\s+allow\b[^&]*\b(22|ssh|openssh)\b|\bdefault\s+deny\b/i.test(joined)) {
      findings.push({ kind: 'access-hold', reason: `ufw ${joined} with no allow for port 22 in the same command` })
    }
  }
  if (cmd === 'iptables' || cmd === 'ip6tables' || cmd === 'nft') {
    const joined = args.join(' ')
    if (/-P\s+INPUT\s+DROP|(^|\s)-F(\s|$)|--dport\s+22\b.*-j\s+(DROP|REJECT)|flush ruleset/i.test(joined)) {
      findings.push({ kind: 'access-hold', reason: `${cmd} ${joined} may close SSH` })
    }
  }
  return findings
}

function usermodRemovesAccess(args: readonly string[]): boolean {
  const appends = args.some(a => a === '-a' || a === '--append' || /^-[a-zA-Z]*a/.test(a))
  const setsGroups = args.some(a => a === '-G' || a === '--groups' || /^-[a-zA-Z]*G/.test(a))
  const locks = args.some(a => a === '-L' || a === '--lock' || a === '-e' || a === '--expiredate')
  const noLogin = args.some(a => /nologin|\/bin\/false/.test(a))
  return (setsGroups && !appends) || locks || noLogin
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
export function tokenize(text: string): readonly string[] {
  const words: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return words
}
