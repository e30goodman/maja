/**
 * Run: `npx tsx src/playheadTypes.test.ts`
 */
import assert from 'node:assert/strict';
import { playheadActiveSignature, type PlayheadPosition } from './playheadTypes';

function testPlayheadActiveSignature() {
	const a: PlayheadPosition[] = [
		{ voice: 0, r: 0, c: 1, absR: 0, step: 0 },
		{ voice: 1, r: 1, c: 0, absR: 1, step: 0 },
	];
	assert.equal(playheadActiveSignature(a), '0:0:1:0|1:1:0:0');
}

testPlayheadActiveSignature();
console.log('playheadTypes.test.ts: ok');
