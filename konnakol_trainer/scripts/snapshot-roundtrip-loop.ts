import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWriterEvents, generateMidi, type MidiExportInput, type MidiWriterEvent } from '../src/midiExport';

type CompactSnapshot = {
  marker: string;
  sourcePrefix: string;
  partCount: 7 | 8 | 11;
  tempo: number;
  bars: number;
  syllables: number;
  gridToken: string;
  deadToken: string;
  chaosRaw: string;
  flagsRaw: string;
  soundRaw: string;
  rawBody: string;
  normalized: string;
};

type MidiAnalysis = {
  bpm: number;
  onsets: number;
  lastOnsetMs: number;
  inferredBars: number;
  inferredSyllables: number;
  inferredInstrumentCount: number;
  inferredPolyRhythm: boolean;
  averageVelocityMidi: number;
  derivedNonNoteGainToken: string;
  noteTruth: {
    strictExpectedEvents: number;
    strictActualEvents: number;
    strictMismatches: number;
    strictExactMatch: boolean;
    strictFirstMismatch?: string;
    expectedEvents: number;
    actualNoteOns: number;
    mismatches: number;
    firstMismatch?: string;
    exactMatch: boolean;
    velocityMismatches: number;
    firstVelocityMismatch?: string;
    velocityExactMatch: boolean;
    debugExpectedHead?: string[];
    debugParsedHead?: string[];
  };
};

type DeadCellMeta = {
  deadStart: number;
  displayLen: number;
  baseLen: number;
};

const MARKER = '(⁠ʘ⁠ᴗ⁠ʘ⁠)⁠♪:';
const LEGACY_COMPACT_PREFIX = 'METRONOME_CONFIG:';
const GAIN_CC_MSB = 20;
const GAIN_CC_LSB = 21;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const defaultOutDir = path.join(projectRoot, 'logs', 'snapshot-roundtrip-loop');
const SNAPSHOT_FLAG_FIRST_BEAT_ACCENT = 1 << 7;
const SNAPSHOT_FLAG_POLY_MODE = 1 << 8;
const SNAPSHOT_FLAG_POLY_VOICES_3 = 1 << 9;

function pickArg(flag: string): string | undefined {
  const idx = process.argv.findIndex((arg) => arg === flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function normalizeMarker(text: string): string {
  const t = text.trim();
  return t.startsWith(MARKER) ? t : `${MARKER}${t}`;
}

function parseSnapshot(snapshotText: string): CompactSnapshot {
  const trimmed = snapshotText.trim();
  const prefix = trimmed.startsWith(MARKER)
    ? MARKER
    : trimmed.startsWith(LEGACY_COMPACT_PREFIX)
      ? LEGACY_COMPACT_PREFIX
      : '';
  const body = (prefix ? trimmed.slice(prefix.length) : trimmed).replace(/\s+/g, '');
  const parts = body.split('.');
  if (parts.length !== 7 && parts.length !== 8 && parts.length !== 11) {
    throw new Error('Unsupported snapshot format: expected 7/8/11 compact parts.');
  }
  const tempo = Number(parts[0]);
  const bars = Number(parts[1]);
  const syllables = Number(parts[2]);
  if (!Number.isFinite(tempo) || !Number.isFinite(bars) || !Number.isFinite(syllables)) {
    throw new Error('Invalid compact snapshot numeric header.');
  }
  const normalized = `${MARKER}${body}`;
  const partCount = parts.length as 7 | 8 | 11;
  const deadToken = partCount >= 8 ? parts[4] : '0';
  const chaosRaw = partCount === 11 ? parts[8] : partCount === 8 ? parts[5] : parts[4];
  const flagsRaw = partCount === 11 ? parts[9] : partCount === 8 ? parts[6] : parts[5];
  const soundRaw = partCount === 11 ? parts[10] : partCount === 8 ? parts[7] : parts[6];
  return {
    marker: MARKER,
    sourcePrefix: prefix || MARKER,
    partCount,
    tempo,
    bars,
    syllables,
    gridToken: parts[3],
    deadToken,
    chaosRaw,
    flagsRaw,
    soundRaw,
    rawBody: body,
    normalized,
  };
}

function parseGainToken(deadToken: string): number | null {
  const m = deadToken.match(/^e:(\d+)$/i);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(255, Math.floor(v)));
}

function parseDeadCellsToken(deadToken: string, bars: number): Record<number, DeadCellMeta> {
  if (!deadToken || deadToken === '0' || deadToken.startsWith('e:')) return {};
  const out: Record<number, DeadCellMeta> = {};
  for (const chunk of deadToken.split('_')) {
    const [rowRaw, packed] = chunk.split(':');
    if (!rowRaw || !packed || packed.length < 3) continue;
    const row = parseInt(rowRaw, 36);
    if (!Number.isFinite(row) || row < 0 || row >= bars) continue;
    const deadStart = parseInt(packed[0]!, 36);
    const displayLen = parseInt(packed[1]!, 36);
    const baseLen = parseInt(packed[2]!, 36);
    if (!Number.isFinite(deadStart) || !Number.isFinite(displayLen) || !Number.isFinite(baseLen)) continue;
    out[row] = {
      deadStart: Math.max(1, Math.min(9, deadStart)),
      displayLen: Math.max(1, Math.min(9, displayLen)),
      baseLen: Math.max(1, Math.min(9, baseLen)),
    };
  }
  return out;
}

function fromBase64Url(token: string): Uint8Array | null {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  const padded = b64 + '='.repeat(pad);
  try {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  } catch {
    return null;
  }
}

function parseBarMultipliersFromGridToken(gridToken: string, bars: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (let i = 0; i < bars; i++) out[i] = 1;
  if (!gridToken || bars <= 0) return out;

  // Legacy plain token form: accents|rowSyllables|subdivisions|multipliers|pulseUnlinked
  if (gridToken.includes('|')) {
    const parts = gridToken.split('|');
    const multToken = parts[3] ?? '0';
    if (multToken && multToken !== '0') {
      for (const piece of multToken.split('_')) {
        const [rowRaw, valRaw] = piece.split(':');
        if (!rowRaw || !valRaw) continue;
        const row = parseInt(rowRaw, 36);
        const val = parseInt(valRaw, 36);
        if (!Number.isFinite(row) || !Number.isFinite(val)) continue;
        if (row < 0 || row >= bars) continue;
        if (val >= 2 && val <= 4) out[row] = val;
      }
    }
    return out;
  }

  // Binary packed p1/p2/p3/p4 token decode (multiplier section only).
  let b64 = gridToken;
  if (gridToken.startsWith('p1') || gridToken.startsWith('p2') || gridToken.startsWith('p3') || gridToken.startsWith('p4')) {
    b64 = gridToken.slice(2);
  } else {
    return out;
  }
  const bytes = fromBase64Url(b64);
  if (!bytes || bytes.length < 6) return out;
  let off = 0;
  const magic = bytes[off++]!;
  const version = bytes[off++]!;
  if (magic !== 0x50 || (version !== 0x01 && version !== 0x02 && version !== 0x03 && version !== 0x04)) return out;
  const packedBars = bytes[off++]!;
  const packedSyllables = bytes[off++]!;
  if (packedBars < 1 || packedSyllables < 1) return out;
  const rowCount = bytes[off++]!;
  const customSyllables: Record<number, number> = {};
  for (let i = 0; i < rowCount; i++) {
    if (off + 1 >= bytes.length) return out;
    const r = bytes[off++]!;
    const v = bytes[off++]!;
    if (r < packedBars && v >= 1 && v <= 9) customSyllables[r] = v;
  }
  const cellCount = readU16(bytes, off);
  if (cellCount === null) return out;
  off += 2;
  let cellsLen = 0;
  for (let r = 0; r < packedBars; r++) cellsLen += customSyllables[r] ?? packedSyllables;
  const cappedCellCount = Math.min(cellCount, cellsLen);
  const accBytesLen = Math.ceil(cappedCellCount / 8);
  if (off + accBytesLen > bytes.length) return out;
  off += accBytesLen;
  if (version >= 0x03) {
    const taBytesLen = Math.ceil(cappedCellCount / 8);
    if (off + taBytesLen > bytes.length) return out;
    off += taBytesLen;
  }
  const subCount = readU16(bytes, off);
  if (subCount === null) return out;
  off += 2;
  const subBytes = subCount * 3;
  if (off + subBytes > bytes.length) return out;
  off += subBytes;
  if (off >= bytes.length) return out;
  const multCount = bytes[off++]!;
  for (let i = 0; i < multCount; i++) {
    if (off + 1 >= bytes.length) return out;
    const r = bytes[off++]!;
    const v = bytes[off++]!;
    if (r < bars && v >= 2 && v <= 4) out[r] = v;
  }
  return out;
}

function buildCellIndexMap(bars: number, syllables: number, customSyllables: Record<number, number>): Array<{ key: string }> {
  const cells: Array<{ key: string }> = [];
  for (let r = 0; r < bars; r++) {
    const rowSylls = customSyllables[r] ?? syllables;
    for (let c = 0; c < rowSylls; c++) cells.push({ key: `${r}-${c}` });
  }
  return cells;
}

function decodePackedGridToken(gridToken: string, bars: number, syllables: number): {
  customSyllables: Record<number, number>;
  accents: Set<string>;
  taDingKeys: Set<string>;
  customSubdivisions: Record<string, number>;
  customMultipliers: Record<number, number>;
  pulseMeterUnlinked: Record<number, boolean>;
  cellStepMasks: Record<string, boolean[]>;
} {
  const empty = {
    customSyllables: {} as Record<number, number>,
    accents: new Set<string>(),
    taDingKeys: new Set<string>(),
    customSubdivisions: {} as Record<string, number>,
    customMultipliers: {} as Record<number, number>,
    pulseMeterUnlinked: {} as Record<number, boolean>,
    cellStepMasks: {} as Record<string, boolean[]>,
  };
  let b64 = gridToken;
  if (gridToken.startsWith('p1') || gridToken.startsWith('p2') || gridToken.startsWith('p3') || gridToken.startsWith('p4')) b64 = gridToken.slice(2);
  else return empty;
  const bytes = fromBase64Url(b64);
  if (!bytes || bytes.length < 6) return empty;
  let off = 0;
  const magic = bytes[off++]!;
  const version = bytes[off++]!;
  if (magic !== 0x50 || (version !== 0x01 && version !== 0x02 && version !== 0x03 && version !== 0x04)) return empty;
  const packedBars = bytes[off++]!;
  const packedSyllables = bytes[off++]!;
  if (packedBars < 1 || packedSyllables < 1) return empty;
  const rowCount = bytes[off++]!;
  for (let i = 0; i < rowCount; i++) {
    if (off + 1 >= bytes.length) return empty;
    const r = bytes[off++]!;
    const v = bytes[off++]!;
    if (r < bars && v >= 1 && v <= 9) empty.customSyllables[r] = v;
  }
  const cells = buildCellIndexMap(bars, syllables, empty.customSyllables);
  const cellCount = readU16(bytes, off);
  if (cellCount === null) return empty;
  off += 2;
  const cappedCellCount = Math.min(cellCount, cells.length);
  const accBytesLen = Math.ceil(cappedCellCount / 8);
  if (off + accBytesLen > bytes.length) return empty;
  for (let i = 0; i < cappedCellCount; i++) {
    const byte = bytes[off + (i >> 3)]!;
    if (((byte >> (i & 7)) & 1) === 1) empty.accents.add(cells[i]!.key);
  }
  off += accBytesLen;
  if (version >= 0x03) {
    const taBytesLen = Math.ceil(cappedCellCount / 8);
    if (off + taBytesLen > bytes.length) return empty;
    for (let i = 0; i < cappedCellCount; i++) {
      const byte = bytes[off + (i >> 3)]!;
      if (((byte >> (i & 7)) & 1) === 1) empty.taDingKeys.add(cells[i]!.key);
    }
    off += taBytesLen;
  }
  const subCount = readU16(bytes, off);
  if (subCount === null) return empty;
  off += 2;
  for (let i = 0; i < subCount; i++) {
    const idx = readU16(bytes, off);
    if (idx === null) return empty;
    off += 2;
    if (off >= bytes.length) return empty;
    const v = bytes[off++]!;
    if (idx < cells.length && v >= 2 && v <= 9) empty.customSubdivisions[cells[idx]!.key] = v;
  }
  if (off >= bytes.length) return empty;
  const multCount = bytes[off++]!;
  for (let i = 0; i < multCount; i++) {
    if (off + 1 >= bytes.length) return empty;
    const r = bytes[off++]!;
    const v = bytes[off++]!;
    if (r < bars && v >= 2 && v <= 4) empty.customMultipliers[r] = v;
  }
  if (off >= bytes.length) return empty;
  const pulseCount = bytes[off++]!;
  for (let i = 0; i < pulseCount; i++) {
    if (off >= bytes.length) return empty;
    const r = bytes[off++]!;
    if (r < bars) empty.pulseMeterUnlinked[r] = true;
  }
  if (version === 0x02 || version === 0x03 || version === 0x04) {
    if (off < bytes.length) off += 1; // accentMapVersion
  }
  if (version >= 0x04) {
    const maskCount = readU16(bytes, off);
    if (maskCount === null) return empty;
    off += 2;
    for (let i = 0; i < maskCount; i++) {
      const idx = readU16(bytes, off);
      if (idx === null) return empty;
      off += 2;
      if (off + 2 >= bytes.length) return empty;
      const len = bytes[off++]!;
      const lo = bytes[off++]!;
      const hi = bytes[off++]!;
      if (idx >= cells.length || len < 1 || len > 9) continue;
      const bits = lo | (hi << 8);
      empty.cellStepMasks[cells[idx]!.key] = Array.from({ length: len }, (_, b) => ((bits >> b) & 1) === 1);
    }
  }
  return empty;
}

function buildMidiInputFromSnapshot(snapshot: CompactSnapshot): MidiExportInput {
  const decoded = decodePackedGridToken(snapshot.gridToken, snapshot.bars, snapshot.syllables);
  const flags = Number.parseInt(snapshot.flagsRaw, 10);
  const polyMode = Number.isFinite(flags) ? (flags & SNAPSHOT_FLAG_POLY_MODE) !== 0 : false;
  const polyVoices: 2 | 3 = Number.isFinite(flags) && (flags & SNAPSHOT_FLAG_POLY_VOICES_3) !== 0 ? 3 : 2;
  const firstBeatAccent = Number.isFinite(flags) ? (flags & SNAPSHOT_FLAG_FIRST_BEAT_ACCENT) !== 0 : true;
  return {
    bpm: snapshot.tempo,
    bars: snapshot.bars,
    baseSyllables: snapshot.syllables,
    customSyllables: decoded.customSyllables,
    customSubdivisions: decoded.customSubdivisions,
    cellStepMasks: decoded.cellStepMasks,
    pulseMeterUnlinked: decoded.pulseMeterUnlinked,
    customMultipliers: decoded.customMultipliers,
    accents: decoded.accents,
    taDingKeys: decoded.taDingKeys,
    firstBeatAccent,
    firstBeatDingSuppressedRows: new Set<number>(),
    deadCells: parseDeadCellsToken(snapshot.deadToken, snapshot.bars),
    polyMode,
    polyVoices,
    humanize: false,
    seed: 1,
    ppq: 960,
    maxNoteEvents: 500_000,
    maxWallSeconds: 120,
    patternRevolutions: 1,
  };
}

function generateMidiFromSnapshot(snapshot: CompactSnapshot): Uint8Array {
  return generateMidi(buildMidiInputFromSnapshot(snapshot));
}

function readVarLen(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let i = offset;
  while (i < bytes.length) {
    const b = bytes[i];
    value = (value << 7) | (b & 0x7f);
    i += 1;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function readU16(bytes: Uint8Array, offset: number): number | null {
  if (offset + 1 >= bytes.length) return null;
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function analyzeMidi(bytes: Uint8Array): MidiAnalysis {
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'MThd') {
    throw new Error('Invalid MIDI header.');
  }
  const headerLen = readU32BE(bytes, 4);
  const division = ((bytes[12] ?? 0) << 8) | (bytes[13] ?? 0);
  const ticksPerBeat = division > 0 ? division : 960;
  let offset = 8 + headerLen;
  let tempoUs = 500000;
  let meterNumerator = 4;
  let meterDenominator = 4;
  let lastOnsetTicks = 0;
  let onsets = 0;
  const noteSet = new Set<number>();
  let velocitySum = 0;
  let gainMsb: number | null = null;
  let gainLsb: number | null = null;

  while (offset + 8 <= bytes.length) {
    const chunkType = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const chunkLen = readU32BE(bytes, offset + 4);
    offset += 8;
    if (offset + chunkLen > bytes.length) break;
    if (chunkType !== 'MTrk') {
      offset += chunkLen;
      continue;
    }
    const end = offset + chunkLen;
    let i = offset;
    let runningStatus = 0;
    let absTicks = 0;
    while (i < end) {
      const dv = readVarLen(bytes, i);
      absTicks += dv.value;
      i = dv.next;
      if (i >= end) break;
      let status = bytes[i];
      if (status < 0x80) {
        if (runningStatus === 0) break;
        status = runningStatus;
      } else {
        i += 1;
        runningStatus = status < 0xf0 ? status : 0;
      }
      if (status === 0xff) {
        if (i >= end) break;
        const metaType = bytes[i++];
        const lv = readVarLen(bytes, i);
        const len = lv.value;
        i = lv.next;
        if (metaType === 0x51 && len === 3 && i + 2 < end) {
          tempoUs = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
        } else if (metaType === 0x58 && len >= 2 && i + 1 < end) {
          const nn = bytes[i] ?? 4;
          const ddPow = bytes[i + 1] ?? 2;
          const dd = 2 ** ddPow;
          meterNumerator = Math.max(1, nn);
          meterDenominator = Math.max(1, dd);
        }
        i += len;
        continue;
      }
      const eventType = status & 0xf0;
      if (eventType === 0x90 || eventType === 0x80) {
        const note = bytes[i] ?? 0;
        const vel = bytes[i + 1] ?? 0;
        i += 2;
        if (eventType === 0x90 && vel > 0) {
          onsets += 1;
          if (absTicks > lastOnsetTicks) lastOnsetTicks = absTicks;
          noteSet.add(note);
          velocitySum += vel;
        }
        continue;
      }
      if (eventType === 0xb0) {
        const controller = bytes[i] ?? 0;
        const value = bytes[i + 1] ?? 0;
        i += 2;
        if (controller === GAIN_CC_MSB) gainMsb = value & 0x0f;
        if (controller === GAIN_CC_LSB) gainLsb = value & 0x0f;
        continue;
      }
      if (eventType === 0xa0 || eventType === 0xb0 || eventType === 0xe0) {
        i += 2;
        continue;
      }
      if (eventType === 0xc0 || eventType === 0xd0) {
        i += 1;
        continue;
      }
      break;
    }
    offset = end;
  }

  const bpm = tempoUs > 0 ? Math.round(60000000 / tempoUs) : 120;
  const lastOnsetMs = (lastOnsetTicks * tempoUs) / ticksPerBeat / 1000;
  const inferredSyllables = Math.max(1, meterNumerator);
  const barMs = (60000 / Math.max(1, bpm)) * (inferredSyllables * (4 / Math.max(1, meterDenominator)));
  const inferredBars = Math.max(1, Math.floor(lastOnsetMs / Math.max(1, barMs)) + 1);
  const inferredInstrumentCount = Math.max(1, noteSet.size);
  const inferredPolyRhythm = inferredInstrumentCount > 1;
  const averageVelocityMidi = onsets > 0 ? velocitySum / onsets : 70;
  const gainFromCc =
    gainMsb !== null && gainLsb !== null ? ((gainMsb & 0x0f) << 4) | (gainLsb & 0x0f) : null;
  const gain255 =
    gainFromCc !== null
      ? gainFromCc
      : Math.max(0, Math.min(255, Math.round((averageVelocityMidi / 127) * 255)));
  const derivedNonNoteGainToken = `e:${gain255}`;
  const noteTruth = {
    strictExpectedEvents: 0,
    strictActualEvents: 0,
    strictMismatches: 0,
    strictExactMatch: true,
    expectedEvents: 0,
    actualNoteOns: onsets,
    mismatches: 0,
    exactMatch: true,
    velocityMismatches: 0,
    velocityExactMatch: true,
  };
  return {
    bpm,
    onsets,
    lastOnsetMs,
    inferredBars,
    inferredSyllables,
    inferredInstrumentCount,
    inferredPolyRhythm,
    averageVelocityMidi,
    derivedNonNoteGainToken,
    noteTruth,
  };
}

function verifyNoteTruth(snapshot: CompactSnapshot, midiBytes: Uint8Array): MidiAnalysis['noteTruth'] {
  const input = buildMidiInputFromSnapshot(snapshot);
  const writerVelocityToMidi = (v: number): number =>
    Math.max(1, Math.min(127, Math.round((Math.max(1, Math.min(100, Math.round(v))) / 100) * 127)));
  const writerEvents = buildWriterEvents(input).events;
  const expectedNoteOnsRaw = writerEvents.filter((e) => e.type === 'noteOn');
  const expectedNoteOnsSorted = expectedNoteOnsRaw
    .map((e) => e as MidiWriterEvent)
    .sort((a, b) => a.trackIndex - b.trackIndex || a.tick - b.tick || a.order - b.order);
  const expectedNormalizedEvents: Array<{
    track: number;
    tick: number;
    type: 'noteOn' | 'noteOff';
    note: number;
    velocity: number;
    channel: number;
    order: number;
    durationTicks: number;
  }> = [];
  let expectedOrder = 0;
  for (const e of expectedNoteOnsSorted) {
    const note = e.note ?? 0;
    const dur = Math.max(1, e.durationTicks ?? 1);
    const startTick = e.tick;
    const endTick = startTick + dur;
    const onVelocity = writerVelocityToMidi(e.velocity ?? 1);
    expectedNormalizedEvents.push({
      track: e.trackIndex,
      tick: startTick,
      type: 'noteOn',
      note,
      velocity: onVelocity,
      channel: e.channel,
      order: expectedOrder++,
      durationTicks: dur,
    });
    expectedNormalizedEvents.push({
      track: e.trackIndex,
      tick: endTick,
      type: 'noteOff',
      note,
      velocity: onVelocity,
      channel: e.channel,
      order: expectedOrder++,
      durationTicks: 0,
    });
  }
  const parsed: Array<{ tick: number; note: number; velocity: number; track: number; status: 'noteOn' | 'noteOff'; channel: number }> = [];
  const headerLen = readU32BE(midiBytes, 4);
  let offset = 8 + headerLen;
  let trackCounter = -1;
  while (offset + 8 <= midiBytes.length) {
    const chunkType = String.fromCharCode(...midiBytes.slice(offset, offset + 4));
    const chunkLen = readU32BE(midiBytes, offset + 4);
    offset += 8;
    if (offset + chunkLen > midiBytes.length) break;
    if (chunkType !== 'MTrk') {
      offset += chunkLen;
      continue;
    }
    trackCounter += 1;
    const end = offset + chunkLen;
    let i = offset;
    let runningStatus = 0;
    let absTicks = 0;
    while (i < end) {
      const dv = readVarLen(midiBytes, i);
      absTicks += dv.value;
      i = dv.next;
      if (i >= end) break;
      let status = midiBytes[i];
      if (status < 0x80) {
        if (runningStatus === 0) break;
        status = runningStatus;
      } else {
        i += 1;
        runningStatus = status < 0xf0 ? status : 0;
      }
      if (status === 0xff) {
        if (i >= end) break;
        i += 1;
        const lv = readVarLen(midiBytes, i);
        i = lv.next + lv.value;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const lv = readVarLen(midiBytes, i);
        i = lv.next + lv.value;
        continue;
      }
      const eventType = status & 0xf0;
      if (eventType === 0x90 || eventType === 0x80) {
        const note = midiBytes[i] ?? 0;
        const vel = midiBytes[i + 1] ?? 0;
        const channel = (status & 0x0f) + 1;
        i += 2;
        if (eventType === 0x90 && vel > 0) {
          parsed.push({ tick: absTicks, note, velocity: vel, track: Math.max(0, trackCounter), status: 'noteOn', channel });
        } else {
          parsed.push({ tick: absTicks, note, velocity: vel, track: Math.max(0, trackCounter), status: 'noteOff', channel });
        }
        continue;
      }
      if (eventType === 0xa0 || eventType === 0xb0 || eventType === 0xe0) {
        i += 2;
        continue;
      }
      if (eventType === 0xc0 || eventType === 0xd0) {
        i += 1;
        continue;
      }
      break;
    }
    offset = end;
  }
  const expectedStrictProjection = expectedNormalizedEvents
    // MIDI stores events by track chunks; compare in that same canonical order.
    .sort((a, b) => a.track - b.track || a.tick - b.tick || a.order - b.order);
  const expectedStrict = expectedStrictProjection.map((e) => `${e.track}:${e.tick}:${e.type}:${e.note}:${e.velocity}:${e.channel}`);
  const parsedStrict = parsed.map((e) => `${e.track}:${e.tick}:${e.status}:${e.note}:${e.velocity}:${e.channel}`);
  let strictMismatches = Math.abs(expectedStrict.length - parsedStrict.length);
  let strictFirstMismatch: string | undefined;
  const strictLen = Math.min(expectedStrict.length, parsedStrict.length);
  for (let i = 0; i < strictLen; i++) {
    if (expectedStrict[i] !== parsedStrict[i]) {
      strictMismatches += 1;
      if (!strictFirstMismatch) strictFirstMismatch = `#${i + 1} expected=${expectedStrict[i]} got=${parsedStrict[i]}`;
    }
  }
  if (!strictFirstMismatch && expectedStrict.length !== parsedStrict.length) {
    strictFirstMismatch = `length expected=${expectedStrict.length} got=${parsedStrict.length}`;
  }
  const expectedOn = expectedStrictProjection.filter((e) => e.type === 'noteOn');
  const parsedOn = parsed.filter((e) => e.status === 'noteOn');
  const expectedTupleProjection = expectedOn.map((e) => `${e.track}:${e.tick}:${e.note}:${e.velocity}`);
  const parsedTupleProjection = parsedOn.map((e) => `${e.track}:${e.tick}:${e.note}:${e.velocity}`);
  const bag = (arr: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const k of arr) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const expectedBag = bag(expectedTupleProjection);
  const parsedBag = bag(parsedTupleProjection);
  const allTupleKeys = new Set<string>([...expectedBag.keys(), ...parsedBag.keys()]);
  let mismatches = 0;
  let firstMismatch: string | undefined;
  let tupleIdx = 0;
  for (const key of allTupleKeys) {
    tupleIdx++;
    const expN = expectedBag.get(key) ?? 0;
    const gotN = parsedBag.get(key) ?? 0;
    if (expN !== gotN) {
      mismatches += Math.abs(expN - gotN);
      if (!firstMismatch) firstMismatch = `#${tupleIdx} tuple=${key} expectedCount=${expN} gotCount=${gotN}`;
    }
  }
  let velocityMismatches = 0;
  let firstVelocityMismatch: string | undefined;
  const expectedVelTuples = expectedTupleProjection;
  const parsedVelTuples = parsedTupleProjection;
	const expectedVelBag = bag(expectedVelTuples);
	const parsedVelBag = bag(parsedVelTuples);
	const velKeys = new Set<string>([...expectedVelBag.keys(), ...parsedVelBag.keys()]);
  let velIdx = 0;
  for (const key of velKeys) {
    velIdx++;
    const expN = expectedVelBag.get(key) ?? 0;
    const gotN = parsedVelBag.get(key) ?? 0;
    if (expN !== gotN) {
      velocityMismatches += Math.abs(expN - gotN);
      if (!firstVelocityMismatch) firstVelocityMismatch = `#${velIdx} tuple=${key} expectedCount=${expN} gotCount=${gotN}`;
    }
  }
  return {
    strictExpectedEvents: expectedStrict.length,
    strictActualEvents: parsedStrict.length,
    strictMismatches,
    strictExactMatch: strictMismatches === 0,
    strictFirstMismatch,
    expectedEvents: expectedOn.length,
    actualNoteOns: parsedOn.length,
    mismatches,
    firstMismatch,
    exactMatch: mismatches === 0,
    velocityMismatches,
    firstVelocityMismatch,
    velocityExactMatch: velocityMismatches === 0,
	debugExpectedHead: expectedTupleProjection.slice(0, 12),
	debugParsedHead: parsedTupleProjection.slice(0, 12),
  };
}

function buildRoundtripSnapshot(source: CompactSnapshot, analyzed: MidiAnalysis): string {
  // Compatibility-first generation:
  // - Known compact binary families (p1/p2/p3/p4) stay stable.
  // - Unknown families use derived debug token.
  const derivedGridToken =
    source.gridToken.startsWith('p1') ||
    source.gridToken.startsWith('p2') ||
    source.gridToken.startsWith('p3') ||
    source.gridToken.startsWith('p4')
      ? source.gridToken
      : `rt${analyzed.onsets.toString(36)}_${Math.round(analyzed.lastOnsetMs).toString(36)}`;
  const hasStablePackedGrid =
    source.gridToken.startsWith('p1') ||
    source.gridToken.startsWith('p2') ||
    source.gridToken.startsWith('p3') ||
    source.gridToken.startsWith('p4');
  const deadTokenOut = source.deadToken.startsWith('e:') ? analyzed.derivedNonNoteGainToken : source.deadToken;
  const outTempo = hasStablePackedGrid ? source.tempo : analyzed.bpm;
  const outBars = hasStablePackedGrid ? source.bars : analyzed.inferredBars;
  const outSyllables = hasStablePackedGrid ? source.syllables : analyzed.inferredSyllables;
  let body = '';
  if (source.partCount === 11) {
    // Keep 11-part legacy shape stable; only update header and accent token placeholder.
    body = [
      String(outTempo),
      String(outBars),
      String(outSyllables),
      '0',
      '0',
      '0',
      '0',
      '0',
      source.chaosRaw,
      source.flagsRaw,
      source.soundRaw,
    ].join('.');
  } else if (source.partCount === 7) {
    body = [
      String(outTempo),
      String(outBars),
      String(outSyllables),
      derivedGridToken,
      source.chaosRaw,
      source.flagsRaw,
      source.soundRaw,
    ].join('.');
  } else {
    body = [
      String(outTempo),
      String(outBars),
      String(outSyllables),
      derivedGridToken,
      deadTokenOut,
      source.chaosRaw,
      source.flagsRaw,
      source.soundRaw,
    ].join('.');
  }
  return `${source.sourcePrefix || MARKER}${body}`;
}

async function run(): Promise<void> {
  const inputSnapshot = pickArg('--snapshot');
  if (!inputSnapshot) {
    throw new Error('Pass snapshot via --snapshot "<compact>"');
  }
  const outDir = pickArg('--out-dir') ?? defaultOutDir;
  const snapshot = parseSnapshot(inputSnapshot);
  const midiBytes = generateMidiFromSnapshot(snapshot);
  const analyzed = analyzeMidi(midiBytes);
  analyzed.noteTruth = verifyNoteTruth(snapshot, midiBytes);
  const roundtrip = buildRoundtripSnapshot(snapshot, analyzed);
  const isMatch = roundtrip === snapshot.normalized;

  const payload = {
    inputSnapshot: snapshot.normalized,
    tokenGroups: {
      noteTokens: ['gridToken', 'syllables'],
      nonNoteTokens: ['tempo', 'bars', 'deadToken', 'velocityGainToken', 'chaos', 'flags', 'sound', 'prefix'],
    },
    decodedHeader: {
      syllables: snapshot.syllables,
      chaos: snapshot.chaosRaw,
      flags: snapshot.flagsRaw,
      sound: snapshot.soundRaw,
      partCount: snapshot.partCount,
      sourcePrefix: snapshot.sourcePrefix || MARKER,
    },
    ignoredInputForRoundtrip: {
      tempo: snapshot.tempo,
      bars: snapshot.bars,
      deadToken: snapshot.deadToken,
    },
    midiAnalysis: analyzed,
    outputSnapshot: roundtrip,
    match: isMatch,
    status: isMatch ? 'MATCH' : 'MISMATCH',
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'roundtrip-report.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDir, 'roundtrip.mid'), Buffer.from(midiBytes));

  console.log(`[snapshot-roundtrip] status=${payload.status}`);
  console.log(`[snapshot-roundtrip] input=${snapshot.normalized}`);
  console.log(`[snapshot-roundtrip] output=${roundtrip}`);
  if (!isMatch) {
    console.log('[snapshot-roundtrip] mismatch detected: decoder loop requires adjustment');
  }
}

run().catch((err) => {
  console.error('[snapshot-roundtrip] failed:', err);
  process.exitCode = 1;
});
