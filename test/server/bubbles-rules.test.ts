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
  assert.equal(bash('git push', 'feature')?.kind, 'push'); // bare push: config decides the destination
  assert.equal(bash('git push origin', 'feature')?.kind, 'push');
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
  // round 2
  'git push', 'git push origin', 'git -c remote.origin.push=refs/heads/feature:refs/heads/main push origin feature',
  'git -c push.default=upstream push', 'GIT_DIR=/other/.git git push origin HEAD', 'GIT_DIR=/other/.git git merge dev',
  'GIT_WORK_TREE=/x GIT_DIR=/o/.git git push origin feature', 'git push origin feature:heads/main', 'git push origin heads/main',
  'git p origin feature:main', 'git config alias.p push', "g''it push origin main", '"gi"t push origin main', 'gi\\t push origin main',
  'X=gi; ${X}t push origin main', 'git push . feature:main', 'git -c include.path=/tmp/evil push', 'git branch -u origin/main',
  'git fetch origin main:main', 'git branch -f main feature', 'git update-ref refs/heads/main HEAD',
  'curl -X PUT -H "Authorization: token t" https://api.github.com/repos/o/r/pulls/1/merge', 'curl -d x https://api.github.com/repos/o/r/git/refs',
  'wget --method=POST https://api.github.com/repos/o/r/merges', 'gh repo sync',
  'rm -rf ~/.ku*', 'rm -rf ~/.k*', 'rm -rf ~/.ku""bicle', 'cd ~ && rm -rf .k*', 'find ~ -name bubbles.yaml -delete',
  "find ~ -name 'office*' -delete", 'rg --pre rm x ~/.kubicle/bubbles.yaml', 'LESSOPEN="|rm %s" less ~/.kubicle/bubbles.yaml',
  '/tmp/cat ~/.kubicle/bubbles.yaml', 'kubi""cle grant push', 'node dist/kubicle.mjs grant push', 'node dist/kubicle.cjs grant push',
  'KUBICLE grant push', 'cat ~/.kubicle/bubbles.yaml | tee /tmp/x', 'mv ~/.kubicle /tmp/k',
];

test('fail-closed: reviewer bypasses are protected', () => {
  for (const c of PROTECTED_BASH) assert.notEqual(bash(c, 'feature'), null, c);
  for (const c of PROTECTED_BASH) assert.notEqual(bash(c, 'main'), null, c);
});

test('fail-closed: common safe commands stay null', () => {
  for (const c of ['git push origin feature', 'git push -u origin feature', 'git status', 'git log --merges', 'echo hello', 'npm test',
    'cat ~/.kubicle/bubbles.yaml', 'ls ~/.kubicle', 'git commit -m "merge notes"', 'git push origin feature 2>&1', 'echo "git push origin main"',
    'git add -A && git commit -m "x" && git push -u origin feature', 'git fetch origin', 'git branch -a', 'git config --get user.name',
    'git checkout -b feat', 'git -C sub status', 'git push origin feature/x', 'GIT_AUTHOR_NAME=a git commit -m x']) {
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
  for (const n of ['mcp__github__create_or_update_file', 'mcp__github__update_ref', 'mcp__x__commit', 'mcp__github__push_files', 'mcp__GH__Merge_PR', 'mcp__github__update_pull_request_branch', 'mcp__github__delete_branch']) {
    assert.ok(protectedAction(n, {}, ctx), n);
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

// ---- round 3: glob/http bypasses, false positives, size guard ----
const R3_PROTECTED = [
 "/usr/bin/gi? push origin main",
 "/usr/bin/g[i]t push origin main",
 "/usr/bin/gi* push origin main",
 "/Library/Developer/CommandLineTools/usr/libexec/git-core/git-push origin main",
 "hub push origin main",
 "curl -T body.json https://api.github.com/repos/o/r/pulls/1/merge",
 "curl --upload-file b.json https://api.github.com/repos/o/r/pulls/1/merge",
 "curl -d@body.json https://api.github.com/repos/o/r/pulls/1/merge",
 "curl -dmerge_method=squash -XPUT https://api.github.com/repos/o/r/pulls/1/merge",
 "curl -dx https://api.github.com/repos/o/r/merges",
 "http PUT https://api.github.com/repos/o/r/pulls/1/merge",
 "xh put api.github.com/repos/o/r/pulls/1/merge",
 "http POST api.github.com/repos/o/r/merges base=main head=f",
 "curl -H 'Content-Type: application/json' --data-raw '{}' -X PUT https://api.github.com/repos/o/r/pulls/1/merge",
 "curl -d '{\"query\":\"mutation{mergePullRequest(input:{pullRequestId:\\\"x\\\"}){clientMutationId}}\"}' https://api.github.com/graphql",
 "python3 -c \"import subprocess as s;s.run(['gi'+'t','push','origin','main'])\"",
 "gh m 3",
 "gh pr merge 3",
 "git push origin feature:refs/tags/../heads/main",
 "git push origin @:main",
 "git push origin feature:MAIN",
 "git push origin feature:Main",
 "GIT_CONFIG_PARAMETERS=\"'remote.origin.push=refs/heads/feature:refs/heads/main'\" git push origin feature",
 "git -cremote.origin.push=x push origin feature",
 "git --config-env=remote.origin.push=V push origin feature",
 "git push origin feature --receive-pack=x",
 "git push --repo=origin",
 "export GIT_DIR=/o/.git; git push origin feature",
 "git push origin feature; git push origin main",
 "git log && git push origin main",
 "true && git push origin main",
 "git push origin main#",
 "git push origin main --",
 "git push -- origin main",
 "git push origin -- main",
 "git push origin feature -- main",
 "git push origin feature main",
 "/usr/bin/gi? push -q origin feature:main",
 "/Library/Developer/CommandLineTools/usr/libexec/git-core/git-push -q origin feature:main",
 "find / -name bubbles.yaml -delete",
 "find $HOME -name bubbles.yaml -delete",
 "cd; rm bubbles.yaml",
 "cd && cd .kubicle && rm bubbles.yaml",
 "git push origin feature --force-with-lease",
 "git push --force-with-lease origin feature"
];
const R3_PROTECTED_ON_MAIN = ["/Library/Developer/CommandLineTools/usr/libexec/git-core/git-merge dev", "/Library/Developer/CommandLineTools/usr/libexec/git-core/git-merge -q feature"];
const R3_SAFE = [
 "git push origin feature",
 "git push -u origin feature",
 "git push origin feature/x",
 "git checkout -b feat && git push -u origin feat",
 "git switch -c feat && git push -u origin feat",
 "cd app && git push origin feature",
 "git status",
 "git diff HEAD~",
 "git show HEAD~",
 "git reset --soft HEAD~",
 "git log --oneline main..HEAD",
 "git add src/Main.kt && git commit -m x",
 "kotlinc Main.kt",
 "./gradlew test --tests Foo.kt",
 "cat app.kt",
 "npm test",
 "npx tsc --noEmit && git push origin feature",
 "npm test && git push origin feature",
 "pytest && git push origin feature",
 "go test ./... && git push origin feature",
 "cargo test && git push origin feature",
 "bun test && git push origin feature",
 "npm run build && git push origin feature",
 "cd ~ && ls",
 "cd ~/code/app && npm test",
 "npm install lodash.kebabcase",
 "cd office-app && npm test",
 "mkdir -p src/office",
 "ls",
 "cat README.md",
 "git commit -m \"fix push logic\"",
 "docker push img",
 "git stash push -m wip",
 "git log --merges | head",
 "git grep -n push",
 "grep -rn \"git push\" src",
 "rg \"merge\" src | wc -l",
 "gh pr create --fill",
 "gh pr view",
 "gh pr checks",
 "gh pr list",
 "gh run list",
 "gh api repos/o/r/pulls",
 "curl -s https://api.github.com/repos/o/r",
 "echo done"
];

test('round 3: bypasses are protected', () => {
  for (const c of [...R3_PROTECTED, ...[], ...[]]) assert.notEqual(bash(c, 'feature'), null, c);
  for (const c of [...R3_PROTECTED, ...R3_PROTECTED_ON_MAIN]) assert.notEqual(bash(c, 'main'), null, c);
  for (const c of ['gh m 3', 'gh pr merge 3', 'xh put api.github.com/repos/o/r/pulls/1/merge']) assert.notEqual(bash(c, 'feature'), null, c);
});

test('round 3: common safe commands stay null (low false positives)', () => {
  for (const c of [...R3_SAFE, ...["cat ~/.kubicle/bubbles.yaml", "ls -la ~/.kubicle"]]) assert.equal(bash(c, 'feature'), null, c);
  for (const c of R3_SAFE) if (!/rebase|merge/.test(c)) assert.equal(bash(c, 'main'), null, `${c} (main)`);
});

test('round 3: find over ancestors of the Kubicle home, ~ forms', () => {
  for (const c of ["find /home -name 'bubbles*' -delete", 'find /home/u -name x -exec rm {} +', 'rm -rf /home/u/.kub*', `find ${home}/.. -delete`]) assert.equal(bash(c)?.kind, 'self', c);
  assert.equal(bash('find /home -name x'), null);
});

test('round 3: oversized commands are protected without analysis', () => {
  const big = 'git push origin feature;'.repeat(4400);
  const t0 = performance.now();
  const r = bash(big);
  assert.equal(r?.kind, 'push');
  assert.ok(performance.now() - t0 < 50);
});

// ---- round 4: brace/find/glob self-protection, HEAD taint, opaque command words, HTTP ----
// Rows that name the user's real home (`~`, `/Users/<u>`) use a Kubicle home under homedir().
// Nothing is executed; the rules only read path strings (and realpath of the home).
const HD = homedir();
const U = HD.split('/').pop()!;
const KHOME = join(HD, '.kubicle');
const bashH = (command: string, current: string | null = 'feature', cwd = '/work/app') =>
  protectedAction('Bash', { command }, { cwd, branches: br(current), home: KHOME, strictScripts: false });

const R4_SELF = [
  // R1 brace expansion
  'echo "grants: all" | tee ~/{.kubicle/bubbles.yaml,/dev/null}', 'cp /tmp/evil.yaml ~/{.kubicle,.kubicle}/bubbles.yaml',
  'mv ~/{.kubicle,.kubicle-old}', 'rm -rf ~/{.kubicle,x}', 'rm -rf ~/{.k,.x}ubicle', 'cd ~ && rm -rf {.kubicle,x}', `rm -rf ${HD}/{.kubicle,x}`,
  // P2 find / fd
  'find -L / -name bubbles.yaml -delete', 'find /. -name bubbles.yaml -delete', `find ${HD}/. -name bubbles.yaml -delete`,
  `find /System/Volumes/Data${HD} -name bubbles.yaml -delete`, 'find / -name bubbles.yaml | xargs rm',
  'find / -name bubbles.yaml -print0 | xargs -0 rm', 'fd -H bubbles.yaml / -x rm', 'fd -H bubbles.yaml /Users -X rm',
  // P3 home ancestors and globs
  `rm -rf ${HD}`, `rm -rf ${HD}/?kubicle`, `rm -rf ${HD}/[.]kubicle`, `cd ${HD} && rm -rf .??bicle`, `rm -rf ~${U}/?kubicle`,
  'rm -rf /', 'chmod -R 000 ~', `mv ${HD} /tmp/x`, 'cp -r /tmp/evil/.kubicle ~/', `echo x > ${KHOME}/bubbles.yaml`,
  'nice -n 5 rm -rf ~/.kubicle', `ls -a ${HD} | xargs rm -rf`, `cp -t ${HD} evil/x`,
  // P5: writes to Kubicle's own port / hook socket
  'curl -X POST -d "{}" http://localhost:4317/api/grants', 'http POST :4317/api/grants a=b',
  'curl --unix-socket /x/run/hook.sock -d "{}" http://x/',
];
const R4_PUSH = [
  // R2 / R3: HEAD after a step we cannot see
  'gh pr checkout 5 -b main && git push origin HEAD', 'gh repo clone o/r && git push origin HEAD',
  './scripts/co.sh main && git push origin HEAD', 'npm run prep && git push origin @', 'make switch-main && git push origin HEAD',
  "echo 'ref: refs/heads/main' > .git/HEAD && git push origin HEAD",
  // P1 opaque / glob command words
  '/opt/homebrew/bin/g? m 3', '~/bin/g* m 3', '$(which gh) m 3', '/usr/bin/gi? p origin main',
  // P4 HTTP
  "echo '{\"merge_method\":\"squash\"}' | http api.github.com/repos/o/r/pulls/1/merge",
  'http api.github.com/repos/o/r/pulls/1/merge < body.json', 'xh api.github.com/repos/o/r/pulls/1/merge < body.json',
  'http api.github.com/repos/o/r/pulls/1/merge @body.json', 'curl -K req.cfg https://api.github.com/repos/o/r/pulls/1/merge',
  'curl --config req.cfg https://api.github.com/repos/o/r/pulls/1/merge', 'curl -X PUT $GITHUB_API_URL/repos/o/r/pulls/1/merge',
  'curl -X PUT "$(cat url.txt)"', 'curl -d x https://$GH_HOST/repos/o/r/merges',
  "gh api repos/o/r/pulls/1/merge -H 'X-HTTP-Method-Override: PUT'",
  // second pass: whole-command and quoted-command views of an HTTP write
  'echo "-X PUT" | xargs curl https://api.github.com/repos/o/r/pulls/1/merge',
  'bash -c "curl -X PUT https://api.github.com/repos/o/r/pulls/1/merge"', "sh -c 'http PUT api.github.com/repos/o/r/pulls/1/merge'",
  'curl -X PUT http://api.$DOMAIN/repos/o/r/pulls/1/merge',
];
const R4_SAFE = [
  'gh pr edit 12 --add-label bug', 'gh pr ready 12', 'gh pr close 12', 'gh pr reopen 12', 'gh pr comment 3 -b hi',
  'curl -X POST -d "{}" http://localhost:3000/api/items', 'curl -s http://localhost:4317/api/state',
  './scripts/co.sh main && git push origin feature', 'npm run prep && git push origin feature',
  'git push origin feature 2>&1 | tee push.log', 'git push origin feature > push.log 2>&1', 'git push origin feature < /dev/null',
  'git push origin feature &> push.log', '[ -f package.json ] && git push origin feature', 'export X=1 && git push origin feature',
  'rm -rf node_modules dist', 'rm -rf ./build', 'find . -name "*.pyc" -delete', 'find src -name "*.orig" -exec rm {} +',
  'find . -name "*.ts" | xargs wc -l', 'fd -e ts . src -x prettier --write', 'fd -H bubbles.yaml --exec rm',
  'ls ~/{code,src}', 'cat ~/.zshrc', 'cd ~ && ls', 'cd ~/code/app && npm test', 'curl -X POST -d "$BODY" https://hooks.example.com/x',
  'curl -s $URL', 'eslint --ext .js,.kt src', 'timeout 60 npm test', 'rsync -avt ~/notes/ backup/',
  'curl -H "Authorization: Bearer $TOKEN" -X POST https://example.com/api', 'git commit -m "fix put" && curl -s https://api.github.com/x',
];

test('round 4: self-protection via braces, find/fd/xargs, home ancestors, globs, Kubicle port', () => {
  for (const c of R4_SELF) assert.equal(bashH(c)?.kind, 'self', c);
});

test('round 4: unseen HEAD changes, opaque command words and HTTP writes are protected', () => {
  for (const c of R4_PUSH) for (const cur of ['feature', 'main']) assert.ok(bashH(c, cur), `${c} (${cur})`);
  assert.equal(bashH('./scripts/co.sh main && git merge dev')?.kind, 'merge');
  assert.equal(bashH('gh pr merge 3')?.kind, 'merge');
});

test('round 4: everyday commands stay null', () => {
  for (const c of R4_SAFE) for (const cur of ['feature', 'main']) assert.equal(bashH(c, cur), null, `${c} (${cur})`);
  assert.equal(bashH('git push origin HEAD > out.txt', 'feature'), null);
});

test('round 4: huge globs and brace bombs neither crash nor stall the guard', () => {
  const K = 16 * 1024 - 40;
  for (const c of ['rm /' + '*a'.repeat(K / 2), 'rm ~/' + '{a,b}'.repeat(K / 5 - 2), 'rm /' + '[a-z]'.repeat(K / 5), 'cd ..;rm x;'.repeat(K / 11)]) {
    const t0 = performance.now();
    assert.doesNotThrow(() => bashH(c));
    assert.ok(performance.now() - t0 < 50, `slow: ${c.slice(0, 20)}`);
  }
  assert.equal(bashH('rm ~/' + '{a,b}'.repeat(3000) + '/.kubicle')?.kind, 'self');
});

test('round 4: kubiclePort is configurable', () => {
  const ctx = { cwd: '/work/app', branches: br('feature'), home: KHOME, strictScripts: false, kubiclePort: 5000 };
  assert.equal(protectedAction('Bash', { command: 'curl -d x http://localhost:5000/api/grants' }, ctx)?.kind, 'self');
  assert.equal(protectedAction('Bash', { command: 'curl -d x http://localhost:4317/api/grants' }, ctx), null);
});

// ---- round 5: linear brace scan, `${` is not a glob, case arms, curl -K without URL, never throws ----
test('round 5: deeply nested comma-less braces stay fast', () => {
  for (const c of ['rm ' + '{'.repeat(8000) + '}'.repeat(8000), 'echo ' + '{'.repeat(8000) + '}'.repeat(8000),
    'git push origin ' + '{'.repeat(8000) + '}'.repeat(8000), 'rm ~/' + '{'.repeat(7990) + '}'.repeat(7990)]) {
    bashH(c);
    const t0 = performance.now();
    bashH(c);
    assert.ok(performance.now() - t0 < 50, `slow: ${c.slice(0, 24)}`);
  }
  assert.equal(bashH('rm ~/{{.kubicle,x},y}')?.kind, 'self'); // nested groups with commas still expand
});

test('round 5: parameter expansions and case arms are not glob command words', () => {
  for (const c of ['"${PYTHON}" -m pytest', '${EDITOR:-vim} notes.md', 'case $x in a*) echo a ;; *) echo b ;; esac',
    'case $x in a*|b?) echo a ;; *) git push origin feature ;; esac', 'case $x in (a*) echo a ;; esac',
    '[ -n "$X" ] && git push origin feature']) {
    assert.equal(bashH(c), null, c);
  }
  for (const c of ['${GIT:-git} push origin main', 'case $x in a*) git push origin main ;; esac',
    'case $x in $(git push origin main)) echo ;; esac', 'case $x in `git push origin main`) echo ;; esac',
    'case $x in esac) git push origin main ;; esac', 'case $x in a) echo ;; esac; /usr/bin/gi? push origin main',
    'case x in "a)" ) git push origin main;; esac', 'echo case x in g*) git push origin main']) {
    assert.ok(bashH(c), c);
  }
});

test('round 5: curl/wget config file without a literal URL is protected', () => {
  for (const c of ['curl -K cfg', 'curl -sK cfg', 'curl --config=cfg', 'wget --config cfg']) assert.equal(bashH(c)?.kind, 'push', c);
  assert.equal(bashH('curl -K cfg https://example.com/x'), null);
});

test('round 5: protectedAction never throws', () => {
  const ctx = { cwd: '/work/app', branches: br('feature'), home, strictScripts: false };
  const weird: unknown[] = [undefined, null, 1, 'str', [], { command: 5 }, { file_path: 5 }, Object.create(null),
    { get command() { throw new Error('getter'); } }, { get file_path() { throw new Error('getter'); } }];
  for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'mcp__x__y', '', undefined, 5, null, {}]) {
    for (const w of weird) assert.doesNotThrow(() => protectedAction(tool as string, w, ctx), `${String(tool)}`);
  }
  assert.equal(protectedAction(5 as unknown as string, {}, ctx)?.kind, 'push');
  assert.equal(protectedAction('Bash', { get command() { throw new Error('x'); } }, ctx)?.kind, 'push');
  assert.equal(protectedAction('Read', {}, ctx), null);
});
