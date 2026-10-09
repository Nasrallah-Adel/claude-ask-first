// ask-first: holds the tool calls people keep having to undo, and refuses the
// ones that could lock them out of their own machines.
//
// Holds (Proceed / Cancel via $.ui.ask, skipped when the prompt or the slash
// command asked for it): git commit, git push, gh pr merge, gh pr create
// against a protected branch in a protected repo, and any write to a
// .claude/settings*.json. Refuses outright: deleting or emptying sudoers,
// authorized_keys or sshd_config, and account changes that remove a protected
// user's access.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so hooks are
// inline arrows and every helper that takes `$` is a top-level function.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AskFirstIntent } from '../types'
import { ACCESS_PATH, SETTINGS_PATH, classify } from './classify'
import type { Finding } from './classify'
import { DEFAULT_CONFIG, configFrom } from './config'
import type { GuardConfig } from './config'
import { EMPTY_INTENT, intentFromCommand, intentFromPrompt, isAffirmation, mergeIntent } from './intent'

const NAME = 'ask-first'
const PAUSED_KEY = 'isPaused'
const PROCEED = 'Proceed'
const CANCEL = 'Cancel'
const DO_NOT_RETRY = 'Do not retry it unless the user asks you to.'
const MAX_SHOWN = 300
const FAILED = `${NAME}: its guard failed or the question was dismissed, so the call did not run. ${DO_NOT_RETRY}`

const intent = atom({ plugin: 'ask-first', key: 'intent' } as const, EMPTY_INTENT)

type Hold = { what: string; grants: Partial<AskFirstIntent> }
type Deny = { deny: string }

// Set by register() from userConfig; a reload runs register() again.
let config: GuardConfig = DEFAULT_CONFIG
// The configured protected users, or $USER when none are configured; read at session.start.
let protectedUsers: readonly string[] = []

export const register: Register = (on, options) => {
  config = configFrom(options)
  protectedUsers = config.protectedUsers

  on('session.start', async ($, e, next) => {
    if (config.protectedUsers.length === 0) {
      const user = await $.env.get('USER')
      protectedUsers = user === undefined || user === '' ? [] : [user]
    }
    await $.command.register({
      name: 'guard',
      description: `${NAME}: show what this turn is allowed to do; "off" pauses the holds, "on" resumes them`,
      argumentHint: '[on|off]',
    })
    return next(e)
  })

  on('command.run', ($, e, next) => grantForCommand($, e.command, () => next(e)))
  on('command.run', { command: 'guard' }, ($, e) => runGuardCommand($, e.args))

  on('prompt.submit', async ($, e, next) => {
    if (!isAffirmation(e.text)) {
      await update($, intent, () => intentFromPrompt(e.text))
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => guardShell($, e.command, () => next(e))).catch(($, e, next) =>
    next.called ? next(e) : { deny: FAILED },
  )
  on('tool.call', { tool: 'Edit' }, ($, e, next) => guardFile($, e.file_path, () => next(e))).catch(($, e, next) =>
    next.called ? next(e) : { deny: FAILED },
  )
  on('tool.call', { tool: 'Write' }, ($, e, next) => guardFile($, e.file_path, () => next(e))).catch(($, e, next) =>
    next.called ? next(e) : { deny: FAILED },
  )
}

function accessRule(): string {
  const who = protectedUsers.length === 0 ? 'the owner' : protectedUsers.join(' / ')
  return `Rule: never remove ${who}'s own root, sudo or SSH access on any machine.`
}

/** `/guard`, `/guard on`, `/guard off`. */
async function runGuardCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const arg = args.trim().toLowerCase()
  if (arg === 'off') {
    await $.store.set(PAUSED_KEY, true)
    return { text: `${NAME} paused: commits, pushes, PRs and settings edits are not held. Access-loss commands are still refused. /guard on resumes.` }
  }
  if (arg === 'on') {
    await $.store.set(PAUSED_KEY, false)
    return { text: `${NAME} active.` }
  }
  const current = await read($, intent)
  const paused = await isPaused($)
  const allowed = (['commit', 'push', 'pr', 'merge', 'settings'] as const).filter(k => current[k]).join(', ')
  const repos = config.protectedRepo === null ? 'off (set "Protected repos" in /config)' : `${config.protectedRepoPattern} → ${[...config.protectedBranches].join(', ')}`
  return {
    text: [
      `${NAME}: ${paused ? 'paused (/guard on resumes)' : 'active'}`,
      `This turn may: ${allowed === '' ? 'nothing unasked' : allowed}${current.source === '' ? '' : ` (${current.source})`}`,
      `Held unless asked: git commit, git push, gh pr merge, writes to .claude/settings*.json. PR-base hold: ${repos}.`,
      `Refused always: deleting or emptying sudoers / authorized_keys / sshd_config; removing ${protectedUsers.length === 0 ? '(no user configured)' : protectedUsers.join(', ')} from sudo, groups or login.`,
      `Ship commands: ${[...config.shipCommands].map(c => `/${c}`).join(' ')}. Settings commands: ${[...config.settingsCommands].map(c => `/${c}`).join(' ')}.`,
    ].join('\n'),
  }
}

/** A slash command that implies commits, pushes or settings edits grants them for its turn. */
async function grantForCommand<R>($: EngineInterface, command: string, run: () => Promise<R>): Promise<R> {
  const grant = intentFromCommand(command, config)
  if (grant !== null) {
    await update($, intent, current => mergeIntent(current, grant))
  }
  return run()
}

/** The Bash guard: refuse access-loss commands, hold the unasked rest. */
async function guardShell<R>($: EngineInterface, command: string, run: () => Promise<R>): Promise<R | Deny> {
  const findings = classify(command, protectedUsers)
  if (findings.length === 0) return run()

  const reasons = findings.flatMap(f => (f.kind === 'access-deny' ? [f.reason] : []))
  if (reasons.length > 0) {
    $.ui.toast(`${NAME}: refused ${reasons.join('; ')}`)
    return { deny: `${NAME} refused this command: ${reasons.join('; ')}. ${accessRule()} ${DO_NOT_RETRY}` }
  }
  if (await isPaused($)) return run()

  const holds = await holdsFor($, findings, await read($, intent))
  if (holds.length === 0) return run()
  return hold($, holds, command, run)
}

/** The Edit / Write guard: refuse access files, hold unasked settings edits. */
async function guardFile<R>($: EngineInterface, filePath: string, run: () => Promise<R>): Promise<R | Deny> {
  const path = await resolvePath($, filePath)
  if (ACCESS_PATH.test(path)) {
    $.ui.toast(`${NAME}: refused edit of ${path}`)
    return { deny: `${NAME} refused editing ${path} with this tool. ${accessRule()} ${DO_NOT_RETRY}` }
  }
  if (!config.holdSettings || !SETTINGS_PATH.test(path)) return run()
  if (await isPaused($)) return run()
  if ((await read($, intent)).settings) return run()
  return hold($, [{ what: `edit ${path} (a settings edit reloads the harness mid-turn)`, grants: { settings: true } }], path, run)
}

/** Which of the findings need a Proceed / Cancel, given what the user asked for. */
async function holdsFor($: EngineInterface, findings: readonly Finding[], current: AskFirstIntent): Promise<readonly Hold[]> {
  const holds: Hold[] = []
  for (const f of findings) {
    if (f.kind === 'git-commit' && config.holdCommits && !current.commit) {
      holds.push({ what: 'git commit', grants: { commit: true } })
    }
    if (f.kind === 'git-push' && config.holdCommits && !current.push) {
      holds.push({ what: f.isForce ? 'git push --force' : 'git push', grants: { push: true } })
    }
    if (f.kind === 'gh-pr-merge' && config.holdCommits && !current.merge && !current.push) {
      holds.push({ what: 'gh pr merge', grants: { merge: true } })
    }
    if (f.kind === 'gh-pr-create' && !current.pr && (await targetsProtectedBranch($, f.base))) {
      holds.push({ what: `open a PR against ${f.base ?? 'the default branch'} (a protected branch of this repo)`, grants: { pr: true } })
    }
    if (f.kind === 'settings-write' && config.holdSettings && !current.settings) {
      holds.push({ what: `write ${f.path} (a settings edit reloads the harness mid-turn)`, grants: { settings: true } })
    }
    if (f.kind === 'access-hold') {
      holds.push({ what: `${f.reason} (this could lock you out)`, grants: {} })
    }
  }
  return holds
}

async function targetsProtectedBranch($: EngineInterface, base: string | null): Promise<boolean> {
  if (config.protectedRepo === null) return false
  if (base !== null && !config.protectedBranches.has(base)) return false
  try {
    const repo = await $.session.repo()
    return config.protectedRepo.test(repo?.remote ?? '')
  } catch {
    return true
  }
}

/** Asks Proceed / Cancel, showing the exact call; logs the answer; Proceed runs the call and grants its flags for the turn. */
async function hold<R>($: EngineInterface, holds: readonly Hold[], detail: string, run: () => Promise<R>): Promise<R | Deny> {
  const what = holds.map(h => h.what).join('; ')
  const shown = shorten(detail)
  $.ui.status(`${NAME}: waiting on you`)
  try {
    const answer = await $.ui.ask(`${NAME}: Claude is about to ${what}, which you did not ask for this turn.\n\n${shown}\n\nProceed?`, {
      options: [PROCEED, CANCEL],
      header: 'Ask first',
    })
    if (answer !== PROCEED) {
      $.ui.log(`${NAME}: you rejected ${what}: ${shown}`)
      $.ui.toast(`${NAME}: rejected ${what}`)
      return { deny: `${NAME} held "${what}": the user pressed Cancel. ${DO_NOT_RETRY}` }
    }
    $.ui.log(`${NAME}: you approved ${what}: ${shown}`)
    $.ui.toast(`${NAME}: approved ${what}`)
    const grants = holds.reduce<Partial<AskFirstIntent>>((all, h) => ({ ...all, ...h.grants }), {})
    await update($, intent, current => mergeIntent(current, { ...grants, source: `${current.source} + Proceed` }))
    return run()
  } finally {
    $.ui.status(undefined)
  }
}

/** The call as shown in the dialog and the log: one trimmed string, cut at MAX_SHOWN characters. */
function shorten(detail: string): string {
  const trimmed = detail.trim()
  return trimmed.length <= MAX_SHOWN ? trimmed : `${trimmed.slice(0, MAX_SHOWN)}…`
}

async function isPaused($: EngineInterface): Promise<boolean> {
  return (await $.store.get(PAUSED_KEY)) === true
}

/** `~` expanded and symlinks followed where the file exists, else the path as spelled. */
async function resolvePath($: EngineInterface, path: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const spelled = path.startsWith('~/') && home !== '' ? `${home}${path.slice(1)}` : path
  try {
    const stat = await $.fs.stat(spelled, { resolve: true })
    return stat.realPath ?? spelled
  } catch {
    return spelled
  }
}
