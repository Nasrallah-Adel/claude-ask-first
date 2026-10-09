// ask-first end to end through the engine's own kit: each guard, each allow
// path, the options, the /guard command and the .catch fallback.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Calls = { ran: string[]; edited: string[]; asks: string[]; toasts: string[]; logs: string[]; statuses: (string | undefined)[] }

type World = { answer: string; remote: string | null; askThrows: boolean; user: string }

const HOME = '/home/dev'
const PROTECTED_REPO = 'git@github.com:acme/payments.git'
const OTHER_REPO = 'git@github.com:dev/dotfiles.git'

function calls(): Calls {
  return { ran: [], edited: [], asks: [], toasts: [], logs: [], statuses: [] }
}

/** The engine beneath the plugin: Bash and Edit run and are recorded, the ask dialog answers from `world`. */
function fakeEngine(on: On, c: Calls, world: World) {
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: { command: 'guard' } }) as never)
  on('command.run', ($, e) => ({ text: `ran /${e.command}` }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text, origin: e.origin }) as never)
  on('session.repo', () => ({ value: world.remote === null ? null : { root: '/repo', remote: world.remote, internal: false, name: null } }) as never)
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: e.path } }) as never)
  on('ui.status', ($, e) => { c.statuses.push((e as { text?: string }).text); return { value: undefined } as never })
  on('ui.log', ($, e) => { c.logs.push((e as { text: string }).text); return { value: undefined } as never })
  on('ui.toast', ($, e) => { c.toasts.push((e as { text: string }).text); return { value: undefined } as never })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    c.asks.push(q)
    if (world.askThrows) throw new Error('dismissed')
    return { result: { answers: { [q]: world.answer } } } as never
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => { c.ran.push(e.command); return { result: { stdout: '', stderr: '', interrupted: false } } as never })
  on('tool.call', { tool: 'Edit' }, ($, e) => { c.edited.push(e.file_path); return { result: { filePath: e.file_path } } as never })
  on('tool.call', { tool: 'Write' }, ($, e) => { c.edited.push(e.file_path); return { result: { filePath: e.file_path } } as never })
  mock.env(on, { HOME, USER: world.user })
  mock.store(on)
}

const world = (over: Partial<World> = {}): World => ({ answer: 'Proceed', remote: PROTECTED_REPO, askThrows: false, user: 'dev', ...over })
const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
const prompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
const command = ($: Engine, name: string, args = '') => $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
const bash = ($: Engine, cmd: string) => $.tool.call({ tool: 'Bash', command: cmd })
const edit = ($: Engine, file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })

function setup(on: On, over: Partial<World> = {}) {
  const c = calls()
  fakeEngine(on, c, world(over))
  return c
}

const PROTECTED = { protectedRepoPattern: 'acme/' }

describe('git commit and push', () => {
  test('an unasked commit asks, Proceed runs it, and a second commit in the turn is not asked again', async ($, on) => {
    const c = setup(on)
    await start($)
    await prompt($, 'run the tests and fix the failures')
    await bash($, 'git add . && git commit -m "fix tests"')
    expect(c.asks.length).toBe(1)
    expect(c.asks[0]).toContain('git commit')
    expect(c.asks[0]).toContain('git add . && git commit -m "fix tests"')
    expect(c.logs).toEqual(['ask-first: you approved git commit: git add . && git commit -m "fix tests"'])
    expect(c.ran).toEqual(['git add . && git commit -m "fix tests"'])
    await bash($, 'git commit --amend --no-edit')
    expect(c.asks.length).toBe(1)
    expect(c.ran.length).toBe(2)
  })

  test('Cancel denies the commit with a reason the model can read', async ($, on) => {
    const c = setup(on, { answer: 'Cancel' })
    await start($)
    await prompt($, 'clean up the lint warnings')
    const out = await bash($, 'cd /repo && git commit -am wip')
    expect(out.deny).toContain('pressed Cancel')
    expect(c.ran).toEqual([])
    expect(c.toasts.some(t => t.includes('rejected'))).toBe(true)
    expect(c.asks[0]).toContain('cd /repo && git commit -am wip')
    expect(c.logs).toEqual(['ask-first: you rejected git commit: cd /repo && git commit -am wip'])
    expect(c.statuses.at(-1)).toBeUndefined()
  })

  test('a prompt that asks for the commit and push is not held', async ($, on) => {
    const c = setup(on)
    await start($)
    await prompt($, 'commit this and push it')
    await bash($, 'git commit -m done && git push origin HEAD')
    expect(c.asks).toEqual([])
    expect(c.ran.length).toBe(1)
  })

  test('a short affirmation keeps the previous intent', async ($, on) => {
    const c = setup(on)
    await start($)
    await prompt($, 'commit this when the tests pass')
    await prompt($, 'yes')
    await bash($, 'git commit -m done')
    expect(c.asks).toEqual([])
    await prompt($, 'now refactor the handler')
    await bash($, 'git commit -m refactor')
    expect(c.asks.length).toBe(1)
  })

  test('a ship command grants pushes and PRs for its turn', { options: PROTECTED }, async ($, on) => {
    const c = setup(on)
    await start($)
    await command($, 'ship-pr', 'feature-x')
    await bash($, 'git push -u origin feature-x-dev && gh pr create --base main --head feature-x-dev')
    expect(c.asks).toEqual([])
    expect(c.ran.length).toBe(1)
  })

  test('a custom ship command name grants the same', { options: { shipCommands: 'release,deploy-it' } }, async ($, on) => {
    const c = setup(on)
    await start($)
    await command($, 'deploy-it')
    await bash($, 'git push origin main')
    expect(c.asks).toEqual([])
    await prompt($, 'tidy the imports')
    await command($, 'ship-pr')
    await bash($, 'git commit -m x')
    expect(c.asks.length).toBe(1)
  })

  test('a force push is held like any push, and read-only git passes', async ($, on) => {
    const c = setup(on, { answer: 'Cancel' })
    await start($)
    await prompt($, 'what changed')
    const out = await bash($, 'git push --force origin x')
    expect(out.deny).toContain('pressed Cancel')
    expect(c.asks[0]).toContain('git push --force')
    await bash($, 'git status && git diff && git log --oneline -5')
    expect(c.ran.length).toBe(1)
  })

  test('git -C another dir push is still caught', async ($, on) => {
    const c = setup(on)
    await start($)
    await prompt($, 'sync the other checkout')
    await bash($, 'git -C ../other push')
    expect(c.asks.length).toBe(1)
    expect(c.asks[0]).toContain('git push')
  })
})

describe('gh pr create against a protected branch', () => {
  test('is held in a protected repo', { options: PROTECTED }, async ($, on) => {
    const c = setup(on, { answer: 'Cancel' })
    await start($)
    await prompt($, 'the branch is ready')
    const out = await bash($, 'gh pr create --base main --title x --body y')
    expect(out.deny).toContain('pressed Cancel')
    expect(c.asks[0]).toContain('against main')
  })

  test('another base passes, and main passes in a repo outside the pattern', { options: PROTECTED }, async ($, on) => {
    const c = setup(on, { remote: OTHER_REPO })
    await start($)
    await prompt($, 'the branch is ready')
    await bash($, 'gh pr create --base feature-x-dev --fill')
    await bash($, 'gh pr create --base main --fill')
    expect(c.asks).toEqual([])
    expect(c.ran.length).toBe(2)
  })

  test('with no pattern configured the PR-base hold is off', async ($, on) => {
    const c = setup(on)
    await start($)
    await prompt($, 'the branch is ready')
    await bash($, 'gh pr create --base main --fill')
    expect(c.asks).toEqual([])
  })

  test('.* protects every repo and protectedBranches picks the branches', { options: { protectedRepoPattern: '.*', protectedBranches: 'release' } }, async ($, on) => {
    const c = setup(on, { remote: OTHER_REPO, answer: 'Cancel' })
    await start($)
    await prompt($, 'the branch is ready')
    await bash($, 'gh pr create --base main --fill')
    expect(c.asks).toEqual([])
    const out = await bash($, 'gh pr create --base release --fill')
    expect(out.deny).toContain('pressed Cancel')
  })

  test('a prompt asking to open the PR is not held', { options: PROTECTED }, async ($, on) => {
    const c = setup(on)
    await start($)
    await prompt($, 'open a pr for this to main')
    await bash($, 'gh pr create --fill')
    expect(c.asks).toEqual([])
  })
})

describe('settings files', () => {
  test('an unasked Edit of ~/.claude/settings.json asks first', async ($, on) => {
    const c = setup(on, { answer: 'Cancel' })
    await start($)
    await prompt($, 'fix the failing lint')
    const out = await edit($, `${HOME}/.claude/settings.json`)
    expect(out.deny).toContain('pressed Cancel')
    expect(c.asks[0]).toContain('reloads the harness')
    expect(c.edited).toEqual([])
  })

  test('a settings command grants the edit, and any other file passes', async ($, on) => {
    const c = setup(on)
    await start($)
    await command($, 'update-config', 'allow npm')
    await edit($, '~/.claude/settings.json')
    await edit($, '/repo/src/main.go')
    expect(c.asks).toEqual([])
    expect(c.edited.length).toBe(2)
  })

  test('a shell write to settings.local.json is held, a read is not', async ($, on) => {
    const c = setup(on, { answer: 'Cancel' })
    await start($)
    await prompt($, 'what does the service return')
    await bash($, 'cat ~/.claude/settings.local.json | jq .permissions')
    const out = await bash($, "jq '.permissions.allow += [\"Bash(go test:*)\"]' ~/.claude/settings.local.json > /tmp/s && mv /tmp/s ~/.claude/settings.local.json")
    expect(c.ran.length).toBe(1)
    expect(out.deny).toContain('pressed Cancel')
  })
})

describe('own access on a machine', () => {
  test('removing $USER from sudo over ssh is refused without asking', async ($, on) => {
    const c = setup(on, { user: 'dev' })
    await start($)
    await prompt($, 'tighten the box permissions')
    const out = await bash($, "ssh dev@10.0.0.5 'sudo deluser dev sudo'")
    expect(out.deny).toContain('refused')
    expect(out.deny).toContain("never remove dev's own")
    expect(c.asks).toEqual([])
    expect(c.ran).toEqual([])
  })

  test('protectedUsers overrides $USER', { options: { protectedUsers: 'ops, admin' } }, async ($, on) => {
    const c = setup(on, { user: 'dev' })
    await start($)
    await prompt($, 'clean up accounts')
    await bash($, 'sudo userdel dev')
    expect(c.ran.length).toBe(1)
    expect((await bash($, 'sudo userdel admin')).deny).toContain('refused')
  })

  test('removing or emptying sudoers or authorized_keys is refused; editing or appending is held', async ($, on) => {
    const c = setup(on, { answer: 'Cancel' })
    await start($)
    await prompt($, 'fix the ssh setup')
    expect((await bash($, 'echo "" > ~/.ssh/authorized_keys')).deny).toContain('refused')
    expect((await bash($, 'sudo rm /etc/sudoers.d/dev')).deny).toContain('refused')
    expect((await bash($, 'echo x | sudo tee /etc/sudoers.d/dev')).deny).toContain('refused')
    expect((await bash($, 'usermod -G docker dev')).deny).toContain('refused')
    expect(c.asks).toEqual([])
    expect((await bash($, 'echo "ssh-ed25519 AAAA bot" >> ~/.ssh/authorized_keys')).deny).toContain('pressed Cancel')
    expect((await bash($, "sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config")).deny).toContain('pressed Cancel')
    expect((await bash($, 'echo "bot ALL=(ALL) NOPASSWD:ALL" | sudo tee -a /etc/sudoers.d/bot')).deny).toContain('pressed Cancel')
    expect(c.asks.length).toBe(3)
    expect(c.asks.every(q => q.includes('lock you out'))).toBe(true)
    await bash($, 'usermod -aG docker dev && cat /etc/sudoers')
    expect(c.ran.length).toBe(1)
  })

  test('Edit on sshd_config is refused', async ($, on) => {
    const c = setup(on)
    await start($)
    const out = await edit($, '/etc/ssh/sshd_config')
    expect(out.deny).toContain('refused')
    expect(c.edited).toEqual([])
  })

  test('ufw that may close port 22 is held, one that allows 22 passes', async ($, on) => {
    const c = setup(on, { answer: 'Cancel' })
    await start($)
    await prompt($, 'set up the firewall')
    await bash($, 'sudo ufw allow 22/tcp && sudo ufw --force enable')
    expect(c.asks).toEqual([])
    const out = await bash($, 'sudo ufw default deny incoming && sudo ufw --force enable')
    expect(out.deny).toContain('pressed Cancel')
    expect(c.asks[0]).toContain('lock you out')
  })
})

describe('the /guard command and the fallbacks', () => {
  test('/guard off pauses the holds and /guard reports it; refusals stay', async ($, on) => {
    const c = setup(on)
    await start($)
    await command($, 'guard', 'off')
    await prompt($, 'tidy up')
    await bash($, 'git commit -m tidy')
    expect(c.asks).toEqual([])
    expect(c.ran.length).toBe(1)
    const status = await command($, 'guard')
    expect(status.text).toContain('paused')
    expect((await bash($, 'userdel dev')).deny).toContain('refused')
    await command($, 'guard', 'on')
    await bash($, 'git commit -m tidy2')
    expect(c.asks.length).toBe(1)
  })

  test('/guard shows what the turn may do and the configuration', { options: PROTECTED }, async ($, on) => {
    setup(on)
    await start($)
    await prompt($, 'commit and push this')
    const status = await command($, 'guard')
    expect(status.text).toContain('commit, push')
    expect(status.text).toContain('active')
    expect(status.text).toContain('acme/')
    expect(status.text).toContain('/ship-pr')
  })

  test('a dismissed question denies the call instead of letting it through', async ($, on) => {
    const c = setup(on, { askThrows: true })
    await start($)
    await prompt($, 'tidy up')
    const out = await bash($, 'git commit -m tidy')
    expect(out.deny).toContain('did not run')
    expect(c.ran).toEqual([])
  })

  test('holdCommits off lets commits through but still holds settings', { options: { holdCommits: false } }, async ($, on) => {
    const c = setup(on, { answer: 'Cancel' })
    await start($)
    await prompt($, 'tidy up')
    await bash($, 'git commit -m tidy')
    expect(c.asks).toEqual([])
    const out = await edit($, `${HOME}/.claude/settings.json`)
    expect(out.deny).toContain('pressed Cancel')
  })
})
