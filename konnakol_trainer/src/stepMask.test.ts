import assert from 'node:assert/strict';
import {
	applyCellIntentToConfig,
	buildCellConfigsFromLegacy,
	ensureCellConfig,
	getRowDataHash,
	splitCellConfigsToLegacy,
	type CellConfig,
} from './stepMask';

function testRowHashChangesForCell2() {
	const customSubdivs = { '0-0': 1, '0-1': 1, '0-2': 1 };
	const baseMasks = {};
	const hashA = getRowDataHash(0, 3, customSubdivs, baseMasks);
	const hashB = getRowDataHash(0, 3, customSubdivs, { '0-2': [false] });
	assert.notEqual(hashA, hashB, 'row hash must change when Cell 2 mask changes');
}

function testSliderToZeroKeepsSubdivs() {
	const base: CellConfig = { subdivs: 4, mask: [true, true, true, true], isMuted: false };
	const next = applyCellIntentToConfig(base, { type: 'SLIDER_TO_ZERO' });
	assert.equal(next.subdivs, 4);
	assert.equal(next.isMuted, true);
	assert.deepEqual(next.mask, [false, false, false, false]);
}

function testLongPressUnmutesMutedCell() {
	const base: CellConfig = { subdivs: 4, mask: [false, false, false, false], isMuted: true };
	const next = applyCellIntentToConfig(base, { type: 'LONG_PRESS', nextSubdivs: 3 });
	assert.equal(next.subdivs, 3);
	assert.equal(next.isMuted, false);
	assert.deepEqual(next.mask, [true, true, true]);
}

function testEnsureCellConfigReadsLegacyMute() {
	const cfg = ensureCellConfig('0-0', 2, undefined, { '0-0': [false, false] });
	assert.equal(cfg.isMuted, true);
	assert.deepEqual(cfg.mask, [false, false]);
}

function testSnapshotLikeRoundtripPreservesZeroDivsMute() {
	// Snapshot-like storage: no custom subdiv entry + all-false mask means "Divs=0" (muted).
	const fromSnapshotSubdivs: Record<string, number> = {};
	const fromSnapshotMasks = { '0-0': [false] };
	const configs = buildCellConfigsFromLegacy(fromSnapshotSubdivs, fromSnapshotMasks);
	const cfg = ensureCellConfig('0-0', 1, configs, fromSnapshotMasks);
	assert.equal(cfg.subdivs, 1);
	assert.equal(cfg.isMuted, true);
	assert.deepEqual(cfg.mask, [false]);

	// Save back to legacy snapshot maps must keep mute semantics.
	const legacy = splitCellConfigsToLegacy(configs);
	assert.equal(legacy.customSubdivs['0-0'], undefined);
	assert.deepEqual(legacy.cellStepMasks['0-0'], [false]);
}

function testShortFalseMaskDoesNotUnmuteWhenSubdivsGrow() {
	// Legacy/clipboard data may contain short all-false masks (e.g. [false]) with subdivs > 1.
	// Contract: cell must stay fully muted after normalization.
	const cfg = ensureCellConfig('0-0', 2, undefined, { '0-0': [false] });
	assert.equal(cfg.subdivs, 2);
	assert.equal(cfg.isMuted, true);
	assert.deepEqual(cfg.mask, [false, false]);
}

testRowHashChangesForCell2();
testSliderToZeroKeepsSubdivs();
testLongPressUnmutesMutedCell();
testEnsureCellConfigReadsLegacyMute();
testSnapshotLikeRoundtripPreservesZeroDivsMute();
testShortFalseMaskDoesNotUnmuteWhenSubdivsGrow();
console.log('stepMask.test.ts: ok');
