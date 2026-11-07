import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTool, describeCommand } from '../../src/shared/describe.ts';

test('Bash prefers the agent-written description', () => {
  assert.equal(describeTool('Bash', { command: 'npm test -- --grep x', description: 'Run the unit tests' }), 'Run the unit tests');
});

test('Bash without a description maps common commands', () => {
  const cases: [string, string][] = [
    ['npm test', 'Running the tests'],
    ['npx vitest run src', 'Running the tests'],
    ['pytest -q tests/', 'Running the tests'],
    ['cargo test', 'Running the tests'],
    ['npm run typecheck', 'Type-checking the code'],
    ['npm run build', 'Building the project'],
    ['npm run lint', 'Linting the code'],
    ['npm run dev', 'Running the "dev" script'],
    ['npm install', 'Installing dependencies'],
    ['pip install requests', 'Installing dependencies'],
    ['git status', 'Checking what changed in git'],
    ['git diff HEAD~1', 'Reviewing code changes'],
    ['git log --oneline -5', 'Reading the git history'],
    ['git add -A && git commit -m "x"', 'Committing changes'],
    ['git push origin feature', 'Pushing to origin'],
    ['git checkout -b fix/login', 'Switching git branches'],
    ['git pull', 'Pulling the latest changes'],
    ['cd /a/b && npm test', 'Running the tests'],
    ['ls -la src', 'Looking through the files'],
    ['find . -name "*.ts"', 'Looking through the files'],
    ['cat README.md', 'Reading README.md'],
    ['sed -n 1,80p src/ui/main.ts', 'Reading main.ts'],
    ['grep -rn foo src', 'Searching the code'],
    ['rg TODO', 'Searching the code'],
    ['curl -s https://api.github.com/repos/x/y', 'Calling api.github.com'],
    ['gh pr create --title x', 'Working with GitHub'],
    ['mkdir -p a/b', 'Creating folders'],
    ['rm -rf dist', 'Deleting files'],
    ['node scripts/build.mjs', 'Running build.mjs'],
    ['python3 tools/gen.py --x', 'Running gen.py'],
    ['docker compose up -d', 'Working with Docker'],
    ['FOO=1 BAR=2 npm test', 'Running the tests'],
    ['sleep 5', 'Waiting'],
    ['weirdtool --flag', 'Running weirdtool'],
  ];
  for (const [cmd, want] of cases) assert.equal(describeCommand(cmd), want, cmd);
});

test('file tools name the file, not the path', () => {
  assert.equal(describeTool('Read', { file_path: '/repo/src/ui/main.ts' }), 'Reading main.ts');
  assert.equal(describeTool('Edit', { file_path: '/repo/src/a.ts' }), 'Editing a.ts');
  assert.equal(describeTool('MultiEdit', { file_path: '/repo/src/a.ts' }), 'Editing a.ts');
  assert.equal(describeTool('Write', { file_path: '/repo/b.md' }), 'Writing b.md');
  assert.equal(describeTool('NotebookEdit', { notebook_path: '/r/n.ipynb' }), 'Editing n.ipynb');
  assert.equal(describeTool('Read', {}), 'Reading a file');
});

test('search, web, delegation and misc tools', () => {
  assert.equal(describeTool('Grep', { pattern: 'useState' }), 'Searching the code for “useState”');
  assert.equal(describeTool('Glob', { pattern: '**/*.ts' }), 'Finding files (**/*.ts)');
  assert.equal(describeTool('WebFetch', { url: 'https://docs.python.org/3/x' }), 'Reading docs.python.org');
  assert.equal(describeTool('WebSearch', { query: 'vite config' }), 'Searching the web for “vite config”');
  assert.equal(describeTool('Agent', { description: 'Audit harness', subagent_type: 'Explore' }), 'Handing off to Explore: Audit harness');
  assert.equal(describeTool('Task', { description: 'Fix login' }), 'Handing off: Fix login');
  assert.equal(describeTool('TodoWrite', {}), 'Updating the to-do list');
  assert.equal(describeTool('Skill', { skill: 'superpowers:brainstorming' }), 'Using the brainstorming skill');
  assert.equal(describeTool('AskUserQuestion', {}), 'Asking you a question');
  assert.equal(describeTool('mcp__claude-in-chrome__navigate', {}), 'Using claude-in-chrome (navigate)');
  assert.equal(describeTool('Mystery', {}), 'Using Mystery');
  assert.equal(describeTool('Bash', null), 'Running a command');
});

test('long descriptions are clipped to one line', () => {
  const d = describeTool('Bash', { command: 'x', description: 'a\nb ' + 'y'.repeat(200) });
  assert.ok(!d.includes('\n'));
  assert.ok(Array.from(d).length <= 80);
  assert.ok(d.endsWith('…'));
});
