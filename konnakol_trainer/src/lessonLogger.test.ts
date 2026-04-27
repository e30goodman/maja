import assert from 'node:assert/strict';
import { LessonLogger, evaluateAestheticDiagnostics, evaluateModeTruth, phraseAnchorBarIndexFromBars, type BarLog } from './lessonLogger';

function makeBar(idx: number, override?: Partial<BarLog>): BarLog {
	return {
		index: idx,
		variationType: '[Rotation] [Gati Mode] - Step 1/3 · phrase#1',
		syllables: ['Ta', 'Ka', 'Dhi', '.'],
		accents: [0, 2],
		subdivision: 4,
		nps: 4,
		phraseId: 1,
		mutationKind: 'rotation',
		...override,
	};
}

function testEnglishHeaderAndGrid() {
	const logger = new LessonLogger();
	logger.reset({
		seed: 1,
		chaos: 20,
		parentThemeLine: 'Ta Ka Dhi Mi',
		formPresetLabel: 'Progressive',
		barCount: 2,
	});
	logger.addBar(makeBar(0));
	logger.addBar(makeBar(1));
	const text = logger.formatLessonLogText();
	assert.ok(text.includes('Bars 1-2:'), 'block header should use english Bars X-Y');
	assert.ok(text.includes('| Sub: 4'), 'constant Sub must be lifted to block header');
	assert.ok(text.includes('| NPS: 4'), 'constant NPS must be lifted to block header');
	assert.ok(text.includes('|xxx.|'), 'grid string must be present');
	assert.ok(text.includes('Muktayi-check'), 'Muktayi-check must stay');
}

function testPulseOffsetPreserved() {
	const logger = new LessonLogger();
	logger.reset({
		seed: 2,
		chaos: 30,
		parentThemeLine: 'Ta Ka Ju Nu',
		formPresetLabel: 'Progressive',
		barCount: 1,
	});
	logger.addBar(
		makeBar(0, {
			pulseOffsetBeforeBar: 17,
			variationType: '[Re-sync Bridge] [Karvai] - Transition buffer · phrase#5',
			mutationKind: 'resync_bridge',
		}),
	);
	const text = logger.formatLessonLogText();
	assert.ok(text.includes('PulseOffset: 17'), 'PulseOffset diagnostics must stay in log');
}

function testMarkersArudiMuktayiPulseShiftPresent() {
	const logger = new LessonLogger();
	logger.reset({
		seed: 3,
		chaos: 40,
		parentThemeLine: 'Ta Nu Ki Te',
		formPresetLabel: 'Progressive',
		barCount: 3,
	});
	logger.addBar(makeBar(0, { mutationKind: 'rotation', deSyncJati: false, arudiReason: 'symmetry_close' }));
	logger.addBar(makeBar(1, { mutationKind: 'rotation', deSyncJati: true, localJati: 7 }));
	logger.addBar(makeBar(2, { mutationKind: 'tihai', isTihaiPart: true, syllables: ['Ta', 'Ki', 'Te', 'Thom'], accents: [3] }));
	const text = logger.formatLessonLogText();
	assert.ok(text.includes('[Pulse Shift]'), 'Pulse shift marker must be present');
	assert.ok(text.includes('[Arudi]'), 'Arudi marker must be present for non-tihai mutation bars');
	assert.ok(text.includes('[Muktayi]'), 'Muktayi marker must be present for the final bar');
}

function testProfileAndCadenceFieldsAreRendered() {
	const logger = new LessonLogger();
	logger.reset({
		seed: 4,
		chaos: 65,
		parentThemeLine: 'Ta Nu Ki Te',
		formPresetLabel: 'Progressive',
		barCount: 1,
	});
	logger.addBar(
		makeBar(0, {
			emotionalProfile: 'tandava',
			arudiReason: 'phrase_cadence',
			prasaMaxEditDistance: 3,
			intensityTarget: 0.82,
			syllables: ['Ta', 'Ki', 'Te', 'Thom'],
			accents: [3],
		}),
	);
	const text = logger.formatLessonLogText();
	assert.ok(text.includes('Profile: tandava'), 'profile field must be rendered');
	assert.ok(text.includes('Cadence: phrase_cadence'), 'cadence reason must be rendered');
	assert.ok(text.includes('PrasaMaxEdit: 3'), 'prasa max edit distance must be rendered');
	assert.ok(text.includes('Intensity(i):'), 'intensity axis label i must be rendered');
}

function testAestheticSummaryAndFlagsAreRendered() {
	const logger = new LessonLogger();
	logger.reset({
		seed: 10,
		chaos: 15,
		parentThemeLine: 'Ta Ka Dhi Mi',
		formPresetLabel: 'Progressive',
		barCount: 2,
	});
	logger.addBar(
		makeBar(0, {
			intensityTarget: 0.35,
			prasaMaxEditDistance: 2,
			syllables: ['Ta', 'Ka', 'Dhi', 'Mi'],
			accents: [0],
		}),
	);
	logger.addBar(
		makeBar(1, {
			isTihaiPart: true,
			intensityTarget: 0.9,
			syllables: ['Ta', 'Te', 'Ki', 'Thom'],
			accents: [3],
			pulseOffsetBeforeBar: 4,
		}),
	);
	const text = logger.formatLessonLogText();
	assert.ok(text.includes('Aesthetic-summary:'), 'text log must include aesthetic summary');
	assert.ok(text.includes('Arc-phase-summary:'), 'text log must include arc phase summary');
	assert.ok(text.includes('Poetry-index:'), 'text log must include poetry index block');
}

function testLessonDebugJsonHasSchemaAndBarFlags() {
	const logger = new LessonLogger();
	logger.reset({
		seed: 11,
		chaos: 35,
		parentThemeLine: 'Ta Ka Dhi Mi',
		formPresetLabel: 'Progressive',
		barCount: 1,
	});
	logger.addBar(
		makeBar(0, {
			intensityTarget: 0.45,
			prasaMaxEditDistance: 2,
			syllables: ['Ta', 'Ka', 'Ju', 'Nu'],
			accents: [0],
			syllableAssembly: {
				subdivNormalization: {
					rawValues: [1, 1, 1, 1],
					normalizedValues: [1, 1, 1, 1],
					invalidOverrideCount: 0,
					clampedOverrideCount: 0,
					allInRange1to9: true,
				},
				deadTail: {
					rawDeadStart: null,
					clampedDeadStart: 4,
					tailCellCount: 0,
					tailSilentByDot: true,
				},
				phraseLenPolicy: {
					localPhraseCells: 0,
					segmentRanges: [{ start: 0, endInclusive: 3, length: 4 }],
					longSegments: [],
				},
				npsKalamBootstrap: {
					cells: [
						{ cellIdx: 0, phraseLen: 4, source: 'sarva_segment', nps: 4, kalam: 'slow' },
						{ cellIdx: 1, phraseLen: 4, source: 'sarva_segment', nps: 4, kalam: 'slow' },
						{ cellIdx: 2, phraseLen: 4, source: 'sarva_segment', nps: 4, kalam: 'slow' },
						{ cellIdx: 3, phraseLen: 4, source: 'sarva_segment', nps: 4, kalam: 'slow' },
					],
				},
				criteria: {
					normalizationContractOk: true,
					deadTailContractOk: true,
					segmentContractOk: true,
				},
			},
		}),
	);
	const json = JSON.parse(logger.formatLessonDebugJson()) as {
		logSchemaVersion: string;
		summary: {
			score: number;
			passRateByFlag: Record<string, number>;
			poetry: { poetryIndex: number; poetryVerdict: string; eduppuLesson: { varietyRatio: number } };
		};
		bars: Array<{
			aestheticDiagnostics?: { flags?: Array<{ code: string; state: string }> };
			syllableAssembly?: {
				criteria?: { normalizationContractOk: boolean; deadTailContractOk: boolean; segmentContractOk: boolean };
			};
		}>;
	};
	assert.equal(json.logSchemaVersion, 'aesthetic-log-v1');
	assert.ok(typeof json.summary.score === 'number');
	assert.ok(typeof json.summary.poetry.poetryIndex === 'number');
	assert.ok(json.summary.poetry.poetryVerdict.length > 0);
	assert.ok(Array.isArray(json.bars[0]?.aestheticDiagnostics?.flags), 'bar flags must exist in debug json');
	assert.equal(json.bars[0]?.syllableAssembly?.criteria?.normalizationContractOk, true);
}

function testBridgeSyncPhaseNotClassifiedAsJati() {
	const verdict = evaluateModeTruth({
		modeTag: 'gati_mode',
		totalCells: 8,
		subdivisionHits: 0,
		maxSubdivision: 1,
		pulseOffsetBeforeBar: 16,
		localJati: 8,
	});
	assert.equal(verdict.resolvedModeTag, 'gati_mode');
	assert.equal(verdict.critical, undefined);
}

function testBridgeDesyncWithRealJatiKeepsTagWithoutCritical() {
	const verdict = evaluateModeTruth({
		modeTag: 'jati_mode',
		totalCells: 7,
		subdivisionHits: 0,
		maxSubdivision: 1,
		pulseOffsetBeforeBar: 15,
		localJati: 7,
	});
	assert.equal(verdict.resolvedModeTag, 'jati_mode');
	assert.equal(verdict.critical, undefined);
}

function testDeclaredBridgeLikeJatiOnTotalCells4IsFlaggedAsFalseJati() {
	const verdict = evaluateModeTruth({
		modeTag: 'jati_mode',
		totalCells: 4,
		subdivisionHits: 0,
		maxSubdivision: 1,
		pulseOffsetBeforeBar: 16,
		localJati: 4,
	});
	assert.equal(verdict.resolvedModeTag, 'gati_mode');
	assert.equal(verdict.critical, 'CRITICAL: False Jati Mapping Detected (ImitationDetected).');
}

function testTrueJatiWithPhysicalCyclePassesWithoutCritical() {
	const verdict = evaluateModeTruth({
		modeTag: 'jati_mode',
		totalCells: 9,
		subdivisionHits: 1,
		maxSubdivision: 2,
		pulseOffsetBeforeBar: 31,
		localJati: 9,
	});
	assert.equal(verdict.resolvedModeTag, 'jati_mode');
	assert.equal(verdict.critical, undefined);
}

function testGatiWithoutJatiEvidenceStaysGati() {
	const verdict = evaluateModeTruth({
		modeTag: 'gati_mode',
		totalCells: 4,
		subdivisionHits: 3,
		maxSubdivision: 8,
		pulseOffsetBeforeBar: 20,
		localJati: 4,
	});
	assert.equal(verdict.resolvedModeTag, 'gati_mode');
	assert.equal(verdict.critical, undefined);
}

function testDeclaredPhysicalJatiMismatchIsCritical() {
	const verdict = evaluateModeTruth({
		modeTag: 'jati_mode',
		totalCells: 7,
		subdivisionHits: 0,
		maxSubdivision: 1,
		pulseOffsetBeforeBar: 23,
		localJati: 5,
	});
	assert.equal(verdict.resolvedModeTag, 'gati_mode');
	assert.equal(verdict.critical, 'CRITICAL: Jati Size Mismatch (declared=5, physical=7).');
}

function testDeclaredPhysicalMismatchInGatiModeIsNotCritical() {
	const verdict = evaluateModeTruth({
		modeTag: 'gati_mode',
		totalCells: 8,
		subdivisionHits: 2,
		maxSubdivision: 3,
		pulseOffsetBeforeBar: 23,
		localJati: 5,
	});
	assert.equal(verdict.resolvedModeTag, 'gati_mode');
	assert.equal(verdict.critical, undefined);
}

function testPhraseAnchorAndSyllableContinuityAlias() {
	const bars: BarLog[] = [
		{ ...makeBar(0), phraseId: 5, phraseStep: 0, syllables: ['Ta', 'Ka', 'Ta', 'Ki'], mutationKind: 'substitution' },
		{ ...makeBar(1), phraseId: 5, phraseStep: 1, syllables: ['Ta', 'Ka', 'Ta', 'Ki'], mutationKind: 'substitution' },
	];
	assert.equal(phraseAnchorBarIndexFromBars(bars, 1), 0);
	const { barsWithDiagnostics } = evaluateAestheticDiagnostics(bars);
	const d = barsWithDiagnostics[1]!.aestheticDiagnostics!;
	assert.ok(d.syllableContinuity);
	assert.deepEqual(d.syllableContinuity, d.sequenceCheck);
	assert.ok(d.prasaAnchor?.ok);
}

function testPrasaAnchorFailsBeyondHalf() {
	const bars: BarLog[] = [
		{
			...makeBar(0),
			phraseId: 2,
			phraseStep: 0,
			syllables: ['Ta', 'Ka', 'Dhi', 'Mi'],
			accents: [0],
			mutationKind: 'substitution',
			prasaMaxEditDistance: 2,
		},
		{
			...makeBar(1),
			phraseId: 2,
			phraseStep: 1,
			syllables: ['Ju', 'Nu', 'Ju', 'Nu'],
			accents: [0],
			mutationKind: 'substitution',
			prasaMaxEditDistance: 2,
		},
	];
	const { barsWithDiagnostics } = evaluateAestheticDiagnostics(bars);
	const prasaFlag = barsWithDiagnostics[1]!.aestheticDiagnostics!.flags.find((f) => f.name === 'prasaContinuity');
	assert.equal(prasaFlag?.state, 'violation');
}

function testShadowBreathPassesWhenCurrentBarStartsWithRest() {
	const bars: BarLog[] = [
		{
			...makeBar(0),
			subdivision: 7,
			syllables: ['Ta', 'Ki', 'Te', 'Ta', 'Ki', 'Te', 'Ta'],
			intensityTarget: 0.7,
			accents: [0, 3, 6],
		},
		{
			...makeBar(1),
			subdivision: 7,
			syllables: ['-', 'Ta', 'Ki', 'Te', 'Ta', 'Ki', 'Te'],
			intensityTarget: 0.7,
			accents: [1, 4, 6],
		},
	];
	const { barsWithDiagnostics } = evaluateAestheticDiagnostics(bars);
	const shadowFlag = barsWithDiagnostics[1]!.aestheticDiagnostics!.flags.find((f) => f.name === 'shadowingBreath');
	assert.equal(shadowFlag?.state, 'pass');
}

function testShiftAccentPassesOnKarvaiWhenPhysicalSamAtZero() {
	const bars: BarLog[] = [
		makeBar(0, {
			deSyncJati: false,
			syllables: ['Ta', 'Ka', 'Dhi', 'Mi'],
			accents: [0, 2],
		}),
		makeBar(1, {
			deSyncJati: true,
			syllables: ['-', '-', '-', '-'],
			accents: [0],
		}),
	];
	const { barsWithDiagnostics } = evaluateAestheticDiagnostics(bars);
	const shiftFlag = barsWithDiagnostics[1]!.aestheticDiagnostics!.flags.find((f) => f.name === 'shiftAccent');
	assert.equal(shiftFlag?.code, 'SHIFT_ACCENT_OK');
	assert.equal(shiftFlag?.state, 'pass');
}

function testShiftAccentFailsWhenPhysicalSamMissingOnShift() {
	const bars: BarLog[] = [
		makeBar(0, {
			deSyncJati: false,
			syllables: ['Ta', 'Ka', 'Dhi', 'Mi'],
			accents: [0, 2],
		}),
		makeBar(1, {
			deSyncJati: true,
			syllables: ['Ta', 'Ka', 'Dhi', 'Mi'],
			accents: [1],
		}),
	];
	const { barsWithDiagnostics } = evaluateAestheticDiagnostics(bars);
	const shiftFlag = barsWithDiagnostics[1]!.aestheticDiagnostics!.flags.find((f) => f.name === 'shiftAccent');
	assert.equal(shiftFlag?.code, 'SHIFT_FLAT');
	assert.equal(shiftFlag?.state, 'violation');
}

function testTihaiAuditBlockIsPresentInTextAndJson() {
	const logger = new LessonLogger();
	logger.reset({
		seed: 21,
		chaos: 15,
		parentThemeLine: 'Ta Ka Dhi Mi',
		formPresetLabel: 'Tihay',
		formPresetId: 'tihai_heavy',
		randomMode: 'parent',
		barCount: 4,
	});
	logger.addBar(
		makeBar(0, {
			phraseId: 100,
			phraseStep: 0,
			isTihaiPart: true,
			mutationKind: 'tihai',
			syllables: ['Ta', 'Ka', 'Dhi', 'Mi'],
			accents: [0, 3],
			prasaMaxEditDistance: 2,
		}),
	);
	logger.addBar(
		makeBar(1, {
			phraseId: 100,
			phraseStep: 1,
			isTihaiPart: true,
			mutationKind: 'tihai',
			syllables: ['Ta', 'Ka', 'Dhi', 'Mi'],
			accents: [0, 3],
			prasaMaxEditDistance: 2,
		}),
	);
	logger.addBar(
		makeBar(2, {
			phraseId: 100,
			phraseStep: 2,
			isTihaiPart: true,
			mutationKind: 'tihai',
			syllables: ['Ta', 'Ka', 'Dhi', 'Mi'],
			accents: [0, 3],
			prasaMaxEditDistance: 2,
		}),
	);
	logger.addBar(
		makeBar(3, {
			phraseId: 100,
			phraseStep: 3,
			isTihaiPart: true,
			mutationKind: 'tihai',
			syllables: ['Ta', 'Ta', 'Ta', 'Thom'],
			accents: [3],
			prasaMaxEditDistance: 2,
		}),
	);
	const text = logger.formatLessonLogText();
	assert.ok(text.includes('Tihai-audit:'), 'text log must include tihai audit section');
	assert.ok(text.includes('Aesthetic Score:'), 'text log must include tihai aesthetic score');
	assert.ok(text.includes('Critical Errors:'), 'text log must include tihai critical errors line');
	assert.ok(text.includes('Verdict:'), 'text log must include tihai verdict line');
	const json = JSON.parse(logger.formatLessonDebugJson()) as {
		summary?: {
			tihaiAudit?: {
				aestheticScore?: number;
				criticalErrors?: string[];
				verdict?: string;
			};
		};
	};
	assert.ok(typeof json.summary?.tihaiAudit?.aestheticScore === 'number');
	assert.ok(Array.isArray(json.summary?.tihaiAudit?.criticalErrors));
	assert.ok(
		json.summary?.tihaiAudit?.verdict === 'Музыка' || json.summary?.tihaiAudit?.verdict === 'Расчет',
		'tihai verdict must be present in debug json',
	);
}

testEnglishHeaderAndGrid();
testPulseOffsetPreserved();
testMarkersArudiMuktayiPulseShiftPresent();
testProfileAndCadenceFieldsAreRendered();
testAestheticSummaryAndFlagsAreRendered();
testLessonDebugJsonHasSchemaAndBarFlags();
testBridgeSyncPhaseNotClassifiedAsJati();
testBridgeDesyncWithRealJatiKeepsTagWithoutCritical();
testDeclaredBridgeLikeJatiOnTotalCells4IsFlaggedAsFalseJati();
testTrueJatiWithPhysicalCyclePassesWithoutCritical();
testGatiWithoutJatiEvidenceStaysGati();
testDeclaredPhysicalJatiMismatchIsCritical();
testDeclaredPhysicalMismatchInGatiModeIsNotCritical();
testPhraseAnchorAndSyllableContinuityAlias();
testPrasaAnchorFailsBeyondHalf();
testShadowBreathPassesWhenCurrentBarStartsWithRest();
testShiftAccentPassesOnKarvaiWhenPhysicalSamAtZero();
testShiftAccentFailsWhenPhysicalSamMissingOnShift();
testTihaiAuditBlockIsPresentInTextAndJson();
console.log('lessonLogger.test.ts: ok');
