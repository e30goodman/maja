/**
 * Accumulates a snapshot of a 32-bar (and other) Parent Mode lesson for offline dramaturgy review.
 */
import type { BarGenome, ParentGenome, PhraseRole } from './parentMode';
import { computePrasaPolicy, effectiveSyllableToken, MUTATION_LABEL, snapshotBarGenome } from './parentMode';
import { computeNps, pickKalam, type Gati, type Kalam } from './sequencerLabels';
import { buildMidiParityEvents } from './midiExport';

export type BarLog = {
	index: number;
	variationType: string;
	syllables: string[];
	accents: number[];
	tempoBpm?: number;
	polyMode?: boolean;
	polyVoices?: 2 | 3 | 4;
	polyrhythmTag?: string;
	multiplier?: number;
	deadStart?: number | null;
	cellDivisions?: number[];
	voiceAccents?: Record<0 | 1 | 2, number[]>;
	voiceAltAccents?: Record<0 | 1 | 2, number[]>;
	voicePassives?: Record<0 | 1 | 2, number[]>;
	barPulseBase?: number;
	barPulseExpanded?: number;
	pulsationLabel?: string;
	subdivision: number;
	/** Notes per second for bar: BPM × number of active beats / 60 (see {@link computeNps}). */
	nps: number;
	isTihaiPart?: boolean;
	/** Used to group sections in text dump. */
	phraseId?: number;
	/** Шаг внутри фразы (0 = anchor-строка блока для Prasa). */
	phraseStep?: number;
	mutationKind?: string;
	modeTag?: 'gati_mode' | 'jati_mode';
	deSyncJati?: boolean;
	localJati?: number;
	reSyncBridge?: boolean;
	bridgeKind?: 'resync' | 'de_sync_prep' | 'gati_prep';
	pulseOffsetBeforeBar?: number;
	gatiTargetSub?: number;
	intensityTarget?: number;
	totalCells?: number;
	subdivisionHits?: number;
	maxSubdivision?: number;
	auditCritical?: string;
	emotionalProfile?: 'tandava' | 'lasya' | 'yati';
	arudiReason?: 'symmetry_close' | 'phrase_cadence';
	prasaMaxEditDistance?: number;
	syllableAssembly?: SyllableAssemblyDiagnostics;
	aestheticDiagnostics?: AestheticBarDiagnostics;
};

export type SyllableAssemblyDiagnostics = {
	subdivNormalization: {
		rawValues: number[];
		normalizedValues: number[];
		invalidOverrideCount: number;
		clampedOverrideCount: number;
		allInRange1to9: boolean;
	};
	deadTail: {
		rawDeadStart: number | null;
		clampedDeadStart: number;
		tailCellCount: number;
		tailSilentByDot: boolean;
	};
	phraseLenPolicy: {
		localPhraseCells: number;
		segmentRanges: Array<{ start: number; endInclusive: number; length: number }>;
		longSegments: number[];
	};
	npsKalamBootstrap: {
		cells: Array<{
			cellIdx: number;
			phraseLen: number;
			source: 'local_subdiv' | 'sarva_segment';
			nps: number;
			kalam: Kalam;
		}>;
	};
	criteria: {
		normalizationContractOk: boolean;
		deadTailContractOk: boolean;
		segmentContractOk: boolean;
	};
};

export type AestheticState = 'pass' | 'violation';

export type AestheticFlagName =
	| 'prasaContinuity'
	| 'thomLegality'
	| 'intensityPalette'
	| 'karvaiBuffer'
	| 'shiftAccent'
	| 'arudiSymmetry'
	| 'samLanding'
	| 'accentTopology'
	| 'eduppuEntry'
	| 'varnaPhoneticFlow'
	| 'layaGatiCharacter'
	| 'guruLaghuWeight'
	| 'shadowingBreath';

export type ArcPhase = 'exposition' | 'exploration' | 'destabilization' | 'culmination';

export type AestheticFlag = {
	name: AestheticFlagName;
	code: string;
	state: AestheticState;
	reason: string;
	evidence: Record<string, number | string | boolean | null>;
	threshold?: string;
};

export type AestheticBarDiagnostics = {
	arcPhaseTag: `[ARC_PHASE: ${Uppercase<ArcPhase>}]`;
	progressivePhase: ArcPhase;
	samAlignment: { mod: number; expectedMod: number; ok: boolean; globalPulse: number };
	accentDensity: number;
	accentPositions: number[];
	phoneticClassMix: { soft: number; hard: number; finalizer: number };
	isComplexConstruction: boolean;
	isKarvaiBar: boolean;
	isTransitionBuffer: boolean;
	editDistanceFromParent: number;
	intensityValue: number;
	expectedPalette: 'soft' | 'hard' | 'balanced';
	usedPalette: 'soft' | 'hard' | 'balanced';
	containsThom: boolean;
	thomPositions: number[];
	isTihaiFinalSegment: boolean;
	notesPerSecond: number;
	shiftDetected: boolean;
	postShiftFirstAccentIndex: number | null;
	arudiDetected: boolean;
	arudiReason: string | null;
	symmetryCloseDetected: boolean;
	cycleLandingOffset: number;
	sequenceCheck: {
		ok: boolean;
		code: 'SEQ_OK' | 'SEQ_FAIL';
		reason: 'contiguous' | 'jump_detected';
		prevSyllableIndex: number;
		currentSyllableIndex: number;
		expectedSyllableIndex: number;
		rowLength: number;
		step: number;
		subdivisionsHint: number;
	};
	/** SCS (Syllable Continuity Score): копия sequenceCheck для контракта DEBUG_CHECKLIST. */
	syllableContinuity?: {
		ok: boolean;
		code: 'SEQ_OK' | 'SEQ_FAIL';
		reason: 'contiguous' | 'jump_detected';
		prevSyllableIndex: number;
		currentSyllableIndex: number;
		expectedSyllableIndex: number;
		rowLength: number;
		step: number;
		subdivisionsHint: number;
	};
	/** Нормализованное время урока t∈[0,1] по индексу такта в логе. */
	progressT?: number;
	/** Prasa относительно первого такта фразы (anchor), не только parent-темы. */
	prasaAnchor?: {
		editDistance: number;
		anchorSyllableCount: number;
		maxEditsByHalf: number;
		effectiveCap: number;
		ok: boolean;
	};
	/** Eduppu: where the first audible syllable sits in the ADI-8 pulse ledger (negative space / lift). */
	eduppu?: {
		firstLiveIndex: number;
		entryGlobalPulse: number;
		entryMod8: number;
		richEntry: boolean;
	};
	/** Varna / phonetic flow: harsh syllable–syllable junctions (consonantal “stumbles”). */
	phoneticJunctions?: { harshCount: number; sample: string };
	/** Laya: “walk” of odd jati — air vs wall-of-notes on a de-sync cycle. */
	layaWalk?: { oddJatiBar: boolean; pulseDensity: number; subdivAir: boolean };
	/** Guru/Laghu: perceptual weight on weak pulses (heavy material without accent / excuse). */
	guruLaghu?: { unaccentedHardCount: number; unaccentedThom: boolean };
	flags: AestheticFlag[];
};

/** Number of per-bar aesthetic gates (used for normalized score denominator). */
const AESTHETIC_GATE_COUNT = 13 as const;

export type LessonPoetryReport = {
	/** 0..1 composite “how sung vs how computed”. */
	poetryIndex: number;
	/** Short Russian verdict for dramaturgy reading. */
	poetryVerdict: string;
	/** Optional sharp note (e.g. premature Thom gravity). */
	poetryCritical?: string;
	eduppuLesson: {
		applicableBars: number;
		syncopatedEntryBars: number;
		samLockedEntryBars: number;
		varietyRatio: number;
	};
	shadowing: {
		stackedComplexDestabilPairs: number;
	};
};

export type TihaiAuditSummary = {
	aestheticScore: number;
	criticalErrors: string[];
	verdict: 'Музыка' | 'Расчет';
	window: { fromBar: number; toBar: number } | null;
	checks: {
		tripleIdentity: boolean;
		equidistantGaps: boolean;
		finalImpact: boolean;
		varnaIntegrity: boolean;
		parentalLink: boolean;
	};
};

export type LessonAestheticSummary = {
	logSchemaVersion: 'aesthetic-log-v1';
	score: number;
	criticalCount: number;
	warningCount: number;
	violations: Array<{ code: string; barIndex: number; phase: ArcPhase; severity: 'critical' | 'warning' }>;
	phaseCoverage: Record<ArcPhase, number>;
	passRateByFlag: Record<AestheticFlagName, number>;
	samLandingStats: { onSam: number; offSam: number; landingOffsetAvg: number };
	poetry: LessonPoetryReport;
	tihaiAudit: TihaiAuditSummary;
};

export type LessonDebugPayload = {
	logSchemaVersion: 'aesthetic-log-v1';
	meta: LessonMeta;
	bars: BarLog[];
	summary: LessonAestheticSummary;
};

export type LessonMeta = {
	seed: number;
	chaos: number;
	tempoBpm?: number;
	polyMode?: boolean;
	polyVoices?: 2 | 3 | 4;
	parentThemeLine: string;
	formPresetLabel: string;
	formPresetId?: string;
	randomMode?: string;
	barCount: number;
};

function normalizeTokForTihai(raw: string): string {
	const s = normalizeSyllableToken(raw).toLowerCase();
	if (s === '—') return '-';
	return s;
}

function isRestTokForTihai(raw: string): boolean {
	const s = normalizeTokForTihai(raw);
	return s === '' || s === '-' || s === '.';
}

function isSameSyllableSeq(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (normalizeTokForTihai(a[i] ?? '') !== normalizeTokForTihai(b[i] ?? '')) return false;
	}
	return true;
}

function collectGapRunLengthsByStep(phraseBars: readonly BarLog[]): number[] {
	const nonRestStepIdx: number[] = [];
	for (let i = 0; i < phraseBars.length; i++) {
		const hasLive = phraseBars[i]!.syllables.some((t) => !isRestTokForTihai(t));
		if (hasLive) nonRestStepIdx.push(i);
	}
	const out: number[] = [];
	for (let i = 1; i < nonRestStepIdx.length; i++) {
		out.push(nonRestStepIdx[i]! - nonRestStepIdx[i - 1]! - 1);
	}
	return out;
}

function computeTihaiAuditSummary(bars: readonly BarLog[]): TihaiAuditSummary {
	const empty: TihaiAuditSummary = {
		aestheticScore: 100,
		criticalErrors: [],
		verdict: 'Музыка',
		window: null,
		checks: {
			tripleIdentity: true,
			equidistantGaps: true,
			finalImpact: true,
			varnaIntegrity: true,
			parentalLink: true,
		},
	};
	const allTihai = bars.filter((b) => b.isTihaiPart === true);
	if (allTihai.length === 0) return empty;
	const phraseId = allTihai[allTihai.length - 1]!.phraseId;
	const phraseBars = allTihai.filter((b) => b.phraseId === phraseId);
	if (phraseBars.length === 0) return empty;
	const byStep = [...phraseBars].sort((a, b) => (a.phraseStep ?? 0) - (b.phraseStep ?? 0));
	const nonRestBars = byStep.filter((b) => b.syllables.some((t) => !isRestTokForTihai(t)));
	const firstThree = nonRestBars.slice(0, 3);
	const tripleIdentity =
		firstThree.length >= 3 &&
		isSameSyllableSeq(firstThree[0]!.syllables, firstThree[1]!.syllables) &&
		isSameSyllableSeq(firstThree[0]!.syllables, firstThree[2]!.syllables);
	const gapRuns = collectGapRunLengthsByStep(byStep);
	const equidistantGaps =
		gapRuns.length <= 1 ||
		gapRuns.every((g) => g === gapRuns[0]);
	const muktayi = computeMuktayiCheck(bars);
	const lastBar = bars[bars.length - 1];
	let lastIdx = -1;
	if (lastBar) {
		for (let i = lastBar.syllables.length - 1; i >= 0; i--) {
			if (!isRestTokForTihai(lastBar.syllables[i] ?? '')) {
				lastIdx = i;
				break;
			}
		}
	}
	const finalTok = lastBar && lastIdx >= 0 ? normalizeTokForTihai(lastBar.syllables[lastIdx] ?? '') : '';
	const finalImpact = Boolean(
		muktayi.ok &&
		lastBar &&
		lastIdx >= 0 &&
		(finalTok === 'thom' || finalTok === 'ta') &&
		lastBar.accents.includes(lastIdx),
	);
	const harshCount = byStep.reduce((sum, b) => sum + (b.aestheticDiagnostics?.phoneticJunctions?.harshCount ?? 0), 0);
	const varnaIntegrity = harshCount <= 3;
	const parentalLink = byStep.every((b) => {
		if (typeof b.prasaMaxEditDistance === 'number' && b.prasaMaxEditDistance > 2) return false;
		const flag = b.aestheticDiagnostics?.flags.find((f) => f.name === 'prasaContinuity');
		return !flag || flag.state !== 'violation';
	});

	const criticalErrors: string[] = [];
	if (!tripleIdentity) criticalErrors.push('TIHAI_MORPH_ERROR');
	if (!equidistantGaps) criticalErrors.push('TIHAI_GEOMETRY_FAIL');
	if (!finalImpact) criticalErrors.push('WEAK_ENDING');
	if (!parentalLink) criticalErrors.push('PRASA_PARENT_BREAK');

	let score = 100;
	if (!tripleIdentity) score -= 35;
	if (!equidistantGaps) score -= 25;
	if (!finalImpact) score -= 30;
	if (!parentalLink) score -= 20;
	if (!varnaIntegrity) score -= 10;
	score = Math.max(0, score);

	return {
		aestheticScore: score,
		criticalErrors,
		verdict: criticalErrors.length === 0 && finalImpact ? 'Музыка' : 'Расчет',
		window: { fromBar: byStep[0]!.index + 1, toBar: byStep[byStep.length - 1]!.index + 1 },
		checks: {
			tripleIdentity,
			equidistantGaps,
			finalImpact,
			varnaIntegrity,
			parentalLink,
		},
	};
}

/** Cycle length for sam ("one") in Muktayi check: syllable pulses, 0-based sam at ...,8,16,... */
export const MUKTAYI_ADI_PULSE_CYCLE = 8;

function barGati(g: BarGenome): Gati {
	return Math.max(1, Math.min(9, g.curSyl)) as Gati;
}

function npsForBar(tempoBpm: number, g: BarGenome): number {
	const gati = barGati(g);
	const raw = computeNps(tempoBpm, gati);
	return Math.round(raw * 1000) / 1000;
}

function normalizeSyllableToken(raw: string): string {
	return raw
		.trim()
		.replace(/\*+$/u, '')
		.replace(/\(.*?\)/gu, '')
		.trim();
}

function isDotLikeRestToken(raw: string): boolean {
	const s = normalizeSyllableToken(raw).toLowerCase();
	return s === '' || s === '.' || s === '-';
}

function computeSyllableAssemblyDiagnostics(
	rowIndex: number,
	g: BarGenome,
	state: {
		customSubdivisions: Record<string, number>;
		deadCells: { [r: number]: { deadStart: number } | undefined };
	},
	tempoBpm: number,
	syllables: readonly string[],
): SyllableAssemblyDiagnostics {
	const rowSyllCount = Math.max(0, Math.floor(g.curSyl));
	const deadRaw = state.deadCells[rowIndex]?.deadStart;
	const deadRawNum = typeof deadRaw === 'number' && Number.isFinite(deadRaw) ? deadRaw : null;
	const deadClamped =
		deadRawNum !== null
			? Math.max(0, Math.min(rowSyllCount, Math.floor(deadRawNum)))
			: rowSyllCount;
	const rawSubdivs: number[] = [];
	const normalizedSubdivs: number[] = [];
	let invalidOverrideCount = 0;
	let clampedOverrideCount = 0;
	for (let c = 0; c < rowSyllCount; c++) {
		const key = `${rowIndex}-${c}`;
		const raw = state.customSubdivisions[key];
		const hasRaw = typeof raw === 'number' && Number.isFinite(raw);
		const rawInt = hasRaw ? Math.floor(raw) : 1;
		const normalized = Math.min(9, Math.max(1, rawInt >= 1 ? rawInt : 1));
		rawSubdivs.push(hasRaw ? raw : 1);
		normalizedSubdivs.push(normalized);
		if (hasRaw && rawInt < 1) invalidOverrideCount += 1;
		if (hasRaw && rawInt !== normalized) clampedOverrideCount += 1;
	}
	const tailSlice = syllables.slice(deadClamped, rowSyllCount);
	const tailSilentByDot = tailSlice.every((tok) => isDotLikeRestToken(tok));
	const segmentRanges: Array<{ start: number; endInclusive: number; length: number }> = [];
	const longSegments: number[] = [];
	const npsKalamCells: SyllableAssemblyDiagnostics['npsKalamBootstrap']['cells'] = [];
	let localPhraseCells = 0;
	let cIdx = 0;
	while (cIdx < deadClamped) {
		const subdiv = normalizedSubdivs[cIdx] ?? 1;
		if (subdiv > 1) {
			localPhraseCells += 1;
			const nps = Number(computeNps(tempoBpm, subdiv).toFixed(3));
			npsKalamCells.push({
				cellIdx: cIdx,
				phraseLen: subdiv,
				source: 'local_subdiv',
				nps,
				kalam: pickKalam(nps, undefined),
			});
			cIdx += 1;
			continue;
		}
		const segStart = cIdx;
		while (cIdx < deadClamped && (normalizedSubdivs[cIdx] ?? 1) === 1) cIdx += 1;
		const segLen = Math.max(1, cIdx - segStart);
		const segEnd = cIdx - 1;
		segmentRanges.push({ start: segStart, endInclusive: segEnd, length: segLen });
		if (segLen > 9) longSegments.push(segLen);
		const nps = Number(computeNps(tempoBpm, segLen).toFixed(3));
		const kalam = pickKalam(nps, undefined);
		for (let i = segStart; i <= segEnd; i++) {
			npsKalamCells.push({
				cellIdx: i,
				phraseLen: segLen,
				source: 'sarva_segment',
				nps,
				kalam,
			});
		}
	}
	return {
		subdivNormalization: {
			rawValues: rawSubdivs,
			normalizedValues: normalizedSubdivs,
			invalidOverrideCount,
			clampedOverrideCount,
			allInRange1to9: normalizedSubdivs.every((x) => x >= 1 && x <= 9),
		},
		deadTail: {
			rawDeadStart: deadRawNum,
			clampedDeadStart: deadClamped,
			tailCellCount: Math.max(0, rowSyllCount - deadClamped),
			tailSilentByDot,
		},
		phraseLenPolicy: {
			localPhraseCells,
			segmentRanges,
			longSegments,
		},
		npsKalamBootstrap: {
			cells: npsKalamCells,
		},
		criteria: {
			normalizationContractOk: normalizedSubdivs.length === rowSyllCount && normalizedSubdivs.every((x) => x >= 1 && x <= 9),
			deadTailContractOk: tailSilentByDot,
			segmentContractOk: npsKalamCells.length === deadClamped,
		},
	};
}

function isTaOrThom(token: string): boolean {
	const s = normalizeSyllableToken(token).toLowerCase();
	return s === 'ta' || s === 'thom';
}

function toArcPhase(intensity: number): ArcPhase {
	if (intensity < 0.3) return 'exposition';
	if (intensity < 0.5) return 'exploration';
	if (intensity < 0.7) return 'destabilization';
	return 'culmination';
}

function isHardToken(token: string): boolean {
	const s = normalizeSyllableToken(token).toLowerCase();
	return s === 'ki' || s === 'te' || s === 'ta' || s === 'thom';
}

function isSoftToken(token: string): boolean {
	const s = normalizeSyllableToken(token).toLowerCase();
	return s === 'ju' || s === 'nu' || s === 'dhi' || s === 'mi' || s === 'ka';
}

function isRestToken(raw: string): boolean {
	const s = normalizeSyllableToken(raw).toLowerCase();
	return s === '' || s === '-' || s === '—' || s === '.';
}

function firstNonRestSyllableIndex(syllables: readonly string[]): number {
	for (let i = 0; i < syllables.length; i++) {
		if (!isRestToken(syllables[i] ?? '')) return i;
	}
	return syllables.length;
}

function leadingRestCount(syllables: readonly string[]): number {
	return Math.min(syllables.length, firstNonRestSyllableIndex(syllables));
}

/** Harsh syllable–syllable boundaries (hard–hard) and obvious hard stutters. */
function countHarshPhoneticJunctions(syllables: readonly string[]): { harshCount: number; sample: string } {
	let harshCount = 0;
	let sample = '';
	const n = syllables.length;
	const tokAt = (j: number) => normalizeSyllableToken(syllables[j] ?? '').toLowerCase();
	for (let i = 0; i < n - 1; i++) {
		if (isRestToken(syllables[i] ?? '') || isRestToken(syllables[i + 1] ?? '')) continue;
		if (isHardToken(syllables[i] ?? '') && isHardToken(syllables[i + 1] ?? '')) {
			harshCount += 1;
			if (!sample) sample = `${tokAt(i)}-${tokAt(i + 1)}@${i}`;
		}
	}
	for (let i = 0; i < n - 2; i++) {
		if (isRestToken(syllables[i] ?? '')) continue;
		const t0 = tokAt(i);
		if (t0.length === 0) continue;
		if (t0 === tokAt(i + 1) && t0 === tokAt(i + 2) && isHardToken(syllables[i] ?? '')) {
			harshCount += 1;
			if (!sample) sample = `stutter:${t0}@${i}`;
		}
	}
	return { harshCount, sample };
}

function barIsComplexForAesthetics(b: BarLog): boolean {
	const sub = b.subdivision ?? b.syllables.length;
	return sub >= 5 || (b.gatiTargetSub ?? 0) >= 5 || b.deSyncJati === true || b.isTihaiPart === true;
}

function editDistanceLimited(a: readonly string[], b: readonly string[]): number {
	const n = Math.max(a.length, b.length);
	let dist = 0;
	for (let i = 0; i < n; i++) {
		const x = normalizeSyllableToken(a[i] ?? '').toLowerCase();
		const y = normalizeSyllableToken(b[i] ?? '').toLowerCase();
		if (x !== y) dist += 1;
	}
	return dist;
}

/** Первый такт contiguous-группы с тем же phraseId (anchor Prasa). */
export function phraseAnchorBarIndexFromBars(bars: readonly Pick<BarLog, 'phraseId'>[], i: number): number {
	const pid = bars[i]?.phraseId;
	let j = i;
	while (j > 0 && bars[j - 1]?.phraseId === pid) j -= 1;
	return j;
}

function evaluateSequenceContinuity(
	rowLengthRaw: number,
	stepRaw: number,
	subdivisionsHintRaw: number,
): AestheticBarDiagnostics['sequenceCheck'] {
	const rowLength = Math.max(1, Math.floor(rowLengthRaw));
	const step = Math.max(1, Math.floor(stepRaw));
	const subdivisionsHint = Math.max(0, Math.floor(subdivisionsHintRaw));
	let prevSyllableIndex = rowLength - 1;
	for (let currentSyllableIndex = 0; currentSyllableIndex < rowLength; currentSyllableIndex++) {
		const expectedSyllableIndex = ((prevSyllableIndex + step) % rowLength + rowLength) % rowLength;
		if (currentSyllableIndex !== expectedSyllableIndex) {
			return {
				ok: false,
				code: 'SEQ_FAIL',
				reason: 'jump_detected',
				prevSyllableIndex,
				currentSyllableIndex,
				expectedSyllableIndex,
				rowLength,
				step,
				subdivisionsHint,
			};
		}
		prevSyllableIndex = currentSyllableIndex;
	}
	return {
		ok: true,
		code: 'SEQ_OK',
		reason: 'contiguous',
		prevSyllableIndex: rowLength - 1,
		currentSyllableIndex: 0,
		expectedSyllableIndex: 0,
		rowLength,
		step,
		subdivisionsHint,
	};
}

function buildLessonPoetryReport(input: {
	technicalScore: number;
	eduppuApplicable: number;
	eduppuSyncopated: number;
	eduppuSamLocked: number;
	stackedShadowPairs: number;
	muktayiOk: boolean;
	symmetryCloseBars: number;
	totalBars: number;
}): LessonPoetryReport {
	const varietyRatio =
		input.eduppuApplicable > 0 ? input.eduppuSyncopated / input.eduppuApplicable : 0;
	const tech = Math.max(0, Math.min(1, input.technicalScore / 100));
	const eduppuF = Math.min(1, varietyRatio * 2.4 + (input.eduppuSamLocked > 0 ? 0.04 : 0));
	const shadowF = Math.max(0, 1 - input.stackedShadowPairs * 0.18);
	const muktayiF = input.muktayiOk ? 1 : 0.35;
	const arcF = input.totalBars > 0 ? Math.min(1, 0.55 + (input.symmetryCloseBars / input.totalBars) * 0.6) : 0.55;
	const raw = 0.38 * tech + 0.22 * eduppuF + 0.2 * shadowF + 0.12 * muktayiF + 0.08 * arcF;
	const poetryIndex = Math.max(0, Math.min(1, Math.round(raw * 100) / 100));

	let poetryVerdict = '';
	if (poetryIndex >= 0.82) {
		poetryVerdict =
			'Высокая «спетость»: баланс техники, Eduppu-лифта и дыхания тени убедителен; фраза читается как жест, а не как таблица.';
	} else if (poetryIndex >= 0.65) {
		poetryVerdict =
			'Уверенный микс математики и музыки; остаются зоны, где можно усилить отрицательное пространство или фонетический перекат.';
	} else {
		poetryVerdict =
			'Преобладает «вычисление»: мало синкопированного Eduppu, перегруз destabilization или ослаблен финальный зов; требуется драматургическая правка.';
	}

	const poetryCriticalParts: string[] = [];
	if (!input.muktayiOk) {
		poetryCriticalParts.push('Muktayi/Sam-замок не сходится — искра финала гаснет до эфира.');
	}
	if (input.stackedShadowPairs >= 2) {
		poetryCriticalParts.push('Закон тени нарушен: несколько тяжёлых destabilization подряд без облегчения.');
	}
	if (input.eduppuApplicable >= 10 && varietyRatio < 0.08) {
		poetryCriticalParts.push('Eduppu беден: почти все входы «в долю», механический старт относительно Sam.');
	}
	const poetryCritical = poetryCriticalParts.length > 0 ? poetryCriticalParts.join(' ') : undefined;

	return {
		poetryIndex,
		poetryVerdict,
		poetryCritical,
		eduppuLesson: {
			applicableBars: input.eduppuApplicable,
			syncopatedEntryBars: input.eduppuSyncopated,
			samLockedEntryBars: input.eduppuSamLocked,
			varietyRatio: Number(varietyRatio.toFixed(3)),
		},
		shadowing: { stackedComplexDestabilPairs: input.stackedShadowPairs },
	};
}

export function evaluateAestheticDiagnostics(bars: readonly BarLog[]): {
	barsWithDiagnostics: BarLog[];
	summary: LessonAestheticSummary;
} {
	const expectedSam = MUKTAYI_ADI_PULSE_CYCLE - 1;
	const basePattern = bars.find((b) => b.mutationKind === 'parent')?.syllables ?? bars[0]?.syllables ?? [];
	const phaseCoverage: Record<ArcPhase, number> = { exposition: 0, exploration: 0, destabilization: 0, culmination: 0 };
	const flagPassCount: Record<AestheticFlagName, number> = {
		prasaContinuity: 0,
		thomLegality: 0,
		intensityPalette: 0,
		karvaiBuffer: 0,
		shiftAccent: 0,
		arudiSymmetry: 0,
		samLanding: 0,
		accentTopology: 0,
		eduppuEntry: 0,
		varnaPhoneticFlow: 0,
		layaGatiCharacter: 0,
		guruLaghuWeight: 0,
		shadowingBreath: 0,
	};
	const flagTotalCount: Record<AestheticFlagName, number> = {
		prasaContinuity: 0,
		thomLegality: 0,
		intensityPalette: 0,
		karvaiBuffer: 0,
		shiftAccent: 0,
		arudiSymmetry: 0,
		samLanding: 0,
		accentTopology: 0,
		eduppuEntry: 0,
		varnaPhoneticFlow: 0,
		layaGatiCharacter: 0,
		guruLaghuWeight: 0,
		shadowingBreath: 0,
	};
	const violations: LessonAestheticSummary['violations'] = [];
	let onSam = 0;
	let offSam = 0;
	let landingOffsetSum = 0;
	let pulsesBefore = 0;
	let stackedShadowPairs = 0;
	let eduppuApplicable = 0;
	let eduppuSyncopated = 0;
	let eduppuSamLocked = 0;
	let symmetryCloseBars = 0;
	const outBars: BarLog[] = [];
	for (let i = 0; i < bars.length; i++) {
		const b = bars[i]!;
		const prev = i > 0 ? bars[i - 1] : undefined;
		const intensity = typeof b.intensityTarget === 'number' ? Math.max(0, Math.min(1, b.intensityTarget)) : 0;
		const phase = toArcPhase(intensity);
		phaseCoverage[phase] += 1;
		const soft = b.syllables.filter((s) => isSoftToken(s)).length;
		const hard = b.syllables.filter((s) => isHardToken(s)).length;
		const finalizer = b.syllables.filter((s) => normalizeSyllableToken(s).toLowerCase() === 'thom').length;
		const expectedPalette =
			b.emotionalProfile === 'lasya'
				? 'balanced'
				: intensity < 0.5
					? 'soft'
					: intensity > 0.7
						? 'hard'
						: 'balanced';
		const usedPalette = soft > hard ? 'soft' : hard > soft ? 'hard' : 'balanced';
		const thomPositions = b.syllables
			.map((token, idx) => ({ token: normalizeSyllableToken(token).toLowerCase(), idx }))
			.filter((x) => x.token === 'thom')
			.map((x) => x.idx);
		const containsThom = thomPositions.length > 0;
		const lastSig = (() => {
			let idx = b.syllables.length - 1;
			while (idx >= 0 && isRestToken(b.syllables[idx] ?? '')) idx--;
			return idx;
		})();
		const globalPulse = pulsesBefore + Math.max(0, lastSig);
		const mod = ((globalPulse % MUKTAYI_ADI_PULSE_CYCLE) + MUKTAYI_ADI_PULSE_CYCLE) % MUKTAYI_ADI_PULSE_CYCLE;
		const onSamBar = mod === expectedSam;
		const cycleLandingOffset = (mod - expectedSam + MUKTAYI_ADI_PULSE_CYCLE) % MUKTAYI_ADI_PULSE_CYCLE;
		if (onSamBar) onSam += 1;
		else offSam += 1;
		landingOffsetSum += cycleLandingOffset;
		const isShift = b.deSyncJati === true && prev?.deSyncJati !== true;
		const postShiftFirstAccentIndex = b.accents.length > 0 ? Math.min(...b.accents) : null;
		const isKarvaiBar = b.syllables.every((s) => isRestToken(s));
		const isTransitionBuffer = b.bridgeKind === 'de_sync_prep' || (b.mutationKind === 'resync_bridge' && isKarvaiBar);
		const isComplexConstruction = b.subdivision >= 5 || (b.gatiTargetSub ?? 0) >= 5 || b.deSyncJati === true || b.isTihaiPart === true;
		if (b.arudiReason === 'symmetry_close') symmetryCloseBars += 1;
		const editDistanceFromParent = editDistanceLimited(basePattern, b.syllables);
		const rowLength = Math.max(1, b.totalCells ?? b.subdivision ?? b.syllables.length);
		const step = 1;
		const sequenceCheck = evaluateSequenceContinuity(rowLength, step, b.subdivisionHits ?? 0);
		const flags: AestheticFlag[] = [];
		const pushFlag = (flag: AestheticFlag) => {
			flags.push(flag);
			flagTotalCount[flag.name] += 1;
			if (flag.state === 'pass') {
				flagPassCount[flag.name] += 1;
			} else {
				violations.push({
					code: flag.code,
					barIndex: b.index + 1,
					phase,
					severity: flag.name === 'samLanding' || flag.name === 'thomLegality' ? 'critical' : 'warning',
				});
			}
		};
		const prasaApplicable = !isKarvaiBar && b.mutationKind !== 'yati' && b.mutationKind !== 'tihai' && b.deSyncJati !== true;
		const phraseStep = typeof b.phraseStep === 'number' ? b.phraseStep : 0;
		const anchorIdx = phraseAnchorBarIndexFromBars(bars, i);
		const anchorSyllables = bars[anchorIdx]!.syllables;
		const editFromPhraseAnchor = editDistanceLimited(anchorSyllables, b.syllables);
		const anchorSyllableCount = Math.max(
			1,
			anchorSyllables.reduce((n, s) => n + (isRestToken(s) ? 0 : 1), 0) || anchorSyllables.length,
		);
		const maxEditsByHalf = Math.max(0, Math.floor(anchorSyllableCount / 2));
		const prasaPolicy = computePrasaPolicy({
			phase,
			prasaMaxEditDistance: b.prasaMaxEditDistance,
			anchorSyllableCount,
			liveLength: Math.max(1, Math.min(anchorSyllables.length, b.syllables.length)),
		});
		const effectiveAnchorCap = prasaPolicy.anchorCap;
		const prasaLimit = prasaPolicy.parentLimit + (phase === 'destabilization' && b.subdivision >= 7 ? 1 : 0);
		const prasaAnchorOk =
			phraseStep <= 0 || anchorIdx === i ? true : editFromPhraseAnchor <= effectiveAnchorCap;
		const prasaParentOk = editDistanceFromParent <= prasaLimit;
		const prasaOk = !prasaApplicable || (prasaAnchorOk && prasaParentOk);
		pushFlag({
			name: 'prasaContinuity',
			code: !prasaApplicable
				? 'PRASA_KARVAI_EXEMPT'
				: prasaOk
					? 'PRASA_PASS'
					: !prasaAnchorOk
						? `PRASA_ANCHOR_${editFromPhraseAnchor}_>${effectiveAnchorCap}`
						: `PRASA_VIOLATION_EDIT_DISTANCE_${editDistanceFromParent}`,
			state: prasaOk || !prasaApplicable ? 'pass' : 'violation',
			reason: !prasaApplicable
				? 'prasa-not-applicable-on-karvai'
				: prasaOk
					? 'anchor-and-parent-within-threshold'
					: !prasaAnchorOk
						? 'anchor-recognition-exceeded'
						: 'edit-distance-from-parent-theme-exceeded',
			evidence: {
				editDistanceFromParent,
				prasaLimit,
				editFromPhraseAnchor,
				effectiveAnchorCap,
				anchorSyllableCount,
				phraseStep,
				isKarvaiBar,
			},
			threshold: `anchorEdits<=${effectiveAnchorCap}, parentEdits<=${prasaLimit}`,
		});
		const thomLegal = !containsThom
			|| b.isTihaiPart === true
			|| (intensity > 0.7 && thomPositions.some((pos) => b.accents.includes(pos)))
			|| thomPositions.some((pos) => pos === 0 && b.accents.includes(pos));
		pushFlag({
			name: 'thomLegality',
			code: thomLegal ? 'THOM_VALID' : 'THOM_ILLEGAL',
			state: thomLegal ? 'pass' : 'violation',
			reason: thomLegal ? 'thom-placement-allowed' : 'thom-detected-outside-final-or-accented-high-intensity',
			evidence: { containsThom, thomPositions: thomPositions.join(','), intensityValue: intensity },
		});
		const intensityOk = isKarvaiBar ? true : expectedPalette === 'balanced' ? true : expectedPalette === usedPalette;
		pushFlag({
			name: 'intensityPalette',
			code: isKarvaiBar ? 'INTENSITY_KARVAI_EXEMPT' : intensityOk ? 'INTENSITY_PALETTE_OK' : 'INTENSITY_MISMATCH',
			state: intensityOk ? 'pass' : 'violation',
			reason: isKarvaiBar
				? 'intensity-palette-not-applicable-on-karvai'
				: intensityOk
					? 'palette-matches-intensity'
					: 'palette-does-not-match-intensity',
			evidence: { expectedPalette, usedPalette, intensityValue: intensity, isKarvaiBar },
		});
		const prevRestPulses =
			prev && prev.syllables.length > 0 && prev.syllables.every((s) => isRestToken(s)) ? prev.syllables.length : 0;
		const karvaiStructureOk =
			!isShift ||
			isTransitionBuffer ||
			(prev ? prev.bridgeKind === 'de_sync_prep' : false) ||
			(prev ? prev.mutationKind === 'resync_bridge' : false) ||
			(prev ? prev.mutationKind === 'parent' : false) ||
			i === 0 ||
			b.mutationKind === 'tihai';
		/** Полный karvai-такт перед сменой Jati: минимум 4, но для короткого цикла допустим ceiling до длины прошлого такта. */
		const requiredKarvaiPulses = prev ? Math.min(4, Math.max(1, prev.syllables.length)) : 4;
		const currentLeadKarvai = leadingRestCount(b.syllables);
		const currentLive = b.syllables.filter((s) => !isRestToken(s)).length;
		const reducedDensityAfterShift = currentLive <= Math.max(1, Math.floor(b.syllables.length / 2));
		const karvaiPulseOk =
			!isShift ||
			isTransitionBuffer ||
			currentLeadKarvai >= 4 ||
			reducedDensityAfterShift ||
			prevRestPulses === 0 ||
			(prev ? prev.mutationKind === 'parent' : false) ||
			prevRestPulses >= 3 ||
			prevRestPulses >= requiredKarvaiPulses;
		const karvaiOk = karvaiStructureOk && karvaiPulseOk;
		pushFlag({
			name: 'karvaiBuffer',
			code: karvaiOk ? 'KARVAI_DETECTED' : 'KARVAI_MISSED',
			state: karvaiOk ? 'pass' : 'violation',
			reason: karvaiOk ? 'karvai-buffer-present-or-not-required' : 'missing-karvai-buffer-before-shift',
			evidence: {
				shiftDetected: isShift,
				isTransitionBuffer,
				prevBridgeKind: prev?.bridgeKind ?? null,
				prevRestPulses,
				currentLeadKarvai,
				reducedDensityAfterShift,
				minBridgePulses: requiredKarvaiPulses,
			},
		});
		const shiftAccentOk = isShift ? isTransitionBuffer || isKarvaiBar || postShiftFirstAccentIndex === 0 : true;
		pushFlag({
			name: 'shiftAccent',
			code: shiftAccentOk ? 'SHIFT_ACCENT_OK' : 'SHIFT_FLAT',
			state: shiftAccentOk ? 'pass' : 'violation',
			reason: shiftAccentOk ? 'physical-sam-present-on-first-shift-cell' : 'physical-sam-missing-on-first-shift-cell',
			evidence: { shiftDetected: isShift, postShiftFirstAccentIndex, isKarvaiBar },
		});
		const arudiSymmetryOk = b.arudiReason
			? b.arudiReason === 'phrase_cadence' || b.arudiReason === 'symmetry_close' || onSamBar
			: true;
		pushFlag({
			name: 'arudiSymmetry',
			code: arudiSymmetryOk ? 'ARUDI_SYMMETRY_OK' : 'ARUDI_DANGLING',
			state: arudiSymmetryOk ? 'pass' : 'violation',
			reason: arudiSymmetryOk ? 'arudi-resolves-symmetry-or-sam' : 'arudi-without-symmetry-or-sam',
			evidence: { arudiReason: b.arudiReason ?? null, onSam: onSamBar },
		});
		const isFinalTihai = b.isTihaiPart === true && i === bars.length - 1;
		const nearSamGrace =
			isFinalTihai &&
			onSamBar === false &&
			cycleLandingOffset === 7 &&
			(prev?.bridgeKind === 'resync' || b.deSyncJati === true);
		const samLandingOk = isFinalTihai ? onSamBar || nearSamGrace : true;
		pushFlag({
			name: 'samLanding',
			code: samLandingOk ? 'LANDING_SAM' : `LANDING_OFF_SAM_${cycleLandingOffset}`,
			state: samLandingOk ? 'pass' : 'violation',
			reason: samLandingOk ? 'landing-on-sam' : 'landing-not-on-sam',
			evidence: { mod, expectedMod: expectedSam, cycleLandingOffset },
		});
		const accentOk = isKarvaiBar ? true : isComplexConstruction ? b.accents.length > 0 : true;
		pushFlag({
			name: 'accentTopology',
			code: isKarvaiBar ? 'ACCENT_KARVAI_EXEMPT' : accentOk ? 'ACCENT_DENSITY_OK' : 'MACHINE_GUN_DETECTED',
			state: accentOk ? 'pass' : 'violation',
			reason: isKarvaiBar ? 'accent-topology-not-applicable-on-karvai' : accentOk ? 'accent-topology-defined' : 'complex-bar-without-accents',
			evidence: { isComplexConstruction, accentCount: b.accents.length, subdivision: b.subdivision, isKarvaiBar },
		});

		const firstLive = firstNonRestSyllableIndex(b.syllables);
		const entryGlobalPulse = firstLive < b.syllables.length ? pulsesBefore + firstLive : pulsesBefore;
		const entryMod8 = ((entryGlobalPulse % MUKTAYI_ADI_PULSE_CYCLE) + MUKTAYI_ADI_PULSE_CYCLE) % MUKTAYI_ADI_PULSE_CYCLE;
		const richEduppu =
			firstLive < b.syllables.length && (firstLive > 0 || entryMod8 !== 0);
		const samLockedEntry =
			firstLive < b.syllables.length && firstLive === 0 && entryMod8 === 0;
		const eduppuExempt =
			isKarvaiBar ||
			isTransitionBuffer ||
			b.mutationKind === 'resync_bridge' ||
			b.mutationKind === 'tihai' ||
			b.mutationKind === 'free' ||
			(phase === 'exposition' && (b.mutationKind === 'parent' || !b.mutationKind));
		if (!eduppuExempt && firstLive < b.syllables.length) {
			eduppuApplicable += 1;
			if (richEduppu) eduppuSyncopated += 1;
			if (samLockedEntry) eduppuSamLocked += 1;
			const eduppuPass = phase === 'exposition' || richEduppu || isShift;
			pushFlag({
				name: 'eduppuEntry',
				code: eduppuPass ? 'EDUPPU_LIFT_OK' : 'EDUPPU_MECHANICAL_SAM_START',
				state: eduppuPass ? 'pass' : 'violation',
				reason: eduppuPass
					? 'negative-space-or-off-sam-entry'
					: 'square-on-beat-entry-without-syncope',
				evidence: { firstLiveIndex: firstLive, entryMod8, entryGlobalPulse, phase },
			});
		} else {
			pushFlag({
				name: 'eduppuEntry',
				code: 'EDUPPU_EXEMPT',
				state: 'pass',
				reason: 'eduppu-not-applicable',
				evidence: { firstLiveIndex: firstLive, isKarvaiBar, mutationKind: b.mutationKind ?? null },
			});
		}

		const junctions = countHarshPhoneticJunctions(b.syllables);
		const varnaSoftContext = b.emotionalProfile === 'lasya' && intensity < 0.52;
		const varnaHarshLimit = varnaSoftContext ? 3 : 5;
		const varnaFail =
			!isKarvaiBar &&
			junctions.harshCount >= varnaHarshLimit;
		pushFlag({
			name: 'varnaPhoneticFlow',
			code: isKarvaiBar
				? 'VARNA_KARVAI_EXEMPT'
				: varnaFail
					? `VARNA_HARSH_FLOW_${junctions.harshCount}`
					: 'VARNA_FLOW_OK',
			state: isKarvaiBar || !varnaFail ? 'pass' : 'violation',
			reason: isKarvaiBar
				? 'varna-not-applicable-on-karvai'
				: varnaFail
					? 'harsh-consonantal-junctions'
					: 'phonetic-roll-acceptable',
			evidence: { harshCount: junctions.harshCount, sample: junctions.sample || null, intensityValue: intensity, varnaHarshLimit },
		});

		const cells = Math.max(1, b.syllables.length);
		const nonRestCount = b.syllables.filter((s) => !isRestToken(s)).length;
		const pulseDensity = nonRestCount / cells;
		const oddJatiBar =
			b.deSyncJati === true &&
			(b.subdivision === 5 || b.subdivision === 7 || b.subdivision === 9 || b.localJati === 5 || b.localJati === 7 || b.localJati === 9);
		const subdivAir = (b.subdivisionHits ?? 0) > 0 || (b.maxSubdivision ?? 1) > 1;
		const layaFail =
			oddJatiBar && !isKarvaiBar && pulseDensity >= 0.98 && !subdivAir;
		pushFlag({
			name: 'layaGatiCharacter',
			code: !oddJatiBar
				? 'LAYA_NOT_ODD_JATI'
				: isKarvaiBar
					? 'LAYA_KARVAI_EXEMPT'
					: layaFail
						? 'LAYA_ODD_JATI_NO_AIR'
						: 'LAYA_WALK_OK',
			state: !layaFail || isKarvaiBar || !oddJatiBar ? 'pass' : 'violation',
			reason: layaFail ? 'odd-cycle-wall-without-micro-laya' : 'gati-bhedam-has-breath-or-subdiv-air',
			evidence: { pulseDensity, oddJatiBar, subdivAir, subdivisionHits: b.subdivisionHits ?? 0 },
		});

		let unaccentedHardCount = 0;
		let unaccentedThom = false;
		for (let si = 0; si < b.syllables.length; si++) {
			if (isRestToken(b.syllables[si] ?? '')) continue;
			const tk = normalizeSyllableToken(b.syllables[si] ?? '').toLowerCase();
			if (b.accents.includes(si)) continue;
			if (tk === 'thom') unaccentedThom = true;
			else if (tk === 'ki' || tk === 'te') unaccentedHardCount += 1;
		}
		const guruFail =
			unaccentedThom ||
			(intensity > 0.85 && unaccentedHardCount >= 2) ||
			(intensity > 0.92 && unaccentedHardCount >= 1);
		const guruExempt = isKarvaiBar || isTransitionBuffer;
		pushFlag({
			name: 'guruLaghuWeight',
			code: guruExempt
				? 'GURU_LAGHU_EXEMPT'
				: !guruFail
					? 'GURU_LAGHU_BALANCED'
					: 'GURU_LAGHU_NOISE_ON_WEAK',
			state: guruExempt || !guruFail ? 'pass' : 'violation',
			reason: guruFail ? 'heavy-syllables-without-solar-gravity' : 'weight-credible-for-pulse-role',
			evidence: { unaccentedHardCount, unaccentedThom, intensityValue: intensity },
		});

		let shadowFail = false;
		if (i > 0 && prev) {
			const prevIntensity = typeof prev.intensityTarget === 'number' ? Math.max(0, Math.min(1, prev.intensityTarget)) : 0;
			const prevPhase = toArcPhase(prevIntensity);
			const prevKarvai = prev.syllables.every((s) => isRestToken(s));
			const prevFirstLive = firstNonRestSyllableIndex(prev.syllables);
			const currHasBreath = firstLive > 0 || isTransitionBuffer;
			const prevHasBreath =
				prevFirstLive > 0 ||
				prev.mutationKind === 'resync_bridge' ||
				prev.bridgeKind === 'de_sync_prep' ||
				prevKarvai;
			const prevComplex = barIsComplexForAesthetics(prev) && !prevKarvai;
			const currComplex = barIsComplexForAesthetics(b) && !isKarvaiBar;
			if (prevPhase === 'destabilization' && phase === 'destabilization' && prevComplex && currComplex && !currHasBreath && !prevHasBreath) {
				shadowFail = true;
				stackedShadowPairs += 1;
			}
		}
		pushFlag({
			name: 'shadowingBreath',
			code: shadowFail ? 'SHADOW_STACKED_COMPLEX' : 'SHADOW_OK',
			state: shadowFail ? 'violation' : 'pass',
			reason: shadowFail ? 'no-breath-between-heavy-destabil-bars' : 'shadow-or-lightening-present',
			evidence: { stackedPair: shadowFail, phase },
		});

		const progressT = bars.length > 1 ? i / (bars.length - 1) : 0;
		const prasaAnchorDiag = {
			editDistance: editFromPhraseAnchor,
			anchorSyllableCount,
			maxEditsByHalf,
			effectiveCap: effectiveAnchorCap,
			ok: prasaAnchorOk,
		};
		const diagnostics: AestheticBarDiagnostics = {
			arcPhaseTag: `[ARC_PHASE: ${phase.toUpperCase() as Uppercase<ArcPhase>}]`,
			progressivePhase: phase,
			samAlignment: { mod, expectedMod: expectedSam, ok: onSamBar, globalPulse },
			accentDensity: b.subdivision > 0 ? b.accents.length / b.subdivision : 0,
			accentPositions: [...b.accents],
			phoneticClassMix: { soft, hard, finalizer },
			isComplexConstruction,
			isKarvaiBar,
			isTransitionBuffer,
			editDistanceFromParent,
			intensityValue: intensity,
			expectedPalette,
			usedPalette,
			containsThom,
			thomPositions,
			isTihaiFinalSegment: b.isTihaiPart === true && i === bars.length - 1,
			notesPerSecond: b.nps,
			shiftDetected: isShift,
			postShiftFirstAccentIndex,
			arudiDetected: !!b.arudiReason,
			arudiReason: b.arudiReason ?? null,
			symmetryCloseDetected: b.arudiReason === 'symmetry_close',
			cycleLandingOffset,
			sequenceCheck,
			syllableContinuity: sequenceCheck,
			progressT: Number(progressT.toFixed(4)),
			prasaAnchor: prasaAnchorDiag,
			eduppu:
				firstLive < b.syllables.length
					? {
							firstLiveIndex: firstLive,
							entryGlobalPulse,
							entryMod8,
							richEntry: richEduppu,
						}
					: undefined,
			phoneticJunctions: { harshCount: junctions.harshCount, sample: junctions.sample },
			layaWalk: {
				oddJatiBar,
				pulseDensity: Number(pulseDensity.toFixed(3)),
				subdivAir,
			},
			guruLaghu: { unaccentedHardCount, unaccentedThom },
			flags,
		};
		outBars.push({ ...b, aestheticDiagnostics: diagnostics });
		pulsesBefore += b.syllables.length;
	}
	const violationCount = violations.length;
	const passRateByFlag = Object.fromEntries(
		Object.entries(flagTotalCount).map(([name, total]) => [name, total > 0 ? flagPassCount[name as AestheticFlagName] / total : 1]),
	) as Record<AestheticFlagName, number>;
	const technicalScore = Math.max(0, Math.round((1 - violationCount / Math.max(1, outBars.length * AESTHETIC_GATE_COUNT)) * 100));
	const muktayiOk = computeMuktayiCheck(outBars).ok;
	const poetry = buildLessonPoetryReport({
		technicalScore,
		eduppuApplicable,
		eduppuSyncopated,
		eduppuSamLocked,
		stackedShadowPairs,
		muktayiOk,
		symmetryCloseBars,
		totalBars: outBars.length,
	});
	const tihaiAudit = computeTihaiAuditSummary(outBars);
	const blendedScore = Math.min(technicalScore, tihaiAudit.aestheticScore);
	const summary: LessonAestheticSummary = {
		logSchemaVersion: 'aesthetic-log-v1',
		score: blendedScore,
		criticalCount: violations.filter((v) => v.severity === 'critical').length + tihaiAudit.criticalErrors.length,
		warningCount: violations.filter((v) => v.severity === 'warning').length,
		violations,
		phaseCoverage,
		passRateByFlag,
		samLandingStats: {
			onSam,
			offSam,
			landingOffsetAvg: Number((landingOffsetSum / Math.max(1, outBars.length)).toFixed(3)),
		},
		poetry,
		tihaiAudit,
	};
	return { barsWithDiagnostics: outBars, summary };
}

/**
 * Muktayi check: the lesson's last syllable is accented Ta or Thom, and its global pulse
 * (sum of bar lengths before it + in-bar index) lands on the last beat of ADI cycle:
 * globalPulse % 8 === 7.
 */
export function computeMuktayiCheck(
	bars: readonly BarLog[],
	opts?: { adiCycle?: number },
): { ok: boolean; lines: string[] } {
	const cycle = opts?.adiCycle ?? MUKTAYI_ADI_PULSE_CYCLE;
	const lines: string[] = [];
	if (bars.length === 0) {
		lines.push('Muktayi-check: FAIL (no bars)');
		return { ok: false, lines };
	}
	const lastBar = bars[bars.length - 1]!;
	const n = lastBar.syllables.length;
	if (n < 1) {
		lines.push('Muktayi-check: FAIL (empty last bar)');
		return { ok: false, lines };
	}
	const isRestTok = (raw: string): boolean => {
		const s = normalizeSyllableToken(raw).toLowerCase();
		return s === '' || s === '-' || s === '—' || s === '.';
	};
	let lastIdx = n - 1;
	while (lastIdx >= 0 && isRestTok(lastBar.syllables[lastIdx] ?? '')) lastIdx--;
	if (lastIdx < 0) {
		lines.push('Muktayi-check: FAIL (last bar contains only rests)');
		return { ok: false, lines };
	}
	let pulsesBefore = 0;
	for (let i = 0; i < bars.length - 1; i++) {
		pulsesBefore += bars[i]!.syllables.length;
	}
	const globalPulse = pulsesBefore + lastIdx;
	const onSam = globalPulse % cycle === cycle - 1;
	const lastTok = lastBar.syllables[lastIdx] ?? '';
	const taThom = isTaOrThom(lastTok);
	const accented = lastBar.accents.includes(lastIdx);
	const ok = taThom && accented && onSam;
	const hadDeSync = bars.some((b) => b.deSyncJati === true);

	lines.push('---------------------------------------');
	lines.push(`Muktayi-check (ADI ${cycle} pulses/cycle; sam -> globalPulse ≡ ${cycle - 1} mod ${cycle}):`);
	lines.push(
		ok
			? `  PASS - last significant syllable "${lastTok}" (Ta/Thom), accented, globalPulse=${globalPulse}; ${globalPulse} % ${cycle} = ${cycle - 1} (last pulse of cycle).`
			: `  FAIL - last significant syllable "${lastTok}", idx=${lastIdx}, accent=${accented}, Ta/Thom=${taThom}, globalPulse=${globalPulse}, ${globalPulse} % ${cycle}=${globalPulse % cycle} (expected ${cycle - 1}).`,
	);
	if (!ok && hadDeSync && !onSam) {
		lines.push('  Re-sync Error: offset mismatch.');
	}
	return { ok, lines };
}

function syllableNamesForGenome(bpm: number, g: BarGenome): string[] {
	const parts: string[] = [];
	const dead = typeof g.deadStart === 'number' ? Math.max(0, Math.min(g.deadStart, g.curSyl)) : g.curSyl;
	for (let i = 0; i < g.curSyl; i++) {
		const ov = g.cellSyllables?.[i];
		if (typeof ov === 'string' && ov.length > 0) {
			parts.push(ov);
			continue;
		}
		parts.push(i >= dead ? '.' : effectiveSyllableToken(g, i, bpm));
	}
	return parts;
}

/** Human-readable theme line (1-2 parent bars). */
export function formatParentGenomeHumanLine(parent: ParentGenome, bpm: number): string {
	return parent.bars.map((g) => syllableNamesForGenome(bpm, g).join(' ')).join(' | ');
}

function intentionLabel(role: PhraseRole): {
	line: string;
	mutationKind: string;
	phraseId: number;
	phraseStep: number;
	isTihai: boolean;
	modeTag?: 'gati_mode' | 'jati_mode';
	deSyncJati?: boolean;
	localJati?: number;
	reSyncBridge?: boolean;
	bridgeKind?: 'resync' | 'de_sync_prep' | 'gati_prep';
	pulseOffsetBeforeBar?: number;
	gatiTargetSub?: number;
	intensityTarget?: number;
	emotionalProfile?: 'tandava' | 'lasya' | 'yati';
	arudiReason?: 'symmetry_close' | 'phrase_cadence';
	prasaMaxEditDistance?: number;
} {
	const phraseId = role.phraseId;
	if (role.type === 'parent') {
		return {
			line: '[Parent Mode] - Exposition',
			mutationKind: 'parent',
			phraseId,
			phraseStep: 0,
			isTihai: false,
			emotionalProfile: role.emotionalProfile,
		};
	}
	if (role.type === 'free') {
		return {
			line: '[Free] - Free-random filler',
			mutationKind: 'free',
			phraseId,
			phraseStep: 0,
			isTihai: false,
			emotionalProfile: role.emotionalProfile,
		};
	}
	if (role.type === 'resync_bridge') {
		const kind = 'bridgeKind' in role && role.bridgeKind ? role.bridgeKind : 'resync';
		const kindLabel = kind === 'de_sync_prep' ? '[De-sync Prep]' : kind === 'gati_prep' ? '[Gati Prep]' : '[Re-sync Bridge]';
		return {
			line: `${kindLabel} [Karvai] - Transition buffer · phrase#${phraseId}`,
			mutationKind: 'resync_bridge',
			phraseId,
			phraseStep: 0,
			isTihai: false,
			// Bridge phases must not be auto-labeled as Jati;
			// truth mode is computed below from physical bar properties.
			modeTag: undefined,
			deSyncJati: false,
			localJati: undefined,
			reSyncBridge: kind === 'resync',
			bridgeKind: kind,
			pulseOffsetBeforeBar: role.pulseOffsetBeforeBar,
			emotionalProfile: role.emotionalProfile,
		};
	}
	const label = MUTATION_LABEL[role.type];
	const stepInfo = `Step ${role.phraseStep + 1}/${role.phraseLength}`;
	const isTihai = role.type === 'tihai';
	const localCycle =
		'localCycleLength' in role && typeof role.localCycleLength === 'number' ? role.localCycleLength : undefined;
	const hasRealJatiCycle = localCycle === 5 || localCycle === 7 || localCycle === 9;
	const deSyncJati =
		'deSyncJati' in role && role.deSyncJati === true && hasRealJatiCycle;
	const modeTag: 'gati_mode' | 'jati_mode' | undefined = deSyncJati ? 'jati_mode' : 'gati_mode';
	const modeLabel = deSyncJati ? ' [Jati Mode (De-sync)]' : ' [Gati Mode]';
	const localJati = deSyncJati ? localCycle : undefined;
	// Re-sync bridge must be a separate role BEFORE tihai, not inside first tihai bar.
	const reSyncBridge = false;
	let extra = '';
	if (isTihai) {
		extra = role.phraseStep === role.phraseLength - 1 ? ' (landing)' : ' (call / build)';
	}
	if (reSyncBridge) extra += ' [Re-sync Bridge]';
	return {
		line: `[${label}]${modeLabel} - ${stepInfo}${extra} · phrase#${phraseId}`,
		mutationKind: role.type,
		phraseId,
		phraseStep: role.phraseStep,
		isTihai,
		modeTag,
		deSyncJati,
		localJati,
		reSyncBridge,
		bridgeKind: reSyncBridge ? 'resync' : undefined,
		pulseOffsetBeforeBar: role.pulseOffsetBeforeBar,
		gatiTargetSub: role.gatiTargetSub,
		intensityTarget: role.intensityTarget,
		emotionalProfile: role.emotionalProfile,
		arudiReason: role.arudiReason,
		prasaMaxEditDistance: role.prasaMaxEditDistance,
	};
}

type ModeTruthInput = {
	modeTag?: 'gati_mode' | 'jati_mode';
	totalCells: number;
	subdivisionHits: number;
	maxSubdivision: number;
	pulseOffsetBeforeBar?: number;
	localJati?: number;
};

export function evaluateModeTruth(input: ModeTruthInput): {
	resolvedModeTag?: 'gati_mode' | 'jati_mode';
	critical?: string;
} {
	const modeTag = input.modeTag;
	if (!modeTag) return { resolvedModeTag: undefined };
	const totalCells = Math.max(0, Math.floor(input.totalCells));
	const localJati = typeof input.localJati === 'number' ? Math.max(1, Math.floor(input.localJati)) : totalCells;
	const hasDeclaredLocalJati = typeof input.localJati === 'number';
	const hasPhysicalOddCycle = totalCells === 5 || totalCells === 7 || totalCells === 9;
	// Strict invariant: with declared Local Jati, physical bar size must match.
	if (modeTag === 'jati_mode' && hasDeclaredLocalJati && hasPhysicalOddCycle && localJati !== totalCells) {
		return {
			resolvedModeTag: 'gati_mode',
			critical: `CRITICAL: Jati Size Mismatch (declared=${localJati}, physical=${totalCells}).`,
		};
	}
	const hasValidJatiCycle = localJati === 5 || localJati === 7 || localJati === 9;
	const hasPhysicalJatiCycle = hasPhysicalOddCycle;
	const hasSubdivisionDrive = input.subdivisionHits > 0 || input.maxSubdivision > 1;
	const hasDrift = typeof input.pulseOffsetBeforeBar === 'number' ? input.pulseOffsetBeforeBar % MUKTAYI_ADI_PULSE_CYCLE !== 0 : false;
	const trueGati = totalCells === MUKTAYI_ADI_PULSE_CYCLE && hasSubdivisionDrive;
	// Truth contract:
	// Jati is true only when the bar itself has physical 5/7/9 cycle.
	// This blocks false promotion to jati_mode in bridge/gati contexts where curSyl != 5|7|9.
	const trueJati = hasPhysicalJatiCycle && (hasDrift || hasValidJatiCycle);
	if (modeTag === 'jati_mode' && !trueJati) {
		return {
			resolvedModeTag: 'gati_mode',
			critical: 'CRITICAL: False Jati Mapping Detected (ImitationDetected).',
		};
	}
	if (modeTag === 'gati_mode' && trueJati) {
		return { resolvedModeTag: 'jati_mode' };
	}
	return { resolvedModeTag: modeTag };
}

/**
 * Bar snapshot after `applyParentModeBar`: syllables/accents from grid + intent from schedule role.
 */
export function buildBarLogForParentRow(
	rowIndex: number,
	role: PhraseRole,
	tempoBpm: number,
	syllablesDefault: number,
	state: {
		customSyllables: Record<number, number>;
		accents: Set<string>;
		accentsByLane?: Partial<Record<number, Iterable<string>>>;
		taDingKeysByLane?: Partial<Record<number, Iterable<string>>>;
		customSubdivisions: Record<string, number>;
		customCellSyllables?: Record<string, string>;
		customMultipliers?: Record<number, number>;
		polyMode?: boolean;
		polyVoices?: 2 | 3 | 4;
		deadCells: { [r: number]: { deadStart: number } | undefined };
	},
): BarLog {
	const g = snapshotBarGenome(rowIndex, syllablesDefault, state);
	let subdivisionHits = 0;
	let maxSubdivision = 1;
	for (let c = 0; c < g.curSyl; c++) {
		const s = state.customSubdivisions[`${rowIndex}-${c}`];
		if (typeof s === 'number' && s > 1) {
			subdivisionHits++;
			maxSubdivision = Math.max(maxSubdivision, Math.floor(s));
		}
	}
	const syllables = syllableNamesForGenome(tempoBpm, g);
	const physicalCells = syllables.length;
	const accents = [...g.accents].sort((a, b) => a - b);
	const intent = intentionLabel(role);
	const bridgeLocalCycleRaw = role.type === 'resync_bridge' ? role.localCycleLength : undefined;
	const bridgeLocalCycle =
		typeof bridgeLocalCycleRaw === 'number' && (bridgeLocalCycleRaw === 5 || bridgeLocalCycleRaw === 7 || bridgeLocalCycleRaw === 9)
			? bridgeLocalCycleRaw
			: undefined;
	const bridgeHasDrift =
		role.type === 'resync_bridge' && typeof intent.pulseOffsetBeforeBar === 'number'
			? intent.pulseOffsetBeforeBar % MUKTAYI_ADI_PULSE_CYCLE !== 0
			: false;
	const bridgeHasPhysicalJati =
		role.type === 'resync_bridge' &&
		bridgeLocalCycle !== undefined &&
		(g.curSyl === 5 || g.curSyl === 7 || g.curSyl === 9) &&
		g.curSyl === bridgeLocalCycle;
	const bridgeModeTag: 'gati_mode' | 'jati_mode' | undefined =
		role.type === 'resync_bridge'
			? bridgeHasPhysicalJati && (bridgeHasDrift || g.curSyl === bridgeLocalCycle)
				? 'jati_mode'
				: 'gati_mode'
			: intent.modeTag;
	const modeTruth = evaluateModeTruth({
		modeTag: bridgeModeTag,
		totalCells: physicalCells,
		subdivisionHits,
		maxSubdivision,
		pulseOffsetBeforeBar: intent.pulseOffsetBeforeBar,
		localJati: role.type === 'resync_bridge' ? bridgeLocalCycle : intent.localJati,
	});
	const resolvedModeTag = modeTruth.resolvedModeTag;
	const variationType =
		resolvedModeTag !== intent.modeTag
			? intent.line
				.replace(' [Jati Mode (De-sync)]', ' [Gati Mode]')
				.replace(' [Gati Mode]', ' [Jati Mode (De-sync)]')
			: intent.line;
	const nps = npsForBar(tempoBpm, g);
	const syllableAssembly = computeSyllableAssemblyDiagnostics(rowIndex, g, state, tempoBpm, syllables);
	const polyVoices = state.polyVoices === 3 ? 3 : state.polyVoices === 4 ? 4 : 2;
	const lane = (polyVoices === 3 ? (rowIndex % 3) : (rowIndex % 2)) as 0 | 1 | 2;
	const divisions: number[] = [];
	for (let c = 0; c < g.curSyl; c++) {
		const raw = state.customSubdivisions[`${rowIndex}-${c}`];
		const normalized = typeof raw === 'number' ? Math.max(1, Math.floor(raw)) : 1;
		divisions.push(normalized);
	}
	const collectVoicePositions = (raw?: Iterable<string>): number[] => {
		const out: number[] = [];
		if (!raw) return out;
		for (const key of raw) {
			if (typeof key !== 'string') continue;
			const parts = key.split('-');
			if (parts.length !== 2) continue;
			const r = Number.parseInt(parts[0] ?? '', 10);
			const c = Number.parseInt(parts[1] ?? '', 10);
			if (!Number.isFinite(r) || !Number.isFinite(c) || r !== rowIndex || c < 0 || c >= g.curSyl) continue;
			out.push(c);
		}
		out.sort((a, b) => a - b);
		return out;
	};
	const voiceAccents: Record<0 | 1 | 2, number[]> = {
		0: collectVoicePositions(state.accentsByLane?.[0]),
		1: collectVoicePositions(state.accentsByLane?.[1]),
		2: collectVoicePositions(state.accentsByLane?.[2]),
	};
	const voiceAltAccents: Record<0 | 1 | 2, number[]> = {
		0: collectVoicePositions(state.taDingKeysByLane?.[0]),
		1: collectVoicePositions(state.taDingKeysByLane?.[1]),
		2: collectVoicePositions(state.taDingKeysByLane?.[2]),
	};
	const allCells = Array.from({ length: g.curSyl }, (_, i) => i);
	const liveMask = new Set(accents);
	const voicePassives: Record<0 | 1 | 2, number[]> = {
		0: allCells.filter((c) => !liveMask.has(c)),
		1: allCells.filter((c) => !voiceAccents[1].includes(c)),
		2: allCells.filter((c) => !voiceAccents[2].includes(c)),
	};
	const multiplierRaw = state.customMultipliers?.[rowIndex];
	const multiplier = Number.isFinite(multiplierRaw) ? Math.max(1, Math.floor(multiplierRaw as number)) : 1;
	const deadStartRaw = state.deadCells[rowIndex]?.deadStart;
	const deadStart =
		typeof deadStartRaw === 'number' && Number.isFinite(deadStartRaw)
			? Math.max(0, Math.min(g.curSyl, Math.floor(deadStartRaw)))
			: null;
	const polyrhythmTag =
		state.polyMode === true
			? `poly-${polyVoices}v lane:${lane + 1}`
			: 'none';
	const barPulseBase = Math.max(1, g.curSyl);
	const barPulseExpanded = Math.max(1, divisions.reduce((acc, v) => acc + Math.max(1, v), 0));
	const pulsationLabel = `${barPulseBase} -> ${barPulseExpanded}`;
	// Truth over declaration: local jati must reflect physical bar size, not role intent.
	const localJatiPhysical =
		role.type === 'resync_bridge'
			? resolvedModeTag === 'jati_mode' && bridgeHasPhysicalJati
				? bridgeLocalCycle
				: undefined
			: resolvedModeTag === 'jati_mode' && (physicalCells === 5 || physicalCells === 7 || physicalCells === 9)
				? Math.max(1, physicalCells)
				: undefined;
	const deSyncJatiResolved =
		role.type === 'resync_bridge'
			? resolvedModeTag === 'jati_mode'
			: resolvedModeTag === 'jati_mode';
	return {
		index: rowIndex,
		variationType,
		syllables,
		accents,
		tempoBpm,
		polyMode: state.polyMode === true,
		polyVoices,
		polyrhythmTag,
		multiplier,
		deadStart,
		cellDivisions: divisions,
		voiceAccents,
		voiceAltAccents,
		voicePassives,
		barPulseBase,
		barPulseExpanded,
		pulsationLabel,
		/** number of active beats in bar (like "Sub: 4" in examples) */
		subdivision: physicalCells,
		nps,
		isTihaiPart: intent.isTihai ? true : undefined,
		phraseId: intent.phraseId,
		mutationKind: intent.mutationKind,
		modeTag: resolvedModeTag,
		deSyncJati: deSyncJatiResolved,
		localJati: localJatiPhysical,
		reSyncBridge: intent.reSyncBridge,
		bridgeKind: intent.bridgeKind,
		pulseOffsetBeforeBar: intent.pulseOffsetBeforeBar,
		gatiTargetSub: intent.gatiTargetSub,
		intensityTarget: intent.intensityTarget,
		totalCells: physicalCells,
		subdivisionHits,
		maxSubdivision,
		auditCritical: modeTruth.critical,
		emotionalProfile: intent.emotionalProfile,
		arudiReason: intent.arudiReason,
		prasaMaxEditDistance: intent.prasaMaxEditDistance,
		phraseStep: intent.phraseStep,
		syllableAssembly,
	};
}

export class LessonLogger {
	private meta: LessonMeta | null = null;
	private bars: BarLog[] = [];

	reset(meta: LessonMeta): void {
		this.meta = meta;
		this.bars = [];
	}

	addBar(bar: BarLog): void {
		this.bars.push(bar);
	}

	getMeta(): LessonMeta | null {
		return this.meta;
	}

	getBars(): readonly BarLog[] {
		return this.bars;
	}

	buildLessonDebugPayload(): LessonDebugPayload {
		const m = this.meta;
		if (!m) {
			return {
				logSchemaVersion: 'aesthetic-log-v1',
				meta: {
					seed: 0,
					chaos: 0,
					parentThemeLine: '',
					formPresetLabel: '',
					formPresetId: '',
					randomMode: '',
					barCount: 0,
				},
				bars: [],
				summary: {
					logSchemaVersion: 'aesthetic-log-v1',
					score: 0,
					criticalCount: 0,
					warningCount: 0,
					violations: [],
					phaseCoverage: { exposition: 0, exploration: 0, destabilization: 0, culmination: 0 },
					passRateByFlag: {
						prasaContinuity: 0,
						thomLegality: 0,
						intensityPalette: 0,
						karvaiBuffer: 0,
						shiftAccent: 0,
						arudiSymmetry: 0,
						samLanding: 0,
						accentTopology: 0,
						eduppuEntry: 0,
						varnaPhoneticFlow: 0,
						layaGatiCharacter: 0,
						guruLaghuWeight: 0,
						shadowingBreath: 0,
					},
					samLandingStats: { onSam: 0, offSam: 0, landingOffsetAvg: 0 },
					poetry: {
						poetryIndex: 0,
						poetryVerdict: '(нет данных)',
						eduppuLesson: { applicableBars: 0, syncopatedEntryBars: 0, samLockedEntryBars: 0, varietyRatio: 0 },
						shadowing: { stackedComplexDestabilPairs: 0 },
					},
					tihaiAudit: {
						aestheticScore: 100,
						criticalErrors: [],
						verdict: 'Музыка',
						window: null,
						checks: {
							tripleIdentity: true,
							equidistantGaps: true,
							finalImpact: true,
							varnaIntegrity: true,
							parentalLink: true,
						},
					},
				},
			};
		}
		const evaluated = evaluateAestheticDiagnostics(this.bars);
		return {
			logSchemaVersion: 'aesthetic-log-v1',
			meta: m,
			bars: evaluated.barsWithDiagnostics,
			summary: evaluated.summary,
		};
	}

	formatLessonDebugJson(): string {
		return JSON.stringify(this.buildLessonDebugPayload(), null, 2);
	}

	formatLessonLogText(): string {
		const m = this.meta;
		const lines: string[] = [];
		if (!m) {
			return 'LESSON LOG\n(no session — reset() was not called for this lesson)\n';
		}
		lines.push(`LESSON LOG (Seed: ${m.seed >>> 0}, Chaos: ${m.chaos})`);
		lines.push(`Parent: ${m.parentThemeLine}`);
		lines.push(`Preset: ${m.formPresetLabel} · Bars: ${m.barCount}`);
		const modeParts: string[] = [];
		if (typeof m.randomMode === 'string' && m.randomMode.length > 0) modeParts.push(`RandomMode: ${m.randomMode}`);
		if (typeof m.formPresetId === 'string' && m.formPresetId.length > 0) modeParts.push(`PresetId: ${m.formPresetId}`);
		if (modeParts.length > 0) lines.push(`Mode: ${modeParts.join(' · ')}`);
		lines.push('---------------------------------------');

		if (this.bars.length === 0) {
			lines.push('(no recorded bars - trigger Random/Dice in Parent mode)');
			return lines.join('\n');
		}
		const makeGridString = (syllables: string[]): string => {
			const cells = syllables.map((tok) => {
				const s = normalizeSyllableToken(tok).toLowerCase();
				if (s === '.' || s === 'dot') return '.';
				if (s === '-' || s === '—') return '-';
				if (s.length === 0) return '.';
				return 'x';
			});
			return `|${cells.join('')}|`;
		};
		const evaluated = evaluateAestheticDiagnostics(this.bars);
		const bars = evaluated.barsWithDiagnostics;
		const isArudiBar = (bar: BarLog): boolean => typeof bar.arudiReason === 'string';
		const isPulseShiftStart = (idx: number): boolean => {
			const cur = bars[idx];
			if (!cur || cur.deSyncJati !== true) return false;
			const prev = idx > 0 ? bars[idx - 1] : undefined;
			return prev?.deSyncJati !== true;
		};
		const isMuktayiBar = (idx: number): boolean => idx === bars.length - 1;

		let i = 0;
		while (i < bars.length) {
			const b0 = bars[i]!;
			const pid = b0.phraseId ?? i;
			const mk = b0.mutationKind ?? 'unknown';
			let j = i + 1;
			while (
				j < bars.length &&
				(bars[j]!.phraseId ?? j) === pid &&
				(bars[j]!.mutationKind ?? '') === mk
			) {
				j++;
			}
			lines.push('');
			const barFrom = bars[i]!.index + 1;
			const barTo = bars[j - 1]!.index + 1;
			const block = bars.slice(i, j);
			const subConst = block.every((bb) => bb.subdivision === b0.subdivision);
			const npsConst = block.every((bb) => Math.abs(bb.nps - b0.nps) < 1e-9);
			const blockSub = subConst ? ` | Sub: ${b0.subdivision}` : '';
			const blockNps = npsConst ? ` | NPS: ${b0.nps}` : '';
			lines.push(`Bars ${barFrom}-${barTo}: ${b0.variationType}${blockSub}${blockNps}`);
			for (let k = i; k < j; k++) {
				const b = bars[k]!;
				const acc = b.accents.length ? b.accents.join(', ') : '—';
				const tih = b.isTihaiPart ? ' | Tihai phrase' : '';
				const jatiInfo =
					b.deSyncJati && typeof b.localJati === 'number'
						? ` | Local Jati: ${Math.max(1, Math.round(b.localJati))}/8`
						: '';
				const bridge = b.reSyncBridge ? ' | [Re-sync Bridge]' : '';
				const bridgeKind = b.bridgeKind ? ` | Bridge: ${b.bridgeKind}` : '';
				const offsetInfo =
					typeof b.pulseOffsetBeforeBar === 'number' ? ` | PulseOffset: ${Math.max(0, Math.floor(b.pulseOffsetBeforeBar))}` : '';
				const gatiTarget = typeof b.gatiTargetSub === 'number' ? ` | GatiTarget: ${b.gatiTargetSub}` : '';
				const intensityInfo =
					typeof b.intensityTarget === 'number' ? ` | Intensity(i): ${b.intensityTarget.toFixed(2)}` : '';
				const tInfo =
					typeof b.aestheticDiagnostics?.progressT === 'number'
						? ` | t≈${b.aestheticDiagnostics.progressT.toFixed(2)}`
						: '';
				const profileInfo = typeof b.emotionalProfile === 'string' ? ` | Profile: ${b.emotionalProfile}` : '';
				const prasaInfo =
					typeof b.prasaMaxEditDistance === 'number' ? ` | PrasaMaxEdit: ${Math.max(0, Math.floor(b.prasaMaxEditDistance))}` : '';
				const phraseStepInfo = typeof b.phraseStep === 'number' ? ` | phraseStep: ${b.phraseStep}` : '';
				const cadenceInfo = b.arudiReason ? ` | Cadence: ${b.arudiReason}` : '';
				const barSub = subConst ? '' : ` | Sub: ${b.subdivision}`;
				const barNps = npsConst ? '' : ` | NPS: ${b.nps}`;
				const grid = makeGridString(b.syllables);
				const markers: string[] = [];
				if (isPulseShiftStart(k)) markers.push('[Pulse Shift]');
				if (isArudiBar(b)) markers.push('[Arudi]');
				if (isMuktayiBar(k)) markers.push('[Muktayi]');
				const seq = b.aestheticDiagnostics?.sequenceCheck;
				if (seq?.ok) markers.push('[SEQ_OK]');
				else if (seq) markers.push('[SEQ_FAIL: Jump Detected]');
				const markerInfo = markers.length > 0 ? ` | ${markers.join(' ')}` : '';
				const ed = b.aestheticDiagnostics?.eduppu;
				const eduppuInfo =
					ed && b.aestheticDiagnostics?.progressivePhase !== 'exposition'
						? ` | Eduppu: mod8=${ed.entryMod8}${ed.richEntry ? '·lift' : ''}`
						: '';
				lines.push(
					`Bar ${b.index + 1}: [${b.syllables.join(', ')}] | ${grid}${markerInfo} | Accents: [${acc}]${barSub}${jatiInfo}${barNps}${gatiTarget}${intensityInfo}${tInfo}${profileInfo}${prasaInfo}${phraseStepInfo}${cadenceInfo}${tih}${bridge}${bridgeKind}${offsetInfo}${eduppuInfo}`,
				);
				if (typeof b.auditCritical === 'string' && b.auditCritical.length > 0) {
					lines.push(`  ${b.auditCritical}`);
				}
				const flagViolations = b.aestheticDiagnostics?.flags.filter((f) => f.state === 'violation') ?? [];
				if (flagViolations.length > 0) {
					lines.push(`  Aesthetic-debug ${b.aestheticDiagnostics?.arcPhaseTag ?? ''}`.trim());
					const seq = b.aestheticDiagnostics?.sequenceCheck;
					if (seq && !seq.ok) {
						lines.push(
							`    [SEQ_FAIL: Jump Detected] currentSyllableIndex=${seq.currentSyllableIndex}, expected=${seq.expectedSyllableIndex}, prevSyllableIndex=${seq.prevSyllableIndex}, rowLength=${seq.rowLength}, step=${seq.step}, subdivs=${seq.subdivisionsHint}`,
						);
					}
					for (const v of flagViolations) {
						lines.push(`    [${v.code}] ${v.reason} | evidence=${JSON.stringify(v.evidence)}`);
					}
				}
			}
			i = j;
		}
		lines.push(...computeMuktayiCheck(bars).lines);
		lines.push('---------------------------------------');
		lines.push('Aesthetic-summary:');
		lines.push(
			`  score=${evaluated.summary.score} | critical=${evaluated.summary.criticalCount} | warning=${evaluated.summary.warningCount} | schema=${evaluated.summary.logSchemaVersion}`,
		);
		lines.push(
			`  Arc-phase-summary: exposition=${evaluated.summary.phaseCoverage.exposition}, exploration=${evaluated.summary.phaseCoverage.exploration}, destabilization=${evaluated.summary.phaseCoverage.destabilization}, culmination=${evaluated.summary.phaseCoverage.culmination}`,
		);
		lines.push(
			`  samLandingStats: onSam=${evaluated.summary.samLandingStats.onSam}, offSam=${evaluated.summary.samLandingStats.offSam}, avgOffset=${evaluated.summary.samLandingStats.landingOffsetAvg}`,
		);
		const p = evaluated.summary.poetry;
		lines.push('Poetry-index:');
		lines.push(`  index=${p.poetryIndex.toFixed(2)}`);
		lines.push(`  verdict=${p.poetryVerdict}`);
		if (p.poetryCritical) {
			lines.push(`  critical=${p.poetryCritical}`);
		}
		lines.push(
			`  eduppu-lesson: applicable=${p.eduppuLesson.applicableBars}, syncopated=${p.eduppuLesson.syncopatedEntryBars}, samLocked=${p.eduppuLesson.samLockedEntryBars}, variety=${p.eduppuLesson.varietyRatio}`,
		);
		lines.push(`  shadowing: stackedComplexDestabilPairs=${p.shadowing.stackedComplexDestabilPairs}`);
		const t = evaluated.summary.tihaiAudit;
		lines.push('Tihai-audit:');
		if (t.window) lines.push(`  window=bars ${t.window.fromBar}-${t.window.toBar}`);
		lines.push(`  Aesthetic Score: ${t.aestheticScore}`);
		lines.push(`  Critical Errors: ${t.criticalErrors.length > 0 ? t.criticalErrors.join(', ') : 'none'}`);
		lines.push(`  Verdict: ${t.verdict}`);
		return lines.join('\n');
	}

	formatLessonLogMarkdown(): string {
		const m = this.meta;
		if (!m) {
			return '# Lesson Log\n\n(no session - reset() was not called for this lesson)\n';
		}
		const evaluated = evaluateAestheticDiagnostics(this.bars);
		const bars = evaluated.barsWithDiagnostics;
		const lines: string[] = [];
		const fmtArr = (arr: readonly number[] | undefined): string => {
			if (!arr || arr.length === 0) return '-';
			return arr.join(', ');
		};
		const pushVoiceBlock = (title: string, voiceData: Record<0 | 1 | 2, number[]> | undefined): void => {
			lines.push(`- **${title}**`);
			lines.push(`  - Voice 1: ${fmtArr(voiceData?.[0])}`);
			lines.push(`  - Voice 2: ${fmtArr(voiceData?.[1])}`);
			lines.push(`  - Voice 3: ${fmtArr(voiceData?.[2])}`);
		};

		lines.push('# Lesson Log');
		lines.push('');
		lines.push('## Session');
		lines.push(`- Seed: ${m.seed >>> 0}`);
		lines.push(`- Chaos: ${m.chaos}`);
		lines.push(`- Tempo: ${typeof m.tempoBpm === 'number' ? `${m.tempoBpm} BPM` : 'n/a'}`);
		lines.push(`- Bars: ${m.barCount}`);
		lines.push(`- Random Mode: ${m.randomMode ?? 'n/a'}`);
		lines.push(`- Preset: ${m.formPresetLabel}${m.formPresetId ? ` (${m.formPresetId})` : ''}`);
		lines.push(`- Poly: ${m.polyMode ? `on (${m.polyVoices ?? 2} voices)` : 'off'}`);
		lines.push(`- Parent Theme: ${m.parentThemeLine}`);
		lines.push('');

		if (bars.length === 0) {
			lines.push('## Bars');
			lines.push('- no recorded bars (run Parent Random/Dice first)');
			return `${lines.join('\n')}\n`;
		}

		lines.push('## Bars');
		lines.push('');
		for (const b of bars) {
			lines.push(`### Bar ${b.index + 1}`);
			lines.push(`- Syllables: ${b.syllables.join(' | ')}`);
			lines.push(`- Tempo: ${typeof b.tempoBpm === 'number' ? `${b.tempoBpm} BPM` : (typeof m.tempoBpm === 'number' ? `${m.tempoBpm} BPM` : 'n/a')}`);
			lines.push(`- Cells: ${b.subdivision}`);
			lines.push(`- Divisions (per cell): ${b.cellDivisions?.join(', ') ?? '-'}`);
			lines.push(`- Bar Pulsation: ${b.pulsationLabel ?? `${b.barPulseBase ?? b.subdivision} -> ${b.barPulseExpanded ?? b.subdivision}`}`);
			lines.push(`- Multiplier: ${b.multiplier ?? 1}`);
			lines.push(`- Dead Cells Start: ${typeof b.deadStart === 'number' ? b.deadStart : 'none'}`);
			lines.push(`- Gati/Jati: ${b.modeTag ?? 'n/a'}${typeof b.localJati === 'number' ? ` (local ${b.localJati})` : ''}`);
			lines.push(`- Polyrhythm: ${b.polyrhythmTag ?? (b.polyMode ? `poly-${b.polyVoices ?? 2}v` : 'none')}`);
			pushVoiceBlock('Accents', b.voiceAccents);
			pushVoiceBlock('Alt Accents', b.voiceAltAccents);
			pushVoiceBlock('Passives (dead cells)', b.voicePassives);
			lines.push('');
		}

		lines.push('## Historical Playback Sequence');
		lines.push('- event format: `# | bar:cell.sub | pulse(global) | syllable | voices`');
		let eventIdx = 1;
		let globalPulse = 1;
		for (const b of bars) {
			const divs = b.cellDivisions ?? [];
			for (let c = 0; c < b.syllables.length; c++) {
				const syll = b.syllables[c] ?? '.';
				const localDiv = Math.max(1, divs[c] ?? 1);
				const accV1 = b.voiceAccents?.[0]?.includes(c) === true ? 'A' : '.';
				const accV2 = b.voiceAccents?.[1]?.includes(c) === true ? 'A' : '.';
				const accV3 = b.voiceAccents?.[2]?.includes(c) === true ? 'A' : '.';
				const altV1 = b.voiceAltAccents?.[0]?.includes(c) === true ? 'T' : '.';
				const altV2 = b.voiceAltAccents?.[1]?.includes(c) === true ? 'T' : '.';
				const altV3 = b.voiceAltAccents?.[2]?.includes(c) === true ? 'T' : '.';
				const pasV1 = b.voicePassives?.[0]?.includes(c) === true ? 'P' : '.';
				const pasV2 = b.voicePassives?.[1]?.includes(c) === true ? 'P' : '.';
				const pasV3 = b.voicePassives?.[2]?.includes(c) === true ? 'P' : '.';
				for (let d = 0; d < localDiv; d++) {
					lines.push(
						`- ${eventIdx} | ${b.index + 1}:${c + 1}.${d + 1} | ${globalPulse} | ${syll} | V1 ${accV1}${altV1}${pasV1} · V2 ${accV2}${altV2}${pasV2} · V3 ${accV3}${altV3}${pasV3}`,
					);
					eventIdx++;
					globalPulse++;
				}
			}
		}
		lines.push('');
		lines.push('## Aesthetic Summary');
		lines.push(`- Score: ${evaluated.summary.score}`);
		lines.push(`- Critical: ${evaluated.summary.criticalCount}`);
		lines.push(`- Warning: ${evaluated.summary.warningCount}`);
		lines.push(
			`- Arc: exposition=${evaluated.summary.phaseCoverage.exposition}, exploration=${evaluated.summary.phaseCoverage.exploration}, destabilization=${evaluated.summary.phaseCoverage.destabilization}, culmination=${evaluated.summary.phaseCoverage.culmination}`,
		);
		lines.push(
			`- Sam landing: onSam=${evaluated.summary.samLandingStats.onSam}, offSam=${evaluated.summary.samLandingStats.offSam}, avgOffset=${evaluated.summary.samLandingStats.landingOffsetAvg}`,
		);
		return `${lines.join('\n')}\n`;
	}
}

export const lessonLogger = new LessonLogger();

export function buildGridLessonLogMarkdown(input: {
	tempoBpm: number;
	bars: number;
	syllablesDefault: number;
	customSyllables: Record<number, number>;
	accentsByLane?: Partial<Record<number, Iterable<string>>>;
	taDingKeysByLane?: Partial<Record<number, Iterable<string>>>;
	customSubdivisions: Record<string, number>;
	customMultipliers?: Record<number, number>;
	deadCells: { [r: number]: { deadStart: number } | undefined };
	polyMode: boolean;
	polyVoices: 2 | 3 | 4;
	progressiveDensityMode?: 'gati_mode' | 'jati_mode';
	deSyncJatiActive?: boolean;
	deSyncCycleLength?: number;
	firstBeatAccent?: boolean;
	firstBeatAccentByLane?: Partial<Record<0 | 1 | 2, boolean>>;
	firstBeatDingSuppressedRows?: Iterable<number>;
	mixerLayerMode?: 'full_mix' | 'no_alt' | 'alt_only';
	trainerMode?: 'normal' | 'ta_only' | 'dictation';
	trainerHoldMute?: boolean;
	syllableReadMuteMode?: 'off' | 'full' | 'no_accent_sharp';
	dictantMode?: boolean;
	squarePlaybackMode?: 'passive_no_alt' | 'full_mix' | 'ta_only' | 'all_beats' | 'accent_only' | 'passive_only';
	squarePassiveLayerMuted?: boolean;
}): string {
	const lines: string[] = [];
	const bars = Math.max(0, Math.floor(input.bars));
	const voices = input.polyVoices === 3 ? 3 : 2;
	const laneForRow = (r: number): 0 | 1 | 2 => (voices === 3 ? (r % 3) : (r % 2)) as 0 | 1 | 2;
	const parseVoicePositions = (iter?: Iterable<string>, row?: number, maxCell?: number): number[] => {
		const out: number[] = [];
		if (!iter || typeof row !== 'number' || typeof maxCell !== 'number') return out;
		for (const key of iter) {
			if (typeof key !== 'string') continue;
			const [rRaw, cRaw] = key.split('-');
			const r = Number.parseInt(rRaw ?? '', 10);
			const c = Number.parseInt(cRaw ?? '', 10);
			if (!Number.isFinite(r) || !Number.isFinite(c) || r !== row || c < 0 || c >= maxCell) continue;
			out.push(c);
		}
		out.sort((a, b) => a - b);
		return out;
	};
	const fmtArr = (arr: readonly number[]): string => (arr.length === 0 ? '-' : arr.join(', '));
	const barRows: Array<{
		row: number;
		syllables: string[];
		divisions: number[];
		multiplier: number;
		deadStart: number | null;
		accents: Record<0 | 1 | 2, number[]>;
		alt: Record<0 | 1 | 2, number[]>;
		passive: Record<0 | 1 | 2, number[]>;
		pulsationLabel: string;
		polyrhythmTag: string;
	}> = [];

	lines.push('# Lesson Log');
	lines.push('');
	lines.push('## Session');
	lines.push(`- Tempo: ${Math.max(1, Math.floor(input.tempoBpm))} BPM`);
	lines.push(`- Bars: ${bars}`);
	lines.push(`- Poly: ${input.polyMode ? `on (${voices} voices)` : 'off'}`);
	lines.push(
		`- Gati/Jati Switch: ${input.progressiveDensityMode ?? 'gati_mode'} | long-press active=${input.deSyncJatiActive === true ? 'yes' : 'no'}${
			typeof input.deSyncCycleLength === 'number' ? ` | cycle=${Math.max(1, Math.floor(input.deSyncCycleLength))}` : ''
		}`,
	);
	lines.push('');
	lines.push('## Bars');
	lines.push('');

	for (let row = 0; row < bars; row++) {
		const g = snapshotBarGenome(row, input.syllablesDefault, {
			customSyllables: input.customSyllables,
			accents: new Set<string>(),
			customSubdivisions: input.customSubdivisions,
			customCellSyllables: {},
			deadCells: input.deadCells,
		});
		const syllables = syllableNamesForGenome(input.tempoBpm, g);
		const divisions: number[] = [];
		for (let c = 0; c < g.curSyl; c++) {
			const d = input.customSubdivisions[`${row}-${c}`];
			divisions.push(typeof d === 'number' ? Math.max(1, Math.floor(d)) : 1);
		}
		const deadStartRaw = input.deadCells[row]?.deadStart;
		const deadStart =
			typeof deadStartRaw === 'number' && Number.isFinite(deadStartRaw)
				? Math.max(0, Math.min(g.curSyl, Math.floor(deadStartRaw)))
				: null;
		const lane = laneForRow(row);
		const accents: Record<0 | 1 | 2, number[]> = {
			0: parseVoicePositions(input.accentsByLane?.[0], row, g.curSyl),
			1: parseVoicePositions(input.accentsByLane?.[1], row, g.curSyl),
			2: parseVoicePositions(input.accentsByLane?.[2], row, g.curSyl),
		};
		const alt: Record<0 | 1 | 2, number[]> = {
			0: parseVoicePositions(input.taDingKeysByLane?.[0], row, g.curSyl),
			1: parseVoicePositions(input.taDingKeysByLane?.[1], row, g.curSyl),
			2: parseVoicePositions(input.taDingKeysByLane?.[2], row, g.curSyl),
		};
		const allCells = Array.from({ length: g.curSyl }, (_, i) => i);
		const passive: Record<0 | 1 | 2, number[]> = {
			0: allCells.filter((c) => !accents[0].includes(c)),
			1: allCells.filter((c) => !accents[1].includes(c)),
			2: allCells.filter((c) => !accents[2].includes(c)),
		};
		const multiplierRaw = input.customMultipliers?.[row];
		const multiplier = Number.isFinite(multiplierRaw) ? Math.max(1, Math.floor(multiplierRaw as number)) : 1;
		const barPulseBase = Math.max(1, g.curSyl);
		const barPulseExpanded = Math.max(1, divisions.reduce((sum, v) => sum + Math.max(1, v), 0));
		const pulsationLabel = `${barPulseBase} -> ${barPulseExpanded}`;
		const polyrhythmTag = input.polyMode ? `poly-${voices}v lane:${lane + 1}` : 'none';
		barRows.push({ row, syllables, divisions, multiplier, deadStart, accents, alt, passive, pulsationLabel, polyrhythmTag });
		lines.push(`### Bar ${row + 1}`);
		lines.push(`- Syllables: ${syllables.join(' | ')}`);
		lines.push(`- Divisions (per cell): ${divisions.join(', ')}`);
		lines.push(`- Bar Pulsation: ${pulsationLabel}`);
		lines.push(`- Multiplier: ${multiplier}`);
		lines.push(`- Dead Cells Start: ${typeof deadStart === 'number' ? deadStart : 'none'}`);
		lines.push(`- Polyrhythm: ${polyrhythmTag}`);
		lines.push(
			`- Gati/Jati Long-Press Switch: ${input.progressiveDensityMode ?? 'gati_mode'}${
				input.deSyncJatiActive ? ' (active)' : ' (inactive)'
			}${typeof input.deSyncCycleLength === 'number' ? `, cycle=${Math.max(1, Math.floor(input.deSyncCycleLength))}` : ''}`,
		);
		lines.push(`- **Accents**`);
		lines.push(`  - Voice 1: ${fmtArr(accents[0])}`);
		lines.push(`  - Voice 2: ${fmtArr(accents[1])}`);
		lines.push(`  - Voice 3: ${fmtArr(accents[2])}`);
		lines.push(`- **Alt Accents**`);
		lines.push(`  - Voice 1: ${fmtArr(alt[0])}`);
		lines.push(`  - Voice 2: ${fmtArr(alt[1])}`);
		lines.push(`  - Voice 3: ${fmtArr(alt[2])}`);
		lines.push(`- **Passives (dead cells)**`);
		lines.push(`  - Voice 1: ${fmtArr(passive[0])}`);
		lines.push(`  - Voice 2: ${fmtArr(passive[1])}`);
		lines.push(`  - Voice 3: ${fmtArr(passive[2])}`);
		lines.push('');
	}

	const parity = buildMidiParityEvents({
		bpm: Math.max(1, Math.floor(input.tempoBpm)),
		bars,
		baseSyllables: input.syllablesDefault,
		customSyllables: input.customSyllables,
		customSubdivisions: input.customSubdivisions,
		customMultipliers: input.customMultipliers ?? {},
		accents: input.accentsByLane?.[0] ?? [],
		accentsByLane: {
			0: input.accentsByLane?.[0] ?? [],
			1: input.accentsByLane?.[1] ?? [],
			2: input.accentsByLane?.[2] ?? [],
		},
		taDingKeys: input.taDingKeysByLane?.[0] ?? [],
		taDingKeysByLane: {
			0: input.taDingKeysByLane?.[0] ?? [],
			1: input.taDingKeysByLane?.[1] ?? [],
			2: input.taDingKeysByLane?.[2] ?? [],
		},
		firstBeatAccent: input.firstBeatAccent ?? true,
		firstBeatAccentByLane: {
			0: input.firstBeatAccentByLane?.[0] ?? (input.firstBeatAccent ?? true),
			1: input.firstBeatAccentByLane?.[1] ?? (input.firstBeatAccent ?? true),
			2: input.firstBeatAccentByLane?.[2] ?? (input.firstBeatAccent ?? true),
		},
		firstBeatDingSuppressedRows: input.firstBeatDingSuppressedRows ?? [],
		deadCells: input.deadCells,
		polyMode: input.polyMode,
		polyVoices: input.polyVoices,
		progressiveDensityMode: input.progressiveDensityMode,
		deSyncJatiActive: input.deSyncJatiActive,
		deSyncCycleLength: input.deSyncCycleLength,
		humanize: false,
		squarePlaybackMode: input.squarePlaybackMode,
		squarePassiveLayerMuted: input.squarePassiveLayerMuted,
		mixerLayerMode: input.mixerLayerMode,
		trainerMode: input.trainerMode,
		trainerHoldMute: input.trainerHoldMute,
		syllableReadMuteMode: input.syllableReadMuteMode,
		dictantMode: input.dictantMode,
	});
	lines.push('## MIDI-Parity Timeline');
	lines.push('- source: exact MIDI emission model (layer-resolved)');
	lines.push('- format: `# | layer | bar:cell | divs(cell) | note | tickStart+dur | msStart+dur`');
	lines.push(`- ppq=${parity.ppq}, bpm=${parity.bpm}, events=${parity.events.length}`);
	for (const ev of parity.events) {
		lines.push(
			`- ${ev.index} | ${ev.layer} | ${ev.row}:${ev.cell} | ${ev.cellSubdivs} | ${ev.note} | ${ev.startTick}+${ev.durationTicks} | ${ev.startMs}+${ev.durationMs}`,
		);
	}
	return `${lines.join('\n')}\n`;
}

export function downloadAestheticScore(custom?: { text?: string; seed?: number }): void {
	const text = custom?.text ?? lessonLogger.formatLessonLogMarkdown();
	const seed = custom?.seed ?? lessonLogger.getMeta()?.seed ?? 0;
	const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `lesson-log-${(seed >>> 0).toString(16)}.md`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
