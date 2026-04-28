/**
 * Рандом-логика konnakol тренажёра: кривые chaos, Markov-bias, применение к такту.
 *
 * Извлечено из App.tsx для изоляции и возможности unit-тестов без React-дерева
 * (см. `randomCurves.test.ts`). Все функции чистые — RNG инжектируется параметром.
 *
 * Архитектура:
 * - `*ChangeProbFromChaos` — вероятность re-randomize axis на границе такта (gate).
 * - `pick*` — выборка конкретного значения с Markov-bias к prev (плавность).
 * - `applyRandomizerEffectsToBar` — оркестратор: gate → mutate, в порядке
 *   pulsation → barSpeed → pattern → speed (dead-cells до pattern/speed).
 */

export const CHAOS_SLIDER_MAX = 100;

/** RNG compatible with Math.random. Seed-инжекция для replay такта (см. mulberry32). */
export type RNG = () => number;

/** mulberry32: детерминированный PRNG от 32-битного seed. */
export function mulberry32(seed: number): RNG {
	let s = seed | 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Кубический smoothstep 3t²−2t³, clamped к [0, 1]. База для всех chaos-кривых. */
export function smoothstep01(t: number): number {
	const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
	return x * x * (3 - 2 * x);
}

/** Вероятность смены пульсации на границе такта: 0 ≤ chaos ≤ 5 → 0; ≥80 → 1. */
export function pulsationChangeProbFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	return smoothstep01((c - 5) / 75);
}
/** Вероятность смены акцентного паттерна: база 0.15 + smoothstep → 1.0 на chaos=100. */
export function patternChangeProbFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	return 0.15 + 0.85 * smoothstep01(c / 100);
}
/** Вероятность re-randomize cell-speed в такте: база 0.1 + smoothstep → 1 к chaos≈60. */
export function speedChangeProbFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	return Math.min(1, 0.1 + 0.9 * smoothstep01(c / 60));
}
/** Вероятность обновления dead-cells: 0 при chaos≤30; → 1 к chaos≈80. */
export function barSpeedChangeProbFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	return smoothstep01((c - 30) / 50);
}

/**
 * Random pulsation: пул по chaos. Пульсации 1 и 2 исключены как целые метры —
 * в Тала Шастре самостоятельных Anga длиной 1 или 2 удара нет, минимум Tisra (3).
 * Единицы/двойки существуют только как составные части фраз (2+3=5), но не как такт.
 */
export const RANDOM_PULSE_POOL_LE_30 = [3, 4, 5] as const;
export const RANDOM_PULSE_POOL_LE_70 = [3, 4, 5, 6, 7] as const;
export const RANDOM_PULSE_POOL_FULL = [3, 4, 5, 6, 7, 8, 9] as const;

export function pulsationPoolForChaos(chaos: number): readonly number[] {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	return c <= 30 ? RANDOM_PULSE_POOL_LE_30 : c <= 70 ? RANDOM_PULSE_POOL_LE_70 : RANDOM_PULSE_POOL_FULL;
}

/** Uniform выборка пульсации из пула (без Markov). */
function pickPulsationWeighted(chaos: number, rng: RNG): number {
	const pool = pulsationPoolForChaos(chaos);
	return pool[Math.floor(rng() * pool.length)]!;
}

/**
 * Random pulsation: Markov-bias к prevMeter на низком chaos, иначе weighted-pool.
 * При stick-branch возможна delta ∈ {−1, 0, +1}; значения вне пула откатываются в prev.
 * stickProb линейно падает 0.6 → 0.1 при chaos 0 → 100 (новичок не прыгает 2→9→4).
 */
export function pickRandomPulsationMeter(
	chaos: number,
	prevMeter?: number,
	rng: RNG = Math.random,
): number {
	const pool = pulsationPoolForChaos(chaos);
	if (
		typeof prevMeter === 'number' &&
		pool.includes(prevMeter as (typeof pool)[number])
	) {
		const stickProb = Math.max(0.1, 0.6 - chaos * 0.005);
		if (rng() < stickProb) {
			const delta = Math.floor(rng() * 3) - 1;
			const target = prevMeter + delta;
			if (pool.includes(target as (typeof pool)[number])) return target;
			return prevMeter;
		}
	}
	return pickPulsationWeighted(chaos, rng);
}

/** Доля акцентуемых долей: непрерывная smoothstep-кривая 0 → 0.9 при chaos 0 → 100. */
export function accentFillRatioFromChaos(c: number): number {
	const x = Math.max(0, Math.min(CHAOS_SLIDER_MAX, c));
	return 0.9 * smoothstep01(x / 100);
}

export const CELL_SPEED_RANDOM_POOL = [2, 3, 4] as const;

/**
 * Веса подделений: 2 (Chatusra) и 4 — основа (четные деления), 3 (Tisra) — специя/синкопа.
 * Равномерный пул делает грув "рваным" и нехарактерным для Востока; при этих весах
 * триоли остаются заметным, но не доминирующим цветом.
 */
const CELL_SPEED_WEIGHTS: readonly (readonly [number, number])[] = [
	[2, 0.5],
	[4, 0.35],
	[3, 0.15],
];

/**
 * Random Speed: {2, 3, 4} с весами 0.5/0.35/0.15. При наличии prev — Markov-bias
 * сохранять предыдущее подделение, stickProb = 1 − chaos/100 (пробежки одинаковой
 * микроритмики — учебно ценно).
 */
export function pickRandomCellSpeedSubdiv(
	rng: RNG = Math.random,
	prev?: number,
	chaos: number = 100,
): number {
	if (
		typeof prev === 'number' &&
		CELL_SPEED_RANDOM_POOL.includes(prev as (typeof CELL_SPEED_RANDOM_POOL)[number])
	) {
		const stickProb = Math.max(0, 1 - chaos / 100);
		if (rng() < stickProb) return prev;
	}
	let sum = 0;
	for (const [, w] of CELL_SPEED_WEIGHTS) sum += w;
	let r = rng() * sum;
	for (const [v, w] of CELL_SPEED_WEIGHTS) {
		r -= w;
		if (r <= 0) return v;
	}
	return CELL_SPEED_WEIGHTS[CELL_SPEED_WEIGHTS.length - 1]![0];
}

/**
 * Плотность cell-speed подделений в такте (на одну ячейку-кандидата).
 * 0..25: линейно 0 → 0.15 (максимум одна ячейка ощущается естественно на малом хаосе).
 * 25..100: smoothstep 0.15 → 1.0. Без ступенек-плато, без cliff на стыке 25/26.
 */
export function cellSpeedHitPFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (c <= 25) return (c / 25) * 0.15;
	return 0.15 + smoothstep01((c - 25) / 75) * (1 - 0.15);
}

export function pickAccentCountForBar(chaos: number, curSyl: number, rng: RNG = Math.random): number {
	const x = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (curSyl < 1) return 0;
	// Малые такты (≤3): пол=1 всегда. Не насыщаем акцентами — всегда остаётся ориентир.
	const minAcc = curSyl <= 3 ? 1 : Math.min(curSyl, x > 15 ? 2 : 1);
	const maxCap = Math.min(curSyl, Math.max(minAcc, Math.floor(curSyl * 0.9)));
	const ratio = accentFillRatioFromChaos(x);
	const cap = Math.floor(curSyl * ratio);
	const spread = 1 + Math.floor(curSyl * 0.12);
	const jitter = Math.floor((rng() - 0.5) * spread);
	let n = Math.max(0, Math.min(curSyl, cap + jitter));
	n = Math.min(maxCap, Math.max(minAcc, n));
	return n;
}

export type DeadCellsMap = Record<number, { deadStart: number; displayLen: number; baseLen: number }>;

export type BarRandomizerMutable = {
	customSyllables: Record<number, number>;
	accents: Set<string>;
	customSubdivisions: Record<string, number>;
	customMultipliers: Record<number, number>;
	deadCells: DeadCellsMap;
};

export type SequencerSeqItem = { r: number; c: number; activeSyllables: number };

/**
 * Порядок долей в legacy (не poly): только живые клетки `c < deadStart`.
 * Иначе мёртвые слоги занимают время в `nextNote`, хотя клик уже глушится в `emitGridSubAudio`.
 */
export function buildLegacyPlaybackSequence(
	barCount: number,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	deadCells: DeadCellsMap,
): SequencerSeqItem[] {
	const seq: SequencerSeqItem[] = [];
	for (let r = 0; r < barCount; r++) {
		const syls = customSyllables[r] !== undefined ? customSyllables[r] : baseSyllables;
		const ds = deadCells[r]?.deadStart;
		const lastLiveExclusive =
			typeof ds === 'number' ? Math.min(Math.max(0, Math.floor(ds)), syls) : syls;
		for (let c = 0; c < lastLiveExclusive; c++) {
			seq.push({ r, c, activeSyllables: syls });
		}
	}
	return seq;
}

/**
 * Одна итерация рандома на такт `prevBar` (как на границе такта в плеере).
 *
 * Каждый axis (pulsation / barSpeed / pattern / speed) проходит два шлюза:
 * 1. User toggle — axis «разрешён» вообще;
 * 2. Probability gate от chaos — реально мутирует такт или оставляет прежнее состояние (persistence).
 *
 * Порядок: pulsation → barSpeed → pattern → speed. Dead-cells считаются до pattern/speed,
 * чтобы не назначать акценты/подделения на уже срубленные ячейки.
 *
 * `forceFirstBeat`: гарантирует акцент на доле 0 при мутации pattern (диктант-режим / низкий
 * chaos). Первая доля такта — Sam/Eduppu, гравитационный центр Тала; без неё ученик теряет
 * сетку. Вызывающая сторона обычно даёт `dictantMode || chaos < 80`.
 *
 * `onlyAccents` оставлен в сигнатуре для backward-compat снэпшотов, но на генерацию
 * рандома не влияет: подделения (Speed) всегда могут попадать на любые живые клетки,
 * включая безакцентные (проходящие ноты в индийской традиции дробятся для скорости).
 *
 * `rng` по умолчанию Math.random; для replay такта передаётся mulberry32(seed).
 */
export function applyRandomizerEffectsToBar(
	prevBar: number,
	chaos: number,
	randomPulsation: boolean,
	randomPattern: boolean,
	randomSpeed: boolean,
	randomBarSpeed: boolean,
	_onlyAccents: boolean,
	syllablesDefault: number,
	m: BarRandomizerMutable,
	rng: RNG = Math.random,
	forceFirstBeat: boolean = false,
): boolean {
	let didChange = false;

	if (randomPulsation && rng() < pulsationChangeProbFromChaos(chaos)) {
		const prevMeter = m.customSyllables[prevBar];
		const newMeter = pickRandomPulsationMeter(chaos, prevMeter, rng);
		if (newMeter !== prevMeter) {
			m.customSyllables[prevBar] = newMeter;
			// Prune stale accents/subdivs за пределами нового curSyl.
			for (let i = newMeter; i < 9; i++) {
				m.accents.delete(`${prevBar}-${i}`);
				delete m.customSubdivisions[`${prevBar}-${i}`];
			}
			didChange = true;
		}
	}

	const curSyl = m.customSyllables[prevBar] ?? syllablesDefault;

	if (randomBarSpeed && rng() < barSpeedChangeProbFromChaos(chaos)) {
		const maxDeadPossible = Math.max(0, curSyl - 1); // минимум одна активная клетка.
		if (maxDeadPossible <= 0) {
			if (m.deadCells[prevBar] !== undefined) {
				delete m.deadCells[prevBar];
				didChange = true;
			}
		} else {
			const flatCap = Math.min(2, maxDeadPossible);
			let deadCount = 0;
			if (chaos < 70) {
				// Soft 0/1/2 distribution, независимо от accents (тишина-Karvai и акцент —
				// разные концепты: динамика vs структура времени). Непрерывная кривая от
				// 90/9/1 при chaos=0 до 40/25/35 при chaos=70.
				const t = Math.max(0, Math.min(1, chaos / 70));
				const p0 = 0.9 - 0.5 * t;
				const p1 = 0.09 + 0.16 * t;
				const roll = rng();
				const deadCountSoft = roll < p0 ? 0 : roll < p0 + p1 ? 1 : 2;
				deadCount = Math.min(deadCountSoft, flatCap);
			} else {
				// 70..100: экспоненциальная кривая к capу 80% — Vilambit Laya, где
				// большая часть такта удерживается внутренним пульсом.
				const tail = Math.max(0, Math.min(1, (chaos - 70) / 30));
				const exp01 = Math.expm1(3 * tail) / Math.expm1(3);
				const deadAt100 = Math.min(maxDeadPossible, Math.max(flatCap, Math.floor(curSyl * 0.8)));
				deadCount = Math.max(
					flatCap,
					Math.min(deadAt100, Math.round(flatCap + exp01 * (deadAt100 - flatCap))),
				);
			}
			const activeCount = Math.max(1, curSyl - deadCount);
			if (activeCount >= curSyl) {
				if (m.deadCells[prevBar] !== undefined) {
					delete m.deadCells[prevBar];
					didChange = true;
				}
			} else {
				const prevMeta = m.deadCells[prevBar];
				if (
					!prevMeta ||
					prevMeta.deadStart !== activeCount ||
					prevMeta.displayLen !== curSyl ||
					prevMeta.baseLen !== curSyl
				) {
					m.deadCells[prevBar] = { deadStart: activeCount, displayLen: curSyl, baseLen: curSyl };
					didChange = true;
				}
				// Prune accents/subdivs в dead-зоне.
				for (let i = activeCount; i < curSyl; i++) {
					m.accents.delete(`${prevBar}-${i}`);
					delete m.customSubdivisions[`${prevBar}-${i}`];
				}
			}
		}
	}

	const deadStart = m.deadCells[prevBar]?.deadStart;
	const liveEnd = typeof deadStart === 'number' ? Math.max(0, Math.min(deadStart, curSyl)) : curSyl;

	if (randomPattern && rng() < patternChangeProbFromChaos(chaos)) {
		for (let i = 0; i < 9; i++) m.accents.delete(`${prevBar}-${i}`);
		const fillCount = pickAccentCountForBar(chaos, liveEnd, rng);
		if (forceFirstBeat && liveEnd >= 1) {
			// Первая доля (Sam/Eduppu) — гарантированный акцент; остальные fillCount-1
			// раскидываем по [1..liveEnd) с sort-bias (см. точка 7 ревизии эксперта).
			m.accents.add(`${prevBar}-0`);
			const rest = Array.from({ length: Math.max(0, liveEnd - 1) }, (_, i) => i + 1)
				.sort(() => rng() - 0.5);
			const remaining = Math.max(0, fillCount - 1);
			for (let i = 0; i < remaining && i < rest.length; i++) {
				m.accents.add(`${prevBar}-${rest[i]}`);
			}
		} else {
			const candidates = Array.from({ length: liveEnd }, (_, i) => i).sort(() => rng() - 0.5);
			for (let i = 0; i < fillCount && i < candidates.length; i++) {
				m.accents.add(`${prevBar}-${candidates[i]}`);
			}
		}
		didChange = true;
	}

	if (randomSpeed && rng() < speedChangeProbFromChaos(chaos)) {
		// Speed бьёт любые живые клетки, включая безакцентные — проходящие ноты
		// часто дробятся для скорости, акценты держат устойчивость (индийская традиция).
		const candidates = Array.from({ length: liveEnd }, (_, i) => i);
		for (let i = 0; i < 9; i++) delete m.customSubdivisions[`${prevBar}-${i}`];
		const hitP = cellSpeedHitPFromChaos(chaos);
		let prevSubdiv: number | undefined;
		for (const i of candidates) {
			if (rng() < hitP) {
				const picked = pickRandomCellSpeedSubdiv(rng, prevSubdiv, chaos);
				m.customSubdivisions[`${prevBar}-${i}`] = picked;
				prevSubdiv = picked;
			} else {
				prevSubdiv = undefined;
			}
		}
		didChange = true;
	}

	return didChange;
}
