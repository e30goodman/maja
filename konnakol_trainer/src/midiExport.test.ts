/**
 * Run: `npx tsx src/midiExport.test.ts` from the `konnakol_trainer` directory.
 */
import assert from 'node:assert/strict';
import {
	buildWriterEvents,
	buildMidiParityEvents,
	classifyGridCellHits,
	computeVelocity,
	generateMidi,
	mulberry32,
	resolveFirstBeatHitRow,
	resolveMidiNoteForLaneRole,
	syllableToDrumNote,
	ticksPerCellFromRow,
} from './midiExport';
import { buildLaneBarIndices } from './polySubLegacyScheduler';

function testSyllableToDrumNote() {
	assert.equal(syllableToDrumNote('Ta'), 38);
	assert.equal(syllableToDrumNote('DHI'), 38);
	assert.equal(syllableToDrumNote('tha'), 38);
	assert.equal(syllableToDrumNote('Ka'), 42);
	assert.equal(syllableToDrumNote('ki'), 42);
	assert.equal(syllableToDrumNote('Thom'), 41);
	assert.equal(syllableToDrumNote('NUM'), 41);
	assert.equal(syllableToDrumNote('Mi'), 37);
	assert.equal(syllableToDrumNote('Ju'), 37);
}

function testComputeVelocity() {
	const rng = mulberry32(1);
	const vAcc = computeVelocity('accent', 1, true, false, 'Ta', false, rng);
	assert.equal(vAcc, 120);
	const v0 = computeVelocity('accent', 0, true, true, 'Ta', false, mulberry32(2));
	assert.equal(v0, 120);
	const vPass = computeVelocity('passive', 2, false, false, 'Ka', false, mulberry32(3));
	assert.equal(vPass, 70);
}

function testTicksPerCell() {
	const ppq = 960;
	const t1 = ticksPerCellFromRow(120, 0, 4, {}, undefined, undefined, ppq);
	assert.equal(t1, ppq);
	const t2 = ticksPerCellFromRow(
		120,
		0,
		4,
		{},
		{ 0: true },
		undefined,
		ppq,
	);
	assert.ok(Math.abs(t2 - (ppq * 120) / (120 * (4 / 4))) < 1e-6);
	const t3 = ticksPerCellFromRow(120, 0, 4, {}, undefined, { 0: 2 }, ppq);
	assert.ok(Math.abs(t3 - (ppq * 120) / (120 * 2)) < 1e-6);
}

function testClassifyAccentPlusTaDing() {
	const slots = new Set<string>();
	const hits = classifyGridCellHits({
		rowIdx: 0,
		colIdx: 2,
		subdivs: 1,
		isAccent: true,
		taDingKeys: new Set(['0-2']),
		accents: new Set(['0-2']),
		firstBeatAccent: true,
		suppressedRow: false,
		polyMode: false,
		polyDedupKey: 'x',
		polyClickSlots: slots,
		mixerLayerMode: 'full_mix',
		trainerMode: 'normal',
		muteMode: 'off',
		dictantActive: false,
	});
	assert.equal(hits.taHigh, true);
	assert.equal(hits.accent, true);
	assert.equal(hits.altShadow, false);
	assert.equal(hits.passive, true);
}

function testClassifyAccentShadow() {
	const slots = new Set<string>();
	const hits = classifyGridCellHits({
		rowIdx: 0,
		colIdx: 2,
		subdivs: 1,
		isAccent: true,
		taDingKeys: new Set<string>(),
		accents: new Set(['0-2']),
		firstBeatAccent: true,
		suppressedRow: false,
		polyMode: false,
		polyDedupKey: 'x',
		polyClickSlots: slots,
		mixerLayerMode: 'full_mix',
		trainerMode: 'normal',
		muteMode: 'off',
		dictantActive: false,
	});
	assert.equal(hits.taHigh, false);
	assert.equal(hits.accent, true);
	assert.equal(hits.altShadow, true);
	assert.equal(hits.passive, true);
}

function testClassifyPolyDedup() {
	const key = '0:0:1000000';
	const slots = new Set<string>([key]);
	const hits = classifyGridCellHits({
		rowIdx: 0,
		colIdx: 0,
		subdivs: 1,
		isAccent: false,
		taDingKeys: new Set<string>(),
		accents: new Set<string>(),
		firstBeatAccent: false,
		suppressedRow: false,
		polyMode: true,
		polyDedupKey: key,
		polyClickSlots: slots,
		mixerLayerMode: 'full_mix',
		trainerMode: 'normal',
		muteMode: 'off',
		dictantActive: false,
	});
	assert.deepEqual(hits, { taHigh: false, accent: false, altShadow: false, passive: false });
}

function testClassifyPolyFirstBeatSafeNoBleed() {
	const hits = classifyGridCellHits({
		rowIdx: 1,
		colIdx: 0,
		subdivs: 1,
		isAccent: false,
		taDingKeys: new Set<string>(),
		accents: new Set<string>(),
		firstBeatAccent: true,
		suppressedRow: false,
		polyMode: true,
		polyDedupKey: '1:1:0',
		polyClickSlots: new Set<string>(),
		mixerLayerMode: 'full_mix',
		trainerMode: 'normal',
		muteMode: 'off',
		dictantActive: false,
		firstBeatRequiresExplicitMark: true,
	});
	assert.equal(hits.taHigh, false);
}

function testClassifyPolyLane1AccentOnlyNoTa() {
	const hits = classifyGridCellHits({
		rowIdx: 1,
		colIdx: 0,
		subdivs: 1,
		isAccent: true,
		taDingKeys: new Set<string>(),
		accents: new Set(['1-0']),
		firstBeatAccent: true,
		suppressedRow: false,
		polyMode: true,
		polyDedupKey: '1:0',
		polyClickSlots: new Set<string>(),
		mixerLayerMode: 'full_mix',
		trainerMode: 'normal',
		muteMode: 'off',
		dictantActive: false,
		firstBeatHitPolicy: 'explicit_ta_only',
	});
	assert.equal(hits.taHigh, false);
	assert.equal(hits.accent, true);
}

function testClassifyLane0LegacyDefaultFirstBeat() {
	const hits = classifyGridCellHits({
		rowIdx: 0,
		colIdx: 0,
		subdivs: 1,
		isAccent: false,
		taDingKeys: new Set<string>(),
		accents: new Set<string>(),
		firstBeatAccent: true,
		suppressedRow: false,
		polyMode: true,
		polyDedupKey: '0:0',
		polyClickSlots: new Set<string>(),
		mixerLayerMode: 'full_mix',
		trainerMode: 'normal',
		muteMode: 'off',
		dictantActive: false,
		firstBeatHitPolicy: 'legacy',
	});
	assert.equal(hits.taHigh, true);
	assert.equal(hits.altShadow, false);
}

function testClassifyFirstBeatTaNeverAltShadow() {
	const hits = classifyGridCellHits({
		rowIdx: 0,
		colIdx: 0,
		subdivs: 1,
		isAccent: true,
		taDingKeys: new Set<string>(),
		accents: new Set(['0-0']),
		firstBeatAccent: true,
		suppressedRow: false,
		polyMode: false,
		polyDedupKey: '0:0:ta',
		polyClickSlots: new Set<string>(),
		mixerLayerMode: 'full_mix',
		trainerMode: 'normal',
		muteMode: 'off',
		dictantActive: false,
		firstBeatHitPolicy: 'legacy',
	});
	assert.equal(hits.taHigh, true);
	assert.equal(hits.altShadow, false);
}

function testFirstBeatPolicyParityRuntimeVsMidi() {
	assert.equal(resolveFirstBeatHitRow('legacy', false, false, true, false), true);
	/* Suppressed row: plain 0-accent must not trigger Ta hit. */
	assert.equal(resolveFirstBeatHitRow('legacy', true, false, true, true), false);
	assert.equal(resolveFirstBeatHitRow('legacy', false, true, true, true), true);
	assert.equal(resolveFirstBeatHitRow('explicit_ta_only', true, false, true, false), false);
	assert.equal(resolveFirstBeatHitRow('explicit_ta_only', false, true, true, true), true);
}

function testBuildLaneBarIndices() {
	assert.deepEqual(buildLaneBarIndices(4, 2), [
		[0, 2],
		[1, 3],
	]);
	assert.deepEqual(buildLaneBarIndices(6, 3), [
		[0, 3],
		[1, 4],
		[2, 5],
	]);
}

function testGenerateMidiSmoke() {
	const bytes = generateMidi({
		bpm: 120,
		bars: 1,
		baseSyllables: 4,
		customSyllables: {},
		customSubdivisions: {},
		accents: new Set<string>(),
		taDingKeys: new Set<string>(),
		firstBeatAccent: false,
		firstBeatDingSuppressedRows: new Set<number>(),
		deadCells: {},
		polyMode: false,
		polyVoices: 2,
		humanize: false,
		seed: 42,
		ppq: 960,
		maxNoteEvents: 500,
		maxWallSeconds: 10,
		patternRevolutions: 1,
	});
	assert.ok(bytes.length > 40);
	assert.equal(bytes[0], 0x4d);
	assert.equal(bytes[1], 0x54);
	assert.equal(bytes[2], 0x68);
	assert.equal(bytes[3], 0x64);
}

function testParityNoAltOnFirstBeatTaCell() {
	const { events } = buildMidiParityEvents({
		bpm: 100,
		bars: 1,
		baseSyllables: 4,
		customSyllables: {},
		customSubdivisions: {},
		accents: new Set<string>(),
		taDingKeys: new Set<string>(),
		firstBeatAccent: true,
		firstBeatDingSuppressedRows: new Set<number>(),
		deadCells: {},
		polyMode: false,
		polyVoices: 2,
		humanize: false,
		seed: 1,
		ppq: 960,
	});
	const taCellEvents = events.filter((e) => e.row === 1 && e.cell === 1);
	assert.ok(taCellEvents.some((e) => e.role === 'taHigh'));
	assert.ok(!taCellEvents.some((e) => e.role === 'alt'));
}

function testParityNoAltOnExplicitTaDingCell() {
	const { events } = buildMidiParityEvents({
		bpm: 100,
		bars: 1,
		baseSyllables: 4,
		customSyllables: {},
		customSubdivisions: {},
		accents: new Set<string>(['0-2']),
		taDingKeys: new Set<string>(['0-2']),
		firstBeatAccent: true,
		firstBeatDingSuppressedRows: new Set<number>(),
		deadCells: {},
		polyMode: false,
		polyVoices: 2,
		humanize: false,
		seed: 1,
		ppq: 960,
	});
	const taDingCellEvents = events.filter((e) => e.row === 1 && e.cell === 3);
	assert.ok(taDingCellEvents.some((e) => e.role === 'taHigh'));
	assert.ok(!taDingCellEvents.some((e) => e.role === 'alt'));
}

function testLaneRoleMidiNotes() {
	assert.equal(resolveMidiNoteForLaneRole(0, 'accent'), 36); // V1 C1 bass drum (GM)
	assert.equal(resolveMidiNoteForLaneRole(0, 'alt'), 38); // V1 D1 acoustic snare (GM)
	assert.equal(resolveMidiNoteForLaneRole(0, 'passive'), 42); // V1 F#1 closed HH (GM)
	assert.equal(resolveMidiNoteForLaneRole(1, 'accent'), 47); // V2 low-mid tom (GM)
	assert.equal(resolveMidiNoteForLaneRole(1, 'alt'), 39); // V2 hand clap (GM)
	assert.equal(resolveMidiNoteForLaneRole(1, 'passive'), 37); // V2 side stick (GM)
	assert.equal(resolveMidiNoteForLaneRole(2, 'accent'), 29); // V3 F1
	assert.equal(resolveMidiNoteForLaneRole(2, 'alt'), 53); // V3 ride bell (GM)
	assert.equal(resolveMidiNoteForLaneRole(2, 'passive'), 76); // V3 high wood block (GM)
	assert.equal(resolveMidiNoteForLaneRole(1, 'taHigh'), 29); // V2 F1
}

function testFirstSubstepMaskBlocksPrimaryHits() {
	const { events } = buildMidiParityEvents({
		bpm: 100,
		bars: 1,
		baseSyllables: 4,
		customSyllables: {},
		customSubdivisions: { '0-0': 2 },
		cellStepMasks: { '0-0': [false, true] },
		accents: new Set<string>(['0-0']),
		taDingKeys: new Set<string>(['0-0']),
		firstBeatAccent: true,
		firstBeatDingSuppressedRows: new Set<number>(),
		deadCells: {},
		polyMode: false,
		polyVoices: 2,
		humanize: false,
		seed: 1,
		ppq: 960,
	});
	const cellEvents = events.filter((e) => e.row === 1 && e.cell === 1);
	assert.equal(cellEvents.some((e) => e.role === 'taHigh' || e.role === 'accent'), false);
}

function testBuildWriterEventsStrictOrderAndOffEvents() {
	const { events } = buildWriterEvents({
		bpm: 120,
		bars: 1,
		baseSyllables: 4,
		customSyllables: {},
		customSubdivisions: {},
		accents: new Set<string>(['0-0']),
		taDingKeys: new Set<string>(),
		firstBeatAccent: false,
		firstBeatDingSuppressedRows: new Set<number>(),
		deadCells: {},
		polyMode: false,
		polyVoices: 2,
		humanize: false,
		seed: 1,
		ppq: 960,
		maxNoteEvents: 1000,
		maxWallSeconds: 30,
		patternRevolutions: 1,
	});
	assert.ok(events.length > 6);
	assert.equal(events[0]?.type, 'cc10');
	const noteOnIdx = events.findIndex((e) => e.type === 'noteOn');
	const noteOffIdx = events.findIndex((e) => e.type === 'noteOff');
	assert.ok(noteOnIdx >= 0 && noteOffIdx > noteOnIdx);
	assert.equal(events.every((e, idx) => e.order === idx), true);
}

function testMonoRegressionSmoke() {
	const bytes = generateMidi({
		bpm: 120,
		bars: 2,
		baseSyllables: 4,
		customSyllables: {},
		customSubdivisions: { '0-1': 2 },
		accents: new Set<string>(['0-0', '1-2']),
		taDingKeys: new Set<string>(['1-0']),
		firstBeatAccent: true,
		firstBeatDingSuppressedRows: new Set<number>(),
		deadCells: {},
		polyMode: false,
		polyVoices: 2,
		humanize: false,
		seed: 123,
		ppq: 960,
		maxNoteEvents: 1000,
		maxWallSeconds: 30,
		patternRevolutions: 1,
	});
	assert.ok(bytes.length > 100);
}

function run() {
	testSyllableToDrumNote();
	testComputeVelocity();
	testTicksPerCell();
	testClassifyAccentPlusTaDing();
	testClassifyAccentShadow();
	testClassifyPolyDedup();
	testClassifyPolyFirstBeatSafeNoBleed();
	testClassifyPolyLane1AccentOnlyNoTa();
	testClassifyLane0LegacyDefaultFirstBeat();
	testClassifyFirstBeatTaNeverAltShadow();
	testFirstBeatPolicyParityRuntimeVsMidi();
	testBuildLaneBarIndices();
	testGenerateMidiSmoke();
	testParityNoAltOnFirstBeatTaCell();
	testParityNoAltOnExplicitTaDingCell();
	testLaneRoleMidiNotes();
	testFirstSubstepMaskBlocksPrimaryHits();
	testBuildWriterEventsStrictOrderAndOffEvents();
	testMonoRegressionSmoke();
	console.log('midiExport.test.ts: all passed');
}

run();
