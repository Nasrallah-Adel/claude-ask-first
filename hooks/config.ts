// The mod's options as register() receives them, parsed once into the shapes
// the guards read.
import type { PluginOptions } from 'claude-code'

export type GuardConfig = {
  holdCommits: boolean
  holdSettings: boolean
  /** PR base branches that are held in a protected repo. */
  protectedBranches: ReadonlySet<string>
  /** Matched against the origin remote; null turns the PR-base hold off. */
  protectedRepo: RegExp | null
  /** The pattern as configured, for display. */
  protectedRepoPattern: string
  /** Accounts whose access must never be removed; empty means "use $USER". */
  protectedUsers: readonly string[]
  /** Slash commands whose turn may commit, push, open and merge PRs. */
  shipCommands: ReadonlySet<string>
  /** Slash commands whose turn may edit .claude/settings*.json. */
  settingsCommands: ReadonlySet<string>
}

export const DEFAULT_SHIP_COMMANDS = 'ship-pr,fast-ship-pr,edit-pr'
export const DEFAULT_SETTINGS_COMMANDS = 'update-config,statusline,fewer-permission-prompts,config'
export const DEFAULT_BRANCHES = 'main,master'

export const DEFAULT_CONFIG: GuardConfig = {
  holdCommits: true,
  holdSettings: true,
  protectedBranches: parseList(DEFAULT_BRANCHES),
  protectedRepo: null,
  protectedRepoPattern: '',
  protectedUsers: [],
  shipCommands: parseList(DEFAULT_SHIP_COMMANDS),
  settingsCommands: parseList(DEFAULT_SETTINGS_COMMANDS),
}

/** The config the manifest's userConfig values describe, defaults filled in. */
export function configFrom(options: PluginOptions): GuardConfig {
  return {
    holdCommits: options.holdCommits !== false,
    holdSettings: options.holdSettings !== false,
    protectedBranches: parseList(stringOr(options.protectedBranches, DEFAULT_BRANCHES)),
    protectedRepo: regExpOrNull(stringOr(options.protectedRepoPattern, '')),
    protectedRepoPattern: stringOr(options.protectedRepoPattern, ''),
    protectedUsers: [...parseList(stringOr(options.protectedUsers, ''))],
    shipCommands: parseList(stringOr(options.shipCommands, DEFAULT_SHIP_COMMANDS)),
    settingsCommands: parseList(stringOr(options.settingsCommands, DEFAULT_SETTINGS_COMMANDS)),
  }
}

/** A comma-separated list as a set of trimmed, non-empty entries. */
export function parseList(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(',')
      .map(s => s.trim())
      .filter(s => s !== ''),
  )
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function regExpOrNull(source: string): RegExp | null {
  if (source.trim() === '') return null
  try {
    return new RegExp(source, 'i')
  } catch {
    return null
  }
}
