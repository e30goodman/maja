import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';

type MacroLogResult = {
	seed: number;
	fileName: string;
	text: string;
	debugJson: string;
};

type FormPresetId = 'random' | 'tihai_heavy' | 'progressive' | 'call_fill';
type SeedEntry = { seed: number; preset?: FormPresetId; note?: string };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const logsDir = path.join(projectRoot, 'logs');
const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const countRaw = Number.parseInt(process.env.MACRO_COUNT ?? '5', 10);
const macroCount = Number.isFinite(countRaw) ? Math.max(1, Math.min(50, countRaw)) : 5;
const headless = process.env.MACRO_HEADLESS !== 'false';
const presetFromEnv = (process.env.MACRO_PRESET ?? 'tihai_heavy').trim() as FormPresetId;
const validPresets: readonly FormPresetId[] = ['random', 'tihai_heavy', 'progressive', 'call_fill'];
const macroPreset: FormPresetId = validPresets.includes(presetFromEnv) ? presetFromEnv : 'tihai_heavy';
const replaySeedsFile = process.env.MACRO_REPLAY_SEEDS_FILE?.trim() ?? '';
const saveSeedsFile = process.env.MACRO_SAVE_SEEDS_FILE?.trim() ?? '';
const bridgeWhitelistEnv = process.env.MACRO_BRIDGE_WHITELIST?.trim() ?? '';

function normalizeSeedInput(raw: unknown): number[] {
	if (!Array.isArray(raw)) return [];
	const out: number[] = [];
	for (const item of raw) {
		if (typeof item === 'number' && Number.isFinite(item)) {
			out.push(Math.floor(item) >>> 0);
			continue;
		}
		if (typeof item === 'object' && item !== null && 'seed' in item) {
			const val = (item as SeedEntry).seed;
			if (typeof val === 'number' && Number.isFinite(val)) {
				out.push(Math.floor(val) >>> 0);
			}
		}
	}
	return out.slice(0, 50);
}

function readReplaySeeds(filePath: string): number[] {
	if (!filePath) return [];
	const full = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
	if (!existsSync(full)) throw new Error(`replay seed file not found: ${full}`);
	const parsed = JSON.parse(readFileSync(full, 'utf8')) as unknown;
	const raw = typeof parsed === 'object' && parsed !== null && 'seeds' in parsed
		? (parsed as { seeds?: unknown }).seeds
		: parsed;
	const seeds = normalizeSeedInput(raw);
	if (seeds.length === 0) throw new Error(`no valid seeds in replay file: ${full}`);
	return seeds;
}

function parseBridgeWhitelist(raw: string): number[] {
	if (!raw) return [];
	const vals = raw
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.filter((n) => Number.isFinite(n))
		.map((n) => Math.max(1, Math.min(9, Math.floor(n))));
	return [...new Set(vals)];
}

async function saveSeedsSnapshot(filePath: string, preset: FormPresetId, logs: readonly MacroLogResult[]): Promise<void> {
	if (!filePath || logs.length === 0) return;
	const full = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
	const payload = {
		preset,
		count: logs.length,
		seeds: logs.map((l) => ({ seed: l.seed })),
	};
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function stamp(): string {
	const d = new Date();
	const yy = String(d.getFullYear());
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	const hh = String(d.getHours()).padStart(2, '0');
	const mi = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	return `${yy}${mm}${dd}-${hh}${mi}${ss}`;
}

async function openAppWithRetry(page: import('playwright').Page, url: string): Promise<void> {
	const attempts = 3;
	for (let i = 1; i <= attempts; i++) {
		try {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
			return;
		} catch (err) {
			if (i >= attempts) throw err;
			console.warn(`[macro] goto attempt ${i}/${attempts} failed, retrying...`);
			await page.waitForTimeout(1_500);
		}
	}
}

async function run(): Promise<void> {
	await mkdir(logsDir, { recursive: true });
	const browser = await chromium.launch({ headless });
	try {
		const page = await browser.newPage();
		const bridgeWhitelist = parseBridgeWhitelist(bridgeWhitelistEnv);
		if (bridgeWhitelist.length > 0) {
			await page.addInitScript((list) => {
				(window as unknown as { __macroBridgeWhitelist?: number[] }).__macroBridgeWhitelist = list;
			}, bridgeWhitelist);
			console.log(`[macro] bridge whitelist active: ${bridgeWhitelist.join(',')}`);
		}
		await openAppWithRetry(page, appUrl);
		await page.waitForFunction(
			() =>
				typeof (window as unknown as { __konnakolDebug?: { runParentProgressiveMacroBatch?: unknown } }).__konnakolDebug
					?.runParentProgressiveMacroBatch === 'function',
			undefined,
			{ timeout: 60_000 },
		);
		const replaySeeds = readReplaySeeds(replaySeedsFile);
		const logs = await page.evaluate(async ({ count, preset, seeds }: { count: number; preset: FormPresetId; seeds: number[] }) => {
			const api = (window as unknown as {
				__konnakolDebug?: {
					runParentProgressiveMacroBatch?: (n?: number, p?: FormPresetId) => Promise<MacroLogResult[]>;
					runParentProgressiveMacroSeedBatch?: (s: number[], p?: FormPresetId) => Promise<MacroLogResult[]>;
				};
			}).__konnakolDebug;
			if (!api?.runParentProgressiveMacroBatch) throw new Error('Debug macro API is not available');
			if (seeds.length > 0) {
				if (!api.runParentProgressiveMacroSeedBatch) {
					throw new Error('Debug macro seed replay API is not available');
				}
				return api.runParentProgressiveMacroSeedBatch(seeds, preset);
			}
			return api.runParentProgressiveMacroBatch(count, preset);
		}, { count: macroCount, preset: macroPreset, seeds: replaySeeds });
		const runId = stamp();
		for (let i = 0; i < logs.length; i++) {
			const item = logs[i]!;
			const idx = String(i + 1).padStart(2, '0');
			const safeName = item.fileName.replace(/\.txt$/i, '');
			const outName = `${safeName}__macro-${runId}-${idx}.txt`;
			const outPath = path.join(logsDir, outName);
			const outJsonName = outName.replace(/\.txt$/i, '.json');
			const outJsonPath = path.join(logsDir, outJsonName);
			await writeFile(outPath, item.text, 'utf8');
			await writeFile(outJsonPath, item.debugJson, 'utf8');
			console.log(`saved: ${outName}`);
		}
		await saveSeedsSnapshot(saveSeedsFile, macroPreset, logs);
		console.log(`done: ${logs.length} logs (${macroPreset}) -> ${logsDir}`);
	} finally {
		await browser.close();
	}
}

run().catch((err) => {
	console.error('[macro] failed:', err);
	process.exitCode = 1;
});

