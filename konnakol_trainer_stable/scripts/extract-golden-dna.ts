import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type EvalRow = {
  file: string;
  seed: number;
  aestheticScore: number;
  verdict: string;
  criticalErrors?: string[];
};

type MacroEval = {
  runId: string;
  rows?: EvalRow[];
};

type BarLog = {
  mutationKind?: string;
  totalCells?: number;
  isTihaiPart?: boolean;
  phraseStep?: number;
  syllables?: string[];
  aestheticDiagnostics?: {
    eduppu?: {
      entryMod8?: number;
    };
  };
};

type LessonLog = {
  bars?: BarLog[];
  summary?: {
    tihaiAudit?: {
      window?: { fromBar?: number; toBar?: number };
    };
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const logsDir = path.join(projectRoot, 'logs');
const dnaOutPath = path.join(logsDir, 'golden-dna.json');

function normalizeTok(raw: string): string {
  return raw.trim().replace(/\*+$/u, '').replace(/\(.*?\)/gu, '').trim();
}

function isRest(raw: string): boolean {
  const s = normalizeTok(raw).toLowerCase();
  return s === '' || s === '-' || s === '—' || s === '.';
}

function topNFromMap(map: Map<string, number>, n: number): Array<{ key: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

function isMusicVerdict(v: string): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'музыка' || s === 'music';
}

function resolveSampleWeight(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score >= 100) return 1.0;
  if (score >= 90) return 0.9;
  if (score >= 80) return 0.75;
  return 0;
}

function normalizeWeightMap(raw: Record<string, number>): Record<string, number> {
  const clean = Object.entries(raw).filter(([, v]) => Number.isFinite(v) && v > 0);
  const total = clean.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) return {};
  return Object.fromEntries(clean.map(([k, v]) => [k, Number((v / total).toFixed(4))]));
}

function capAndRenormalizeWeights(
  raw: Record<string, number>,
  caps: Record<string, number>,
): Record<string, number> {
  const src = normalizeWeightMap(raw);
  if (Object.keys(src).length === 0) return {};
  const out: Record<string, number> = { ...src };
  for (let i = 0; i < 8; i++) {
    let overflow = 0;
    const uncapped: string[] = [];
    for (const [k, v] of Object.entries(out)) {
      const cap = caps[k];
      if (Number.isFinite(cap) && cap >= 0 && v > cap) {
        overflow += v - cap;
        out[k] = cap;
      } else {
        uncapped.push(k);
      }
    }
    if (overflow <= 1e-9) break;
    const uncappedSum = uncapped.reduce((s, k) => s + (out[k] ?? 0), 0);
    if (uncappedSum <= 1e-12) break;
    for (const k of uncapped) out[k] = (out[k] ?? 0) + (overflow * (out[k] ?? 0)) / uncappedSum;
  }
  return normalizeWeightMap(out);
}

function detectBridgeEduppuCombo(lesson: LessonLog): { bridgeLen: number; shiftLabel: string } | null {
  const bars = lesson.bars;
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const fromBar = lesson.summary?.tihaiAudit?.window?.fromBar;
  const tihaiStartIdx = typeof fromBar === 'number' && fromBar > 0 ? fromBar - 1 : bars.findIndex((b) => b.isTihaiPart === true);
  if (tihaiStartIdx < 0 || !bars[tihaiStartIdx]) return null;
  const mod = bars[tihaiStartIdx]!.aestheticDiagnostics?.eduppu?.entryMod8;
  if (typeof mod !== 'number' || !Number.isFinite(mod)) return null;
  const m = ((Math.floor(mod) % 8) + 8) % 8;
  const shiftLabel = m === 0 ? 'Sam (0)' : `+${m}`;
  let bridgeLen = 0;
  for (let i = tihaiStartIdx - 1; i >= 0; i--) {
    const b = bars[i];
    if (!b) continue;
    if (b.mutationKind === 'resync_bridge' && typeof b.totalCells === 'number' && b.totalCells > 0) {
      bridgeLen = Math.floor(b.totalCells);
      break;
    }
  }
  if (bridgeLen <= 0) return null;
  return { bridgeLen, shiftLabel };
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const shouldSave = args.includes('--save');

  const names = await readdir(logsDir);
  const evalFiles = names.filter((n) => /^macro-eval-.*\.json$/i.test(n));

  const idealRows: Array<EvalRow & { evalFile: string; sampleWeight: number }> = [];
  for (const name of evalFiles) {
    const parsed = await readJson<MacroEval>(path.join(logsDir, name));
    if (!parsed?.rows) continue;
    for (const row of parsed.rows) {
      const score = Number(row.aestheticScore);
      const weight = resolveSampleWeight(score);
      if (weight > 0 && isMusicVerdict(row.verdict)) {
        idealRows.push({ ...row, evalFile: name, sampleWeight: weight });
      }
    }
  }

  const bridgeLenCount = new Map<string, number>();
  const eduppuShiftCount = new Map<string, number>();
  const tihaiSyllableCount = new Map<string, number>();
  const comboTotals = new Map<string, number>();
  const comboWeakEnding = new Map<string, number>();
  const motifLengths: number[] = [];

  let loadedLessons = 0;
  for (const row of idealRows) {
    const lessonPath = path.join(logsDir, row.file);
    const lesson = await readJson<LessonLog>(lessonPath);
    if (!lesson?.bars || lesson.bars.length === 0) continue;
    loadedLessons++;
    const bars = lesson.bars;

    for (const b of bars) {
      if (b.mutationKind === 'resync_bridge' && typeof b.totalCells === 'number' && b.totalCells > 0) {
        const k = String(Math.floor(b.totalCells));
        bridgeLenCount.set(k, (bridgeLenCount.get(k) ?? 0) + row.sampleWeight);
      }
    }

    const fromBar = lesson.summary?.tihaiAudit?.window?.fromBar;
    const tihaiStartIdx = typeof fromBar === 'number' && fromBar > 0 ? fromBar - 1 : bars.findIndex((b) => b.isTihaiPart === true);
    if (tihaiStartIdx >= 0 && bars[tihaiStartIdx]) {
      const mod = bars[tihaiStartIdx]!.aestheticDiagnostics?.eduppu?.entryMod8;
      if (typeof mod === 'number' && Number.isFinite(mod)) {
        const m = ((Math.floor(mod) % 8) + 8) % 8;
        const label = m === 0 ? 'Sam (0)' : `+${m}`;
        eduppuShiftCount.set(label, (eduppuShiftCount.get(label) ?? 0) + row.sampleWeight);
      }
    }

    const motifBar = bars.find(
      (b) =>
        b.isTihaiPart === true &&
        b.mutationKind === 'tihai' &&
        b.phraseStep === 0 &&
        Array.isArray(b.syllables) &&
        b.syllables.some((t) => !isRest(t)),
    );
    if (motifBar && typeof motifBar.totalCells === 'number' && motifBar.totalCells > 0) {
      motifLengths.push(Math.floor(motifBar.totalCells));
    }

    for (const b of bars) {
      if (b.isTihaiPart !== true || !Array.isArray(b.syllables)) continue;
      for (const tok of b.syllables) {
        if (isRest(tok)) continue;
        const norm = normalizeTok(tok);
        if (!norm) continue;
        tihaiSyllableCount.set(norm, (tihaiSyllableCount.get(norm) ?? 0) + row.sampleWeight);
      }
    }
  }

  // Anti-pattern mining: build "bad combo" stats from all evaluated rows.
  for (const name of evalFiles) {
    const parsed = await readJson<MacroEval>(path.join(logsDir, name));
    if (!parsed?.rows) continue;
    for (const row of parsed.rows) {
      if (!row.file) continue;
      const lesson = await readJson<LessonLog>(path.join(logsDir, row.file));
      if (!lesson) continue;
      const combo = detectBridgeEduppuCombo(lesson);
      if (!combo) continue;
      const key = `${combo.bridgeLen}|${combo.shiftLabel}`;
      comboTotals.set(key, (comboTotals.get(key) ?? 0) + 1);
      const hasWeakEnding = Array.isArray(row.criticalErrors) && row.criticalErrors.includes('WEAK_ENDING');
      if (hasWeakEnding) {
        comboWeakEnding.set(key, (comboWeakEnding.get(key) ?? 0) + 1);
      }
    }
  }

  const badComboEntries = [...comboTotals.entries()]
    .map(([key, total]) => {
      const weak = comboWeakEnding.get(key) ?? 0;
      const failRate = total > 0 ? weak / total : 0;
      return { key, total, weak, failRate };
    })
    .filter((x) => x.total >= 5 && x.failRate >= 0.8)
    .sort((a, b) => b.failRate - a.failRate || b.total - a.total || a.key.localeCompare(b.key));
  const bridgeEduppuPenalty = Object.fromEntries(
    badComboEntries.map((x) => [x.key, Number(x.failRate.toFixed(4))]),
  );

  const avgMotif =
    motifLengths.length > 0
      ? Number((motifLengths.reduce((a, b) => a + b, 0) / motifLengths.length).toFixed(2))
      : 0;

  const totalBridge = [...bridgeLenCount.values()].reduce((a, b) => a + b, 0);
  const totalEduppu = [...eduppuShiftCount.values()].reduce((a, b) => a + b, 0);
  const totalSyllables = [...tihaiSyllableCount.values()].reduce((a, b) => a + b, 0);

  const bridgeWeightsRaw = Object.fromEntries(
    [...bridgeLenCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, totalBridge > 0 ? Number((v / totalBridge).toFixed(4)) : 0]),
  );
  const eduppuWeightsRaw = Object.fromEntries(
    [...eduppuShiftCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, totalEduppu > 0 ? Number((v / totalEduppu).toFixed(4)) : 0]),
  );
  const syllableWeightsRaw = Object.fromEntries(
    [...tihaiSyllableCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, totalSyllables > 0 ? Number((v / totalSyllables).toFixed(4)) : 0]),
  );
  // Diversity guard: prevent single leader collapse (Bridge 7 / Ta monoculture).
  const bridgeWeights = capAndRenormalizeWeights(bridgeWeightsRaw, { '7': 0.34 });
  const eduppuWeights = normalizeWeightMap(eduppuWeightsRaw);
  const syllableWeights = capAndRenormalizeWeights(syllableWeightsRaw, { Ta: 0.32 });
  const bridgeVals = Object.values(bridgeWeights);
  const syllVals = Object.values(syllableWeights);
  const bridgeAvg = bridgeVals.length > 0 ? bridgeVals.reduce((a, b) => a + b, 0) / bridgeVals.length : 0;
  const syllAvg = syllVals.length > 0 ? syllVals.reduce((a, b) => a + b, 0) / syllVals.length : 0;
  const dominancePenalty = {
    bridgeLength: {
      '7': bridgeAvg > 0 && (bridgeWeights['7'] ?? 0) > bridgeAvg * 2 ? 0.7 : 1.0,
      '5': bridgeAvg > 0 && (bridgeWeights['5'] ?? 0) > bridgeAvg * 2 ? 0.7 : 1.0,
    },
    tihaiSyllable: {
      Ta: syllAvg > 0 && (syllableWeights['Ta'] ?? 0) > syllAvg * 2 ? 0.7 : 1.0,
    },
  };

  const result = {
    source: {
      logsDir,
      macroEvalFiles: evalFiles.length,
      idealRows: idealRows.length,
      lessonsLoaded: loadedLessons,
      filter: 'score>=80 AND verdict in {Музыка, Music}',
      weighting: { score100: 1.0, score90to99: 0.9, score80to89: 0.75 },
      antiFilter: 'combo total>=5 AND WEAK_ENDING_rate>=0.8',
      diversityCaps: { bridge7Max: 0.34, taMax: 0.32 },
    },
    topResyncBridgeLengths: topNFromMap(bridgeLenCount, 3).map((x) => ({
      pulses: Number(x.key),
      count: x.count,
    })),
    topEduppuShifts: topNFromMap(eduppuShiftCount, 3).map((x) => ({
      shift: x.key,
      count: x.count,
    })),
    avgTihaiBaseMotifLength: avgMotif,
    tihaiSyllableFrequency: topNFromMap(tihaiSyllableCount, 50).map((x) => ({
      syllable: x.key,
      count: x.count,
    })),
    weights: {
      bridgeLength: bridgeWeights,
      eduppuShift: eduppuWeights,
      tihaiSyllable: syllableWeights,
      bridgeEduppuPenalty,
      dominancePenalty,
    },
    topWeakEndingCombos: badComboEntries.slice(0, 10).map((x) => ({
      combo: x.key,
      weakEndingRate: Number(x.failRate.toFixed(4)),
      weakEndingCount: x.weak,
      totalCount: x.total,
    })),
  };

  if (shouldSave) {
    await writeFile(dnaOutPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(result, null, 2));
  if (shouldSave) {
    console.log(`saved: ${dnaOutPath}`);
  }
}

run().catch((err) => {
  console.error('[extract-golden-dna] failed:', err);
  process.exitCode = 1;
});
