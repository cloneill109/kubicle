// Tiny stdio MCP server for tests. `answer` replies to initialize; `silent` never does; `env` echoes FIXTURE_ECHO into serverInfo.name.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const mode = process.argv[2] ?? 'answer';
if (process.env.FIXTURE_PIDFILE) writeFileSync(process.env.FIXTURE_PIDFILE, String(process.pid));
if (process.env.FIXTURE_ENVFILE) writeFileSync(process.env.FIXTURE_ENVFILE, JSON.stringify({ a: process.env.ANTHROPIC_API_KEY ?? null, c: process.env.CLAUDE_CODE_USE_BEDROCK ?? null, tok: process.env.FIXTURE_TOK ?? null }));
if (mode === 'grandchild' || mode === 'holdout') {
  // grandchild: same process group, silent. holdout: its own session, keeps our stdout open for 8 s.
  const gc = mode === 'grandchild'
    ? spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    : spawn(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true });
  writeFileSync(process.env.FIXTURE_GCFILE, String(gc.pid));
  gc.unref();
}
if (mode === 'silent' || mode === 'grandchild') setInterval(() => {}, 1000);
else createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method !== 'initialize') return;
  if (mode === 'refuse') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -1, message: process.env.FIXTURE_MSG ?? '' } }) + '\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: mode === 'env' ? (process.env.FIXTURE_TOK ?? '') : 'fixture', version: '1' } } }) + '\n');
});
