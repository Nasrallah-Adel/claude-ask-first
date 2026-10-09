// ask-first's state contract: the intent read from the current prompt, which
// the guards consult before holding a tool call.
export type AskFirstIntent = {
  /** The user asked for a commit this turn. */
  commit: boolean
  /** The user asked for a push, or ran a ship command. */
  push: boolean
  /** The user asked for a pull request to be created. */
  pr: boolean
  /** The user asked for a merge. */
  merge: boolean
  /** The user asked for a settings / hooks / statusline change. */
  settings: boolean
  /** Where the intent came from: a prompt's first words or a command's name. */
  source: string
}

declare module 'claude-code' {
  interface PluginState {
    'ask-first': { intent: AskFirstIntent }
  }
}
