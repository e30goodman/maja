/**
 * Запуск: `npx tsx src/midiExport.test.ts` из каталога konnakol_trainer.
 */
import assert from 'node:assert/strict';
import {
	classifyGridCellHits,
	computeVelocity,
	generateMidi,
	mulberry32,
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
	assert.equal(vAcc, 115);
	const v0 = computeVelocity('accent', 0, true, true, 'Ta', false, mulberry32(2));
	assert.equal(v0, 127);
	const vPass = computeVelocity('passive', 2, false, false, 'Ka', false, mulberry32(3));
	assert.equal(vPass, 80);
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
		playbackMode: 'all_beats',
		muteMode: 'off',
		dictantActive: false,
	});
	assert.equal(hits.taHigh, true);
	assert.equal(hits.accent, true);
	assert.equal(hits.altShadow, false);
	assert.equal(hits.passive, false);
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
		playbackMode: 'all_beats',
		muteMode: 'off',
		dictantActive: false,
	});
	assert.equal(hits.taHigh, false);
	assert.equal(hits.accent, true);
	assert.equal(hits.altShadow, true);
	assert.equal(hits.passive, false);
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
		playbackMode: 'all_beats',
		muteMode: 'off',
		dictantActive: false,
	});
	assert.deepEqual(hits, { taHigh: false, accent: false, altShadow: false, passive: false });
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

function run() {
	testSyllableToDrumNote();
	testComputeVelocity();
	testTicksPerCell();
	testClassifyAccentPlusTaDing();
	testClassifyAccentShadow();
	testClassifyPolyDedup();
	testBuildLaneBarIndices();
	testGenerateMidiSmoke();
	console.log('midiExport.test.ts: all passed');
}

run();
