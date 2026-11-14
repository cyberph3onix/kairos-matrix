// GET /api/pipeline/benchmark: parses the newest committed report of each kind from
// backend/benchmarks/e2e/reports (written by the existing benchmark framework, `pnpm benchmark:e2e`)
// into JSON. Numbers are copied from those files, never computed or invented here.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIRS = [path.resolve(here, '../../benchmarks/e2e/reports'), path.resolve(process.cwd(), 'benchmarks/e2e/reports')];

function latest(dir: string, kind: string): string | null {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.md')).sort();
  return files.length ? files[files.length - 1] : null;
}

/** Parses every markdown table in a report into {heading, columns, rows}. */
function tables(md: string) {
  const out: { heading: string; columns: string[]; rows: string[][] }[] = [];
  const lines = md.split('\n');
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#')) heading = lines[i].replace(/^#+\s*/, '');
    if (lines[i].startsWith('|') && lines[i + 1]?.startsWith('| ---')) {
      const split = (l: string) => l.split('|').slice(1, -1).map((c) => c.trim());
      const columns = split(lines[i]);
      const rows: string[][] = [];
      let j = i + 2;
      while (lines[j]?.startsWith('|')) rows.push(split(lines[j++]));
      out.push({ heading, columns, rows });
      i = j;
    }
  }
  return out;
}
function field(md: string, label: string): string | null {
  const m = md.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

export function loadBenchmarkSummary() {
  const dir = REPORT_DIRS.find((d) => fs.existsSync(d));
  if (!dir) throw new Error('benchmark reports directory not found');
  const reports: Record<string, unknown> = {};
  for (const kind of ['determinism', 'performance', 'reliability', 'concurrency']) {
    const file = latest(dir, kind);
    if (!file) continue;
    const md = fs.readFileSync(path.join(dir, file), 'utf8');
    const t = tables(md);
    const verdict = field(md, 'Overall verdict');
    const base = { file: `backend/benchmarks/e2e/reports/${file}`, generated: field(md, 'Generated'), verdict };
    if (kind === 'determinism') {
      reports[kind] = { ...base, iterations: field(md, 'Iterations'), successfulRuns: field(md, 'Successful runs'), failedRuns: field(md, 'Failed runs'), perStageHashStability: t[0]?.rows.map((r) => ({ stage: r[0], distinctHashes: Number(r[1]), deterministic: r[2] === 'yes' })), stageLatencyMs: t.find((x) => /Latency/.test(x.heading))?.rows.map((r) => ({ stage: r[0], avg: Number(r[1]), p95: Number(r[2]), p99: Number(r[3]) })) };
    } else if (kind === 'performance') {
      const seq = t.find((x) => /Sequential/.test(x.heading));
      const totals = md.match(/Total pipeline \(sequential\)[^\n]*/)?.[0] ?? null;
      reports[kind] = { ...base, sequentialTotal: totals, sequentialStageLatencyMs: seq?.rows.map((r) => ({ stage: r[0], avg: Number(r[1]), p95: Number(r[2]), p99: Number(r[3]) })) };
    } else if (kind === 'reliability') {
      reports[kind] = { ...base, scenarios: field(md, 'Scenarios'), passed: field(md, 'Passed \\(failed closed as expected\\)'), results: t[0]?.rows.map((r) => ({ scenario: r[0], category: r[1], result: r[2], detail: r[3] })) };
    } else {
      reports[kind] = { ...base, summary: t[0]?.rows.map((r) => ({ level: Number(r[0]), success: Number(r[1]), errors: Number(r[2]), crossContamination: r[3], dedupProbe: r[4] })) };
    }
  }
  return {
    framework: 'backend/benchmarks/e2e (pnpm benchmark:e2e) — stage hashes, latency, fault injection, concurrency',
    caveat: 'These committed reports run the full 11-stage pipeline with a deterministic stubbed LLM provider (benchmarks/e2e/fetchStub.ts), so latencies exclude real model time and measure the pipeline engines themselves. Live LLM latency per run appears in /api/pipeline/run stage timings.',
    reports,
  };
}
