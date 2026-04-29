/**
 * Parent Mode — наследственные мутации мотива.
 *
 * Контракт: один ParentGenome (1 или 2 такта) служит тематическим ядром, а каждый такт
 * плейлиста получает роль (`PhraseRole`) из расписания (`PhraseSchedule`). Роль говорит,
 * какой оператор мутации применять и какой "кадр" фразы возвращать.
 *
 * Этот модуль строго отделён от `randomLogic.ts`: free-random продолжает работать через
 * `applyRandomizerEffectsToBar`, а parent-mode — через `applyParentModeBar`. Маршрутизация
 * в `App.tsx` смотрит на `randomMode`.
 *
 * Phase 1: skeleton без реальных операторов — каждая роль, отличная от 'parent'/'free',
 * возвращает копию parent.bars[0]. Phase 2+ добавит настоящие мутации.
 */

import type { BarRandomizerMutable, RNG } from './randomLogic';
import { smoothstep01, applyRandomizerEffectsToBar } from './randomLogic';
import { computeNps, getSyllablesForGati, pickKalam, type Gati, type Kalam } from './sequencerLabels';

/** 13 типов наследственных мутаций + служебные 'parent' (чистая копия) и 'free' (free-random filler). */
export type MutationType =
	| 'substitution'
	| 'retrograde'
	| 'inversion'
	| 'rotation'
	| 'truncation'
	| 'augmentation'
	| 'diminution'
	| 'prepend_append'
	| 'fractal'
	| 'tihai'
	| 'echo_decay'
	| 'neighbour_pulsation'
	| 'call_fill'
	| 'yati';

export const ALL_MUTATION_TYPES: readonly MutationType[] = [
	'substitution',
	'retrograde',
	'inversion',
	'rotation',
	'truncation',
	'augmentation',
	'diminution',
	'prepend_append',
	'fractal',
	'tihai',
	'echo_decay',
	'neighbour_pulsation',
	'call_fill',
	'yati',
] as const;

/**
 * Длина фразы (число тактов), которую занимает каждый тип мутации. Scheduler
 * гарантирует, что фраза проигрывается целиком — никаких "половинок".
 *
 * Числа — см. §3 плана. Tihai: длина блока задаётся планировщиком (см. {@link computeTihaiBlockBarCount}). Augmentation/Diminution/
 * Rotation/Fractal/Neighbour = 3 (плавное развитие). Prepend/Echo/Call = 4. Truncation = 5.
 * Substitution/Retrograde/Inversion = 2 (одноходовка parent→variant).
 */
export const MUTATION_PHRASE_LEN: Record<MutationType, number> = {
	substitution: 2,
	retrograde: 2,
	inversion: 2,
	rotation: 3,
	truncation: 5,
	augmentation: 3,
	diminution: 3,
	prepend_append: 4,
	fractal: 3,
	tihai: 6,
	echo_decay: 4,
	neighbour_pulsation: 3,
	call_fill: 4,
	yati: 4,
};

/** Человекочитаемое имя для UI (короткое, влезает в чекбокс). */
export const MUTATION_LABEL: Record<MutationType, string> = {
	substitution: 'Substitution',
	retrograde: 'Retrograde',
	inversion: 'Inversion',
	rotation: 'Rotation',
	truncation: 'Truncation',
	augmentation: 'Augmentation',
	diminution: 'Diminution',
	prepend_append: 'Prepend/Append',
	fractal: 'Fractal',
	tihai: 'Tihai',
	echo_decay: 'Echo decay',
	neighbour_pulsation: 'Neighbour pulse',
	call_fill: 'Call & fill',
	yati: 'Yati',
};

/** Категории для группировки чекбоксов в UI (Phase 5). */
export type MutationCategory = 'structural' | 'pattern' | 'density' | 'meta';
export const MUTATION_CATEGORY: Record<MutationType, MutationCategory> = {
	tihai: 'structural',
	truncation: 'structural',
	prepend_append: 'structural',
	call_fill: 'structural',
	substitution: 'pattern',
	rotation: 'pattern',
	inversion: 'pattern',
	retrograde: 'pattern',
	augmentation: 'density',
	diminution: 'density',
	echo_decay: 'density',
	neighbour_pulsation: 'meta',
	fractal: 'meta',
	yati: 'density',
};

export type FormPresetId = 'random' | 'tihai_heavy' | 'progressive' | 'call_fill';

export const ALL_FORM_PRESETS: readonly FormPresetId[] = [
	'random',
	'tihai_heavy',
	'progressive',
	'call_fill',
] as const;

export const FORM_PRESET_LABEL: Record<FormPresetId, string> = {
	random: 'Random',
	tihai_heavy: 'Tihay',
	progressive: 'Progressive',
	call_fill: 'Call-fill',
};

/**
 * Полный слепок одного такта в parent-mode-формате. Позиции относительные (0..curSyl-1),
 * без префикса "r-". Это делает геномы переносимыми между барами.
 */
export type BarGenome = {
	curSyl: number;
	/** Индексы долей с акцентом. Сет — идентичная семантика с `accents: Set<"r-c">`. */
	accents: Set<number>;
	/** Поддоли (cell-speed): {cellIdx → subdiv ∈ [2,3,4]}. */
	subdivisions: Record<number, number>;
	/** Переопределение слога на доле (источник истины для UI/лога поверх словаря gati). */
	cellSyllables?: Record<number, string>;
	/** Начало dead-зоны внутри такта. Все клетки >= deadStart — мёртвые. */
	deadStart?: number;
};

const KARVAI_TOKEN = '-';
const SOFT_PHONETICS = ['Dhi', 'Mi', 'Nu', 'Ju'] as const;
const HARD_PHONETICS = ['Ta', 'Ki', 'Te', 'Thom'] as const;

type GoldenDnaLike = {
	weights?: {
		bridgeEduppuPenalty?: Record<string, number>;
		tihaiSyllable?: Record<string, number>;
		dominancePenalty?: {
			bridgeLength?: Record<string, number>;
			tihaiSyllable?: Record<string, number>;
		};
	};
};

let cachedGoldenDnaRef: unknown = undefined;
let cachedGoldenDna: GoldenDnaLike | null = null;

function getGoldenDna(): GoldenDnaLike | null {
	const maybeRef = (globalThis as unknown as { __goldenDna?: unknown }).__goldenDna;
	if (maybeRef === cachedGoldenDnaRef) return cachedGoldenDna;
	cachedGoldenDnaRef = maybeRef;
	if (!maybeRef || typeof maybeRef !== 'object') {
		cachedGoldenDna = null;
		return null;
	}
	cachedGoldenDna = maybeRef as GoldenDnaLike;
	return cachedGoldenDna;
}

function getBridgeEduppuPenalty(bridgePulses: number, shiftLabel: string): number {
	const penalties = getGoldenDna()?.weights?.bridgeEduppuPenalty;
	if (!penalties) return 0;
	const key = `${bridgePulses}|${shiftLabel}`;
	const raw = Number(penalties[key] ?? 0);
	if (!Number.isFinite(raw) || raw <= 0) return 0;
	return Math.max(0, Math.min(1, raw));
}

function getBridgeDominancePenalty(bridgePulses: number): number {
	const raw = Number(getGoldenDna()?.weights?.dominancePenalty?.bridgeLength?.[String(bridgePulses)] ?? 1);
	if (!Number.isFinite(raw) || raw <= 0) return 1;
	return Math.max(0.5, Math.min(1, raw));
}

function getSyllableDominancePenalty(token: string): number {
	const raw = Number(getGoldenDna()?.weights?.dominancePenalty?.tihaiSyllable?.[token] ?? 1);
	if (!Number.isFinite(raw) || raw <= 0) return 1;
	return Math.max(0.5, Math.min(1, raw));
}

const TIHAI_CONTEXT_ENTRY = ['Ta', 'Di', 'Na', 'Dhi'] as const;
const TIHAI_CONTEXT_MID = ['Di', 'Dhi', 'Mi', 'Na', 'Gi', 'Nu'] as const;
const TIHAI_CONTEXT_CADENCE = ['Ta', 'Dhin', 'Na', 'Mi', 'Ka'] as const;
const TIHAI_CONTEXT_FINAL_PREP = ['Ta', 'Dhin', 'Thom'] as const;

function contextBaseWeight(token: string, phase: 'entry' | 'mid' | 'cadence' | 'final_prep'): number {
	if (phase === 'entry') {
		if (token === 'Ta') return 1.2;
		if (token === 'Di' || token === 'Na') return 1.05;
		return 0.9;
	}
	if (phase === 'mid') {
		if (token === 'Thom') return 0.08;
		if (token === 'Ta') return 0.65;
		if (token === 'Dhi' || token === 'Mi' || token === 'Nu') return 1.2;
		return 1.0;
	}
	if (phase === 'cadence') {
		if (token === 'Dhin') return 1.25;
		if (token === 'Ta' || token === 'Na') return 1.05;
		if (token === 'Thom') return 0.35;
		return 0.95;
	}
	// final_prep
	if (token === 'Thom') return 1.5;
	if (token === 'Dhin') return 1.2;
	if (token === 'Ta') return 0.9;
	return 0.75;
}

function hash01(seed: number): number {
	const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
	return x - Math.floor(x);
}

function pickWeightedTokenBySeed(tokens: readonly string[], weights: readonly number[], seed: number): string {
	if (tokens.length === 0) return 'Ta';
	const cleanWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
	const total = cleanWeights.reduce((a, b) => a + b, 0);
	if (total <= 0) return tokens[Math.abs(seed) % tokens.length] ?? 'Ta';
	let r = hash01(seed) * total;
	for (let i = 0; i < tokens.length; i++) {
		r -= cleanWeights[i] ?? 0;
		if (r <= 0) return tokens[i] ?? 'Ta';
	}
	return tokens[tokens.length - 1] ?? 'Ta';
}

function pickContextualTihaiTokenBySeed(cellIdx: number, total: number, phraseId: number): string {
	const safeTotal = Math.max(1, total);
	const t = safeTotal <= 1 ? 1 : cellIdx / (safeTotal - 1);
	const phase: 'entry' | 'mid' | 'cadence' | 'final_prep' =
		t <= 0.2 ? 'entry' : t <= 0.72 ? 'mid' : t <= 0.9 ? 'cadence' : 'final_prep';
	const pool =
		phase === 'entry'
			? TIHAI_CONTEXT_ENTRY
			: phase === 'mid'
				? TIHAI_CONTEXT_MID
				: phase === 'cadence'
					? TIHAI_CONTEXT_CADENCE
					: TIHAI_CONTEXT_FINAL_PREP;
	const dnaWeights = getGoldenDna()?.weights?.tihaiSyllable ?? {};
	const weights = pool.map((tok) => {
		const dnaW = Math.max(0, Number(dnaWeights[tok] ?? 0));
		// Weaken leader collapse: DNA nudges, but should not dominate contextual phrasing.
		const dnaMul = dnaW > 0 ? 0.9 + Math.sqrt(Math.min(0.35, dnaW)) * 0.9 : 1.0;
		return contextBaseWeight(tok, phase) * dnaMul * getSyllableDominancePenalty(tok);
	});
	const seed = (phraseId >>> 0) * 131 + (cellIdx + 1) * 17 + safeTotal * 43;
	return pickWeightedTokenBySeed(pool, weights, seed);
}

function buildContextualTihaiFormula(phraseId: number, pulseLen: number): Record<number, string> {
	const out: Record<number, string> = {};
	const n = Math.max(1, pulseLen);
	for (let c = 0; c < n; c++) out[c] = pickContextualTihaiTokenBySeed(c, n, phraseId);
	enforceLegacySyllableAssembly(out, n, phraseId);
	enforceNoRepeatedTaRuns(out, phraseId, n);
	enforceNoRepeatedSyllableRuns(out, phraseId, n);
	enforceLegacySyllableAssembly(out, n, phraseId + 401);
	return out;
}

function normalizeTokLower(raw: string): string {
	return normalizeTokenClass(raw).toLowerCase();
}

function chooseLegacyKalamByEnergy(energy: number): Kalam {
	const e = Math.max(0, Math.min(1, energy));
	if (e >= 0.72) return 'fast';
	if (e >= 0.42) return 'medium';
	return 'slow';
}

function enforceLegacySyllableAssembly(cells: Record<number, string>, pulseLen: number, seedHint: number): void {
	const g = Math.max(1, Math.min(9, Math.floor(pulseLen)));
	const primary = chooseLegacyKalamByEnergy(Math.abs(Math.sin(seedHint)));
	const kalamOrder: Kalam[] =
		primary === 'slow' ? ['slow', 'medium', 'fast'] : primary === 'medium' ? ['medium', 'slow', 'fast'] : ['fast', 'medium', 'slow'];
	const baseKalam = kalamOrder[0] ?? 'medium';
	const basePhrase = getSyllablesForGati(g, baseKalam).slice(0, g);
	const alternatives = kalamOrder.slice(1).map((k) => getSyllablesForGati(g, k).slice(0, g));
	for (let i = 0; i < g; i++) {
		const current = normalizeTokLower(cells[i] ?? '');
		const allowed = new Set<string>([normalizeTokLower(basePhrase[i] ?? '')]);
		for (const alt of alternatives) allowed.add(normalizeTokLower(alt[i] ?? ''));
		if (!allowed.has(current)) {
			cells[i] = basePhrase[i] ?? 'Ta';
		}
	}
}

function enforceNoRepeatedTaRuns(cells: Record<number, string>, phraseId: number, total: number): void {
	const n = Math.max(1, total);
	let runStart = -1;
	for (let i = 0; i <= n; i++) {
		const tok = i < n ? normalizeTokenClass(cells[i] ?? '').toLowerCase() : '__end__';
		if (tok === 'ta') {
			if (runStart < 0) runStart = i;
			continue;
		}
		if (runStart >= 0) {
			const runLen = i - runStart;
			// Hard lock: forbid Ta-Ta-Ta... sequences (3+), including 3..9.
			if (runLen >= 3) {
				for (let p = runStart + 2; p < i; p += 2) {
					cells[p] = pickContextualTihaiTokenBySeed(p, n, phraseId + 997);
					if (normalizeTokenClass(cells[p] ?? '').toLowerCase() === 'ta') {
						cells[p] = p >= Math.floor(n * 0.75) ? 'Dhin' : 'Di';
					}
				}
			}
			runStart = -1;
		}
	}
}

function enforceNoRepeatedSyllableRuns(cells: Record<number, string>, phraseId: number, total: number): void {
	const n = Math.max(1, total);
	let runStart = -1;
	let runTok = '';
	const flushRun = (endExclusive: number): void => {
		if (runStart < 0 || !runTok) return;
		const runLen = endExclusive - runStart;
		const limit = runTok === 'ka' || runTok === 'ta' ? 2 : 3; // Ka-Ka / Ta-Ta from 2+, others from 3+.
		if (runLen >= limit) {
			for (let p = runStart + 1; p < endExclusive; p++) {
				const replacement = pickContextualTihaiTokenBySeed(p, n, phraseId + 1297 + p * 11);
				const replNorm = normalizeTokenClass(replacement).toLowerCase();
				cells[p] = replNorm === runTok ? (p >= Math.floor(n * 0.75) ? 'Dhin' : 'Di') : replacement;
			}
		}
	};
	for (let i = 0; i <= n; i++) {
		const tok = i < n ? normalizeTokenClass(cells[i] ?? '').toLowerCase() : '__end__';
		if (!tok || tok === '-' || tok === '—' || tok === '.') {
			flushRun(i);
			runStart = -1;
			runTok = '';
			continue;
		}
		if (runStart < 0) {
			runStart = i;
			runTok = tok;
			continue;
		}
		if (tok !== runTok) {
			flushRun(i);
			runStart = i;
			runTok = tok;
		}
	}
}

function getRuntimeBridgeWhitelist(): Set<number> | null {
	const raw = (globalThis as unknown as { __macroBridgeWhitelist?: unknown }).__macroBridgeWhitelist;
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const out = new Set<number>();
	for (const v of raw) {
		const n = Number(v);
		if (!Number.isFinite(n)) continue;
		const p = Math.max(1, Math.min(9, Math.floor(n)));
		out.add(p);
	}
	return out.size > 0 ? out : null;
}

function resolveTihaiGapPulses(profile: EmotionalProfile, curSyl: number): number | undefined {
	const safe = Math.max(1, Math.min(9, Math.floor(curSyl)));
	// Lasya: длинный вдох (полный gap-бар), Tandava/Yati: частичное затухание.
	if (profile === 'lasya') return undefined;
	if (profile === 'tandava') return Math.min(2, safe);
	return Math.min(4, safe);
}

function resolveFinalTihaiLandingIndex(curSyl: number, requestedLandingIndex?: number): number {
	const last = Math.max(0, curSyl - 1);
	const requested =
		typeof requestedLandingIndex === 'number'
			? Math.max(0, Math.min(last, Math.floor(requestedLandingIndex)))
			: last;
	// Канон финала: избегаем Thom в самом начале такта с последующей пустотой.
	if (curSyl > 1 && requested === 0) return last;
	return requested;
}

/** Adi: приземление sam — (offset + totalPulses - 1) % cycle === 0 для последнего пульса блока. */
export const TIHAI_ADI_CYCLE = 8;

/**
 * Число тактов урока в блоке тихая: 3 фразы + (2+e) паузных тактов Karvai + 1 landing,
 * подбирается e ≥ 0 так, чтобы последний пульс блока попал в sam.
 */
export function computeTihaiBlockBarCount(pulseOffsetAtBlockStart: number, motifLen: number, cycle: number = TIHAI_ADI_CYCLE): number {
	const L = Math.max(1, Math.min(9, Math.floor(motifLen)));
	let best = 6;
	let bestDist = cycle;
	/** С 3: математически возможен короткий блок (scheduler всё равно ограничивает fit по окну). */
	for (let barCount = 3; barCount <= 24; barCount++) {
		const lastGlobal = pulseOffsetAtBlockStart + barCount * L - 1;
		const r = ((lastGlobal % cycle) + cycle) % cycle;
		if (r === 0) return barCount;
		const dist = Math.min(r, cycle - r);
		if (dist < bestDist) {
			bestDist = dist;
			best = barCount;
		}
	}
	return best;
}

/** Gati=3: ограничиваем блок тихая до 6 тактов (2 полных Karvai-бара максимум). */
function clampTihaiLenForMotif(rawLen: number, motifLen: number): number {
	if (motifLen === 3) return Math.min(rawLen, 6);
	return rawLen;
}

/** Parent mode хранит 1 или 2 такта. Длина >= 1, <= 2. */
export type ParentGenome = {
	bars: BarGenome[];
};

export type ParentLength = 1 | 2;
export type ProgressiveDensityMode = 'gati_mode' | 'jati_mode';
export type EmotionalProfile = 'tandava' | 'lasya' | 'yati';
export type ArudiReason = 'symmetry_close' | 'phrase_cadence';

/**
 * Роль одного такта в расписании. `phraseId` группирует последовательные такты одной фразы;
 * `phraseStep` — индекс внутри фразы [0, phraseLength). `parentBarIdx` ∈ {0,1} — какой из
 * двух parent-тактов используется (для ParentLength=1 всегда 0).
 */
type PhraseRoleShared = {
	phraseId: number;
	phraseStep: number;
	phraseLength: number;
	parentBarIdx: 0 | 1;
	pulseOffsetBeforeBar?: number;
	densityFreeze?: boolean;
	deSyncJati?: boolean;
	localCycleLength?: number;
	bridgeKind?: 'resync' | 'de_sync_prep' | 'gati_prep';
	gatiTargetSub?: number;
	intensityTarget?: number;
	tihaiPrefixBars?: number;
	tihaiGapBars?: number;
	tihaiGapPulses?: number;
	tihaiLandingIndex?: number;
	tihaiPulseLen?: number;
	triggerJatiAction?: { targetCurSyl: 5 | 7 | 9; source: 'auto' | 'ui' };
	emotionalProfile?: EmotionalProfile;
	arudiReason?: ArudiReason;
	prasaMaxEditDistance?: number;
};

type MutationPhraseRole = {
	[K in MutationType]: PhraseRoleShared & { type: K };
}[MutationType];

export type PhraseRole =
	| MutationPhraseRole
	| (PhraseRoleShared & { type: 'resync_bridge' })
	| (PhraseRoleShared & { type: 'parent' })
	| (PhraseRoleShared & { type: 'free'; parentBarIdx: 0 });

export type PhraseSchedule = PhraseRole[];

export type RandomMode = 'free' | 'parent';

export type PrasaPhase = 'exposition' | 'exploration' | 'destabilization' | 'culmination';

export function computePrasaPolicy(input: {
	phase: PrasaPhase;
	prasaMaxEditDistance?: number;
	anchorSyllableCount: number;
	liveLength: number;
}): { parentLimit: number; anchorCap: number } {
	const baseCap = Math.max(0, Math.floor(input.prasaMaxEditDistance ?? 2));
	const anchorHalfCap = Math.max(0, Math.floor(Math.max(1, input.anchorSyllableCount) / 2));
	const anchorCap = Math.max(0, Math.min(baseCap, anchorHalfCap));
	const live = Math.max(1, Math.floor(input.liveLength));
	if (input.phase === 'destabilization') {
		// In destabilization we allow wider parent divergence, but keep anchor recognition tight.
		return { parentLimit: live, anchorCap };
	}
	return { parentLimit: baseCap, anchorCap };
}

// ============================================================================
// Chaos → intensity (ослабленное влияние per требованию)
// ============================================================================

/**
 * chaos=0 → 0.2 (минимальное отклонение, parent узнаётся моментально).
 * chaos=50 → ~0.7.
 * chaos=100 → 1.2 (экстремальные вариации, «до абсурда» по запросу).
 */
export function chaosToIntensity(chaos: number): number {
	const c = Math.max(0, Math.min(100, chaos));
	return 0.2 + 1.0 * smoothstep01(c / 100);
}

// ============================================================================
// Genome ↔ BarRandomizerMutable converters
// ============================================================================

/**
 * Снимает BarGenome из текущего состояния бара. curSyl берётся из customSyllables[r]
 * или падает на baseSyl. deadStart — из deadCells[r] если есть.
 */
export function snapshotBarGenome(
	barIdx: number,
	baseSyl: number,
	state: {
		customSyllables: Record<number, number>;
		accents: Set<string>;
		customSubdivisions: Record<string, number>;
		customCellSyllables?: Record<string, string>;
		deadCells: { [r: number]: { deadStart: number } | undefined };
	},
): BarGenome {
	const curSyl = state.customSyllables[barIdx] ?? baseSyl;
	const accents = new Set<number>();
	const subdivisions: Record<number, number> = {};
	const cellSyllables: Record<number, string> = {};
	const csMap = state.customCellSyllables;
	for (let c = 0; c < curSyl; c++) {
		const k = `${barIdx}-${c}`;
		if (state.accents.has(k)) accents.add(c);
		const s = state.customSubdivisions[k];
		if (typeof s === 'number' && s >= 2 && s <= 9) subdivisions[c] = s;
		if (csMap && typeof csMap[k] === 'string' && csMap[k]!.length > 0) cellSyllables[c] = csMap[k]!;
	}
	const ds = state.deadCells[barIdx]?.deadStart;
	const out: BarGenome = { curSyl, accents, subdivisions };
	if (Object.keys(cellSyllables).length > 0) out.cellSyllables = cellSyllables;
	if (typeof ds === 'number' && ds >= 0 && ds < curSyl) out.deadStart = ds;
	return out;
}

/**
 * Пишет BarGenome обратно в BarRandomizerMutable для такта `barIdx`. Перезаписывает
 * accents/subdivisions/deadCells данного бара, не трогая остальные бары.
 */
export function applyGenomeToBar(
	barIdx: number,
	genome: BarGenome,
	m: BarRandomizerMutable,
): void {
	m.customSyllables[barIdx] = genome.curSyl;

	for (let c = 0; c < 9; c++) {
		m.accents.delete(`${barIdx}-${c}`);
		delete m.customSubdivisions[`${barIdx}-${c}`];
		delete m.customCellSyllables[`${barIdx}-${c}`];
	}
	for (const c of genome.accents) {
		if (c >= 0 && c < genome.curSyl) m.accents.add(`${barIdx}-${c}`);
	}
	for (const [cStr, s] of Object.entries(genome.subdivisions)) {
		const c = parseInt(cStr, 10);
		if (Number.isFinite(c) && c >= 0 && c < genome.curSyl) {
			m.customSubdivisions[`${barIdx}-${c}`] = s;
		}
	}
	if (genome.cellSyllables) {
		for (const [cStr, tok] of Object.entries(genome.cellSyllables)) {
			const c = parseInt(cStr, 10);
			if (Number.isFinite(c) && c >= 0 && c < genome.curSyl && typeof tok === 'string' && tok.length > 0) {
				m.customCellSyllables[`${barIdx}-${c}`] = tok;
			}
		}
	}

	if (typeof genome.deadStart === 'number' && genome.deadStart >= 0 && genome.deadStart < genome.curSyl) {
		m.deadCells[barIdx] = {
			deadStart: genome.deadStart,
			displayLen: genome.curSyl,
			baseLen: genome.curSyl,
		};
	} else {
		delete m.deadCells[barIdx];
	}
}

function computePhysicalPulseOffsetBeforeBar(
	barIdx: number,
	syllablesDefault: number,
	m: BarRandomizerMutable,
): number {
	let pulses = 0;
	for (let i = 0; i < barIdx; i++) {
		pulses += Math.max(1, Math.floor(m.customSyllables[i] ?? syllablesDefault));
	}
	return pulses;
}

function hasContinuousMaterializedHistory(barIdx: number, m: BarRandomizerMutable): boolean {
	for (let i = 0; i < barIdx; i++) {
		if (typeof m.customSyllables[i] !== 'number') return false;
	}
	return true;
}

/** Глубокое клонирование BarGenome (Set и объекты — новые ссылки). */
export function cloneBarGenome(g: BarGenome): BarGenome {
	const out: BarGenome = {
		curSyl: g.curSyl,
		accents: new Set(g.accents),
		subdivisions: { ...g.subdivisions },
	};
	if (g.cellSyllables) out.cellSyllables = { ...g.cellSyllables };
	if (typeof g.deadStart === 'number') out.deadStart = g.deadStart;
	return out;
}

export function cloneParentGenome(p: ParentGenome): ParentGenome {
	return { bars: p.bars.map(cloneBarGenome) };
}

// ============================================================================
// Phrase scheduler
// ============================================================================

export type SchedulerContext = {
	bars: number;
	enabledMutations: MutationType[];
	preset: FormPresetId;
	parentLength: ParentLength;
	rng: RNG;
	/** Длина такта в пульсах (curSyl темы) для расчёта блока тихая и sam. */
	motifPulseLen?: number;
	/** Источник драматургии: gati внутри клетки (default) или jati/de-sync контраст. */
	progressiveDensityMode?: ProgressiveDensityMode;
	/** Активирован ли автономный Jati/de-sync. */
	deSyncJati?: boolean;
	/** Локальный цикл в de-sync режиме (если задан). */
	deSyncCycleLength?: number;
	/** Уровень хаоса (0..100) — нужен для форсированного Jati/de-sync в progressive. */
	chaosLevel?: number;
	/** Явный override для художественного профиля progressive. */
	emotionalProfileOverride?: EmotionalProfile;
};

function densityFreezeWindow(bars: number): { from: number; to: number } | null {
	if (bars === 16) return { from: 10, to: 11 };
	if (bars === 24) return { from: 16, to: 18 };
	if (bars === 32) return { from: 24, to: 26 };
	return null;
}

function isDensityFreezeBar(barPos: number, bars: number): boolean {
	const w = densityFreezeWindow(bars);
	if (!w) return false;
	return barPos >= w.from - 1 && barPos <= w.to - 1;
}

function selectEmotionalProfile(chaosLevel: number, override?: EmotionalProfile): EmotionalProfile {
	if (override) return override;
	if (chaosLevel >= 70) return 'tandava';
	if (chaosLevel <= 30) return 'lasya';
	return 'yati';
}

function estimateRolePulseLen(
	role: { type: PhraseRole['type']; phraseStep: number; phraseLength: number; bridgeKind?: 'resync' | 'de_sync_prep' | 'gati_prep' },
	motifL: number,
	mode: ProgressiveDensityMode,
	deSync: boolean,
	localCycleLength?: number,
): number {
	const base = Math.max(1, motifL);
	const isMutation = role.type !== 'parent' && role.type !== 'free' && role.type !== 'resync_bridge';
	if (
		isMutation &&
		role.type !== 'tihai' &&
		deSync &&
		typeof localCycleLength === 'number' &&
		localCycleLength > 0
	) {
		return Math.max(1, Math.round(localCycleLength));
	}
	if (role.type === 'resync_bridge') {
		if (typeof localCycleLength === 'number' && localCycleLength > 0) {
			return Math.max(1, Math.round(localCycleLength));
		}
		return base;
	}
	// В gati_mode длительность такта не меняется: меняем только внутреннюю плотность.
	// Это удерживает globalPulseAccumulator согласованным с реальным timeline/логом.
	return base;
}

type StrictTihaiPlan = {
	totalBars: number;
	prefixKarvaiBars: number;
	gapBars: number;
	landingIndex: number;
	fits: boolean;
};

type ProgressiveDensityRouteDecision = {
	route: 'gati' | 'jati';
	localJati?: 5 | 7 | 9;
	lockBars?: number;
};

function decideProgressiveDensityRoute(input: {
	preset: FormPresetId;
	chaosLevel: number;
	barPos: number;
	bars: number;
	rng: RNG;
	alreadyInDeSync: boolean;
	phaseContext: {
		isPhraseBoundary: boolean;
		inMidWindow: boolean;
		freeze: boolean;
		chosen: MutationType | null;
		remainingBars: number;
		forcedJatiDone: boolean;
	};
}): ProgressiveDensityRouteDecision {
	const { preset, chaosLevel, barPos, bars, rng, alreadyInDeSync, phaseContext } = input;
	if (preset !== 'progressive' || chaosLevel <= 0) return { route: 'gati' };
	if (alreadyInDeSync) return { route: 'jati' };
	if (!phaseContext.isPhraseBoundary || !phaseContext.inMidWindow || phaseContext.freeze) return { route: 'gati' };
	if (phaseContext.chosen === null || phaseContext.chosen === 'tihai') return { route: 'gati' };
	// Должно оставаться место для обязательного выхода через bridge + финальный tihai.
	const minBarsForSafeExit = Math.max(7, Math.ceil(bars * 0.22));
	if (phaseContext.remainingBars < minBarsForSafeExit) return { route: 'gati' };
	const base = 0.30;
	const chaosGain = 0.10 * smoothstep01(Math.min(1, chaosLevel / 100));
	const pJati = Math.max(0.3, Math.min(0.4, base + chaosGain));
	const barsLeftInWindow = 20 - (barPos + 1) + 1;
	const forceNearWindowEnd = chaosLevel >= 80 && !phaseContext.forcedJatiDone && barsLeftInWindow <= 2;
	if (forceNearWindowEnd || rng() < pJati) {
		const roll = rng();
		const localJati: 5 | 7 | 9 = roll < 0.25 ? 5 : roll < 0.75 ? 7 : 9;
		const lockBars = localJati === 9 ? 2 : 3;
		return { route: 'jati', localJati, lockBars };
	}
	return { route: 'gati' };
}

function computeStrictTihaiPlan(
	pulseOffsetBeforeTihai: number,
	motifLen: number,
	availableBars: number,
	cycle: number = TIHAI_ADI_CYCLE,
): StrictTihaiPlan {
	const P = Math.max(1, Math.min(9, Math.floor(motifLen)));
	const maxBars = Math.max(0, Math.floor(availableBars));
	let best: StrictTihaiPlan | null = null;
	for (let totalBars = 4; totalBars <= maxBars; totalBars++) {
		for (let prefix = 0; prefix <= totalBars - 4; prefix++) {
			const coreBars = totalBars - prefix;
			const rem = coreBars - 4;
			if (rem < 0 || rem % 2 !== 0) continue;
			const gapBars = rem / 2;
			const landingFrom = P > 1 ? 1 : 0;
			for (let landingIndex = landingFrom; landingIndex < P; landingIndex++) {
				const lastGlobalPulse = pulseOffsetBeforeTihai + (totalBars - 1) * P + landingIndex;
				const mod = ((lastGlobalPulse % cycle) + cycle) % cycle;
				if (mod !== cycle - 1) continue;
				best = { totalBars, prefixKarvaiBars: prefix, gapBars, landingIndex, fits: true };
				break;
			}
			if (best) break;
		}
		if (best) break;
	}
	if (best) return best;
	const fallbackTotal = Math.max(4, Math.min(maxBars, computeTihaiBlockBarCount(pulseOffsetBeforeTihai, P, cycle)));
	return {
		totalBars: fallbackTotal,
		prefixKarvaiBars: Math.max(0, fallbackTotal - 6),
		gapBars: 1,
		landingIndex: Math.max(0, P - 1),
		fits: false,
	};
}

function pickStrictTihaiPlanForWindow(
	pulseOffsetBeforeTihai: number,
	motifLen: number,
	availableBars: number,
	cycle: number = TIHAI_ADI_CYCLE,
): StrictTihaiPlan {
	const P = Math.max(1, Math.min(9, Math.floor(motifLen)));
	const maxBars = Math.max(0, Math.floor(availableBars));
	for (let totalBars = maxBars; totalBars >= 4; totalBars--) {
		const plan = computeStrictTihaiPlan(pulseOffsetBeforeTihai, P, totalBars, cycle);
		if (plan.fits && plan.totalBars === totalBars) return plan;
	}
	return computeStrictTihaiPlan(pulseOffsetBeforeTihai, P, maxBars, cycle);
}

function computeStrictTihaiPlanForExactTotalAndGap(
	pulseOffsetBeforeTihai: number,
	motifLen: number,
	totalBars: number,
	requiredGapBars: number,
	cycle: number = TIHAI_ADI_CYCLE,
): StrictTihaiPlan {
	const P = Math.max(1, Math.min(9, Math.floor(motifLen)));
	const n = Math.max(4, Math.floor(totalBars));
	const G = Math.max(0, Math.floor(requiredGapBars));
	for (let prefix = 0; prefix <= n - 4; prefix++) {
		const coreBars = n - prefix;
		const rem = coreBars - 4;
		if (rem < 0 || rem % 2 !== 0) continue;
		const gapBars = rem / 2;
		if (gapBars !== G) continue;
		const landingFrom = P > 1 ? 1 : 0;
		for (let landingIndex = landingFrom; landingIndex < P; landingIndex++) {
			const lastGlobalPulse = pulseOffsetBeforeTihai + (n - 1) * P + landingIndex;
			const mod = ((lastGlobalPulse % cycle) + cycle) % cycle;
			if (mod !== cycle - 1) continue;
			return {
				totalBars: n,
				prefixKarvaiBars: prefix,
				gapBars,
				landingIndex,
				fits: true,
			};
		}
	}
	return {
		totalBars: n,
		prefixKarvaiBars: Math.max(0, n - 6),
		gapBars: G,
		landingIndex: Math.max(0, P - 1),
		fits: false,
	};
}

function pickGatiPrepLengthForStrictTihai(
	pulseOffsetBeforePrep: number,
	motifLen: number,
	remainingBars: number,
	requireExactWindow: boolean = false,
): number | null {
	if (remainingBars <= 1) return null;
	const P = Math.max(1, Math.min(9, Math.floor(motifLen)));
	// Предпочитаем prep, который стабильно даёт strict-landing в odd-tail.
	// `5` оставляем только как крайний fallback: исторически этот путь чаще давал
	// лишний resync перед tihai в 9-cycle tail.
	const candidates = [7, 3, 6, 5];
	let fallback: { prep: number; coveredBars: number } | null = null;
	let unstableFallback: { prep: number; coveredBars: number } | null = null;
	for (const localCycle of candidates) {
		const nextOffset = pulseOffsetBeforePrep + localCycle;
		const fit = pickStrictTihaiPlanForWindow(nextOffset, motifLen, remainingBars - 1, TIHAI_ADI_CYCLE);
		if (!fit.fits) continue;
		if (fit.totalBars > remainingBars - 1) continue;
		const tihaiLength = resolveTihaiLengthToLandingPulses(fit, P);
		const mod = expectedFinalPulseMod8(pulseOffsetBeforePrep, localCycle, tihaiLength);
		if (mod !== TIHAI_ADI_CYCLE - 1) continue;
		if (fit.totalBars === remainingBars - 1) return localCycle;
		if (!requireExactWindow) {
			if (localCycle === 5) {
				if (unstableFallback === null || fit.totalBars > unstableFallback.coveredBars) {
					unstableFallback = { prep: localCycle, coveredBars: fit.totalBars };
				}
				continue;
			}
			if (fallback === null || fit.totalBars > fallback.coveredBars) {
				fallback = { prep: localCycle, coveredBars: fit.totalBars };
			}
		}
	}
	return fallback?.prep ?? unstableFallback?.prep ?? null;
}

function isTihaiFormulaReplicaStep(role: Extract<PhraseRole, { type: 'tihai' }>): boolean {
	const n = Math.max(1, role.phraseLength);
	const last = n - 1;
	if (role.phraseStep <= 0 || role.phraseStep >= last) return false;
	const prefixBars = Math.max(0, Math.floor(role.tihaiPrefixBars ?? Math.max(0, n - 6)));
	const gapBars = Math.max(0, Math.floor(role.tihaiGapBars ?? 1));
	const coreStep = role.phraseStep - prefixBars;
	const phrase2Start = 1 + gapBars;
	const phrase3Start = phrase2Start + 1 + gapBars;
	return coreStep === phrase2Start || coreStep === phrase3Start;
}

function isTihaiKarvaiOnlyStep(role: Extract<PhraseRole, { type: 'tihai' }>): boolean {
	const n = Math.max(1, role.phraseLength);
	const last = n - 1;
	const s = role.phraseStep;
	if (s < 0 || s >= n) return false;
	if (s === 0 || s === last) return false;
	const prefixBars = Math.max(0, Math.floor(role.tihaiPrefixBars ?? Math.max(0, n - 6)));
	if (s < prefixBars) return true;
	const gapBars = Math.max(0, Math.floor(role.tihaiGapBars ?? 1));
	const coreStep = s - prefixBars;
	const phrase2Start = 1 + gapBars;
	const phrase3Start = phrase2Start + 1 + gapBars;
	return (
		(coreStep > 0 && coreStep < phrase2Start) ||
		(coreStep > phrase2Start && coreStep < phrase3Start)
	);
}

function expectedFinalPulseMod8(currentGlobalPulse: number, bridgePaddingPulses: number, tihaiLength: number): number {
	const finalPulse = currentGlobalPulse + bridgePaddingPulses + tihaiLength - 1;
	return ((finalPulse % TIHAI_ADI_CYCLE) + TIHAI_ADI_CYCLE) % TIHAI_ADI_CYCLE;
}

function resolveTihaiLengthToLandingPulses(plan: StrictTihaiPlan, motifPulseLen: number): number {
	const motifLen = Math.max(1, Math.floor(motifPulseLen));
	const body = Math.max(0, plan.totalBars - 1) * motifLen;
	const landing = Math.max(0, Math.min(motifLen - 1, plan.landingIndex)) + 1;
	return body + landing;
}

function logBridgePlannerPadding(
	currentGlobalPulse: number,
	bridgePaddingPulses: number,
	plan: StrictTihaiPlan,
	motifPulseLen: number,
): void {
	const tihaiLength = resolveTihaiLengthToLandingPulses(plan, motifPulseLen);
	const finalMod = expectedFinalPulseMod8(currentGlobalPulse, bridgePaddingPulses, tihaiLength);
	console.log(`[Planner] Bridge Padding P=${bridgePaddingPulses}, Expected Final Pulse Mod 8 = ${finalMod}`);
}

function pickSoftResyncBridgeForTihaiWindow(
	pulseOffsetBeforeBridge: number,
	motifLen: number,
	remainingBars: number,
): { bridgePulses: number; plan: StrictTihaiPlan } | null {
	if (remainingBars <= 1) return null;
	const motifPulseLen = Math.max(1, Math.min(9, Math.floor(motifLen)));
	const naturalLanding = Math.max(0, motifPulseLen - 1);
	const baseCandidates = [motifPulseLen, 7, 6, 5, 4, 3, 8, 2, 9, 1];
	const whitelist = getRuntimeBridgeWhitelist();
	const candidates = whitelist ? baseCandidates.filter((c) => whitelist.has(c)) : baseCandidates;
	if (candidates.length === 0) return null;
	let best: { bridgePulses: number; plan: StrictTihaiPlan; score: number } | null = null;
	for (const pulses of candidates) {
		const bridgePulses = Math.max(1, Math.min(9, Math.floor(pulses)));
		const nextOffset = pulseOffsetBeforeBridge + bridgePulses;
		const plan = pickStrictTihaiPlanForWindow(nextOffset, motifLen, remainingBars - 1, TIHAI_ADI_CYCLE);
		if (!plan.fits || plan.totalBars > remainingBars - 1) continue;
		const tihaiLength = resolveTihaiLengthToLandingPulses(plan, motifPulseLen);
		const finalMod = expectedFinalPulseMod8(pulseOffsetBeforeBridge, bridgePulses, tihaiLength);
		if (finalMod !== 7) continue;
		const naturalBonus = plan.landingIndex === naturalLanding ? 100 : 0;
		const fullWindowBonus = plan.totalBars === remainingBars - 1 ? 20 : 0;
		const closenessPenalty = Math.abs(bridgePulses - motifPulseLen);
		let score = naturalBonus + fullWindowBonus - closenessPenalty;
		const shift = ((pulseOffsetBeforeBridge + bridgePulses) % 8 + 8) % 8;
		const shiftLabel = shift === 0 ? 'Sam (0)' : `+${shift}`;
		const weakEndingPenalty = getBridgeEduppuPenalty(bridgePulses, shiftLabel);
		// Anti-DNA: combinations with high WEAK_ENDING rate are downweighted aggressively.
		score -= weakEndingPenalty * 240;
		score *= getBridgeDominancePenalty(bridgePulses);
		if (best === null || score > best.score) {
			best = { bridgePulses, plan, score };
		}
	}
	return best ? { bridgePulses: best.bridgePulses, plan: best.plan } : null;
}

function assertBridgePulseConsistency(role: PhraseRole, physicalBarLen: number): void {
	if (role.type !== 'resync_bridge') return;
	if (role.bridgeKind !== 'gati_prep' && role.bridgeKind !== 'resync' && role.bridgeKind !== 'de_sync_prep') return;
	if (typeof role.localCycleLength !== 'number' || role.localCycleLength <= 0) return;
	const expected = Math.max(1, Math.round(role.localCycleLength));
	if (physicalBarLen !== expected) {
		throw new Error(
			`CRITICAL: ${role.bridgeKind} bridge pulse mismatch. expected=${expected}, actual=${physicalBarLen}`,
		);
	}
}

/**
 * Greedy-планировщик. Пока `remaining > 0`:
 *  1. Выбирает мутацию из `enabled` по правилу пресета.
 *  2. Если её phraseLength > remaining или > bars — откатывается на 'parent' filler.
 *  3. Разворачивает фразу на phraseLength ролей (step=0..len-1).
 *
 * Phase 1: пресеты-заглушки ведут себя как 'random'. Реальное поведение пресетов —
 * Phase 4.
 */
export function buildPhraseSchedule(ctx: SchedulerContext): PhraseSchedule {
	const { bars, enabledMutations, preset, parentLength, rng } = ctx;
	const hasExplicitMotifPulseLen = typeof ctx.motifPulseLen === 'number' && Number.isFinite(ctx.motifPulseLen);
	const motifL = Math.max(1, Math.min(9, Math.floor(ctx.motifPulseLen ?? 4)));
	const densityMode: ProgressiveDensityMode = ctx.progressiveDensityMode ?? 'gati_mode';
	const deSyncJati = ctx.deSyncJati === true;
	const deSyncCycleLength = ctx.deSyncCycleLength;
	const chaosLevel = Math.max(0, Math.min(100, Math.round(ctx.chaosLevel ?? 0)));
	const emotionalProfile = selectEmotionalProfile(chaosLevel, ctx.emotionalProfileOverride);
	const autoJatiEnabled = preset === 'progressive' && chaosLevel > 0;
	const out: PhraseSchedule = [];
	let remaining = bars;
	let phraseId = 0;
	let parentBarIdx: 0 | 1 = 0;
	const progressiveBars = { early: 0, mid: 0, late: 0 };
	let globalPulseAccumulator = 0;
	const earlyThirdEnd = Math.max(0, Math.ceil(bars / 3) - 1);
	const earlyTruncationCap = Math.max(0, Math.floor(bars * 0.15));
	let earlyTruncationBarsUsed = 0;
	let forcedJatiPhraseDone = false;
	let everAutoDeSync = false;
	let narrativeDeSyncStarted = false;
	let densityDebt = 0;
	let activeDeSyncJati = deSyncJati;
	let activeDeSyncCycle = typeof deSyncCycleLength === 'number' && deSyncCycleLength > 0 ? Math.round(deSyncCycleLength) : undefined;
	let activeDeSyncLockBars = 0;
	const inProgressiveMidWindow = (barPos: number): boolean =>
		preset === 'progressive' && bars === 32 && barPos + 1 >= 8 && barPos + 1 <= 20;
	const inNarrativeJatiWindow = (barPos: number): boolean => {
		if (preset !== 'progressive' || bars < 24) return false;
		if (bars >= 32) return barPos + 1 >= 12 && barPos + 1 <= 22;
		return barPos + 1 >= Math.max(8, Math.floor(bars * 0.35)) && barPos + 1 <= Math.max(12, Math.floor(bars * 0.72));
	};
	const isPhraseBoundary = (): boolean => {
		if (out.length === 0) return true;
		const prev = out[out.length - 1]!;
		if (prev.type === 'parent' || prev.type === 'free' || prev.type === 'resync_bridge') return true;
		return prev.phraseStep === prev.phraseLength - 1;
	};
	const progressiveGatiTarget = (barPos: number): number => {
		const oneBased = barPos + 1;
		if (bars >= 32) {
			if (oneBased <= 12) return 4;
			if (oneBased <= 24) return 6;
			return 8;
		}
		const p = bars > 0 ? oneBased / bars : 1;
		if (p <= 0.4) return 4;
		if (p <= 0.8) return 6;
		return 8;
	};
	const progressiveIntensityTarget = (barPos: number): number => {
		if (bars <= 1) return 0.35;
		const p = Math.max(0, Math.min(1, barPos / (bars - 1)));
		return 0.35 + p * 0.6;
	};

	const phraseLenForPick = (t: MutationType, fit: number): number => {
		if (t === 'tihai') {
			const plan = computeStrictTihaiPlan(globalPulseAccumulator, motifL, fit);
			return Math.min(plan.totalBars, fit);
		}
		return MUTATION_PHRASE_LEN[t];
	};
	const overlapEarlyThird = (startBarPos: number, len: number): number => {
		const endBarPos = startBarPos + len - 1;
		const from = Math.max(startBarPos, 0);
		const to = Math.min(endBarPos, earlyThirdEnd);
		if (to < from) return 0;
		return to - from + 1;
	};

	const pickMutation = (fit: number, progress: number): MutationType | null => {
		const barPos = bars - remaining;
		const freeze = isDensityFreezeBar(barPos, bars);
		const candidatesAll = enabledMutations.filter((t) => phraseLenForPick(t, fit) <= fit);
		const candidatesFreeze = freeze
			? candidatesAll.filter((t) => !['augmentation', 'diminution', 'echo_decay'].includes(t))
			: candidatesAll;
		// tihai_heavy: тихаи только явными блоками в цикле ниже, не через random pick.
		const candidates =
			preset === 'tihai_heavy' ? candidatesFreeze.filter((t) => t !== 'tihai') : candidatesFreeze;
		const candidatesEarlyTruncCap = candidates.filter((t) => {
			if (t !== 'truncation') return true;
			if (barPos > earlyThirdEnd) return true;
			const truncLen = phraseLenForPick('truncation', fit);
			const gain = overlapEarlyThird(barPos, truncLen);
			return earlyTruncationBarsUsed + gain <= earlyTruncationCap;
		});
		const candidatesFinal = candidatesEarlyTruncCap.length > 0 ? candidatesEarlyTruncCap : candidates;
		if (candidatesFinal.length === 0) return null;
		if (preset === 'progressive') {
			// Явная драматургия: начало проще, середина плотнее, финал структурнее.
			const early: MutationType[] = ['substitution', 'inversion', 'retrograde', 'rotation', 'augmentation'];
			const mid: MutationType[] = ['augmentation', 'fractal', 'yati', 'diminution', 'echo_decay', 'neighbour_pulsation'];
			const late: MutationType[] = ['prepend_append', 'truncation', 'tihai', 'call_fill'];
			const densityHeavy = new Set<MutationType>(['augmentation', 'fractal', 'yati']);
			const curTarget = progressiveGatiTarget(barPos);
			const needDensityPush =
				!freeze &&
				(((curTarget >= 6 && progress >= 0.35) || (curTarget >= 8 && progress >= 0.7)) || densityDebt >= 2);
			if (needDensityPush) {
				for (const t of ['yati', 'augmentation', 'fractal'] as const) {
					if (candidatesFinal.includes(t)) return t;
				}
				for (const t of candidatesFinal) {
					if (densityHeavy.has(t)) return t;
				}
			}

			const goals = {
				early: Math.round(bars * 0.3),
				mid: Math.round(bars * 0.35),
				late: bars - Math.round(bars * 0.3) - Math.round(bars * 0.35),
			} as const;
			const deficit = {
				early: goals.early - progressiveBars.early,
				mid: goals.mid - progressiveBars.mid,
				late: goals.late - progressiveBars.late,
			} as const;
			const progressStage: 'early' | 'mid' | 'late' =
				progress < 0.33 ? 'early'
				: progress < 0.66 ? 'mid'
				: 'late';
			const byStage: Record<'early' | 'mid' | 'late', MutationType[]> = { early, mid, late };
			const orderedStages = [...(['early', 'mid', 'late'] as const)].sort((a, b) => {
				// Жёсткий приоритет текущей фазы формы.
				if (a === progressStage && b !== progressStage) return -1;
				if (b === progressStage && a !== progressStage) return 1;
				const affinity = (st: 'early' | 'mid' | 'late'): number => {
					const order: Record<'early' | 'mid' | 'late', number> = { early: 0, mid: 1, late: 2 };
					return Math.abs(order[st] - order[progressStage]) === 1 ? 25 : 0;
				};
				const scoreA = deficit[a] + affinity(a);
				const scoreB = deficit[b] + affinity(b);
				const byNeed = scoreB - scoreA;
				if (byNeed !== 0) return byNeed;
				const order: Record<'early' | 'mid' | 'late', number> = { early: 0, mid: 1, late: 2 };
				return Math.abs(order[a] - order[progressStage]) - Math.abs(order[b] - order[progressStage]);
			});
			for (const st of orderedStages) {
				for (const t of byStage[st]) if (candidatesFinal.includes(t)) return t;
			}

			// Fallback, если текущий fit не позволяет мутации выбранной стадии.
			const order: MutationType[] = [...early, ...mid, ...late];
			for (const t of order) if (candidatesFinal.includes(t)) return t;
			return candidatesFinal[0]!;
		}
		if (preset === 'call_fill' && candidatesFinal.includes('call_fill') && rng() < 0.7) {
			return 'call_fill';
		}
		// Chhanda truncation как поздний структурный выход к развязке в jati/de-sync режиме.
		if (densityMode === 'jati_mode' && progress >= 0.6 && candidatesFinal.includes('truncation') && rng() < 0.65) {
			return 'truncation';
		}
		return candidatesFinal[Math.floor(rng() * candidatesFinal.length)]!;
	};

	let tihaiHeavyMidDone = false;
	let tihaiHeavyFinalDone = false;
	let lastTihaiEndBarPos = -100;
	let preFinalBreathDone = false;
	let progressiveTailPlan: StrictTihaiPlan | null = null;

	const pickBreathMutation = (): MutationType | null => {
		const order: MutationType[] = [
			'diminution',
			'neighbour_pulsation',
			'rotation',
			'augmentation',
			'fractal',
		];
		for (const t of order) {
			if (enabledMutations.includes(t) && MUTATION_PHRASE_LEN[t] === 3) return t;
		}
		return null;
	};

	let safety = 0;
	while (remaining > 0 && safety++ < 1000) {
		const barPos = bars - remaining;
		// Progressive: каждые 8 тактов явный возврат темы (parent-anchor),
		// чтобы 32-тактовая форма держала "общую нить".
		if (preset === 'progressive' && barPos % 8 === 0) {
			out.push({
				type: 'parent',
				phraseId: phraseId++,
				phraseStep: 0,
				phraseLength: 1,
				parentBarIdx,
			});
			globalPulseAccumulator += estimateRolePulseLen({ type: 'parent', phraseStep: 0, phraseLength: 1 }, motifL, densityMode, deSyncJati, deSyncCycleLength);
			parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
			remaining -= 1;
			continue;
		}
		// Tihai-heavy: максимум два tihai-блока (середина + финал), ≥6 тактов развития между ними;
		// перед финальным tihai — 3 такта «вдоха» (diminution / neighbour / rotation).
		if (preset === 'tihai_heavy') {
			const minGap = 6;
			const midLo = Math.max(minGap, Math.floor(bars * 0.34));
			const midHiExclusive = bars - 8;

			const tailDramaMinBars = 18;
			const inFinalTail = bars >= tailDramaMinBars;

			if (
				inFinalTail &&
				!preFinalBreathDone &&
				remaining === 6 &&
				barPos === bars - 6 &&
				enabledMutations.includes('tihai') &&
				!tihaiHeavyFinalDone
			) {
				for (let k = 0; k < 2; k++) {
					out.push({
						type: 'parent',
						phraseId: phraseId++,
						phraseStep: 0,
						phraseLength: 1,
						parentBarIdx,
					});
					globalPulseAccumulator += estimateRolePulseLen({ type: 'parent', phraseStep: 0, phraseLength: 1 }, motifL, densityMode, deSyncJati, deSyncCycleLength);
					parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
					remaining -= 1;
				}
				preFinalBreathDone = true;
				continue;
			}

			if (
				inFinalTail &&
				!tihaiHeavyFinalDone &&
				remaining === 5 &&
				barPos === bars - 5 &&
				enabledMutations.includes('tihai') &&
				barPos - lastTihaiEndBarPos >= minGap
			) {
				out.push({
					type: 'parent',
					phraseId: phraseId++,
					phraseStep: 0,
					phraseLength: 1,
					parentBarIdx,
				});
				globalPulseAccumulator += estimateRolePulseLen({ type: 'parent', phraseStep: 0, phraseLength: 1 }, motifL, densityMode, deSyncJati, deSyncCycleLength);
				parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
				remaining -= 1;
				continue;
			}

			if (!preFinalBreathDone && remaining === 7) {
				const breath = pickBreathMutation();
				if (breath !== null) {
					const pid = phraseId++;
					const len = MUTATION_PHRASE_LEN[breath];
					for (let step = 0; step < len; step++) {
						out.push({
							type: breath,
							phraseId: pid,
							phraseStep: step,
							phraseLength: len,
							parentBarIdx,
							pulseOffsetBeforeBar: globalPulseAccumulator,
							densityFreeze: isDensityFreezeBar(out.length, bars),
							deSyncJati,
							localCycleLength: deSyncJati ? deSyncCycleLength : undefined,
						} as PhraseRole);
						globalPulseAccumulator += estimateRolePulseLen(
							{ type: breath, phraseStep: step, phraseLength: len },
							motifL,
							densityMode,
							deSyncJati,
							deSyncCycleLength,
						);
					}
					parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
					remaining -= len;
				}
				preFinalBreathDone = true;
				if (breath !== null) continue;
			}

			if (
				!tihaiHeavyFinalDone &&
				enabledMutations.includes('tihai') &&
				barPos - lastTihaiEndBarPos >= minGap
			) {
				const strict = computeStrictTihaiPlan(globalPulseAccumulator, motifL, remaining);
				const tiLen = Math.max(4, Math.min(strict.totalBars, remaining));
				if (remaining === tiLen && barPos >= bars - tiLen) {
					const pid = phraseId++;
					for (let step = 0; step < tiLen; step++) {
						out.push({
							type: 'tihai',
							phraseId: pid,
							phraseStep: step,
							phraseLength: tiLen,
							parentBarIdx,
							pulseOffsetBeforeBar: globalPulseAccumulator,
							densityFreeze: isDensityFreezeBar(out.length, bars),
							deSyncJati,
							localCycleLength: deSyncJati ? deSyncCycleLength : undefined,
							tihaiPrefixBars: strict.prefixKarvaiBars,
							tihaiGapBars: strict.gapBars,
							tihaiGapPulses: resolveTihaiGapPulses(emotionalProfile, motifL),
							tihaiLandingIndex: strict.landingIndex,
							tihaiPulseLen: hasExplicitMotifPulseLen ? motifL : undefined,
						});
						globalPulseAccumulator += estimateRolePulseLen(
							{ type: 'tihai', phraseStep: step, phraseLength: tiLen },
							motifL,
							densityMode,
							deSyncJati,
							deSyncCycleLength,
						);
					}
					parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
					remaining -= tiLen;
					tihaiHeavyFinalDone = true;
					lastTihaiEndBarPos = barPos + tiLen - 1;
					continue;
				}
			}

			if (
				!tihaiHeavyMidDone &&
				enabledMutations.includes('tihai') &&
				remaining >= 11 &&
				barPos >= midLo &&
				barPos < midHiExclusive &&
				barPos - lastTihaiEndBarPos >= minGap
			) {
				const strictMid = computeStrictTihaiPlan(globalPulseAccumulator, motifL, Math.min(remaining, 11));
				const tiMidLen = Math.max(4, Math.min(strictMid.totalBars, Math.min(remaining, 11)));
				const pid = phraseId++;
				for (let step = 0; step < tiMidLen; step++) {
					out.push({
						type: 'tihai',
						phraseId: pid,
						phraseStep: step,
						phraseLength: tiMidLen,
						parentBarIdx,
						pulseOffsetBeforeBar: globalPulseAccumulator,
						densityFreeze: isDensityFreezeBar(out.length, bars),
						deSyncJati,
						localCycleLength: deSyncJati ? deSyncCycleLength : undefined,
						tihaiPrefixBars: strictMid.prefixKarvaiBars,
						tihaiGapBars: strictMid.gapBars,
						tihaiGapPulses: resolveTihaiGapPulses(emotionalProfile, motifL),
						tihaiLandingIndex: strictMid.landingIndex,
						tihaiPulseLen: hasExplicitMotifPulseLen ? motifL : undefined,
					});
					globalPulseAccumulator += estimateRolePulseLen(
						{ type: 'tihai', phraseStep: step, phraseLength: tiMidLen },
						motifL,
						densityMode,
						deSyncJati,
						deSyncCycleLength,
					);
				}
				parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
				remaining -= tiMidLen;
				tihaiHeavyMidDone = true;
				lastTihaiEndBarPos = barPos + tiMidLen - 1;
				continue;
			}
		}
		// Call-fill: секции по 8 тактов как "вопрос-ответ":
		// 1) такт-ссылка на тему,
		// 2) ранний обязательный 4-тактовый call_fill блок (чтобы стиль не вырождался в random).
		if (preset === 'call_fill') {
			const inSection = barPos % 8;
			if (inSection === 0) {
				out.push({
					type: 'parent',
					phraseId: phraseId++,
					phraseStep: 0,
					phraseLength: 1,
					parentBarIdx,
				});
				globalPulseAccumulator += estimateRolePulseLen({ type: 'parent', phraseStep: 0, phraseLength: 1 }, motifL, densityMode, deSyncJati, deSyncCycleLength);
				parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
				remaining -= 1;
				continue;
			}
			if (
				inSection === 1 &&
				remaining >= MUTATION_PHRASE_LEN.call_fill &&
				enabledMutations.includes('call_fill')
			) {
				const pid = phraseId++;
				for (let step = 0; step < MUTATION_PHRASE_LEN.call_fill; step++) {
					out.push({
						type: 'call_fill',
						phraseId: pid,
						phraseStep: step,
						phraseLength: MUTATION_PHRASE_LEN.call_fill,
						parentBarIdx,
						pulseOffsetBeforeBar: globalPulseAccumulator,
						densityFreeze: isDensityFreezeBar(out.length, bars),
						deSyncJati,
						localCycleLength: deSyncJati ? deSyncCycleLength : undefined,
					});
					globalPulseAccumulator += estimateRolePulseLen(
						{ type: 'call_fill', phraseStep: step, phraseLength: MUTATION_PHRASE_LEN.call_fill },
						motifL,
						densityMode,
						deSyncJati,
						deSyncCycleLength,
					);
				}
				parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
				remaining -= MUTATION_PHRASE_LEN.call_fill;
				continue;
			}
		}
		if (preset === 'progressive' && bars >= 24 && enabledMutations.includes('tihai') && remaining <= 12) {
			if (progressiveTailPlan === null || remaining < progressiveTailPlan.totalBars) {
				progressiveTailPlan = pickStrictTihaiPlanForWindow(globalPulseAccumulator, motifL, remaining);
			}
			const strictTail = progressiveTailPlan;
			if (!strictTail.fits && remaining > 5) {
				const prepLen = pickGatiPrepLengthForStrictTihai(globalPulseAccumulator, motifL, remaining, true);
				if ((activeDeSyncJati || everAutoDeSync || deSyncJati) && prepLen !== null) {
					const postPrepPlan = pickStrictTihaiPlanForWindow(
						globalPulseAccumulator + prepLen,
						motifL,
						remaining - 1,
						TIHAI_ADI_CYCLE,
					);
					if (postPrepPlan.fits) {
						logBridgePlannerPadding(globalPulseAccumulator, prepLen, postPrepPlan, motifL);
					}
					out.push({
						type: 'resync_bridge',
						phraseId: phraseId++,
						phraseStep: 0,
						phraseLength: 1,
						parentBarIdx,
						pulseOffsetBeforeBar: globalPulseAccumulator,
						localCycleLength: prepLen,
						bridgeKind: 'gati_prep',
					});
					globalPulseAccumulator += estimateRolePulseLen(
						{ type: 'resync_bridge', phraseStep: 0, phraseLength: 1, bridgeKind: 'gati_prep' },
						motifL,
						densityMode,
						true,
						prepLen,
					);
					remaining -= 1;
					// gati_prep завершает de-sync перед входом в финальный tihai.
					activeDeSyncJati = false;
					activeDeSyncCycle = undefined;
					activeDeSyncLockBars = 0;
					progressiveTailPlan = null;
					continue;
				}
				out.push({
					type: 'parent',
					phraseId: phraseId++,
					phraseStep: 0,
					phraseLength: 1,
					parentBarIdx,
				});
				globalPulseAccumulator += estimateRolePulseLen({ type: 'parent', phraseStep: 0, phraseLength: 1 }, motifL, densityMode, deSyncJati, deSyncCycleLength);
				parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
				remaining -= 1;
				continue;
			}
			if (remaining > strictTail.totalBars) {
				const exactPrep = pickGatiPrepLengthForStrictTihai(globalPulseAccumulator, motifL, remaining, true);
				if ((activeDeSyncJati || everAutoDeSync || deSyncJati) && exactPrep !== null) {
					const postPrepPlan = pickStrictTihaiPlanForWindow(
						globalPulseAccumulator + exactPrep,
						motifL,
						remaining - 1,
						TIHAI_ADI_CYCLE,
					);
					if (postPrepPlan.fits) {
						logBridgePlannerPadding(globalPulseAccumulator, exactPrep, postPrepPlan, motifL);
					}
					out.push({
						type: 'resync_bridge',
						phraseId: phraseId++,
						phraseStep: 0,
						phraseLength: 1,
						parentBarIdx,
						pulseOffsetBeforeBar: globalPulseAccumulator,
						localCycleLength: exactPrep,
						bridgeKind: 'gati_prep',
					});
					globalPulseAccumulator += estimateRolePulseLen(
						{ type: 'resync_bridge', phraseStep: 0, phraseLength: 1, bridgeKind: 'gati_prep' },
						motifL,
						densityMode,
						true,
						exactPrep,
					);
					remaining -= 1;
					// gati_prep завершает de-sync перед входом в финальный tihai.
					activeDeSyncJati = false;
					activeDeSyncCycle = undefined;
					activeDeSyncLockBars = 0;
					progressiveTailPlan = null;
					continue;
				}
				out.push({
					type: 'parent',
					phraseId: phraseId++,
					phraseStep: 0,
					phraseLength: 1,
					parentBarIdx,
				});
				globalPulseAccumulator += estimateRolePulseLen({ type: 'parent', phraseStep: 0, phraseLength: 1 }, motifL, densityMode, deSyncJati, deSyncCycleLength);
				parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
				remaining -= 1;
				continue;
			}
			const len = strictTail.totalBars;
			// Художественный контракт: перед финальным tihai всегда оставляем отдельный «вдох».
			const hasShiftNarrative = activeDeSyncJati || everAutoDeSync || deSyncJati;
			if (hasShiftNarrative && remaining === len && len > 4) {
				const prepCandidate =
					pickGatiPrepLengthForStrictTihai(globalPulseAccumulator, motifL, remaining, true) ??
					7;
				const prepLen = prepCandidate === 5 || prepCandidate === 7 || prepCandidate === 9 ? prepCandidate : 7;
				const afterPrepPlan = pickStrictTihaiPlanForWindow(
					globalPulseAccumulator + prepLen,
					motifL,
					remaining - 1,
				);
				if (!(afterPrepPlan.fits && afterPrepPlan.totalBars === remaining - 1)) {
					// Если обязательный «вдох» рушит strict-landing, оставляем математический путь без него.
					// Приоритет: корректный Sam-финал.
				} else {
				logBridgePlannerPadding(globalPulseAccumulator, prepLen, afterPrepPlan, motifL);
				out.push({
					type: 'resync_bridge',
					phraseId: phraseId++,
					phraseStep: 0,
					phraseLength: 1,
					parentBarIdx,
					pulseOffsetBeforeBar: globalPulseAccumulator,
					localCycleLength: prepLen,
					bridgeKind: 'gati_prep',
				});
				globalPulseAccumulator += estimateRolePulseLen(
					{ type: 'resync_bridge', phraseStep: 0, phraseLength: 1, bridgeKind: 'gati_prep' },
					motifL,
					densityMode,
					true,
					prepLen,
				);
				remaining -= 1;
				progressiveTailPlan = null;
				continue;
				}
			}
			const prevTailRole = out[out.length - 1];
			const collapseGapAfterPrep =
				prevTailRole?.type === 'resync_bridge' &&
				prevTailRole.bridgeKind === 'gati_prep' &&
				(strictTail.gapBars ?? 0) > 0;
			let tailPrefixBars = strictTail.prefixKarvaiBars;
			let tailGapBars = strictTail.gapBars;
			let tailLandingIndex = strictTail.landingIndex;
			if (collapseGapAfterPrep) {
				const noGapExact = computeStrictTihaiPlanForExactTotalAndGap(
					globalPulseAccumulator,
					motifL,
					len,
					0,
					TIHAI_ADI_CYCLE,
				);
				// Применяем gap=0 только если сохраняется strict-landing для этого же окна.
				if (noGapExact.fits) {
					tailPrefixBars = noGapExact.prefixKarvaiBars;
					tailGapBars = noGapExact.gapBars;
					tailLandingIndex = noGapExact.landingIndex;
				}
			}
			const pid = phraseId++;
			for (let step = 0; step < len; step++) {
				const barPosNow = out.length;
				const peak = Math.min(1, 0.95 + (step / Math.max(1, len - 1)) * 0.05);
				out.push({
					type: 'tihai',
					phraseId: pid,
					phraseStep: step,
					phraseLength: len,
					parentBarIdx,
					pulseOffsetBeforeBar: globalPulseAccumulator,
					densityFreeze: isDensityFreezeBar(barPosNow, bars),
					deSyncJati,
					localCycleLength: deSyncJati ? deSyncCycleLength : undefined,
					gatiTargetSub: progressiveGatiTarget(barPosNow),
					intensityTarget: peak,
					tihaiPrefixBars: tailPrefixBars,
					tihaiGapBars: tailGapBars,
					tihaiGapPulses: resolveTihaiGapPulses(emotionalProfile, motifL),
					tihaiLandingIndex: tailLandingIndex,
					tihaiPulseLen: hasExplicitMotifPulseLen ? motifL : undefined,
				});
				globalPulseAccumulator += estimateRolePulseLen(
					{ type: 'tihai', phraseStep: step, phraseLength: len },
					motifL,
					densityMode,
					deSyncJati,
					deSyncCycleLength,
				);
			}
			parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
			remaining -= len;
			progressiveTailPlan = null;
			lastTihaiEndBarPos = barPos + len - 1;
			continue;
		}
		const progress = bars > 0 ? (bars - remaining) / bars : 0;
		const progressiveWindow =
			preset === 'progressive'
				? Math.min(remaining, 8 - (barPos % 8))
				: remaining;
		const sectionWindow =
			preset === 'call_fill'
				? Math.min(progressiveWindow, 8 - (barPos % 8))
				: progressiveWindow;
		const chosen = enabledMutations.length > 0 ? pickMutation(sectionWindow, progress) : null;
		if (chosen === null) {
			out.push({
				type: 'parent',
				phraseId: phraseId++,
				phraseStep: 0,
				phraseLength: 1,
				parentBarIdx,
			});
			globalPulseAccumulator += estimateRolePulseLen({ type: 'parent', phraseStep: 0, phraseLength: 1 }, motifL, densityMode, deSyncJati, deSyncCycleLength);
			parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
			remaining -= 1;
			continue;
		}
		const strictTihai =
			chosen === 'tihai'
				? computeStrictTihaiPlan(globalPulseAccumulator, motifL, remaining)
				: null;
		let phraseTihaiPlan = strictTihai;
		let len =
			chosen === 'tihai'
				? Math.min(strictTihai?.totalBars ?? remaining, remaining)
				: MUTATION_PHRASE_LEN[chosen];
		const wantsBridge = chosen === 'tihai' && everAutoDeSync && progress >= 0.7;
		const needsSoftLandingBridge =
			chosen === 'tihai' &&
			remaining > 5 &&
			(strictTihai?.landingIndex ?? Math.max(0, motifL - 1)) !== Math.max(0, motifL - 1);
		if (wantsBridge && remaining <= len && len > 3) {
			len -= 1;
		}
		// Контракт: bridge обязан стоять ДО формулы tihai.
		// Если де-синк активен и tihai упирается в хвост окна, резервируем 1 такт под bridge.
		if (chosen === 'tihai' && activeDeSyncJati && remaining === len && len > 4) {
			len -= 1;
		}
		/** Не пересекать якорь parent каждые 8 тактов (кроме самого якоря). */
		if (preset === 'progressive' && barPos % 8 !== 0) {
			const slotsUntilAnchor = 8 - (barPos % 8);
			if (len > slotsUntilAnchor) {
				for (let i = 0; i < slotsUntilAnchor; i++) {
					out.push({
						type: 'parent',
						phraseId: phraseId++,
						phraseStep: 0,
						phraseLength: 1,
						parentBarIdx,
					});
					globalPulseAccumulator += estimateRolePulseLen({ type: 'parent', phraseStep: 0, phraseLength: 1 }, motifL, densityMode, deSyncJati, deSyncCycleLength);
					parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
					remaining -= 1;
				}
				continue;
			}
		}
		if (preset === 'progressive') {
			const earlySet = new Set<MutationType>(['substitution', 'inversion', 'retrograde', 'rotation']);
			const midSet = new Set<MutationType>(['augmentation', 'diminution', 'echo_decay', 'neighbour_pulsation', 'fractal', 'yati']);
			if (earlySet.has(chosen)) progressiveBars.early += len;
			else if (midSet.has(chosen)) progressiveBars.mid += len;
			else progressiveBars.late += len;
		}
		let phraseAutoDeSync = false;
		let phraseLocalCycle = activeDeSyncCycle;
		const narrativeDeSyncRequired =
			preset === 'progressive' &&
			autoJatiEnabled &&
			chaosLevel >= 20 &&
			bars >= 24;
		const canStartNarrativeDeSync = narrativeDeSyncRequired && !narrativeDeSyncStarted && inNarrativeJatiWindow(barPos) && isPhraseBoundary();
		if (autoJatiEnabled && activeDeSyncJati && activeDeSyncLockBars > 0 && chosen !== 'tihai') {
			phraseAutoDeSync = true;
			if (!(typeof phraseLocalCycle === 'number' && phraseLocalCycle > 0)) phraseLocalCycle = 5;
		}
		if (!phraseAutoDeSync && autoJatiEnabled && chosen !== 'tihai') {
			const route = decideProgressiveDensityRoute({
				preset,
				chaosLevel,
				barPos,
				bars,
				rng,
				alreadyInDeSync: activeDeSyncJati,
				phaseContext: {
					isPhraseBoundary: isPhraseBoundary(),
					inMidWindow: inProgressiveMidWindow(barPos),
					freeze: isDensityFreezeBar(barPos, bars),
					chosen,
					remainingBars: remaining,
					forcedJatiDone: forcedJatiPhraseDone,
				},
			});
			if (route.route === 'jati') {
				phraseAutoDeSync = true;
				forcedJatiPhraseDone = true;
				everAutoDeSync = true;
				phraseLocalCycle = route.localJati ?? 5;
				activeDeSyncJati = true;
				activeDeSyncCycle = phraseLocalCycle;
				activeDeSyncLockBars = Math.max(activeDeSyncLockBars, Math.max(1, route.lockBars ?? 2));
			}
		}
		if (!phraseAutoDeSync && !activeDeSyncJati && canStartNarrativeDeSync && chosen !== 'tihai') {
			phraseAutoDeSync = true;
			forcedJatiPhraseDone = true;
			everAutoDeSync = true;
			narrativeDeSyncStarted = true;
			if (!(typeof phraseLocalCycle === 'number' && phraseLocalCycle > 0)) phraseLocalCycle = rng() < 0.5 ? 5 : 7;
			activeDeSyncJati = true;
			activeDeSyncCycle = phraseLocalCycle;
			activeDeSyncLockBars = Math.max(activeDeSyncLockBars, 2);
		}
		if (phraseAutoDeSync) narrativeDeSyncStarted = true;
		const hardJatiBridge =
			chosen === 'tihai' &&
			autoJatiEnabled &&
			(activeDeSyncJati || phraseAutoDeSync || everAutoDeSync) &&
			remaining > len;
		const needsReSyncBridge = (wantsBridge || hardJatiBridge || needsSoftLandingBridge) && remaining > len;
		const needsDeSyncPrep = phraseAutoDeSync && remaining > len + (needsReSyncBridge ? 1 : 0);
		if (needsDeSyncPrep) {
			out.push({
				type: 'resync_bridge',
				phraseId: phraseId++,
				phraseStep: 0,
				phraseLength: 1,
				parentBarIdx,
				pulseOffsetBeforeBar: globalPulseAccumulator,
				localCycleLength: phraseLocalCycle,
				bridgeKind: 'de_sync_prep',
			});
			globalPulseAccumulator += estimateRolePulseLen(
				{ type: 'resync_bridge', phraseStep: 0, phraseLength: 1, bridgeKind: 'de_sync_prep' },
				motifL,
				densityMode,
				true,
				phraseLocalCycle,
			);
			remaining -= 1;
		}
		if (needsReSyncBridge) {
			const softBridge =
				chosen === 'tihai'
					? pickSoftResyncBridgeForTihaiWindow(globalPulseAccumulator, motifL, remaining)
					: null;
			const bridgePulseLen = softBridge?.bridgePulses ?? TIHAI_ADI_CYCLE;
			if (chosen === 'tihai' && softBridge) {
				phraseTihaiPlan = softBridge.plan;
				len = Math.min(softBridge.plan.totalBars, remaining - 1);
				logBridgePlannerPadding(globalPulseAccumulator, bridgePulseLen, softBridge.plan, motifL);
			}
			out.push({
				type: 'resync_bridge',
				phraseId: phraseId++,
				phraseStep: 0,
				phraseLength: 1,
				parentBarIdx,
				pulseOffsetBeforeBar: globalPulseAccumulator,
				localCycleLength: bridgePulseLen,
				bridgeKind: 'resync',
			});
			globalPulseAccumulator += estimateRolePulseLen(
				{ type: 'resync_bridge', phraseStep: 0, phraseLength: 1 },
				motifL,
				densityMode,
				true,
				bridgePulseLen,
			);
			remaining -= 1;
			activeDeSyncJati = false;
			activeDeSyncCycle = undefined;
			activeDeSyncLockBars = 0;
		}
		const pid = phraseId++;
		for (let step = 0; step < len; step++) {
			const barPosNow = out.length;
			const roleDeSync = activeDeSyncJati || phraseAutoDeSync || needsReSyncBridge;
			const roleLocalCycle = roleDeSync ? (needsReSyncBridge ? undefined : phraseLocalCycle) : undefined;
			const baseIntensity = preset === 'progressive' ? progressiveIntensityTarget(barPosNow) : undefined;
			const finalMuktayiPeak =
				chosen === 'tihai' && barPosNow >= Math.max(0, bars - 8)
					? Math.min(1, 0.95 + (step / Math.max(1, len - 1)) * 0.05)
					: undefined;
			out.push({
				type: chosen,
				phraseId: pid,
				phraseStep: step,
				phraseLength: len,
				parentBarIdx,
				pulseOffsetBeforeBar: globalPulseAccumulator,
				densityFreeze: isDensityFreezeBar(barPosNow, bars),
				deSyncJati: roleDeSync,
				localCycleLength: roleLocalCycle,
				gatiTargetSub: preset === 'progressive' ? progressiveGatiTarget(barPosNow) : undefined,
				intensityTarget:
					preset === 'progressive'
						? Math.max(baseIntensity ?? 0, finalMuktayiPeak ?? 0)
						: undefined,
				tihaiPrefixBars: chosen === 'tihai' ? phraseTihaiPlan?.prefixKarvaiBars : undefined,
				tihaiGapBars: chosen === 'tihai' ? phraseTihaiPlan?.gapBars : undefined,
				tihaiGapPulses:
					chosen === 'tihai'
						? resolveTihaiGapPulses(emotionalProfile, motifL)
						: undefined,
				tihaiLandingIndex: chosen === 'tihai' ? phraseTihaiPlan?.landingIndex : undefined,
				tihaiPulseLen:
					chosen === 'tihai' && preset === 'progressive' && hasExplicitMotifPulseLen ? motifL : undefined,
			} as PhraseRole);
			globalPulseAccumulator += estimateRolePulseLen(
				{ type: chosen, phraseStep: step, phraseLength: len },
				motifL,
				densityMode,
				roleDeSync,
				roleLocalCycle,
			);
		}
		const densityHeavyChosen = chosen === 'augmentation' || chosen === 'fractal' || chosen === 'yati';
		const targetNow = progressiveGatiTarget(barPos);
		if (preset === 'progressive' && targetNow >= 6 && !densityHeavyChosen) densityDebt += 1;
		else if (densityHeavyChosen) densityDebt = Math.max(0, densityDebt - 2);
		parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
		if (chosen === 'truncation') {
			earlyTruncationBarsUsed += overlapEarlyThird(barPos, len);
		}
		if (activeDeSyncJati && activeDeSyncLockBars > 0) activeDeSyncLockBars = Math.max(0, activeDeSyncLockBars - len);
		remaining -= len;
	}
	if (preset === 'progressive' && bars === 32 && chaosLevel >= 15 && !forcedJatiPhraseDone) {
		for (const role of out) {
			if (
				role.type !== 'parent' &&
				role.type !== 'free' &&
				role.phraseStep === 0 &&
				role.pulseOffsetBeforeBar !== undefined &&
				role.pulseOffsetBeforeBar >= 0 &&
				inProgressiveMidWindow(out.indexOf(role))
			) {
				role.deSyncJati = true;
				// Раньше здесь всегда был 5, что делало середину слишком однообразной.
				const roll = rng();
				role.localCycleLength = roll < 0.4 ? 5 : roll < 0.75 ? 7 : 9;
				break;
			}
		}
	}
	if (preset === 'progressive' && everAutoDeSync) {
		const tihaiStart = out.findIndex((r, idx) => idx >= Math.max(0, out.length - 8) && r.type === 'tihai' && r.phraseStep === 0);
		if (tihaiStart > 0) {
			const prev = out[tihaiStart - 1];
			if (prev && prev.type !== 'resync_bridge') {
				out[tihaiStart - 1] = {
					type: 'resync_bridge',
					phraseId: prev.phraseId,
					phraseStep: 0,
					phraseLength: 1,
					parentBarIdx: prev.parentBarIdx,
					pulseOffsetBeforeBar: prev.type === 'parent' || prev.type === 'free' ? undefined : prev.pulseOffsetBeforeBar,
					localCycleLength: TIHAI_ADI_CYCLE,
					bridgeKind: 'resync',
				};
			}
		}
	}
	// Единая инструкция для App-layer: где роль реально в Jati-блоке, роль должна явно
	// нести целевой curSyl (5/7/9), чтобы UI/auto шли через один action-поток.
	for (const role of out) {
		if (role.type === 'parent' || role.type === 'free' || role.type === 'resync_bridge') continue;
		if (role.deSyncJati !== true) continue;
		const target = role.localCycleLength;
		if (target === 5 || target === 7 || target === 9) {
			role.triggerJatiAction = { targetCurSyl: target, source: 'auto' };
		} else {
			// Жесткий gate: Jati-инструкция допустима только для реального размера 5/7/9.
			role.deSyncJati = false;
			role.localCycleLength = undefined;
		}
	}
	for (const [idx, role] of out.entries()) {
		role.emotionalProfile = emotionalProfile;
		if (role.type === 'parent' || role.type === 'free' || role.type === 'resync_bridge') continue;
		const arudiBoundary = role.type !== 'tihai' && role.phraseStep === role.phraseLength - 1;
		const sectionBoundary = (idx + 1) % 8 === 0;
		const nextRole = out[idx + 1];
		const endsBeforeThemeOrBridge = !nextRole || nextRole.type === 'parent' || nextRole.type === 'resync_bridge';
		const majorCadenceType =
			role.type === 'truncation' ||
			role.type === 'prepend_append' ||
			role.type === 'call_fill' ||
			role.type === 'tihai';
		if (arudiBoundary && (sectionBoundary || endsBeforeThemeOrBridge || majorCadenceType)) {
			role.arudiReason = role.phraseLength % 2 === 0 ? 'symmetry_close' : 'phrase_cadence';
		}
		role.prasaMaxEditDistance =
			role.type === 'tihai'
				? 1
				: emotionalProfile === 'yati' ? 1
				: emotionalProfile === 'lasya' ? 2
				: 3;
	}
	return out;
}

// ============================================================================
// Mutation operators (Phase 1 = заглушки, Phase 2+ = реальные)
// ============================================================================

export type MutationOperator = (
	parent: ParentGenome,
	role: Extract<PhraseRole, { type: MutationType }>,
	intensity: number,
	rng: RNG,
) => BarGenome;

/** Заглушка-оператор: возвращает копию указанного parent-бара. Phase 3+ заменит реальными. */
const stubOperator: MutationOperator = (parent, role) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	return cloneBarGenome(src);
};

/** Живая длина такта (до deadStart если задан, иначе curSyl). */
function liveLen(g: BarGenome): number {
	if (typeof g.deadStart === 'number') return Math.max(0, Math.min(g.deadStart, g.curSyl));
	return g.curSyl;
}

/** Слог для доли `cellIdx`: override → словарь → Karvai «-» за пределами живой зоны. */
export function effectiveSyllableToken(genome: BarGenome, cellIdx: number, bpm: number): string {
	if (cellIdx < 0 || cellIdx >= genome.curSyl) return KARVAI_TOKEN;
	const ov = genome.cellSyllables?.[cellIdx];
	if (typeof ov === 'string' && ov.length > 0) return ov;
	const live = liveLen(genome);
	if (cellIdx >= live) return KARVAI_TOKEN;
	const gati = Math.max(1, Math.min(9, genome.curSyl)) as Gati;
	const nps = computeNps(bpm, gati);
	const kalam = pickKalam(nps, undefined);
	const arr = getSyllablesForGati(gati, kalam);
	return arr[cellIdx] ?? 'Ta';
}

/**
 * Substitution: step=0 — parent; step=1 — контрастные слоги (Ja Nu Ki Te или Ta Ka Ju Nu).
 */
const substitutionOperator: MutationOperator = (parent, role, _intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 1) return out;
	const g = Math.min(9, Math.max(1, src.curSyl)) as Gati;
	const baseArr = getSyllablesForGati(g, 'slow');
	const mapA = ['Ja', 'Nu', 'Ki', 'Te'];
	const mapB = ['Ta', 'Ka', 'Ju', 'Nu'];
	const alt = rng() < 0.5 ? mapA : mapB;
	const cs: Record<number, string> = {};
	for (let c = 0; c < live; c++) {
		const tok = c < alt.length ? alt[c]! : (baseArr[c] ?? 'Ta');
		cs[c] = typeof tok === 'string' && tok.trim().length > 0 ? tok : 'Ta';
	}
	out.cellSyllables = cs;
	return out;
};

/**
 * Retrograde: step=0 — parent; step=1 — разворот массива слогов живой зоны + зеркало accents/subs.
 */
const retrogradeOperator: MutationOperator = (parent, role) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 2) return out;
	const lastLive = live - 1;
	const g = Math.min(9, Math.max(1, src.curSyl)) as Gati;
	const baseArr = getSyllablesForGati(g, 'slow');
	const tokens: string[] = [];
	for (let c = 0; c < live; c++) {
		const raw = src.cellSyllables?.[c] ?? baseArr[c] ?? 'Ta';
		tokens.push(typeof raw === 'string' && raw.trim().length > 0 ? raw : 'Ta');
	}
	const revTok = [...tokens].reverse();
	const cs: Record<number, string> = {};
	for (let c = 0; c < live; c++) {
		/** Strict mirror: never invent new syllables here. */
		cs[c] = revTok[c] ?? tokens[live - 1 - c]!;
	}
	out.cellSyllables = cs;

	const revAccents = new Set<number>();
	for (const c of out.accents) {
		if (c < live) revAccents.add(lastLive - c);
		else revAccents.add(c);
	}
	out.accents = revAccents;

	const revSubs: Record<number, number> = {};
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		const c = parseInt(cStr, 10);
		if (c < live) revSubs[lastLive - c] = s;
		else revSubs[c] = s;
	}
	out.subdivisions = revSubs;

	const sameStr = tokens.every((t, i) => t === revTok[i]);
	if (sameStr && live >= 2) {
		const comp = new Set<number>();
		for (let c = 0; c < live; c++) {
			if (!src.accents.has(c)) comp.add(c);
		}
		out.accents = comp;
	}
	return out;
};

/**
 * Inversion: step=0 — parent; step=1 — акценты только на тех живых клетках, где у parent их
 * НЕ было (и наоборот). Subdivisions сохраняются — инвертируем только акцентную поверхность.
 */
const inversionOperator: MutationOperator = (parent, role) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 1) return out;
	const nextAccents = new Set<number>();
	for (let c = 0; c < live; c++) {
		if (!out.accents.has(c)) nextAccents.add(c);
	}
	// Акценты в dead-зоне — не сохраняем (они и так не слышны).
	out.accents = nextAccents;
	return out;
};

// ============================================================================
// Phase 3 operators
// ============================================================================

/**
 * Rotation (len=3): parent → сдвиг на k1 → сдвиг на k2.
 * Accents/subdivisions живой зоны циклически смещаются; мёртвая зона не трогается.
 * k = round(step * (0.5 + intensity * 1.5)), ограничено [1, live-1].
 */
const rotationOperator: MutationOperator = (parent, role, intensity) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 2) return out;
	const raw = Math.round(role.phraseStep * (0.5 + intensity * 1.5));
	const k = Math.max(1, Math.min(live - 1, raw));

	const rotAcc = new Set<number>();
	for (const c of out.accents) {
		if (c < live) rotAcc.add((c + k) % live);
		else rotAcc.add(c);
	}
	out.accents = rotAcc;

	const rotSub: Record<number, number> = {};
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		const c = parseInt(cStr, 10);
		if (c < live) rotSub[(c + k) % live] = s;
		else rotSub[c] = s;
	}
	out.subdivisions = rotSub;
	return out;
};

/**
 * Truncation (len=5): parent → постепенно урезанная live-зона через растущий deadStart.
 * На последнем шаге intensity=0.8 удаляет ≈0.95*live0 клеток в dead, оставляя опорный «огрызок».
 */
const truncationOperator: MutationOperator = (parent, role, intensity) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live0 = liveLen(out);
	if (live0 < 2) return out;
	const maxStep = Math.max(1, role.phraseLength - 1);
	const shrink = (role.phraseStep / maxStep) * (0.3 + intensity * 0.7);
	const targetLive = Math.max(1, Math.round(live0 * (1 - shrink)));
	/** Grid conservation: curSyl не меняется; deadStart = число живых долей (первая мёртвая = индекс). */
	if (targetLive >= out.curSyl) {
		delete out.deadStart;
	} else {
		out.deadStart = targetLive;
	}
	const dead = typeof out.deadStart === 'number' ? out.deadStart : out.curSyl;
	const liveAcc = new Set<number>();
	for (const c of out.accents) if (c < dead) liveAcc.add(c);
	out.accents = liveAcc;
	const liveSubs: Record<number, number> = {};
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		const c = parseInt(cStr, 10);
		if (c < dead) liveSubs[c] = s;
	}
	out.subdivisions = liveSubs;
	return out;
};

/**
 * Augmentation (len=3): parent → растущая плотность подделений на живых клетках без subdiv.
 * Это «augmentation» в смысле Carnatic-Gati-усложнения — больше ударов внутри долей,
 * а не удлинение времени (CurSyl/meter — это Jati, не трогаем).
 */
const augmentationOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 1) return out;
	const maxStep = Math.max(1, role.phraseLength - 1);
	const fraction = (role.phraseStep / maxStep) * (0.3 + intensity * 0.6);
	const free: number[] = [];
	for (let c = 0; c < live; c++) if (!(c in out.subdivisions)) free.push(c);
	if (free.length === 0) return out;
	const target = Math.max(1, Math.round(fraction * live));

	for (let i = free.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = free[i]!;
		free[i] = free[j]!;
		free[j] = tmp;
	}
	for (let i = 0; i < target && i < free.length; i++) {
		out.subdivisions[free[i]!] = 2 + Math.floor(rng() * 3);
	}
	return out;
};

/**
 * Diminution (len=3): обратное Augmentation — постепенно снимаем подделения, возвращая
 * клетки к плоскому пульсу. step=2 при intensity=0.8 снимает ~80% подделений.
 */
const diminutionOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const keys = Object.keys(out.subdivisions).map((k) => parseInt(k, 10)).filter((n) => Number.isFinite(n));
	if (keys.length === 0) return out;
	const maxStep = Math.max(1, role.phraseLength - 1);
	const fraction = (role.phraseStep / maxStep) * (0.4 + intensity * 0.6);
	const removeN = Math.max(1, Math.round(fraction * keys.length));

	for (let i = keys.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = keys[i]!;
		keys[i] = keys[j]!;
		keys[j] = tmp;
	}
	for (let i = 0; i < removeN && i < keys.length; i++) {
		delete out.subdivisions[keys[i]!];
	}
	return out;
};

/**
 * Prepend/Append (len=4): step=0 parent; step=1 добавляет opening-accent (idx=0);
 * step=2 добавляет closing-accent (idx=live-1); step=3 ставит оба (tihai-подобная рамка).
 */
const prependAppendOperator: MutationOperator = (parent, role) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 2) return out;
	const prepend = role.phraseStep === 1 || role.phraseStep === 3;
	const append = role.phraseStep === 2 || role.phraseStep === 3;
	if (prepend) out.accents.add(0);
	if (append) out.accents.add(live - 1);
	return out;
};

/**
 * Tihai: 3× фраза + Karvai между повторами + landing. Длина блока n ≥ 6: опциональные
 * префиксные такты «-» (n−6), затем P G P G P и landing.
 */
const tihaiOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const targetPulseLen = Math.max(1, Math.min(9, Math.floor(role.tihaiPulseLen ?? src.curSyl)));
	const n = role.phraseLength;
	const s = role.phraseStep;
	const last = n - 1;
	const live = liveLen(src);
	if (live < 1) return cloneBarGenome(src);
	const prefixBars = Math.max(0, Math.floor(role.tihaiPrefixBars ?? Math.max(0, n - 6)));
	const gapBars = Math.max(0, Math.floor(role.tihaiGapBars ?? 1));
	const gapPulses = Math.max(0, Math.floor(role.tihaiGapPulses ?? src.curSyl));
	const cycleLen = role.deSyncJati && typeof role.localCycleLength === 'number' ? Math.max(1, role.localCycleLength) : TIHAI_ADI_CYCLE;
	void cycleLen;

	if (s === last) {
		const out = cloneBarGenome(src);
		out.curSyl = targetPulseLen;
		delete out.deadStart;
		out.subdivisions = {};
		out.accents = new Set<number>();
		const landingIdx = resolveFinalTihaiLandingIndex(out.curSyl, role.tihaiLandingIndex);
		out.accents.add(landingIdx);
		const cs: Record<number, string> = {};
		for (let c = 0; c < landingIdx; c++) {
			const tok = out.cellSyllables?.[c];
			cs[c] = tok === 'Thom' ? 'Ta' : tok ?? 'Ta';
		}
		enforceLegacySyllableAssembly(cs, out.curSyl, role.phraseId + 197);
		enforceNoRepeatedTaRuns(cs, role.phraseId + 211, out.curSyl);
		enforceNoRepeatedSyllableRuns(cs, role.phraseId + 311, out.curSyl);
		enforceLegacySyllableAssembly(cs, out.curSyl, role.phraseId + 419);
		cs[landingIdx] = 'Thom';
		for (let c = landingIdx + 1; c < out.curSyl; c++) cs[c] = KARVAI_TOKEN;
		out.cellSyllables = cs;
		return out;
	}

	// Контракт: первый такт формулы tihai всегда цельная фраза (без скрытых karvai).
	if (s === 0) {
		const out = cloneBarGenome(src);
		out.curSyl = targetPulseLen;
		delete out.deadStart;
		out.subdivisions = {};
		out.cellSyllables = buildContextualTihaiFormula(role.phraseId, out.curSyl);
		return out;
	}

	if (s < prefixBars) {
		const out = cloneBarGenome(src);
		out.curSyl = targetPulseLen;
		delete out.deadStart;
		out.accents = new Set();
		out.subdivisions = {};
		const cs: Record<number, string> = {};
		for (let c = 0; c < out.curSyl; c++) cs[c] = KARVAI_TOKEN;
		out.cellSyllables = cs;
		return out;
	}

	const coreStep = s - prefixBars;
	const phrase2Start = 1 + gapBars;
	const phrase3Start = phrase2Start + 1 + gapBars;
	const energy = Math.max(0, Math.min(1, role.intensityTarget ?? intensity ?? 0.5));
	const arc = role.emotionalProfile ?? 'tandava';
	const inGap =
		(coreStep > 0 && coreStep < phrase2Start) ||
		(coreStep > phrase2Start && coreStep < phrase3Start);
	if (inGap) {
		const out = cloneBarGenome(src);
		out.curSyl = targetPulseLen;
		delete out.deadStart;
		out.accents = new Set();
		out.subdivisions = {};
		const cs: Record<number, string> = {};
		const densePrefix = energy >= 0.72;
		const arcSparseBoost = arc === 'lasya' ? 2 : arc === 'yati' ? 1 : 0;
		const baseFade = Math.max(0, Math.min(out.curSyl, gapPulses));
		const fade = densePrefix
			? Math.max(baseFade, Math.min(out.curSyl, Math.ceil(out.curSyl * 0.7) + arcSparseBoost))
			: baseFade;
		for (let c = 0; c < out.curSyl; c++) {
			cs[c] = c < fade ? KARVAI_TOKEN : 'Ta';
		}
		out.cellSyllables = cs;
		return out;
	}

	const out = cloneBarGenome(src);
	out.curSyl = targetPulseLen;
	delete out.deadStart;
	out.subdivisions = {};
	const lockedFormulaCells = buildContextualTihaiFormula(role.phraseId, out.curSyl);
	out.cellSyllables = lockedFormulaCells;
	const formulaReplicaStep = coreStep === 0 || coreStep === phrase2Start || coreStep === phrase3Start;
	if (formulaReplicaStep) {
		// Micro-variation: keep syllable identity, allow tiny accent/karvai arc on A2/A3.
		if (coreStep === phrase2Start || coreStep === phrase3Start) {
			const live = Math.max(1, out.curSyl);
			const shift = coreStep === phrase2Start ? 1 : -1;
			const shifted = new Set<number>();
			for (const a of out.accents) shifted.add((a + shift + live) % live);
			if (shifted.size > 0) out.accents = shifted;
			const canKarvai = energy <= 0.62 || arc === 'lasya' || coreStep === phrase3Start;
			if (canKarvai && out.cellSyllables) {
				const pivot = Math.max(1, Math.min(live - 2, ((role.phraseId + coreStep * 3) % Math.max(2, live - 1))));
				const tok = out.cellSyllables[pivot];
				if (typeof tok === 'string' && tok !== 'Thom') out.cellSyllables[pivot] = KARVAI_TOKEN;
			}
		}
		return out;
	}
	if (!role.densityFreeze && coreStep >= phrase2Start && intensity >= 0.7) {
		const heavy = intensity >= 0.7;
		const superTihai = intensity >= 1.0;
		const shift = Math.max(1, Math.min(Math.max(1, live - 1), Math.round((0.5 + intensity * 0.8))));
		const nextAcc = new Set<number>();
		for (const c of out.accents) {
			if (c < live) nextAcc.add((c + shift) % live);
		}
		nextAcc.add(0);
		if (live > 1) nextAcc.add(live - 1);
		if (heavy) for (let c = 1; c < live; c += 2) nextAcc.add(c);
		if (superTihai) for (let c = 0; c < live; c++) if (c % 3 === 0) nextAcc.add(c);
		out.accents = nextAcc;
		const density = superTihai ? 0.75 : heavy ? 0.55 : 0.35;
		for (let c = 0; c < live; c++) {
			if (rng() < density) out.subdivisions[c] = superTihai ? 4 + Math.floor(rng() * 3) : 2 + Math.floor(rng() * 3);
		}
	}
	return out;
};

/**
 * Echo decay (len=4): parent → затухающие эхо. На каждом шаге часть accents и subdivisions
 * снимается (amnesia-curve). intensity регулирует скорость затухания.
 */
const echoDecayOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const maxStep = Math.max(1, role.phraseLength - 1);
	// keepRatio: step=1 ≈ 0.7, step=3 ≈ 0.1 при intensity=0.8.
	const decayFactor = (role.phraseStep / maxStep) * (0.5 + intensity * 0.8);
	const keepRatio = Math.max(0, 1 - decayFactor);

	const pruneSet = <K>(set: Set<K>, rng: RNG) => {
		const arr = [...set];
		const kept = new Set<K>();
		for (const v of arr) {
			if (rng() < keepRatio) kept.add(v);
		}
		return kept;
	};

	out.accents = pruneSet(out.accents, rng);

	const keptSubs: Record<number, number> = {};
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		if (rng() < keepRatio) keptSubs[parseInt(cStr, 10)] = s;
	}
	out.subdivisions = keptSubs;
	return out;
};

/**
 * Neighbour pulsation (len=3): parent → соседняя пульсация ±1 клетка → parent.
 * step=0 parent (curSyl=N); step=1 curSyl=N±1 (направление — детерминистски от rng);
 * step=2 возвращает curSyl=N. Accent-каркас масштабируется пропорционально.
 *
 * «Neighbour» в Carnatic-смысле: движение по родственным Jati, не прыжок на дальние пульсы.
 */
const neighbourPulsationOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;
	if (role.phraseStep === 2) return out; // возврат к parent

	// Gati-маршрут: сохраняем скелет цикла, меняем только внутреннюю плотность.
	if (role.deSyncJati !== true) {
		const live = liveLen(out);
		if (live < 1) return out;
		const target = Math.max(1, Math.min(live, Math.round(1 + intensity * 2)));
		for (let i = 0; i < target; i++) {
			const c = Math.min(live - 1, i * 2);
			out.subdivisions[c] = Math.max(out.subdivisions[c] ?? 1, 2 + (i % 2));
		}
		return out;
	}

	// step=1: соседняя пульсация. Направление: ±1 (ограничено [3..9]).
	const delta = rng() < 0.5 ? -1 : 1;
	const nextSyl = Math.max(3, Math.min(9, src.curSyl + delta));
	if (nextSyl === src.curSyl) return out;

	const scale = nextSyl / src.curSyl;
	const scaled: BarGenome = {
		curSyl: nextSyl,
		accents: new Set<number>(),
		subdivisions: {},
	};
	for (const c of out.accents) {
		const mapped = Math.min(nextSyl - 1, Math.max(0, Math.round(c * scale)));
		scaled.accents.add(mapped);
	}
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		const c = parseInt(cStr, 10);
		const mapped = Math.min(nextSyl - 1, Math.max(0, Math.round(c * scale)));
		scaled.subdivisions[mapped] = s;
	}
	// deadStart масштабируем пропорционально
	if (typeof out.deadStart === 'number') {
		scaled.deadStart = Math.min(nextSyl, Math.max(1, Math.round(out.deadStart * scale)));
	}
	// intensity не меняет структуру neighbour — она про соседство, не про силу.
	void intensity;
	return scaled;
};

/**
 * Call & fill (len=4): диалогическая пара. step=0 parent (call);
 * step=1 fill — уплотнение (augmentation-like subdivisions на свободных клетках);
 * step=2 parent снова (повтор call); step=3 fill — retrograde или сильнее augmentation.
 */
const callFillOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	// call-бары (step 0, 2) — чистый parent
	if (role.phraseStep === 0 || role.phraseStep === 2) return out;

	const live = liveLen(out);
	if (live < 1) return out;

	if (role.phraseStep === 1) {
		// Fill #1: уплотнение subdivisions на свободных клетках.
		const free: number[] = [];
		for (let c = 0; c < live; c++) if (!(c in out.subdivisions)) free.push(c);
		const target = Math.min(
			free.length,
			Math.max(1, Math.round(free.length * (0.5 + intensity * 0.7))),
		);
		for (let i = free.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			const tmp = free[i]!;
			free[i] = free[j]!;
			free[j] = tmp;
		}
		for (let i = 0; i < target && i < free.length; i++) {
			out.subdivisions[free[i]!] = 2 + Math.floor(rng() * 3);
		}
		return out;
	}

	// step=3: сильнее — retrograde + добавить акцент на live-1 (конец фразы).
	const lastLive = live - 1;
	const revAccents = new Set<number>();
	for (const c of out.accents) {
		if (c < live) revAccents.add(lastLive - c);
		else revAccents.add(c);
	}
	revAccents.add(lastLive);
	out.accents = revAccents;
	const revSubs: Record<number, number> = {};
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		const c = parseInt(cStr, 10);
		if (c < live) revSubs[lastLive - c] = s;
		else revSubs[c] = s;
	}
	out.subdivisions = revSubs;
	return out;
};

/**
 * Fractal (len=3): parent → на случайных живых клетках прописывается subdivision,
 * равный curSyl parent-такта — клетка «становится уменьшенной копией мотива».
 * Число фрактальных клеток растёт по step, ограничено intensity.
 */
const fractalOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 1) return out;
	const target = Math.max(1, Math.round((0.2 + intensity * 0.5) * role.phraseStep));
	const recSub = Math.max(2, Math.min(9, src.curSyl));
	const pool: number[] = [];
	for (let c = 0; c < live; c++) pool.push(c);
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = pool[i]!;
		pool[i] = pool[j]!;
		pool[j] = tmp;
	}
	for (let i = 0; i < target && i < pool.length; i++) {
		out.subdivisions[pool[i]!] = recSub;
	}
	return out;
};

/**
 * Yati (len=4): ступенчатая плотность 1-2-3-4 по живым клеткам.
 */
const yatiOperator: MutationOperator = (parent, role) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	const live = liveLen(out);
	if (live < 1) return out;
	const yati = [1, 2, 3, 4];
	const steps = yati.slice(0, Math.max(1, role.phraseStep + 1));
	out.subdivisions = {};
	const cs: Record<number, string> = { ...(out.cellSyllables ?? {}) };
	for (let i = 0; i < Math.min(live, steps.length); i++) {
		const g = Math.max(1, Math.min(9, steps[i] ?? 1)) as Gati;
		if (g > 1) out.subdivisions[i] = g;
		cs[i] = getSyllablesForGati(g, 'medium')[0] ?? 'Ta';
		out.accents.add(i);
	}
	out.cellSyllables = cs;
	return out;
};

/**
 * Реестр операторов по типу. Phase 2: Substitution/Retrograde/Inversion — настоящие.
 * Phase 3: Rotation/Truncation/Augmentation/Diminution/Prepend-Append/Fractal.
 * Phase 4: Tihai/Echo-decay/Neighbour/Call-fill.
 */
function isAllRestCellBar(genome: BarGenome): boolean {
	if (!genome.cellSyllables) return false;
	const keys = Object.keys(genome.cellSyllables);
	if (keys.length < genome.curSyl) return false;
	for (let c = 0; c < genome.curSyl; c++) {
		const t = genome.cellSyllables[c];
		if (t !== KARVAI_TOKEN && t !== '-') return false;
	}
	return true;
}

/** Минимум ceil(curSyl/4) акцентов; truncation → доля 0; такты только из «-» не трогаем. */
function ensureAccentPolicy(genome: BarGenome, role: PhraseRole): void {
	if (role.type === 'parent' || role.type === 'free' || role.type === 'resync_bridge') return;
	if (isAllRestCellBar(genome)) return;
	const live = liveLen(genome);
	const minA = Math.max(1, Math.ceil(genome.curSyl / 4));
	if (role.type === 'truncation' && role.phraseStep > 0) genome.accents.add(0);
	if (genome.accents.size >= minA) return;
	const cand = [0, Math.floor(genome.curSyl / 2), genome.curSyl - 1, 1, genome.curSyl - 2].filter((c) => c >= 0 && c < live);
	for (const c of cand) {
		if (genome.accents.size >= minA) break;
		genome.accents.add(c);
	}
}

function enforceTihaiSubdivisionContract(genome: BarGenome, role: Extract<PhraseRole, { type: MutationType }>): void {
	// Hard contract for tihai block (A-A-A + inter-segment pauses):
	// no mutator may leave subdivisions in tihai cells.
	if (role.type !== 'tihai') return;
	genome.subdivisions = {};
}

function enforceTihaiLandingTailContract(genome: BarGenome, role: Extract<PhraseRole, { type: MutationType }>): void {
	if (role.type !== 'tihai') return;
	// Dead-tail must never cut tihai timing; keep full physical bar.
	delete genome.deadStart;
	if (role.phraseStep !== role.phraseLength - 1) return;
	if (!genome.cellSyllables) genome.cellSyllables = {};
	const landingIdx = resolveFinalTihaiLandingIndex(genome.curSyl, role.tihaiLandingIndex);
	genome.accents.add(landingIdx);
	genome.cellSyllables[landingIdx] = 'Thom';
	for (let c = landingIdx + 1; c < genome.curSyl; c++) {
		genome.cellSyllables[c] = KARVAI_TOKEN;
	}
}

function applyDeSyncWholeJatiPattern(genome: BarGenome, role: Extract<PhraseRole, { type: MutationType }>, rng: RNG): void {
	if (role.deSyncJati !== true) return;
	if (role.type === 'tihai') return;
	if (genome.curSyl <= 2) return;
	const preferred =
		typeof role.localCycleLength === 'number' && role.localCycleLength > 0 ? Math.round(role.localCycleLength) : (rng() < 0.5 ? 5 : 7);
	const nextSyl = Math.max(3, Math.min(9, preferred));
	genome.curSyl = nextSyl;
	delete genome.deadStart;
	genome.subdivisions = {};
	const kalam = (role.gatiTargetSub ?? 4) >= 8 ? 'fast' : 'medium';
	const basePhrase = getSyllablesForGati(nextSyl, kalam);
	const rotateBy = Math.floor(rng() * Math.max(1, nextSyl));
	const rotate = <T,>(arr: readonly T[], k: number): T[] => {
		if (arr.length < 2) return [...arr];
		const shift = ((k % arr.length) + arr.length) % arr.length;
		return [...arr.slice(shift), ...arr.slice(0, shift)];
	};
	const phrase5: readonly string[][] = [
		['Ta', 'Ka', 'Ta', 'Ki', 'Ta'],
		['Ta', 'Dhi', 'Nu', 'Ki', 'Ta'],
		['Ta', 'Nu', 'Ka', 'Ju', 'Ta'],
	];
	const phrase7: readonly string[][] = [
		['Ta', 'Ki', 'Ta', 'Ka', 'Dhi', 'Mi', 'Ta'],
		['Ta', 'Nu', 'Ka', 'Ta', 'Ki', 'Te', 'Ta'],
		['Ta', 'Dhi', 'Mi', 'Nu', 'Ka', 'Ju', 'Ta'],
	];
	const phrase9: readonly string[][] = [
		['Ta', 'Ka', 'Dhi', 'Mi', 'Ta', 'Ki', 'Te', 'Nu', 'Ta'],
		['Ta', 'Nu', 'Ka', 'Ju', 'Ta', 'Ki', 'Ta', 'Dhi', 'Ta'],
		['Ta', 'Ki', 'Ta', 'Ka', 'Dhi', 'Mi', 'Nu', 'Te', 'Ta'],
	];
	const customPool =
		nextSyl === 5 ? phrase5
		: nextSyl === 7 ? phrase7
		: nextSyl === 9 ? phrase9
		: null;
	const selectedCustom =
		customPool && customPool.length > 0
			? rotate(customPool[Math.floor(rng() * customPool.length)]!, rotateBy)
			: null;
	const cs: Record<number, string> = {};
	for (let c = 0; c < nextSyl; c++) {
		const tok = selectedCustom?.[c] ?? basePhrase[c] ?? 'Ta';
		cs[c] = tok;
	}
	genome.cellSyllables = cs;
	// Делает рисунок менее «одинаковым»: 2-3 варианта акцентного каркаса.
	const accentVariant = Math.floor(rng() * 3);
	if (accentVariant === 0) {
		genome.accents = new Set<number>([0, Math.max(0, Math.floor(nextSyl / 2)), nextSyl - 1]);
	} else if (accentVariant === 1) {
		genome.accents = new Set<number>([0, Math.max(0, Math.floor(nextSyl / 3)), nextSyl - 1]);
	} else {
		genome.accents = new Set<number>([0, Math.max(0, Math.floor((2 * nextSyl) / 3)), nextSyl - 1]);
	}
}

function applyProgressiveGatiFlow(genome: BarGenome, role: Extract<PhraseRole, { type: MutationType }>, rng: RNG): void {
	if (role.deSyncJati === true) return;
	const target = Math.max(1, Math.min(9, Math.round(role.gatiTargetSub ?? 4)));
	if (target <= 4) return;
	const live = liveLen(genome);
	if (live < 1) return;
	const minCells = target >= 8 ? Math.max(2, Math.ceil(live * 0.7)) : Math.max(1, Math.ceil(live * 0.45));
	const desiredSub = target >= 8 ? 4 : 3;
	const cells: number[] = [];
	for (let c = 0; c < live; c++) cells.push(c);
	for (let i = cells.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const t = cells[i]!;
		cells[i] = cells[j]!;
		cells[j] = t;
	}
	for (let i = 0; i < minCells && i < cells.length; i++) {
		const c = cells[i]!;
		const prev = genome.subdivisions[c] ?? 1;
		genome.subdivisions[c] = Math.max(prev, desiredSub);
	}
}

function applyStrongBeatPhonetics(genome: BarGenome, role: Extract<PhraseRole, { type: MutationType }>): void {
	// Для tihai не форсируем Ta на сильных долях:
	// - gap/prefix должны оставаться karvai (иначе появляется артефакт [Ta, -, -, -, Ta]);
	// - в landing-баре нельзя добавлять хвостовой Ta после Thom.
	if (role.type === 'tihai') return;
	if (!genome.cellSyllables) genome.cellSyllables = {};
	const live = liveLen(genome);
	for (const beat of [0, 4]) {
		if (beat >= live) continue;
		const cur = genome.cellSyllables[beat];
		if (cur === 'Thom' && role.phraseStep === role.phraseLength - 1) continue;
		genome.cellSyllables[beat] = 'Ta';
	}
}

function normalizeTokenClass(raw: string): string {
	return raw.trim().replace(/\*+$/u, '').replace(/\(.*?\)/gu, '').trim();
}

function isThomToken(raw: string): boolean {
	return normalizeTokenClass(raw).toLowerCase() === 'thom';
}

function isHardToken(raw: string): boolean {
	const tok = normalizeTokenClass(raw);
	return (HARD_PHONETICS as readonly string[]).includes(tok);
}

function isSoftToken(raw: string): boolean {
	const tok = normalizeTokenClass(raw);
	return (SOFT_PHONETICS as readonly string[]).includes(tok);
}

function pickSoftToken(seed: number): string {
	return SOFT_PHONETICS[Math.abs(seed) % SOFT_PHONETICS.length]!;
}

function pickHardToken(seed: number): string {
	return HARD_PHONETICS[Math.abs(seed) % HARD_PHONETICS.length]!;
}

function isArudiBoundary(role: Extract<PhraseRole, { type: MutationType }>): boolean {
	return role.phraseStep === role.phraseLength - 1 && role.type !== 'tihai';
}

function applyIntensityPhonetics(
	genome: BarGenome,
	role: Extract<PhraseRole, { type: MutationType }>,
	intensityTarget: number | undefined,
): void {
	if (role.type === 'tihai') return;
	const intensity = Math.max(0, Math.min(1, intensityTarget ?? 0.5));
	if (!genome.cellSyllables) genome.cellSyllables = {};
	const live = liveLen(genome);
	if (live < 1) return;
	if (intensity < 0.5) {
		for (let c = 0; c < live; c++) {
			const cur = genome.cellSyllables[c];
			if (typeof cur === 'string' && isHardToken(cur)) {
				genome.cellSyllables[c] = pickSoftToken(c);
			}
		}
		return;
	}
	if (intensity <= 0.8) {
		for (let c = 0; c < live; c++) {
			const cur = genome.cellSyllables[c];
			if (typeof cur !== 'string' || cur.length === 0) {
				genome.cellSyllables[c] = c % 2 === 0 ? pickSoftToken(c) : pickHardToken(c);
			}
		}
		return;
	}
	if (intensity > 0.8) {
		const heavyFrom = Math.max(0, Math.floor(live * 0.4));
		for (let c = heavyFrom; c < live; c++) {
			const cur = genome.cellSyllables[c];
			if (!(typeof cur === 'string' && isHardToken(cur))) {
				genome.cellSyllables[c] = pickHardToken(c);
			}
		}
		// На boundary-барах ставим тяжелое закрытие, но сам Thom пройдет через Thom-rule gate.
		if (isArudiBoundary(role)) genome.cellSyllables[live - 1] = 'Thom';
	}
}

function softenPhoneticHardJunctions(
	genome: BarGenome,
	role: Extract<PhraseRole, { type: MutationType }>,
	intensityTarget: number | undefined,
): void {
	if (role.type === 'tihai') return;
	if (!genome.cellSyllables) return;
	const live = liveLen(genome);
	if (live < 2) return;
	const intensity = Math.max(0, Math.min(1, intensityTarget ?? 0.5));
	// Mid-section aggressive smoothing: reduce hard-hard collisions before culmination.
	const active = intensity >= 0.45 && intensity <= 0.86;
	if (!active) return;
	for (let c = 0; c < live - 1; c++) {
		const left = genome.cellSyllables[c];
		const right = genome.cellSyllables[c + 1];
		if (typeof left !== 'string' || typeof right !== 'string') continue;
		if (!isHardToken(left) || !isHardToken(right)) continue;
		const accentProtected = genome.accents.has(c + 1);
		if (accentProtected) continue;
		genome.cellSyllables[c + 1] = pickSoftToken(c + 1);
	}
}

function applyPrasaContinuity(
	barIdx: number,
	genome: BarGenome,
	role: Extract<PhraseRole, { type: MutationType }>,
	syllablesDefault: number,
	m: BarRandomizerMutable,
): void {
	if (role.phraseStep <= 0 || barIdx <= 0) return;
	if (role.type === 'tihai') {
		// Для tihai допускаем prasa-правку только на чистых karvai-барах,
		// чтобы формула A-A-A оставалась неизменной без жесткой индексации.
		if (!isTihaiKarvaiOnlyStep(role) || isTihaiFormulaReplicaStep(role)) return;
	}
	const prev = snapshotBarGenome(barIdx - 1, syllablesDefault, {
		customSyllables: m.customSyllables,
		accents: m.accents,
		customSubdivisions: m.customSubdivisions,
		customCellSyllables: m.customCellSyllables,
		deadCells: m.deadCells,
	});
	const livePrev = liveLen(prev);
	const liveNow = liveLen(genome);
	const live = Math.min(livePrev, liveNow);
	if (live < 1) return;
	if (!genome.cellSyllables) genome.cellSyllables = {};
	let diffs = 0;
	const defaultCap = role.type === 'tihai' ? 1 : Math.floor(live * 0.25);
	const maxDiffs = Math.max(1, Math.min(live - 1, role.prasaMaxEditDistance ?? defaultCap));
	for (let c = 0; c < live; c++) {
		const prevTok = prev.cellSyllables?.[c];
		if (typeof prevTok !== 'string' || prevTok.length === 0) continue;
		const curTok = genome.cellSyllables[c];
		if (typeof curTok !== 'string' || curTok.length === 0) {
			genome.cellSyllables[c] = prevTok;
			continue;
		}
		if (normalizeTokenClass(curTok) !== normalizeTokenClass(prevTok)) {
			diffs += 1;
			if (diffs > maxDiffs) genome.cellSyllables[c] = prevTok;
		}
	}
}

function enforceThomRule(genome: BarGenome, role: Extract<PhraseRole, { type: MutationType }>): void {
	if (!genome.cellSyllables) return;
	const live = liveLen(genome);
	if (live < 1) return;
	const isFinalTihaiLanding = role.type === 'tihai' && role.phraseStep === role.phraseLength - 1;
	const landingIdx = isFinalTihaiLanding ? resolveFinalTihaiLandingIndex(genome.curSyl, role.tihaiLandingIndex) : -1;
	const arudiIdx = isArudiBoundary(role) ? live - 1 : -1;
	for (let c = 0; c < live; c++) {
		const tok = genome.cellSyllables[c];
		if (typeof tok !== 'string' || !isThomToken(tok)) continue;
		const allowed = c === landingIdx || c === arudiIdx;
		if (!allowed) {
			genome.cellSyllables[c] = c >= Math.max(0, live - 2) ? 'Ta' : 'Dhi';
			continue;
		}
		genome.accents.add(c);
		const next = c + 1 < live ? genome.cellSyllables[c + 1] : undefined;
		if (typeof next === 'string' && isSoftToken(next)) {
			// Thom не должен тянуть за собой лёгкий хвост внутри смыслового блока.
			genome.cellSyllables[c + 1] = 'Ta';
		}
	}
}

function scrubInternalThom(genome: BarGenome, allowedIndex: number | null): void {
	if (!genome.cellSyllables) return;
	for (const [cStr, tok] of Object.entries(genome.cellSyllables)) {
		if (tok !== 'Thom') continue;
		const c = parseInt(cStr, 10);
		if (allowedIndex === null || c !== allowedIndex) {
			genome.cellSyllables[c] = 'Ta';
		}
	}
}

export const MUTATION_OPERATORS: Record<MutationType, MutationOperator> = {
	substitution: substitutionOperator,
	retrograde: retrogradeOperator,
	inversion: inversionOperator,
	rotation: rotationOperator,
	truncation: truncationOperator,
	augmentation: augmentationOperator,
	diminution: diminutionOperator,
	prepend_append: prependAppendOperator,
	fractal: fractalOperator,
	yati: yatiOperator,
	tihai: tihaiOperator,
	echo_decay: echoDecayOperator,
	neighbour_pulsation: neighbourPulsationOperator,
	call_fill: callFillOperator,
};

// ============================================================================
// Bar-boundary apply
// ============================================================================

export type ApplyParentModeArgs = {
	barIdx: number;
	parent: ParentGenome;
	schedule: PhraseSchedule;
	chaos: number;
	syllablesDefault: number;
	m: BarRandomizerMutable;
	rng: RNG;
	/** Для role='free' филлера — передаём те же оси, что и во free-режиме. */
	freeAxes: {
		randomPulsation: boolean;
		randomPattern: boolean;
		randomSpeed: boolean;
		randomBarSpeed: boolean;
		forceFirstBeat: boolean;
	};
};

/**
 * Одна итерация parent-режима на границе такта `barIdx` (как `applyRandomizerEffectsToBar`
 * в free-режиме). Маршрутизация по `schedule[barIdx]`:
 *
 * - role='parent' → копия parent.bars[role.parentBarIdx].
 * - role='free' → делегирует во free-random с текущими осями.
 * - role=MutationType → вызывает оператор из MUTATION_OPERATORS.
 *
 * Возвращает true если состояние бара изменилось (для триггера перестройки sequenceRef).
 */
export function applyParentModeBar(args: ApplyParentModeArgs): boolean {
	const { barIdx, parent, schedule, chaos, syllablesDefault, m, rng, freeAxes } = args;
	const role = schedule[barIdx];
	if (!role) return false;
	const physicalPulseBeforeBar = computePhysicalPulseOffsetBeforeBar(barIdx, syllablesDefault, m);
	const canAssertPulseHistory = hasContinuousMaterializedHistory(barIdx, m);
	if (
		canAssertPulseHistory &&
		role.type === 'tihai' &&
		role.phraseStep === 0 &&
		typeof role.pulseOffsetBeforeBar === 'number'
	) {
		if (physicalPulseBeforeBar !== role.pulseOffsetBeforeBar) {
			const msg = `CRITICAL: tihai start pulse mismatch. planned=${role.pulseOffsetBeforeBar}, actual=${physicalPulseBeforeBar}, bar=${barIdx}`;
			if (process.env.KONNAKOL_STRICT_PULSE_ASSERT === '1') throw new Error(msg);
			console.warn(msg);
		}
	}

	if (role.type === 'free') {
		const didChange = applyRandomizerEffectsToBar(
			barIdx,
			chaos,
			freeAxes.randomPulsation,
			freeAxes.randomPattern,
			freeAxes.randomSpeed,
			freeAxes.randomBarSpeed,
			false,
			syllablesDefault,
			m,
			rng,
			freeAxes.forceFirstBeat,
		);
		let sanitized = false;
		// free-ветка не проходит через genome->scrub pipeline, поэтому чистим Thom здесь.
		for (let c = 0; c < 9; c++) {
			const k = `${barIdx}-${c}`;
			if (m.customCellSyllables[k] === 'Thom') {
				m.customCellSyllables[k] = 'Ta';
				sanitized = true;
			}
		}
		return didChange || sanitized;
	}
	if (role.type === 'resync_bridge') {
		const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
		const bridge = cloneBarGenome(src);
		if (
			(role.bridgeKind === 'gati_prep' || role.bridgeKind === 'resync' || role.bridgeKind === 'de_sync_prep') &&
			typeof role.localCycleLength === 'number' &&
			role.localCycleLength > 0
		) {
			bridge.curSyl = Math.max(1, Math.min(9, Math.round(role.localCycleLength)));
		}
		if (role.bridgeKind === 'de_sync_prep' && !(typeof role.localCycleLength === 'number' && role.localCycleLength > 0)) {
			bridge.curSyl = Math.max(4, bridge.curSyl);
		}
		delete bridge.deadStart;
		bridge.accents = new Set<number>();
		bridge.subdivisions = {};
		bridge.cellSyllables = {};
		for (let c = 0; c < bridge.curSyl; c++) bridge.cellSyllables[c] = KARVAI_TOKEN;
		assertBridgePulseConsistency(role, bridge.curSyl);
		applyGenomeToBar(barIdx, bridge, m);
		for (let c = 0; c < bridge.curSyl; c++) {
			const key = `${barIdx}-${c}`;
			const tok = m.customCellSyllables[key];
			if (tok !== KARVAI_TOKEN) {
				throw new Error(`CRITICAL: bridge karvai materialization failed at bar=${barIdx} cell=${c}`);
			}
			if (m.accents.has(key)) {
				throw new Error(`CRITICAL: bridge accent leak at bar=${barIdx} cell=${c}`);
			}
			if (typeof m.customSubdivisions[key] === 'number') {
				throw new Error(`CRITICAL: bridge subdivision leak at bar=${barIdx} cell=${c}`);
			}
		}
		const nextRole = schedule[barIdx + 1];
		if (
			canAssertPulseHistory &&
			nextRole?.type === 'tihai' &&
			nextRole.phraseStep === 0 &&
			typeof nextRole.pulseOffsetBeforeBar === 'number'
		) {
			const actualNextPulse = physicalPulseBeforeBar + bridge.curSyl;
			if (actualNextPulse !== nextRole.pulseOffsetBeforeBar) {
				const msg = `CRITICAL: bridge->tihai pulse mismatch. planned=${nextRole.pulseOffsetBeforeBar}, actual=${actualNextPulse}, bridgeBar=${barIdx}`;
				if (process.env.KONNAKOL_STRICT_PULSE_ASSERT === '1') throw new Error(msg);
				console.warn(msg);
			}
		}
		return true;
	}

	let nextGenome: BarGenome;
	if (role.type === 'parent') {
		const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
		nextGenome = cloneBarGenome(src);
		if (nextGenome.curSyl > 0) nextGenome.accents.add(0);
	} else {
		const op = MUTATION_OPERATORS[role.type];
		const baseIntensity = chaosToIntensity(chaos);
		const intensity = role.densityFreeze ? Math.min(baseIntensity, 0.45) : baseIntensity;
		nextGenome = op(parent, role, intensity, rng);
		applyDeSyncWholeJatiPattern(nextGenome, role, rng);
		applyProgressiveGatiFlow(nextGenome, role, rng);
		applyPrasaContinuity(barIdx, nextGenome, role, syllablesDefault, m);
		applyIntensityPhonetics(nextGenome, role, role.intensityTarget);
		softenPhoneticHardJunctions(nextGenome, role, role.intensityTarget);
		enforceThomRule(nextGenome, role);
		applyStrongBeatPhonetics(nextGenome, role);
		ensureAccentPolicy(nextGenome, role);
		enforceTihaiSubdivisionContract(nextGenome, role);
		enforceTihaiLandingTailContract(nextGenome, role);
		// Финальное приземление тихая: последний слог обязательно акцентирован.
		if (role.type === 'tihai' && role.phraseStep === role.phraseLength - 1 && nextGenome.curSyl > 0) {
			const landingIdx = resolveFinalTihaiLandingIndex(nextGenome.curSyl, role.tihaiLandingIndex);
			nextGenome.accents.add(landingIdx);
		}
	}
	const allowedThomIndex =
		role.type === 'tihai' && role.phraseStep === role.phraseLength - 1
			? resolveFinalTihaiLandingIndex(nextGenome.curSyl, role.tihaiLandingIndex)
			: null;
	scrubInternalThom(nextGenome, allowedThomIndex);

	const prevSyl = m.customSyllables[barIdx] ?? syllablesDefault;
	const prevAccents = new Set<string>();
	const prevSubs: Record<string, number> = {};
	for (let c = 0; c < 9; c++) {
		const k = `${barIdx}-${c}`;
		if (m.accents.has(k)) prevAccents.add(k);
		if (m.customSubdivisions[k] !== undefined) prevSubs[k] = m.customSubdivisions[k]!;
	}
	const prevDead = m.deadCells[barIdx]?.deadStart;
	const prevCellSyl: Record<string, string> = {};
	for (let c = 0; c < 9; c++) {
		const k = `${barIdx}-${c}`;
		const v = m.customCellSyllables[k];
		if (typeof v === 'string' && v.length > 0) prevCellSyl[k] = v;
	}

	applyGenomeToBar(barIdx, nextGenome, m);

	if (prevSyl !== nextGenome.curSyl) return true;
	if (prevDead !== nextGenome.deadStart) return true;
	for (let c = 0; c < 9; c++) {
		const k = `${barIdx}-${c}`;
		const nextV = m.customCellSyllables[k];
		const prevV = prevCellSyl[k];
		if (prevV !== nextV) return true;
	}
	const nextKeys = new Set<string>();
	for (const c of nextGenome.accents) nextKeys.add(`${barIdx}-${c}`);
	if (nextKeys.size !== prevAccents.size) return true;
	for (const k of nextKeys) if (!prevAccents.has(k)) return true;
	const nextSubKeys = Object.keys(nextGenome.subdivisions);
	if (nextSubKeys.length !== Object.keys(prevSubs).length) return true;
	for (const cStr of nextSubKeys) {
		const c = parseInt(cStr, 10);
		const k = `${barIdx}-${c}`;
		if (prevSubs[k] !== nextGenome.subdivisions[c]) return true;
	}
	return false;
}

// ============================================================================
// Snapshot serialization helpers (компактный JSON)
// ============================================================================

export type ParentGenomeJSON = {
	bars: Array<{
		curSyl: number;
		accents: number[];
		subdivisions: Record<string, number>;
		cellSyllables?: Record<string, string>;
		deadStart?: number;
	}>;
};

export function parentGenomeToJSON(p: ParentGenome): ParentGenomeJSON {
	return {
		bars: p.bars.map((b) => {
			const out: ParentGenomeJSON['bars'][number] = {
				curSyl: b.curSyl,
				accents: [...b.accents].sort((a, bb) => a - bb),
				subdivisions: { ...b.subdivisions },
			};
			if (b.cellSyllables && Object.keys(b.cellSyllables).length > 0) {
				out.cellSyllables = Object.fromEntries(
					Object.entries(b.cellSyllables).map(([k, v]) => [String(k), String(v)]),
				);
			}
			if (typeof b.deadStart === 'number') out.deadStart = b.deadStart;
			return out;
		}),
	};
}

export function parentGenomeFromJSON(raw: unknown): ParentGenome | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as { bars?: unknown };
	if (!Array.isArray(o.bars) || o.bars.length < 1 || o.bars.length > 2) return null;
	const bars: BarGenome[] = [];
	for (const b of o.bars) {
		if (!b || typeof b !== 'object') return null;
		const bo = b as Record<string, unknown>;
		const curSyl = parseInt(String(bo.curSyl), 10);
		if (!Number.isFinite(curSyl) || curSyl < 1 || curSyl > 9) return null;
		const accentsIn = Array.isArray(bo.accents) ? bo.accents : [];
		const accents = new Set<number>();
		for (const a of accentsIn) {
			const n = parseInt(String(a), 10);
			if (Number.isFinite(n) && n >= 0 && n < curSyl) accents.add(n);
		}
		const subsIn = bo.subdivisions && typeof bo.subdivisions === 'object' ? (bo.subdivisions as Record<string, unknown>) : {};
		const subdivisions: Record<number, number> = {};
		for (const [k, v] of Object.entries(subsIn)) {
			const c = parseInt(k, 10);
			const s = parseInt(String(v), 10);
			if (Number.isFinite(c) && c >= 0 && c < curSyl && Number.isFinite(s) && s >= 2 && s <= 9) {
				subdivisions[c] = s;
			}
		}
		const barOut: BarGenome = { curSyl, accents, subdivisions };
		const csRaw = bo.cellSyllables;
		if (csRaw && typeof csRaw === 'object') {
			const cs: Record<number, string> = {};
			for (const [k, v] of Object.entries(csRaw as Record<string, unknown>)) {
				const ci = parseInt(k, 10);
				if (!Number.isFinite(ci) || ci < 0 || ci >= curSyl) continue;
				if (typeof v === 'string' && v.length > 0) cs[ci] = v;
			}
			if (Object.keys(cs).length > 0) barOut.cellSyllables = cs;
		}
		const ds = parseInt(String(bo.deadStart), 10);
		if (Number.isFinite(ds) && ds >= 0 && ds < curSyl) barOut.deadStart = ds;
		bars.push(barOut);
	}
	return { bars };
}

export function isMutationType(v: unknown): v is MutationType {
	return typeof v === 'string' && (ALL_MUTATION_TYPES as readonly string[]).includes(v);
}

export function isFormPresetId(v: unknown): v is FormPresetId {
	return typeof v === 'string' && (ALL_FORM_PRESETS as readonly string[]).includes(v);
}

export function isRandomMode(v: unknown): v is RandomMode {
	return v === 'free' || v === 'parent';
}
