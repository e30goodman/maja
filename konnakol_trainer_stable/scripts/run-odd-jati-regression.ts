import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

type FormPresetId = 'random' | 'tihai_heavy' | 'progressive' | 'call_fill';
type MacroLogResult = { seed: number; fileName: string; text: string; debugJson: string };
type ExpectedCase = {
	seed: number;
	expectedVerdict: 'Музыка' | 'Расчет';
	expectedCriticalErrors?: string[];
	note?: string;
};
type ExpectedFile = {
	preset?: FormPresetId;
	cases: ExpectedCase[];
};
type DebugPayload = {
	summary?: {
		tihaiAudit?: {
			verdict?: string;
			criticalErrors?: string[];
			aestheticScore?: number;
		};
	};
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const logsDir = path.join(projectRoot, 'logs');
const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const headless = process.env.MACRO_HEADLESS !== 'false';
const expectedPath = path.join(projectRoot, 'regression', 'odd-jati.expected.json');
const outName = `odd-jati-regression-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

function verdictFromPayload(payload: DebugPayload): 'Музыка' | 'Расчет' {
	const v = payload.summary?.tihaiAudit?.verdict;
	return v === 'Музыка' ? 'Музыка' : 'Расчет';
}

async function run(): Promise<void> {
	const expected = JSON.parse(await readFile(expectedPath, 'utf8')) as ExpectedFile;
	const preset: FormPresetId = expected.preset ?? 'progressive';
	const seeds = expected.cases.map((c) => c.seed >>> 0).slice(0, 50);
	if (seeds.length === 0) throw new Error('odd-jati.expected.json has no cases');

	const browser = await chromium.launch({ headless });
	try {
		const page = await browser.newPage();
		await page.goto(appUrl, { waitUntil: 'networkidle' });
		await page.waitForFunction(
			() =>
				typeof (window as unknown as { __konnakolDebug?: { runParentProgressiveMacroSeedBatch?: unknown } }).__konnakolDebug
					?.runParentProgressiveMacroSeedBatch === 'function',
			undefined,
			{ timeout: 60_000 },
		);
		const logs = await page.evaluate(async ({ replaySeeds, presetId }: { replaySeeds: number[]; presetId: FormPresetId }) => {
			const api = (window as unknown as {
				__konnakolDebug?: {
					runParentProgressiveMacroSeedBatch?: (s: number[], p?: FormPresetId) => Promise<MacroLogResult[]>;
				};
			}).__konnakolDebug;
			if (!api?.runParentProgressiveMacroSeedBatch) throw new Error('seed macro API is not available');
			return api.runParentProgressiveMacroSeedBatch(replaySeeds, presetId);
		}, { replaySeeds: seeds, presetId: preset });

		const bySeed = new Map<number, MacroLogResult>();
		for (const item of logs) bySeed.set(item.seed >>> 0, item);
		const results = expected.cases.map((testCase) => {
			const hit = bySeed.get(testCase.seed >>> 0);
			if (!hit) {
				return {
					seed: testCase.seed >>> 0,
					ok: false,
					reason: 'missing log for seed',
					expectedVerdict: testCase.expectedVerdict,
				};
			}
			const payload = JSON.parse(hit.debugJson) as DebugPayload;
			const actualVerdict = verdictFromPayload(payload);
			const actualErrors = payload.summary?.tihaiAudit?.criticalErrors ?? [];
			const expectErrors = testCase.expectedCriticalErrors ?? [];
			const errorsMatch =
				expectErrors.length === 0 ||
				(expectErrors.length === actualErrors.length &&
					expectErrors.every((e, i) => e === actualErrors[i]));
			const verdictMatch = actualVerdict === testCase.expectedVerdict;
			return {
				seed: testCase.seed >>> 0,
				ok: verdictMatch && errorsMatch,
				expectedVerdict: testCase.expectedVerdict,
				actualVerdict,
				expectedCriticalErrors: expectErrors,
				actualCriticalErrors: actualErrors,
				aestheticScore: payload.summary?.tihaiAudit?.aestheticScore ?? 0,
				note: testCase.note,
			};
		});

		const failed = results.filter((r) => !r.ok);
		await mkdir(logsDir, { recursive: true });
		await writeFile(path.join(logsDir, outName), `${JSON.stringify({ preset, results, failed: failed.length }, null, 2)}\n`, 'utf8');
		console.log(`saved: ${outName}`);
		console.log(`cases=${results.length}, failed=${failed.length}`);
		if (failed.length > 0) process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

run().catch((err) => {
	console.error('[regression:odd-jati] failed:', err);
	process.exitCode = 1;
});
