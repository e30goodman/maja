/**
 * Run: `npx tsx scripts/snapshot-roundtrip-loop.test.ts`
 */
import assert from 'node:assert/strict';
import { buildRoundtripSnapshot, parseSnapshot, type MidiAnalysis } from './snapshot-roundtrip-loop';

function makeAnalysis(overrides: Partial<MidiAnalysis> = {}): MidiAnalysis {
  return {
    bpm: 133,
    onsets: 10,
    lastOnsetMs: 1200,
    inferredBars: 9,
    inferredSyllables: 7,
    inferredInstrumentCount: 1,
    inferredPolyRhythm: false,
    averageVelocityMidi: 90,
    derivedNonNoteGainToken: 'e:201',
    noteTruth: {
      strictExpectedEvents: 0,
      strictActualEvents: 0,
      strictMismatches: 0,
      strictExactMatch: true,
      expectedEvents: 0,
      actualNoteOns: 0,
      mismatches: 0,
      exactMatch: true,
      velocityMismatches: 0,
      velocityExactMatch: true,
    },
    ...overrides,
  };
}

function testTempoBarsAlwaysDerivedEvenForPackedGrid() {
  const source = parseSnapshot('(⁠ʘ⁠ᴗ⁠ʘ⁠)⁠♪:240.64.4.p3AAAA.e:1.45.446.9');
  const analyzed = makeAnalysis({ bpm: 101, inferredBars: 5, inferredSyllables: 3 });
  const out = buildRoundtripSnapshot(source, analyzed, 'p4DERIVEDGRID');
  const body = out.replace('(⁠ʘ⁠ᴗ⁠ʘ⁠)⁠♪:', '');
  const parts = body.split('.');
  assert.equal(parts[0], '101', 'tempo must come from analyzed bpm');
  assert.equal(parts[1], '5', 'bars must come from analyzed inferredBars');
  assert.equal(parts[2], '3', 'syllables must come from analyzed inferredSyllables');
}

function testLegacy11PartUsesDerivedGridAndDead() {
  const source = parseSnapshot('(⁠ʘ⁠ᴗ⁠ʘ⁠)⁠♪:240.64.4.p3SOURCEGRID.e:7.A.B.C.45.446.9');
  const analyzed = makeAnalysis({ derivedNonNoteGainToken: 'e:222' });
  const out = buildRoundtripSnapshot(source, analyzed, 'p4DERIVEDGRID');
  const body = out.replace('(⁠ʘ⁠ᴗ⁠ʘ⁠)⁠♪:', '');
  const parts = body.split('.');
  assert.equal(parts.length, 11, '11-part shape must be preserved');
  assert.equal(parts[3], 'p4DERIVEDGRID', 'grid token must be derived, not copied');
  assert.equal(parts[4], 'e:222', 'dead token must be derived for e:* input');
  assert.notEqual(parts[3], 'p3SOURCEGRID', 'restoring grid linkage is forbidden');
  assert.notEqual(parts[4], 'e:7', 'restoring dead linkage is forbidden');
}

function run() {
  testTempoBarsAlwaysDerivedEvenForPackedGrid();
  testLegacy11PartUsesDerivedGridAndDead();
  console.log('snapshot-roundtrip-loop.test.ts: all passed');
}

run();
