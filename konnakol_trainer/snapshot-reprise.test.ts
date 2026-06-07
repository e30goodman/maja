import assert from 'node:assert/strict';
import {
	createEmptySnapshotForTest,
	decodeSnapshotClipboardForReport,
	encodeSnapshotClipboardForTest,
} from './src/App';

function testRepriseDisabledRowsRoundtripInCompactClipboard(): void {
	const snap = createEmptySnapshotForTest();
	snap.bars = 4;
	snap.customMultipliers = { 0: 2, 2: 4 };
	snap.repriseDisabledRows = { 0: true, 1: true };

	const encoded = encodeSnapshotClipboardForTest(snap);
	const decoded = decodeSnapshotClipboardForReport(encoded);
	assert.ok(decoded, 'compact snapshot must decode');

	assert.deepEqual(decoded!.customMultipliers, { 0: 2, 2: 4 });
	assert.deepEqual(decoded!.repriseDisabledRows, { 0: true, 1: true });
}

function testActiveRepriseNeedsNoDisabledRowsEntry(): void {
	const snap = createEmptySnapshotForTest();
	snap.customMultipliers = { 1: 2 };
	snap.repriseDisabledRows = {};

	const decoded = decodeSnapshotClipboardForReport(encodeSnapshotClipboardForTest(snap));
	assert.ok(decoded);
	assert.deepEqual(decoded!.customMultipliers, { 1: 2 });
	assert.deepEqual(decoded!.repriseDisabledRows, {});
}

function run(): void {
	testRepriseDisabledRowsRoundtripInCompactClipboard();
	testActiveRepriseNeedsNoDisabledRowsEntry();
	console.log('snapshot-reprise.test.ts: all passed');
}

run();
