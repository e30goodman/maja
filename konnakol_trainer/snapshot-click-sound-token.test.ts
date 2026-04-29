import assert from 'node:assert/strict';
import {
	decodeSnapshotSoundTokenForTest,
	encodeSnapshotSoundTokenForTest,
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

function run(): void {
	testRoundtripPolyVoiceSoundMap();
	testBackwardCompatibleNumericToken();
	console.log('snapshot-click-sound-token.test.ts: all passed');
}

run();
