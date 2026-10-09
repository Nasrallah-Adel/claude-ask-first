# ask-first

A Claude Code mod that makes Claude ask before doing the things you did not ask for, and refuses the few that could lock you out of your own machines.

It grew out of the corrections one developer kept typing: "why did you commit, I said don't", "why a PR from main", "every time you edit settings you disconnect yourself", and a standing rule never to drop their own SSH or sudo access on a remote box. Each of those is now a Proceed / Cancel question or a refusal, and each hold goes away the moment your prompt asks for the action.

## What it does

| Call | Without you asking | After you asked (prompt or command) |
|---|---|---|
| `git commit`, `git push` (force too), `gh pr merge` | Proceed / Cancel question | runs |
| `gh pr create` against a protected branch in a protected repo | Proceed / Cancel question | runs |
| Edit, Write or shell write to any `.claude/settings.json` / `settings.local.json` | Proceed / Cancel question | runs |
| Shell edit or append (`sed -i`, `visudo`, `tee -a`, `>>`) to `authorized_keys`, `sudoers`, `sshd_config`; `ufw` / `iptables` rules with no allow for port 22 in the same command | Proceed / Cancel question | Proceed / Cancel question |
| Delete, move or empty `sudoers`, `authorized_keys`, `sshd_config` (`rm`, `mv`, `>`, `tee` without `-a`) or the Edit / Write tool on them; `deluser` / `userdel` / `gpasswd -d` / `usermod -G` (no `-a`) / `passwd -l` / `chage -E` on a protected user, locally or inside `ssh host '...'` and `bash -c '...'` | refused | refused |

"Asked" means the prompt that started the turn mentions it (commit, push, ship, make/open a PR, merge, settings/hooks/statusline/permissions) or the turn was started by one of the configured ship or settings commands. A short reply ("yes", "ok", "continue", a lettered option) keeps the previous prompt's intent. Pressing Proceed grants that action for the rest of the turn, so one question covers a commit followed by an amend.

A refusal tells the model why and not to retry, so the turn continues with the rest of the work.

## Configuration

Every option is a row in `/config`. Nothing is tied to one user or company.

| Option | Default | Meaning |
|---|---|---|
| Hold git commit / push / gh pr merge | on | The commit, push and merge holds |
| Hold .claude/settings*.json edits | on | The settings-file hold |
| Protected PR base branches | `main,master` | Branches a `gh pr create` may not target unasked |
| Protected repos (regex on origin URL) | empty | Empty turns the PR-base hold off; `.*` covers every repo; `myorg/` covers one org |
| Accounts whose access must never be removed | empty | Empty uses `$USER`; a comma list names several |
| Commands that imply commit, push and PR | `ship-pr,fast-ship-pr,edit-pr` | Slash commands whose turn may commit, push and open PRs without a question |
| Commands that imply settings edits | `update-config,statusline,fewer-permission-prompts,config` | Slash commands whose turn may edit settings files |

- `/guard` shows whether the mod is active, what this turn may do, and the configuration in force.
- `/guard off` pauses the holds across sessions until `/guard on`. Refusals stay on.

If you also run the blast-radius mod, a force push gets both questions: this mod's push hold and blast-radius's measured report.

## Install

In a Claude Code terminal session:

```
/plugin install ask-first --marketplace Nasrallah-Adel/claude-ask-first
```

Answer `y` to add the marketplace, pick a scope, and set the options. Or clone this repo into `~/.claude/skills/ask-first`, where mods load on their own.

## Checking it

```
claude plugin validate .
claude plugin test .
```

The tests cover each guard, each allow path, every option, `/guard` and the `.catch` fallback.

## License

Apache-2.0. See NOTICE for the parts adapted from the blast-radius example in anthropics/claude-code-playground.
