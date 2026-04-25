import assert from 'node:assert/strict';
import { LessonLogger, evaluateModeTruth, type BarLog } from './lessonLogger';

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
			syllables: ['Ta', 'Ki', 'Te', 'Thom'],
			accents: [3],
		}),
	);
	const text = logger.formatLessonLogText();
	assert.ok(text.includes('Profile: tandava'), 'profile field must be rendered');
	assert.ok(text.includes('Cadence: phrase_cadence'), 'cadence reason must be rendered');
	assert.ok(text.includes('PrasaMaxEdit: 3'), 'prasa max edit distance must be rendered');
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

testEnglishHeaderAndGrid();
testPulseOffsetPreserved();
testMarkersArudiMuktayiPulseShiftPresent();
testProfileAndCadenceFieldsAreRendered();
testBridgeSyncPhaseNotClassifiedAsJati();
testBridgeDesyncWithRealJatiKeepsTagWithoutCritical();
testDeclaredBridgeLikeJatiOnTotalCells4IsFlaggedAsFalseJati();
testTrueJatiWithPhysicalCyclePassesWithoutCritical();
testGatiWithoutJatiEvidenceStaysGati();
testDeclaredPhysicalJatiMismatchIsCritical();
console.log('lessonLogger.test.ts: ok');
