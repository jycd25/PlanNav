#!/usr/bin/env node
// PlanNav friction benchmark. Read-only during experiment runs: scenarios, dialogues, weights and scorer are frozen.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { runScenario } from './src/replay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const weights = JSON.parse(readFileSync(join(here, 'weights.json'), 'utf8'));
const only = opt('--only');
const fmt = (n, d = 1) => (Number.isInteger(n) ? String(n) : n.toFixed(d));

// The default set is the instance scenarios (the baseline week and its operations); --suggest runs the from-scratch
// planner scenarios (plan_schedule, the suggest path when no baseline exists) under scenarios/suggest/.
const set = flag('--suggest') ? 'suggest' : 'instance';
const scenarioDir = set === 'suggest' ? join(here, 'scenarios', 'suggest') : join(here, 'scenarios');
const scenarioFiles = readdirSync(scenarioDir).filter((f) => f.endsWith('.json') && (!only || f.includes(only))).sort();
const scenarioRuns = [];
for (const f of scenarioFiles) {
  const scenario = JSON.parse(readFileSync(join(scenarioDir, f), 'utf8'));
  const run = await runScenario(scenario, weights, { dir: scenarioDir });
  scenarioRuns.push(run);
  const s = run.summary;
  console.log(`  ${run.name.padEnd(28)} friction ${fmt(s.friction).padStart(6)}  churn ${s.churn.toFixed(2)}  holes ${fmt(s.holes, 0).padStart(4)}  blobs ${fmt(s.blobs, 0).padStart(4)}  splinters ${fmt(s.splinters)}  off_seg ${fmt(s.off_segment, 0).padStart(4)}  miss ${fmt(s.budget_miss, 0).padStart(4)}  mustdo ${fmt(s.must_do_miss, 0).padStart(3)}  switches ${fmt(s.switches)}  late ${fmt(s.late_start, 0).padStart(4)}  consist ${fmt(s.consistency)}  p95 ${fmt(s.p95_ms, 0)}ms  hard ${s.hard}  under ${s.under_commitment}${s.errors ? `  errors ${s.errors}` : ''}`);
  for (const r of run.results) if (r.error) console.log(`      ! ${r.event}: ${r.error}`);
  for (const r of run.results) for (const h of r.hard ?? []) console.log(`      ! ${r.event}: ${h.kind} (${h.block})`);
  if (flag('--timelines')) for (const line of run.timelines) console.log(`      ${line}`);
}
const n = scenarioRuns.length || 1;
const mean = (k) => scenarioRuns.reduce((a, r) => a + r.summary[k], 0) / n;
const crashA = scenarioRuns.reduce((a, r) => a + r.summary.hard + r.summary.errors + r.summary.slow, 0);
const p95 = Math.max(0, ...scenarioRuns.map((r) => r.summary.p95_ms));
console.log('');
console.log(`set ${set}: ${scenarioRuns.length} scenario${scenarioRuns.length === 1 ? '' : 's'} (${set === 'suggest' ? 'scenarios/suggest/, from-scratch planning' : 'scenarios/, baseline week and instance operations; --suggest for the from-scratch set'})`);
const under = scenarioRuns.reduce((a, r) => a + r.summary.under_commitment, 0);
console.log(`A  friction ${mean('friction').toFixed(1)}  churn ${mean('churn').toFixed(2)}  holes ${mean('holes').toFixed(0)}  blobs ${mean('blobs').toFixed(0)}  splinters ${mean('splinters').toFixed(1)}  off_segment ${mean('off_segment').toFixed(0)}  budget_miss ${mean('budget_miss').toFixed(0)}  must_do_miss ${mean('must_do_miss').toFixed(0)}  switches ${mean('switches').toFixed(1)}  late_start ${mean('late_start').toFixed(0)}  consistency ${mean('consistency').toFixed(1)}  p95 ${p95.toFixed(0)}ms  crash ${crashA}  under ${under}`);

if (flag('--dialogue')) {
  let hasClaude = true;
  try { execSync('which claude', { stdio: 'ignore' }); } catch { hasClaude = false; }
  if (!hasClaude) {
    console.log('B  skipped: claude CLI not found');
  } else {
    const { runDialogue, aggregateDialogues } = await import('./src/dialogue.mjs');
    const files = readdirSync(join(here, 'dialogues')).filter((f) => f.endsWith('.json') && (!only || f.includes(only))).sort();
    const runs = [];
    for (const f of files) {
      const file = join(here, 'dialogues', f);
      const dialogue = JSON.parse(readFileSync(file, 'utf8'));
      const run = await runDialogue(dialogue, { model: opt('--model') ?? 'sonnet', file });
      runs.push(run);
      const correct = run.turns.filter((t) => t.correct).length;
      const per = (k, d = 1) => run.turns.map((t) => (t[k] === undefined ? '-' : t[k].toFixed(d))).join('/');
      console.log(`  ${run.name.padEnd(28)} ${correct}/${run.turns.length} turns correct  unrequested ${run.turns.reduce((a, t) => a + t.unrequested, 0)}  words ${run.turns.map((t) => t.words).join('/')}  latency ${run.turns.map((t) => t.latency_s.toFixed(1)).join('/')}s  ttft ${per('ttft_s')}s  api ${per('api_s')}s  rounds ${per('rounds', 0)}  cache_create ${run.turns.map((t) => (t.cache_create === undefined ? '-' : `${Math.round(t.cache_create / 1000)}k`)).join('/')}${run.turns.some((t) => t.direct) ? `  direct ${run.turns.filter((t) => t.direct).length}` : ''}`);
      for (const t of run.turns) if (!t.correct) console.log(`      ! turn ${t.index} "${t.user.slice(0, 50)}": called [${t.calls.join(', ')}]${t.error ? ` error: ${t.error}` : ''}`);
      if (flag('--transcript')) for (const t of run.turns) console.log(`      > ${t.user}\n      < ${t.text}`);
    }
    const b = aggregateDialogues(runs);
    console.log('');
    console.log(`B  tool_acc ${b.tool_acc.toFixed(2)}  unrequested ${b.unrequested}  words_med ${b.words_med}  words_max ${b.words_max}  questions_max ${b.questions_max}  setup_turns ${b.setup_turns ?? '-'}  latency_med ${b.latency_med_s.toFixed(1)}s  latency_p90 ${b.latency_p90_s.toFixed(1)}s  ttft_med ${b.ttft_med_s.toFixed(1)}s  rounds_med ${b.rounds_med}  overhead_med ${b.overhead_med_s.toFixed(1)}s  cache_create_med ${Math.round(b.cache_create_med / 1000)}k  direct ${b.direct}  crash ${b.crash}`);
  }
}
