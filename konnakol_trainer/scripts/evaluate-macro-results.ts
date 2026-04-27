import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type TihaiAudit = {
  aestheticScore?: number;
  criticalErrors?: string[];
  verdict?: 'Музыка' | 'Расчет' | string;
};

type DebugPayload = {
  meta?: { seed?: number; formPresetId?: string };
  summary?: { tihaiAudit?: TihaiAudit };
};

type EvalRow = {
  file: string;
  seed: number;
  aestheticScore: number;
  criticalErrors: string[];
  verdict: 'Музыка' | 'Расчет';
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const logsDir = path.join(projectRoot, 'logs');
const forcedRunId = (process.env.MACRO_RUN_ID ?? '').trim();
const outBaseName = (process.env.MACRO_EVAL_NAME ?? '').trim();

const CRITICAL_CODES = new Set([
  'TIHAI_MORPH_ERROR',
  'TIHAI_GEOMETRY_FAIL',
  'WEAK_ENDING',
  'PRASA_PARENT_BREAK',
]);

function extractRunId(name: string): string | null {
  const m = name.match(/__macro-(\d{8}-\d{6})-\d{2}\.json$/i);
  return m ? m[1] : null;
}

function forcedVerdict(audit: TihaiAudit | undefined): 'Музыка' | 'Расчет' {
  const errs = Array.isArray(audit?.criticalErrors) ? audit.criticalErrors : [];
  const hasCritical = errs.some((e) => CRITICAL_CODES.has(e));
  return hasCritical ? 'Расчет' : 'Музыка';
}

async function pickRunFiles(): Promise<{ runId: string; files: string[] }> {
  const names = await readdir(logsDir);
  const jsonFiles = names.filter((n) => n.toLowerCase().endsWith('.json') && n.includes('__macro-'));
  const grouped = new Map<string, string[]>();
  for (const name of jsonFiles) {
    const runId = extractRunId(name);
    if (!runId) continue;
    const bucket = grouped.get(runId) ?? [];
    bucket.push(name);
    grouped.set(runId, bucket);
  }
  if (grouped.size === 0) throw new Error(`macro json logs not found in ${logsDir}`);
  const runId = forcedRunId || [...grouped.keys()].sort().at(-1)!;
  const files = (grouped.get(runId) ?? []).sort();
  if (files.length === 0) throw new Error(`run id "${runId}" not found in ${logsDir}`);
  return { runId, files };
}

async function run(): Promise<void> {
  const { runId, files } = await pickRunFiles();
  const rows: EvalRow[] = [];
  for (const name of files) {
    const full = path.join(logsDir, name);
    const parsed = JSON.parse(await readFile(full, 'utf8')) as DebugPayload;
    const audit = parsed.summary?.tihaiAudit;
    const verdict = forcedVerdict(audit);
    rows.push({
      file: name,
      seed: Number(parsed.meta?.seed ?? 0) >>> 0,
      aestheticScore: Number(audit?.aestheticScore ?? 0),
      criticalErrors: Array.isArray(audit?.criticalErrors) ? audit.criticalErrors : [],
      verdict,
    });
  }
  const music = rows.filter((r) => r.verdict === 'Музыка').length;
  const calc = rows.length - music;
  const summary = {
    runId,
    total: rows.length,
    verdicts: { music, calculation: calc },
    rows,
  };
  const outPrefix = outBaseName || `macro-eval-${runId}`;
  await mkdir(logsDir, { recursive: true });
  await writeFile(path.join(logsDir, `${outPrefix}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  const mdLines = [
    `# Macro evaluation (${runId})`,
    '',
    `- Total: ${rows.length}`,
    `- Музыка: ${music}`,
    `- Расчет: ${calc}`,
    '',
    '| File | Seed | Score | Critical Errors | Verdict |',
    '|------|------|------:|-----------------|---------|',
    ...rows.map((r) => `| ${r.file} | ${r.seed} | ${r.aestheticScore} | ${r.criticalErrors.join(', ') || 'none'} | ${r.verdict} |`),
    '',
  ];
  await writeFile(path.join(logsDir, `${outPrefix}.md`), `${mdLines.join('\n')}\n`, 'utf8');
  console.log(`evaluated: ${rows.length} files (run=${runId})`);
  console.log(`saved: ${outPrefix}.json, ${outPrefix}.md`);
}

run().catch((err) => {
  console.error('[macro:evaluate] failed:', err);
  process.exitCode = 1;
});

