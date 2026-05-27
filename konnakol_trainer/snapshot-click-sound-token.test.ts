import assert from 'node:assert/strict';
import {
	decodeSnapshotSoundTokenForTest,
	encodeSnapshotSoundTokenForTest,
	pinInheritedPolyClickVoicesBeforeMasterChangeForTest,
} from './src/App';

function testRoundtripPolyVoiceSoundMap(): void {
	const token = encodeSnapshotSoundTokenForTest('modern_daw', {
		1: 'standard',
		2: 'woodblock',
	});
	const decoded = decodeSnapshotSoundTokenForTest(token);
	assert.equal(decoded.clickSound, 'modern_daw');
	assert.deepEqual(decoded.clickSoundByPolyVoice, {
		1: 'standard',
		2: 'woodblock',
	});
}

function testBackwardCompatibleNumericToken(): void {
	const decoded = decodeSnapshotSoundTokenForTest('3');
	assert.equal(decoded.clickSound, 'modern_daw');
	assert.deepEqual(decoded.clickSoundByPolyVoice, {});
}

function testPinInheritedPolyVoicesBeforeMasterChange(): void {
	const pinned = pinInheritedPolyClickVoicesBeforeMasterChangeForTest(
		{},
		'classic',
		'oldschool',
		2,
	);
	assert.deepEqual(pinned, { 1: 'classic' });
	const keepExplicit = pinInheritedPolyClickVoicesBeforeMasterChangeForTest(
		{ 1: 'woodblock' },
		'classic',
		'oldschool',
		2,
	);
	assert.deepEqual(keepExplicit, { 1: 'woodblock' });
	assert.deepEqual(
		pinInheritedPolyClickVoicesBeforeMasterChangeForTest({}, 'classic', 'classic', 2),
		{},
	);
}

function run(): void {
	testRoundtripPolyVoiceSoundMap();
	testBackwardCompatibleNumericToken();
	testPinInheritedPolyVoicesBeforeMasterChange();
	console.log('snapshot-click-sound-token.test.ts: all passed');
}

run();
