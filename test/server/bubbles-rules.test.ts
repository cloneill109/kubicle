import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { protectedAction, branchInfo, clearBranchCache, grantMatches } from '../../src/server/bubbles/rules.ts';
import type { Protected, Grant, BranchInfo } from '../../src/server/bubbles/rules.ts';

const home = '/home/u/.kubicle';
const br = (current: string | null): BranchInfo => ({ protected: new Set(['main', 'master']), current });
const bash = (command: string, current: string | null = 'feature', strictScripts = false) =>
  protectedAction('Bash', { command }, { cwd: '/work/app', branches: br(current), home, strictScripts });

test('protectedAction table: push', () => {
  assert.equal(bash('git push origin feature'), null);
  const a = bash('git push origin HEAD:main');
  assert.equal(a?.kind, 'push'); assert.equal((a as { branch: string | null }).branch, 'main');
  assert.equal(bash('cd app && git push', 'main')?.kind, 'push');
  assert.equal(bash('git push', null)?.kind, 'push');
  assert.equal(bash('git push', 'feature'), null);
  assert.equal(bash('git push origin', 'feature'), null);
  assert.equal(bash('git -C ../x push --force origin feature')?.kind, 'push');
  assert.equal(bash('git push -f origin feature')?.kind, 'push');
  assert.equal(bash('git push --force-with-lease origin feature')?.kind, 'push');
  assert.equal(bash('git push --mirror')?.kind, 'push');
  assert.equal(bash('git push --all')?.kind, 'push');
  assert.equal(bash('git push --delete origin feature')?.kind, 'push');
  assert.equal(bash('git push origin +feature')?.kind, 'push');
  assert.equal(bash('git push origin :master')?.kind, 'push');
  assert.equal(bash('git push origin refs/heads/main')?.kind, 'push');
  assert.equal(bash('env GIT_SSH=x git push origin main')?.kind, 'push');
  assert.equal(bash('FOO=1 sudo -E git -c a=b push origin main')?.kind, 'push');
  assert.equal(bash('git push origin HEAD', 'main')?.kind, 'push');
  assert.equal(bash('git push origin HEAD', 'feature'), null);
  assert.equal(bash('git push origin HEAD', null)?.kind, 'push');
  assert.equal(bash('git push origin feature:main')?.kind, 'push');
  assert.equal(bash('git push origin main:feature'), null);
});

test('protectedAction: quoting and segments', () => {
  assert.equal(bash('echo "git push origin main"'), null);
  assert.equal(bash("echo 'a && git push origin main'"), null);
  assert.equal(bash('echo hi; git push origin main')?.kind, 'push');
  assert.equal(bash('true || git push origin main')?.kind, 'push');
  assert.equal(bash('ls\ngit push origin main')?.kind, 'push');
  assert.equal(bash('{"decision":"approve"} && git push origin main')?.kind, 'push');
  assert.equal(bash('echo $(git push origin main)')?.kind, 'push');
  assert.equal(bash('echo `git push origin main`')?.kind, 'push');
  assert.equal(bash('echo "x $(git push origin main)"')?.kind, 'push');
  assert.equal(bash('(git push origin main)')?.kind, 'push');
  assert.equal(bash('bash -c "git push origin main"')?.kind, 'push');
  assert.equal(bash('git push origin "main"')?.kind, 'push');
});

test('protectedAction: merge', () => {
  assert.equal(bash('gh pr merge 12 --squash')?.kind, 'merge');
  assert.equal(bash('gh -R o/r pr merge 12')?.kind, 'merge');
  assert.equal(bash('gh api -X PUT repos/o/r/pulls/3/merge')?.kind, 'merge');
  assert.equal(bash('gh api repos/o/r/merges -f base=main')?.kind, 'merge');
  assert.equal(bash('gh pr view 3'), null);
  assert.equal(bash('git merge dev', 'main')?.kind, 'merge');
  assert.equal(bash('git rebase dev', 'main')?.kind, 'merge');
  assert.equal(bash('git merge dev', 'feature'), null);
  const m = protectedAction('mcp__github__merge_pull_request', {}, { branches: br('feature'), home, strictScripts: false });
  assert.equal(m?.kind, 'merge');
  assert.equal(protectedAction('mcp__x__push_files', {}, { branches: br('feature'), home, strictScripts: false })?.kind, 'merge');
  assert.equal(protectedAction('mcp__x__list', {}, { branches: br('feature'), home, strictScripts: false }), null);
});

test('protectedAction: self', () => {
  assert.equal(bash('kubicle grant push --project .')?.kind, 'self');
  assert.equal(bash('/opt/x/bin/kubicle instruct foo')?.kind, 'self');
  assert.equal(bash('cd x && kubicle bubbles on')?.kind, 'self');
  assert.equal(bash('kubicle status'), null);
  const ctx = { cwd: '/work/app', branches: br('feature'), home, strictScripts: false };
  assert.equal(protectedAction('Write', { file_path: `${home}/bubbles.yaml` }, ctx)?.kind, 'self');
  assert.equal(protectedAction('Edit', { file_path: '../../home/u/.kubicle/x' }, ctx)?.kind, 'self');
  assert.equal(protectedAction('MultiEdit', { file_path: '/anywhere/office.db-wal' }, ctx)?.kind, 'self');
  assert.equal(protectedAction('Write', { file_path: 'src/a.ts' }, ctx), null);
  assert.equal(protectedAction('Write', { file_path: `${home}-other/a` }, ctx), null);
  assert.equal(bash(`sqlite3 ${home}/office.db 'delete from bubbles_log'`)?.kind, 'self');
  assert.equal(bash(`echo x > ${home}/bubbles.yaml`)?.kind, 'self');
  assert.equal(bash(`cat ${home}/bubbles.yaml`), null);
});

test('protectedAction: scripts', () => {
  assert.equal(bash('npm run deploy', 'feature', false), null);
  assert.equal(bash('npm run deploy', 'feature', true)?.kind, 'script');
  assert.equal(bash('./deploy.sh', 'feature', true)?.kind, 'script');
  assert.equal(bash('make release', 'feature', true)?.kind, 'script');
  assert.equal(bash('ls -la', 'feature', true), null);
});

function git(root: string, head: string) { mkdirSync(join(root, '.git'), { recursive: true }); writeFileSync(join(root, '.git/HEAD'), head); }

test('branchInfo: plain, detached, worktree, origin/HEAD', () => {
  clearBranchCache();
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'rules-')));
  const repo = join(d, 'repo'); mkdirSync(join(repo, 'sub'), { recursive: true });
  git(repo, 'ref: refs/heads/main\n');
  let b = branchInfo(join(repo, 'sub'), []);
  assert.equal(b.current, 'main');
  assert.deepEqual([...b.protected].sort(), ['main', 'master']);
  assert.ok(branchInfo(repo, ['release']).protected.has('release'));

  clearBranchCache();
  git(repo, '0123456789abcdef0123456789abcdef01234567\n');
  assert.equal(branchInfo(repo, []).current, null);

  clearBranchCache();
  git(repo, 'ref: refs/heads/feature/x\n');
  mkdirSync(join(repo, '.git/refs/remotes/origin'), { recursive: true });
  writeFileSync(join(repo, '.git/refs/remotes/origin/HEAD'), 'ref: refs/remotes/origin/trunk\n');
  b = branchInfo(repo, []);
  assert.equal(b.current, 'feature/x');
  assert.ok(b.protected.has('trunk'));

  // worktree: .git is a file pointing at <repo>/.git/worktrees/wt, with commondir
  clearBranchCache();
  const wt = join(d, 'wt'); mkdirSync(wt);
  const wgit = join(repo, '.git/worktrees/wt'); mkdirSync(wgit, { recursive: true });
  writeFileSync(join(wgit, 'HEAD'), 'ref: refs/heads/wtbranch\n');
  writeFileSync(join(wgit, 'commondir'), '../..\n');
  writeFileSync(join(wt, '.git'), `gitdir: ${wgit}\n`);
  b = branchInfo(wt, []);
  assert.equal(b.current, 'wtbranch');
  assert.ok(b.protected.has('trunk'));

  // no repo
  clearBranchCache();
  const none = mkdtempSync(join(tmpdir(), 'rules-none-'));
  assert.equal(branchInfo(none, []).current, null);
});

test('branchInfo: current is never cached, origin/HEAD cached 10 s', () => {
  clearBranchCache();
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'rules-c-')));
  git(d, 'ref: refs/heads/a\n');
  mkdirSync(join(d, '.git/refs/remotes/origin'), { recursive: true });
  writeFileSync(join(d, '.git/refs/remotes/origin/HEAD'), 'ref: refs/remotes/origin/t1\n');
  assert.equal(branchInfo(d, [], 1000).current, 'a');
  git(d, 'ref: refs/heads/b\n');
  writeFileSync(join(d, '.git/refs/remotes/origin/HEAD'), 'ref: refs/remotes/origin/t2\n');
  const b = branchInfo(d, [], 5000);
  assert.equal(b.current, 'b');
  assert.ok(b.protected.has('t1') && !b.protected.has('t2'));
  assert.ok(branchInfo(d, [], 11001).protected.has('t2'));
});

const PROTECTED_BASH = [
  'git checkout main && git push', 'git switch main; git push origin', 'git checkout main && git push origin HEAD',
  'git checkout main && git merge dev', 'cd ../other && git push',
  'if git push origin main; then echo ok; fi', 'if ! git push origin main; then echo no; fi', '{ git push origin main; }',
  '! git push origin main', 'for r in origin; do git push $r main; done', 'if true; then kubicle grant push; fi',
  '/usr/bin/git push origin main', '/opt/homebrew/bin/gh pr merge 3', '$(which git) push origin main',
  'env -u FOO git push origin main', 'sudo -u me git push origin main', 'nice -n 5 git push origin main',
  'timeout 60 git push origin main', 'echo main | xargs git push origin', 'bash -lc "git push origin main"',
  'echo "git push origin main" | sh',
  'B=main; git push origin $B', 'git push origin "$(git branch --show-current)"', 'git push origin main>/dev/null',
  "git push origin $'main'",
  'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true', 'gh api -X PUT repos/o/r/contents/f -f branch=main -f content=x',
  'git -c alias.p=push p origin main', 'git subtree push --prefix d origin main',
  'bin/kubicle grant push', 'npx kubicle grant push', 'node bin/kubicle grant push', 'node src/cli/kubicle.ts grant push',
  'npx tsx src/cli/kubicle.ts grant push',
  'cd ~/.kubicle && rm bubbles.yaml', 'cd ~ && rm -rf .kubicle', 'rm -rf ~/.kub*',
  `node -e "require('fs').writeFileSync('${home}/bubbles.yaml','x')"`, `python3 -c "open('${home}/x','w')"`,
  `ln -sf /x ${home}/bubbles.yaml`, `truncate -s 0 ${home}/office.db`, `chmod 777 ${home}`, 'rm /tmp/OFFICE.DB',
  'git push origin feature && git push --force origin feature', 'git push -fu origin feature',
];

test('fail-closed: reviewer bypasses are protected', () => {
  for (const c of PROTECTED_BASH) assert.notEqual(bash(c, 'feature'), null, c);
  for (const c of PROTECTED_BASH) assert.notEqual(bash(c, 'main'), null, c);
});

test('fail-closed: common safe commands stay null', () => {
  for (const c of ['git push origin feature', 'git push -u origin feature', 'git status', 'git log --merges', 'echo hello', 'npm test',
    'cat ~/.kubicle/bubbles.yaml', 'ls ~/.kubicle', 'git commit -m "merge notes"', 'git push origin feature 2>&1', 'echo "git push origin main"',
    'git add -A && git commit -m "x" && git push -u origin feature']) {
    assert.equal(bash(c, 'feature'), null, c);
  }
});

test('fail-closed: file tools', () => {
  const ctx = { cwd: '/work/app', branches: br('feature'), home, strictScripts: false };
  assert.equal(protectedAction('Write', { file_path: '~/.kubicle/bubbles.yaml' }, { ...ctx, home: join(homedir(), '.kubicle') })?.kind, 'self');
  assert.equal(protectedAction('Write', { file_path: '/tmp/OFFICE.DB' }, ctx)?.kind, 'self');
  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.equal(protectedAction('Write', { file_path: `${home.toUpperCase()}/bubbles.yaml` }, ctx)?.kind, 'self');
  }
  for (const n of ['mcp__github__create_or_update_file', 'mcp__github__update_ref', 'mcp__x__commit', 'mcp__github__push_files', 'mcp__GH__Merge_PR']) {
    assert.equal(protectedAction(n, {}, ctx)?.kind, 'merge', n);
  }
});

test('grantMatches prefers unlimited, then soonest expiry', () => {
  const lim = G({ id: 'lim', usesLeft: 1 }); const unl = G({ id: 'unl', expiresAt: 5000 }); const soon = G({ id: 'soon', usesLeft: 2, expiresAt: 1500 });
  assert.equal(grantMatches(P(), 'p', [lim, unl], 1000)?.id, 'unl');
  assert.equal(grantMatches(P(), 'p', [lim, soon], 1000)?.id, 'soon');
});

const G = (o: Partial<Grant> = {}): Grant => ({ id: 'g', projectId: 'p', action: 'push', branch: null, usesLeft: null, expiresAt: 2000, createdAt: 0, confirmedAt: 0, revokedAt: null, ...o });
const P = (o: { kind?: 'push' | 'merge'; branch?: string | null } = {}): Protected => ({ kind: 'push', branch: 'main', reason: 'r', ...o });

test('grantMatches', () => {
  const now = 1000;
  const g = G();
  assert.equal(grantMatches(P(), 'p', [g], now), g);
  assert.equal(grantMatches(P(), 'q', [g], now), null);
  assert.equal(grantMatches(P({ kind: 'merge' }), 'p', [g], now), null);
  assert.equal(grantMatches(P({ kind: 'merge' }), 'p', [G({ action: 'merge' })], now)?.action, 'merge');
  assert.equal(grantMatches(P(), 'p', [G({ branch: 'main' })], now)?.branch, 'main');
  assert.equal(grantMatches(P(), 'p', [G({ branch: 'dev' })], now), null);
  assert.equal(grantMatches(P({ branch: null }), 'p', [G({ branch: 'main' })], now), null);
  assert.ok(grantMatches(P({ branch: null }), 'p', [G()], now));
  assert.equal(grantMatches(P(), 'p', [G({ expiresAt: 1000 })], now), null);
  assert.equal(grantMatches(P(), 'p', [G({ usesLeft: 0 })], now), null);
  assert.ok(grantMatches(P(), 'p', [G({ usesLeft: 1 })], now));
  assert.equal(grantMatches(P(), 'p', [G({ revokedAt: 5 })], now), null);
  assert.equal(grantMatches({ kind: 'self', reason: 'r' }, 'p', [g], now), null);
  const second = G({ id: 'h' });
  assert.equal(grantMatches(P(), 'p', [G({ revokedAt: 1 }), second], now), second);
});
