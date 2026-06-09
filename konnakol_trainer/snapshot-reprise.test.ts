import assert from 'node:assert/strict';
import {
	createEmptySnapshotForTest,
	decodeSnapshotClipboardForReport,
	encodeSnapshotClipboardForTest,
} from './src/App';

function testBarRepriseCountsRoundtripInCompactClipboard(): void {
	const snap = createEmptySnapshotForTest();
	snap.bars = 4;
	snap.customMultipliers = { 0: 2, 2: 4 };
	snap.barRepriseCounts = { 0: 4, 1: 2 };

	const encoded = encodeSnapshotClipboardForTest(snap);
	const decoded = decodeSnapshotClipboardForReport(encoded);
	assert.ok(decoded, 'compact snapshot must decode');

	assert.deepEqual(decoded!.customMultipliers, { 0: 2, 2: 4 });
	assert.deepEqual(decoded!.barRepriseCounts, { 0: 4, 1: 2 });
}

function testDefaultRepriseIsR2WithoutSparseEntry(): void {
	const snap = createEmptySnapshotForTest();
	snap.customMultipliers = { 1: 2 };
	snap.barRepriseCounts = {};

	const decoded = decodeSnapshotClipboardForReport(encodeSnapshotClipboardForTest(snap));
	assert.ok(decoded);
	assert.deepEqual(decoded!.customMultipliers, { 1: 2 });
	assert.deepEqual(decoded!.barRepriseCounts, {});
}

function run(): void {
	testBarRepriseCountsRoundtripInCompactClipboard();
	testDefaultRepriseIsR2WithoutSparseEntry();
	console.log('snapshot-reprise.test.ts: all passed');
}

run();
