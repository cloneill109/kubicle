#!/usr/bin/env node
// Test stand-in for `claude -p ... --output-format json`. Never talks to a model.
// Mode: a `fake-mode:<mode>` marker in stdin, else FAKE_CLAUDE_MODE, else approve-high.
// FAKE_CLAUDE_LOG (optional): JSONL of {event:'start'|'end'|'child', pid, model, args, cwd, agent, stdin}.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
const logFile = process.env.FAKE_CLAUDE_LOG;
const note = (o) => { if (logFile) appendFileSync(logFile, JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\n'); };

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', main);

const verdict = (decision, confidence, uncertain = false) => JSON.stringify({
  decision, confidence, reason: `fake ${decision} at ${confidence}`, uncertain_about_direction: uncertain,
});
const envelope = (result, extra = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result,
  session_id: 'fake-session', total_cost_usd: 0, usage: { input_tokens: 100, output_tokens: 20 }, ...extra,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mode = stdin.match(/fake-mode:([a-z0-9-]+)/)?.[1] ?? process.env.FAKE_CLAUDE_MODE ?? 'approve-high';
  note({ event: 'start', model, mode, args, cwd: process.cwd(), agent: process.env.KUBICLE_AGENT ?? null, apiKey: 'ANTHROPIC_API_KEY' in process.env || 'ANTHROPIC_AUTH_TOKEN' in process.env, stdin });
  const out = (s, code = 0) => { note({ event: 'end' }); process.stdout.write(s, () => process.exit(code)); };
  const strong = model !== 'haiku';
  switch (mode) {
    case 'approve-high': return out(envelope(verdict('approve', 0.95)));
    case 'escalate': return out(envelope(verdict('escalate', 0.9)));
    // Model text that looks like markup: the office must show it as text (never build elements from it).
    case 'escalate-xss': return out(envelope(JSON.stringify({
      decision: 'escalate', confidence: 0.9, reason: 'odd <img src=x onerror="window.__xss=1"> request', uncertain_about_direction: false,
      recommendation_for_owner: 'deny <b>it</b><img src=y onerror="window.__xss=2">',
    })));
    case 'approve-mid-then-high': return out(envelope(verdict('approve', strong ? 0.9 : 0.6)));
    case 'approve-mid-then-mid': return out(envelope(verdict('approve', 0.6)));
    case 'uncertain': return out(envelope(verdict('approve', 0.95, true)));
    case 'prose-wrapped':
      return out(envelope(`Sure! Weighing {"it": "up"} first.\n\`\`\`json\n${verdict('approve', 0.9)}\n\`\`\`\nThanks {not json}`));
    case 'garbage': return out(envelope('I cannot decide {not: json} at all'));
    case 'slow': await sleep(Number(process.env.FAKE_CLAUDE_DELAY ?? 300)); return out(envelope(verdict('approve', 0.95)));
    case 'slow-escalate': await sleep(Number(process.env.FAKE_CLAUDE_DELAY ?? 300)); return out(envelope(verdict('escalate', 0.9)));
    case 'flood': { const chunk = 'x'.repeat(65536); for (let i = 0; i < 40; i++) process.stdout.write(chunk); return out(''); }
    case 'usage-limit':
      return out(envelope('Claude AI usage limit reached|1793491200', { subtype: 'error_during_execution', is_error: true, api_error_status: 429 }), 1);
    case 'exit1': note({ event: 'end' }); process.stderr.write('boom\n'); process.exit(1); break;
    case 'hang': {
      // A grandchild in the same process group proves the runner kills the whole group.
      const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      note({ event: 'child', child: c.pid });
      setInterval(() => {}, 1000);
      return;
    }
    default: return out(envelope(`unknown fake mode ${mode}`));
  }
}
