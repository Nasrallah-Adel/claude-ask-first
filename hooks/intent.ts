// What the user asked for this turn, read from their prompt or the slash
// command they ran. A guard lets a tool call through when the matching flag is
// set, so "commit this" is never held and a stray commit always is.
import type { AskFirstIntent as Intent } from '../types'
import type { GuardConfig } from './config'

export const EMPTY_INTENT: Intent = {
  commit: false,
  push: false,
  pr: false,
  merge: false,
  settings: false,
  source: '',
}

const COMMIT = /\bcomm?its?\b/i
const PUSH = /\bpush(ed|es|ing)?\b|\bship\b/i
const PR_VERB = '(make|create|open|ship|raise|submit|send)'
const PR_NOUN = "(prs?'?s?|pull[- ]requests?)"
const PR = new RegExp(`\\b${PR_VERB}\\b[^.\\n]{0,40}\\b${PR_NOUN}\\b|\\b${PR_NOUN}\\b[^.\\n]{0,40}\\b${PR_VERB}\\b`, 'i')
const MERGE = /\bmerge[sd]?\b/i
const SETTINGS = /settings(\.local)?\.json|\bstatus ?line\b|\bhooks?\b|\bpermissions?\b|allowed ?tools|pluginConfigs|claude (code )?settings|settings file|\/config\b/i

// Short replies that continue the previous ask rather than start a new one:
// "yes", "ok", "continue", a lettered or numbered option, and the Arabic
// keyboard-layout spellings of "yes" and "next" typed on a QWERTY layout.
const AFFIRMATION = /^\s*(y|yes|yep|yeah|ok|okay|sure|go|go ahead|do it|proceed|continue|next|done|yes please|ok go|غثس|ثءهف|[a-h]|[1-4])\s*[.!]?\s*$/i
const AFFIRMATION_MAX_LENGTH = 25

/** The intent a freshly typed prompt carries. */
export function intentFromPrompt(text: string): Intent {
  const head = text.trim().slice(0, 60).replace(/\s+/g, ' ')
  const pr = PR.test(text)
  return {
    commit: COMMIT.test(text),
    push: PUSH.test(text) || pr,
    pr,
    merge: MERGE.test(text),
    settings: SETTINGS.test(text),
    source: head === '' ? '' : `prompt: ${head}`,
  }
}

/** True for a reply that answers a question rather than asking for new work. */
export function isAffirmation(text: string): boolean {
  return text.length <= AFFIRMATION_MAX_LENGTH && AFFIRMATION.test(text)
}

/** The flags a slash command grants for the turn it starts, or null for one that grants none. */
export function intentFromCommand(command: string, config: GuardConfig): Partial<Intent> | null {
  if (config.shipCommands.has(command)) {
    return { commit: true, push: true, pr: true, merge: true, source: `command: /${command}` }
  }
  if (config.settingsCommands.has(command)) {
    return { settings: true, source: `command: /${command}` }
  }
  return null
}

/** A new intent with `grant`'s true flags added to `base`. */
export function mergeIntent(base: Intent, grant: Partial<Intent>): Intent {
  return {
    commit: base.commit || grant.commit === true,
    push: base.push || grant.push === true,
    pr: base.pr || grant.pr === true,
    merge: base.merge || grant.merge === true,
    settings: base.settings || grant.settings === true,
    source: grant.source ?? base.source,
  }
}
