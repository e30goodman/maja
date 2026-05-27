import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildWriterEvents,
  effectiveBpmForRow,
  generateMidi,
  resolveMidiNoteForLaneRole,
  ticksPerCellFromRow,
  type MidiExportInput,
  type MidiWriterEvent,
} from '../src/midiExport';

export type CompactSnapshot = {
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

export type MidiAnalysis = {
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

type DecodedGrid = {
  customSyllables: Record<number, number>;
  accents: Set<string>;
  taDingKeys: Set<string>;
  customSubdivisions: Record<string, number>;
  customMultipliers: Record<number, number>;
  pulseMeterUnlinked: Record<number, boolean>;
  cellStepMasks: Record<string, boolean[]>;
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
const CLICK_SOUND_PRESET_ORDER = [
  'classic',
  'oldschool',
  'standard',
  'modern_daw',
  'woodblock',
  'punchy',
  'sharp_digital',
  'deep_sub',
  'laser_snap',
  'hi_hat',
  'glass_drop',
  'plastic_knock',
  'metallic',
  'clock_tick',
  'cowbell',
  'analog_synth',
  'vinyl_crackle',
  'dry_click',
  'soft_ping',
  'noise_burst',
  'eight_bit',
] as const;

function pickArg(flag: string): string | undefined {
  const idx = process.argv.findIndex((arg) => arg === flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function normalizeMarker(text: string): string {
  const t = text.trim();
  return t.startsWith(MARKER) ? t : `${MARKER}${t}`;
}

export function parseSnapshot(snapshotText: string): CompactSnapshot {
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

function decodeSnapshotSoundToken(soundRaw: string): {
  clickSound: string;
  clickSoundByPolyVoice: Partial<Record<0 | 1 | 2, string>>;
} {
  const token = String(soundRaw ?? '').trim();
  const [baseRaw, byVoiceRaw] = token.split('~', 2);
  const baseId = Number.parseInt(baseRaw, 10);
  const clickSound =
    Number.isFinite(baseId) && baseId >= 0 && baseId < CLICK_SOUND_PRESET_ORDER.length
      ? CLICK_SOUND_PRESET_ORDER[baseId]!
      : 'classic';
  const clickSoundByPolyVoice: Partial<Record<0 | 1 | 2, string>> = {};
  if (byVoiceRaw) {
    for (const chunk of byVoiceRaw.split('_')) {
      const [voiceRaw, presetRaw] = chunk.split(':', 2);
      const voice = Number.parseInt(String(voiceRaw), 10);
      const presetId = Number.parseInt(String(presetRaw), 36);
      if (!Number.isFinite(voice) || voice < 0 || voice > 2) continue;
      if (!Number.isFinite(presetId) || presetId < 0 || presetId >= CLICK_SOUND_PRESET_ORDER.length) continue;
      clickSoundByPolyVoice[voice as 0 | 1 | 2] = CLICK_SOUND_PRESET_ORDER[presetId]!;
    }
  }
  return { clickSound, clickSoundByPolyVoice };
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

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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

function pushU16(out: number[], value: number): void {
  out.push((value >> 8) & 0xff, value & 0xff);
}

function encodePackedGridToken(args: {
  bars: number;
  syllables: number;
  customSyllables: Record<number, number>;
  accents: Set<string>;
  taDingKeys: Set<string>;
  customSubdivisions: Record<string, number>;
  customMultipliers: Record<number, number>;
  pulseMeterUnlinked: Record<number, boolean>;
  cellStepMasks: Record<string, boolean[]>;
}): string {
  const bars = Math.max(1, Math.min(255, Math.floor(args.bars)));
  const syllables = Math.max(1, Math.min(9, Math.floor(args.syllables)));
  const cells = buildCellIndexMap(bars, syllables, args.customSyllables);
  const out: number[] = [];
  const hasStepMasks = Object.keys(args.cellStepMasks || {}).length > 0;
  const gridVersion = hasStepMasks ? 0x04 : 0x03;
  out.push(0x50, gridVersion, bars, syllables);

  const rowEntries = Object.entries(args.customSyllables)
    .map(([k, v]) => [parseInt(k, 10), parseInt(String(v), 10)] as const)
    .filter(([r, v]) => Number.isFinite(r) && r >= 0 && r < bars && Number.isFinite(v) && v >= 1 && v <= 9)
    .sort((a, b) => a[0] - b[0]);
  out.push(Math.min(255, rowEntries.length));
  for (let i = 0; i < Math.min(255, rowEntries.length); i++) {
    const [r, v] = rowEntries[i]!;
    out.push(r & 0xff, v & 0xff);
  }

  pushU16(out, Math.min(65535, cells.length));
  let accByte = 0;
  let accBit = 0;
  for (let i = 0; i < cells.length; i++) {
    if (args.accents.has(cells[i]!.key)) accByte |= 1 << accBit;
    accBit++;
    if (accBit === 8) {
      out.push(accByte);
      accByte = 0;
      accBit = 0;
    }
  }
  if (accBit !== 0) out.push(accByte);

  let taByte = 0;
  let taBit = 0;
  for (let i = 0; i < cells.length; i++) {
    if (args.taDingKeys.has(cells[i]!.key)) taByte |= 1 << taBit;
    taBit++;
    if (taBit === 8) {
      out.push(taByte);
      taByte = 0;
      taBit = 0;
    }
  }
  if (taBit !== 0) out.push(taByte);

  const subEntries: Array<[number, number]> = [];
  for (let i = 0; i < cells.length; i++) {
    const v = args.customSubdivisions[cells[i]!.key];
    if (typeof v === 'number' && v >= 2 && v <= 9) subEntries.push([i, v]);
  }
  pushU16(out, Math.min(65535, subEntries.length));
  for (let i = 0; i < Math.min(65535, subEntries.length); i++) {
    const [idx, v] = subEntries[i]!;
    pushU16(out, idx);
    out.push(v & 0xff);
  }

  const multEntries = Object.entries(args.customMultipliers)
    .map(([k, v]) => [parseInt(k, 10), parseInt(String(v), 10)] as const)
    .filter(([r, v]) => Number.isFinite(r) && r >= 0 && r < bars && Number.isFinite(v) && v >= 2 && v <= 4)
    .sort((a, b) => a[0] - b[0]);
  out.push(Math.min(255, multEntries.length));
  for (let i = 0; i < Math.min(255, multEntries.length); i++) {
    const [r, v] = multEntries[i]!;
    out.push(r & 0xff, v & 0xff);
  }

  const pulseRows = Object.entries(args.pulseMeterUnlinked || {})
    .map(([k, v]) => [parseInt(k, 10), Boolean(v)] as const)
    .filter(([r, v]) => Number.isFinite(r) && r >= 0 && r < bars && v)
    .map(([r]) => r)
    .sort((a, b) => a - b);
  out.push(Math.min(255, pulseRows.length));
  for (let i = 0; i < Math.min(255, pulseRows.length); i++) out.push(pulseRows[i]! & 0xff);

  // Preserve legacy-compatible accent map version byte used by snapshot pipeline.
  out.push(0);

  if (gridVersion >= 0x04) {
    const maskEntries: Array<[number, number, number]> = [];
    for (let i = 0; i < cells.length; i++) {
      const key = cells[i]!.key;
      const subdivs = args.customSubdivisions[key] ?? 1;
      const mask = args.cellStepMasks[key] ?? Array.from({ length: Math.max(1, subdivs) }, () => true);
      if (mask.every(Boolean)) continue;
      let bits = 0;
      for (let b = 0; b < mask.length; b++) if (mask[b]) bits |= (1 << b);
      maskEntries.push([i, mask.length, bits]);
    }
    pushU16(out, Math.min(65535, maskEntries.length));
    for (let i = 0; i < Math.min(65535, maskEntries.length); i++) {
      const [idx, len, bits] = maskEntries[i]!;
      pushU16(out, idx);
      out.push(len & 0xff, bits & 0xff, (bits >> 8) & 0xff);
    }
  }

  return `${gridVersion === 0x04 ? 'p4' : 'p3'}${toBase64Url(new Uint8Array(out))}`;
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

function parseMidiNoteOnTicks(bytes: Uint8Array): number[] {
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'MThd') return [];
  const headerLen = readU32BE(bytes, 4);
  let offset = 8 + headerLen;
  const onsets: number[] = [];
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
        i += 1;
        const lv = readVarLen(bytes, i);
        i = lv.next + lv.value;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const lv = readVarLen(bytes, i);
        i = lv.next + lv.value;
        continue;
      }
      const eventType = status & 0xf0;
      if (eventType === 0x90 || eventType === 0x80) {
        const _note = bytes[i] ?? 0;
        const vel = bytes[i + 1] ?? 0;
        i += 2;
        if (eventType === 0x90 && vel > 0) onsets.push(absTicks);
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
  return onsets;
}

function parseMidiNoteOnTuples(bytes: Uint8Array): Array<{ tick: number; note: number; velocity: number; track: number }> {
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'MThd') return [];
  const headerLen = readU32BE(bytes, 4);
  let offset = 8 + headerLen;
  const out: Array<{ tick: number; note: number; velocity: number; track: number }> = [];
  let trackCounter = -1;
  while (offset + 8 <= bytes.length) {
    const chunkType = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const chunkLen = readU32BE(bytes, offset + 4);
    offset += 8;
    if (offset + chunkLen > bytes.length) break;
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
        i += 1;
        const lv = readVarLen(bytes, i);
        i = lv.next + lv.value;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const lv = readVarLen(bytes, i);
        i = lv.next + lv.value;
        continue;
      }
      const eventType = status & 0xf0;
      if (eventType === 0x90 || eventType === 0x80) {
        const note = bytes[i] ?? 0;
        const vel = bytes[i + 1] ?? 0;
        i += 2;
        if (eventType === 0x90 && vel > 0) out.push({ tick: absTicks, note, velocity: vel, track: Math.max(0, trackCounter) });
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
  return out;
}

function deriveCellStepMasksFromMidi(args: {
  snapshot: CompactSnapshot;
  decoded: DecodedGrid;
  midiInput: MidiExportInput;
  midiBytes: Uint8Array;
}): {
  masks: Record<string, boolean[]>;
  quantizationSamples: string[];
  expectedMaskedCells: string[];
  reconstructedMaskedCells: string[];
  extraMaskedCells: string[];
  missingMaskedCells: string[];
} {
  const { decoded, midiInput, midiBytes } = args;
  const rawByCellLane = new Map<string, Array<{ tick: number; lane: number; note: number }>>();
  const laneCount = midiInput.polyMode ? (midiInput.polyVoices === 3 ? 3 : 2) : 1;
  let cursorTick = 0;
  const ppq = midiInput.ppq ?? 960;
  for (let row = 0; row < args.snapshot.bars; row++) {
    const rowSyllables = decoded.customSyllables[row] ?? args.snapshot.syllables;
    const cellTicks = ticksPerCellFromRow(
      midiInput.bpm,
      row,
      args.snapshot.syllables,
      decoded.customSyllables,
      decoded.pulseMeterUnlinked,
      decoded.customMultipliers,
      ppq,
      midiInput.progressiveDensityMode,
      midiInput.deSyncJatiActive,
      midiInput.deSyncCycleLength,
    );
    for (let col = 0; col < rowSyllables; col++) {
      const key = `${row}-${col}`;
      const subdivs = Math.max(1, Math.min(9, Math.floor(decoded.customSubdivisions[key] ?? 1)));
      if (subdivs <= 1) continue;
      const cellStart = cursorTick + col * cellTicks;
      const subTick = cellTicks / subdivs;
      for (let lane = 0; lane < laneCount; lane++) {
        const laneKey = `${key}|${lane}`;
        const arr = rawByCellLane.get(laneKey) ?? [];
        for (let subIdx = 0; subIdx < subdivs; subIdx++) {
          arr.push({
            tick: Math.round(cellStart + subIdx * subTick),
            lane,
            note: resolveMidiNoteForLaneRole(lane, 'passive'),
          });
        }
        rawByCellLane.set(laneKey, arr);
      }
    }
    const rowEffBpm = effectiveBpmForRow(
      midiInput.bpm,
      row,
      args.snapshot.syllables,
      decoded.customSyllables,
      decoded.pulseMeterUnlinked,
      decoded.customMultipliers,
      midiInput.progressiveDensityMode,
      midiInput.deSyncJatiActive,
      midiInput.deSyncCycleLength,
    );
    const rowCellTicks = Number.isFinite(rowEffBpm) && rowEffBpm > 0 ? (ppq * midiInput.bpm) / rowEffBpm : ppq;
    cursorTick += rowSyllables * rowCellTicks;
  }
  const candidatesByCellLane = new Map<string, Array<{ subIdx: number; tick: number; lane: number; note: number }>>();
  for (const [laneKey, raw] of rawByCellLane.entries()) {
    const [key] = laneKey.split('|');
    const subdivs = Math.max(1, Math.min(9, Math.floor(decoded.customSubdivisions[key] ?? 1)));
    const ordered = [...raw].sort((a, b) => a.tick - b.tick);
    const mapped = ordered.map((r, idx) => ({
      subIdx: idx % subdivs,
      tick: r.tick,
      lane: r.lane,
      note: r.note,
    }));
    candidatesByCellLane.set(laneKey, mapped);
  }
  const out: Record<string, boolean[]> = {};
  const samples: string[] = [];
  const onsetsRaw = parseMidiNoteOnTuples(midiBytes);
  const usedTracks = Array.from(new Set(onsetsRaw.map((o) => o.track))).sort((a, b) => a - b);
  const trackToLane = new Map<number, number>();
  for (let i = 0; i < usedTracks.length; i++) trackToLane.set(usedTracks[i]!, i);
  const onsets = onsetsRaw.map((o) => ({ ...o, track: trackToLane.get(o.track) ?? o.track }));
  const passiveNotes = new Set<number>([
    resolveMidiNoteForLaneRole(0, 'passive'),
    resolveMidiNoteForLaneRole(1, 'passive'),
    resolveMidiNoteForLaneRole(2, 'passive'),
  ]);
  const onsetByLaneNote = new Map<string, number[]>();
  for (const o of onsets) {
    const lane = o.track;
    const k = `${lane}:${o.note}`;
    const arr = onsetByLaneNote.get(k) ?? [];
    arr.push(o.tick);
    onsetByLaneNote.set(k, arr);
  }
  for (const arr of onsetByLaneNote.values()) arr.sort((a, b) => a - b);
  const usedLaneWindows = new Set<string>();
  const laneMasksByCell = new Map<string, Map<number, boolean[]>>();
  for (const [laneKey, candidates] of candidatesByCellLane.entries()) {
    const [key, laneRaw] = laneKey.split('|');
    const lane = Number(laneRaw);
    const subdivs = Math.max(1, Math.min(9, Math.floor(decoded.customSubdivisions[key] ?? 1)));
    const laneMask = Array.from({ length: subdivs }, () => false);
    const sorted = [...candidates].sort((a, b) => a.tick - b.tick);
    const laneStep = sorted.length >= 2 ? Math.max(1, sorted[1]!.tick - sorted[0]!.tick) : 1;
    const consumed = new Set<number>();
    for (const c of sorted) {
      const laneNote = `${lane}:${c.note}`;
      const ticks = onsetByLaneNote.get(laneNote) ?? [];
      let bestDist = Infinity;
      let bestIdx = -1;
      for (let i = 0; i < ticks.length; i++) {
        const t = ticks[i]!;
        if (consumed.has(i)) continue;
        const d = Math.abs(t - c.tick);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      const maxError = c.subIdx === 0
        ? Math.max(1, Math.floor(laneStep * 0.22)) // asymmetric tolerance: tighter on head
        : Math.max(1, Math.floor(laneStep * 0.42)); // wider on inner sub-steps
      if (bestIdx >= 0 && bestDist <= maxError) {
        const bestTick = ticks[bestIdx]!;
        const roleWindow = Math.round(bestTick / Math.max(1, laneStep));
        const dedupKey = `${key}:${c.subIdx}:${lane}:${roleWindow}`;
        if (usedLaneWindows.has(dedupKey)) continue;
        usedLaneWindows.add(dedupKey);
        consumed.add(bestIdx);
        laneMask[c.subIdx] = true;
        if (samples.length < 16) {
          samples.push(`tick=${bestTick} lane=${lane} note=${c.note} -> ${key}[${c.subIdx}] d=${bestDist} max=${maxError}`);
        }
      }
    }
    const laneMap = laneMasksByCell.get(key) ?? new Map<number, boolean[]>();
    laneMap.set(lane, laneMask);
    laneMasksByCell.set(key, laneMap);
  }
  for (const [key, laneMasks] of laneMasksByCell.entries()) {
    const subdivs = Math.max(1, Math.min(9, Math.floor(decoded.customSubdivisions[key] ?? 1)));
    const merged = Array.from({ length: subdivs }, () => false);
    // lane-specific primary, merge with stable priority V1 > V2 > V3
    for (const lane of [0, 1, 2]) {
      const m = laneMasks.get(lane);
      if (!m) continue;
      for (let i = 0; i < subdivs; i++) merged[i] = merged[i] || Boolean(m[i]);
    }
    // Head-less cell supported explicitly:
    // if there are inner hits but no head hit, keep a stable "hole-at-head" mask.
    const hasInner = merged.slice(1).some(Boolean);
    const hasHead = Boolean(merged[0]);
    if (hasInner && !hasHead) {
      const headlessMask = Array.from({ length: subdivs }, (_, i) => i !== 0);
      out[key] = headlessMask;
      continue;
    }
    if (merged.some(Boolean) && merged.some((v) => v === false)) out[key] = merged;
  }
  const expectedMaskedCells = Object.keys(decoded.cellStepMasks)
    .filter((k) => (decoded.cellStepMasks[k] ?? []).some((v) => v === false))
    .sort();
  const reconstructedMaskedCells = Object.keys(out)
    .filter((k) => (out[k] ?? []).some((v) => v === false))
    .sort();
  const expectedSet = new Set(expectedMaskedCells);
  const reconstructedSet = new Set(reconstructedMaskedCells);
  const extraMaskedCells = reconstructedMaskedCells.filter((k) => !expectedSet.has(k)).slice(0, 20);
  const missingMaskedCells = expectedMaskedCells.filter((k) => !reconstructedSet.has(k)).slice(0, 20);
  return {
    masks: out,
    quantizationSamples: samples,
    expectedMaskedCells: expectedMaskedCells.slice(0, 20),
    reconstructedMaskedCells: reconstructedMaskedCells.slice(0, 20),
    extraMaskedCells,
    missingMaskedCells,
  };
}

function deriveCustomSubdivisionsFromMidi(args: {
  snapshot: CompactSnapshot;
  decoded: DecodedGrid;
  midiInput: MidiExportInput;
  midiBytes: Uint8Array;
}): {
  subdivisions: Record<string, number>;
  traceByLinearCell: Record<
    string,
    {
      row: number;
      col: number;
      startTick: number;
      endTick: number;
      cellTicks: number;
      passiveTicks: number[];
      passiveOffsets: number[];
      chosenDiv: number;
      candidates: Array<{
        div: number;
        matchedSteps: number[];
        coverage: number;
        meanError: number;
        fatalHits: number;
        rejectedReason: string | null;
        score: number;
      }>;
    }
  >;
} {
  const { snapshot, decoded, midiInput, midiBytes } = args;
  const out: Record<string, number> = {};
  const traceByLinearCell: Record<
    string,
    {
      row: number;
      col: number;
      startTick: number;
      endTick: number;
      cellTicks: number;
      passiveTicks: number[];
      passiveOffsets: number[];
      chosenDiv: number;
      candidates: Array<{
        div: number;
        matchedSteps: number[];
        coverage: number;
        meanError: number;
        fatalHits: number;
        rejectedReason: string | null;
        score: number;
      }>;
    }
  > = {};
  const traceTargets = new Set<number>([9, 19]);
  const onsetsRaw = parseMidiNoteOnTuples(midiBytes);
  const usedTracks = Array.from(new Set(onsetsRaw.map((o) => o.track))).sort((a, b) => a - b);
  const trackToLane = new Map<number, number>();
  for (let i = 0; i < usedTracks.length; i++) trackToLane.set(usedTracks[i]!, i);
  const onsets = onsetsRaw.map((o) => ({ ...o, track: trackToLane.get(o.track) ?? o.track }));
  const passiveNotes = new Set<number>([
    resolveMidiNoteForLaneRole(0, 'passive'),
    resolveMidiNoteForLaneRole(1, 'passive'),
    resolveMidiNoteForLaneRole(2, 'passive'),
  ]);
  const ppq = midiInput.ppq ?? 960;
  let cursorTick = 0;
  let linearCell = 0;
  const orderedKeys: string[] = [];
  const rawOnlyDivs: Record<string, number> = {};
  const softHints: Record<string, number> = {};
  const signalTickCount: Record<string, number> = {};
  const rowCells: Record<number, Array<{ col: number; key: string }>> = {};
  for (let row = 0; row < snapshot.bars; row++) {
    const rowSyllables = decoded.customSyllables[row] ?? snapshot.syllables;
    const cellTicks = ticksPerCellFromRow(
      midiInput.bpm,
      row,
      snapshot.syllables,
      decoded.customSyllables,
      decoded.pulseMeterUnlinked,
      decoded.customMultipliers,
      ppq,
      midiInput.progressiveDensityMode,
      midiInput.deSyncJatiActive,
      midiInput.deSyncCycleLength,
    );
    for (let col = 0; col < rowSyllables; col++) {
      const key = `${row}-${col}`;
      orderedKeys.push(key);
      const rowList = rowCells[row] ?? [];
      rowList.push({ col, key });
      rowCells[row] = rowList;
      const start = cursorTick + col * cellTicks;
      const end = start + cellTicks;
      const endWindow = end;
      const passiveTicks = onsets
        .filter((o) => passiveNotes.has(o.note) && o.tick >= start && o.tick < endWindow + 1)
        .map((o) => o.tick)
        .sort((a, b) => a - b);
      const allTicks = onsets
        .filter((o) => o.tick >= start && o.tick < endWindow + 1)
        .map((o) => o.tick)
        .sort((a, b) => a - b);
      const signalTicks = passiveTicks.length >= 2 ? passiveTicks : allTicks;
      signalTickCount[key] = signalTicks.length;
      const candidateTrace: Array<{
        div: number;
        matchedSteps: number[];
        coverage: number;
        meanError: number;
        fatalHits: number;
        rejectedReason: string | null;
        score: number;
      }> = [];
      if (signalTicks.length < 2) {
        if (traceTargets.has(linearCell)) {
          traceByLinearCell[String(linearCell)] = {
            row,
            col,
            startTick: start,
            endTick: end,
            cellTicks,
            passiveTicks: signalTicks,
            passiveOffsets: signalTicks.map((t) => t - start),
            chosenDiv: 1,
            candidates: candidateTrace,
          };
        }
        linearCell += 1;
        continue;
      }
      const EPSILON_TICKS = 2;
      let bestDiv = 1;
      let bestScore = Number.NEGATIVE_INFINITY;
      let fallbackDiv = 1;
      let fallbackMatched = -1;
      let fallbackError = Number.POSITIVE_INFINITY;
      for (let div = 2; div <= 9; div++) {
        const step = cellTicks / div;
        const strictTolerance = EPSILON_TICKS;
        const matchedSteps = new Set<number>();
        let totalError = 0;
        let fatalHits = 0;
        for (const tick of signalTicks) {
          const offset = tick - start;
          const nearestStep = Math.round(offset / step);
          if (nearestStep < 0 || nearestStep >= div) {
            fatalHits += 1;
            continue;
          }
          const nearestErr = Math.abs(offset - nearestStep * step);
          if (nearestErr > strictTolerance) {
            fatalHits += 1;
            continue;
          }
          matchedSteps.add(nearestStep);
          totalError += nearestErr;
        }
        const coverage = matchedSteps.size / div;
        const meanError = totalError / Math.max(1, matchedSteps.size);
        if (fatalHits === 0) {
          if (
            matchedSteps.size > fallbackMatched ||
            (matchedSteps.size === fallbackMatched && totalError < fallbackError)
          ) {
            fallbackMatched = matchedSteps.size;
            fallbackError = totalError;
            fallbackDiv = div;
          }
        }
        let rejectedReason: string | null = null;
        if (fatalHits > 0) rejectedReason = 'fatal_strict_grid_miss';
        else if (matchedSteps.size < 2) rejectedReason = 'low_matched_steps';
        if (rejectedReason) {
          if (traceTargets.has(linearCell)) {
            candidateTrace.push({
              div,
              matchedSteps: Array.from(matchedSteps).sort((a, b) => a - b),
              coverage,
              meanError,
              fatalHits,
              rejectedReason,
              score: Number.NEGATIVE_INFINITY,
            });
          }
          continue;
        }
        const score = matchedSteps.size * 1000 - totalError;
        if (traceTargets.has(linearCell)) {
          candidateTrace.push({
            div,
            matchedSteps: Array.from(matchedSteps).sort((a, b) => a - b),
            coverage,
            meanError,
            fatalHits,
            rejectedReason: null,
            score,
          });
        }
        if (score > bestScore) {
          bestScore = score;
          bestDiv = div;
        }
      }
      if (bestDiv >= 2) rawOnlyDivs[key] = bestDiv;
      else if (fallbackDiv >= 2 && signalTicks.length > 0) softHints[key] = fallbackDiv;
      if (traceTargets.has(linearCell)) {
        traceByLinearCell[String(linearCell)] = {
          row,
          col,
          startTick: start,
          endTick: end,
          cellTicks,
          passiveTicks: signalTicks,
          passiveOffsets: signalTicks.map((t) => t - start),
          chosenDiv: bestDiv,
          candidates: candidateTrace.sort((a, b) => b.score - a.score || a.div - b.div),
        };
      }
      linearCell += 1;
    }
    const rowEffBpm = effectiveBpmForRow(
      midiInput.bpm,
      row,
      snapshot.syllables,
      decoded.customSyllables,
      decoded.pulseMeterUnlinked,
      decoded.customMultipliers,
      midiInput.progressiveDensityMode,
      midiInput.deSyncJatiActive,
      midiInput.deSyncCycleLength,
    );
    const rowCellTicks = Number.isFinite(rowEffBpm) && rowEffBpm > 0 ? (ppq * midiInput.bpm) / rowEffBpm : ppq;
    cursorTick += rowSyllables * rowCellTicks;
  }
  for (const key of orderedKeys) {
    const raw = rawOnlyDivs[key];
    if (raw !== undefined) out[key] = raw;
  }
  // Pass 2: row-context inpainting for sparse/lossy MIDI holes.
  for (const rowKey of Object.keys(rowCells)) {
    const row = Number.parseInt(rowKey, 10);
    const cells = (rowCells[row] ?? []).sort((a, b) => a.col - b.col);
    const rowSyllables = cells.length;
    const rowExpanded = rowSyllables > snapshot.syllables;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      if (out[cell.key] !== undefined) continue;
      let leftDiv: number | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const neighborKey = cells[j]!.key;
        const v = out[neighborKey] ?? softHints[neighborKey];
        if (v !== undefined) {
          leftDiv = v;
          break;
        }
      }
      let rightDiv: number | null = null;
      for (let j = i + 1; j < cells.length; j++) {
        const neighborKey = cells[j]!.key;
        const v = out[neighborKey] ?? softHints[neighborKey];
        if (v !== undefined) {
          rightDiv = v;
          break;
        }
      }
      const isTail = rightDiv === null && leftDiv !== null;
      const isHead = leftDiv === null && rightDiv !== null;
      const isMiddle = leftDiv !== null && rightDiv !== null;
      const isSilentCell = (signalTickCount[cell.key] ?? 0) === 0;
      if (isTail && isSilentCell) {
        const inherited = leftDiv ?? 1;
        out[cell.key] = rowExpanded ? Math.max(4, inherited) : inherited;
      } else if (isHead && isSilentCell) {
        const inherited = rightDiv ?? 1;
        out[cell.key] = rowExpanded ? Math.max(4, inherited) : inherited;
      } else if (isMiddle && isSilentCell && leftDiv === rightDiv) {
        out[cell.key] = rowExpanded ? Math.max(4, leftDiv) : leftDiv;
      } else if (isSilentCell && rowExpanded && i === cells.length - 1) {
        out[cell.key] = 4;
      }
    }
  }
  // Pass 3: global mode fallback (only if row context still cannot fill).
  const freq = new Map<number, number>();
  for (const v of Object.values(out)) {
    if (!Number.isFinite(v) || v < 2) continue;
    freq.set(v, (freq.get(v) ?? 0) + 1);
  }
  for (const v of Object.values(softHints)) {
    if (!Number.isFinite(v) || v < 2) continue;
    freq.set(v, (freq.get(v) ?? 0) + 1);
  }
  const globalMode = Array.from(freq.entries()).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 1;
  // Do not broadcast global mode to every cell: this creates false dense grids.
  // Keep global mode only as a tie-break signal for local decisions above.
  void globalMode;
  for (const target of ['9', '19']) {
    const trace = traceByLinearCell[target];
    if (!trace) continue;
    const key = `${trace.row}-${trace.col}`;
    trace.chosenDiv = out[key] ?? trace.chosenDiv;
  }
  return { subdivisions: out, traceByLinearCell };
}

function buildMidiInputFromSnapshot(snapshot: CompactSnapshot): MidiExportInput {
  const flags = Number.parseInt(snapshot.flagsRaw, 10);
  const polyMode = Number.isFinite(flags) ? (flags & SNAPSHOT_FLAG_POLY_MODE) !== 0 : false;
  const polyVoices: 2 | 3 = Number.isFinite(flags) && (flags & SNAPSHOT_FLAG_POLY_VOICES_3) !== 0 ? 3 : 2;
  const firstBeatAccent = Number.isFinite(flags) ? (flags & SNAPSHOT_FLAG_FIRST_BEAT_ACCENT) !== 0 : true;
  const sound = decodeSnapshotSoundToken(snapshot.soundRaw);
  /**
   * Decoder must not trust tempo encoded in snapshot header.
   * Positional timing is reconstructed from per-row structure (syllables/subdivisions/multipliers/pulse),
   * so we keep a neutral base tempo and let row-level pulse math define relative placement.
   */
  const decodedBaseTempo = 100;
  // Anti-linkage policy: note-grid structures are not copied from snapshot token.
  const derivedCustomSyllables: Record<number, number> = {};
  const derivedCustomSubdivisions: Record<string, number> = {};
  const derivedCellStepMasks: Record<string, boolean[]> = {};
  const derivedPulseMeterUnlinked: Record<number, boolean> = {};
  const derivedCustomMultipliers: Record<number, number> = {};
  const derivedAccents = new Set<string>();
  const derivedTaDingKeys = new Set<string>();
  return {
    bpm: decodedBaseTempo,
    bars: snapshot.bars,
    baseSyllables: snapshot.syllables,
    customSyllables: derivedCustomSyllables,
    customSubdivisions: derivedCustomSubdivisions,
    cellStepMasks: derivedCellStepMasks,
    pulseMeterUnlinked: derivedPulseMeterUnlinked,
    customMultipliers: derivedCustomMultipliers,
    accents: derivedAccents,
    taDingKeys: derivedTaDingKeys,
    clickSound: sound.clickSound,
    clickSoundByPolyVoice: sound.clickSoundByPolyVoice,
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

export function buildRoundtripSnapshot(source: CompactSnapshot, analyzed: MidiAnalysis, rebuiltGridToken: string): string {
  // Security rule: never copy gridToken from input snapshot.
  const derivedGridToken = rebuiltGridToken;
  const deadTokenOut = source.deadToken.startsWith('e:') ? analyzed.derivedNonNoteGainToken : source.deadToken;
  // Security rule: tempo/bars/syllables must always be derived from MIDI analysis.
  // Restoring linkage to input snapshot header is forbidden.
  const outTempo = analyzed.bpm;
  const outBars = analyzed.inferredBars;
  const outSyllables = analyzed.inferredSyllables;
  let body = '';
  if (source.partCount === 11) {
    // Security rule: for 11-part legacy form, do not restore grid/dead linkage from input snapshot.
    // grid/dead must stay derived from decoder/analyzer; restoring input linkage is forbidden.
    body = [
      String(outTempo),
      String(outBars),
      String(outSyllables),
      derivedGridToken,
      deadTokenOut,
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
  const decodedGrid = decodePackedGridToken(snapshot.gridToken, snapshot.bars, snapshot.syllables);
  const midiInput = buildMidiInputFromSnapshot(snapshot);
  const midiBytes = generateMidi(midiInput);
  const derivedMask = deriveCellStepMasksFromMidi({
    snapshot,
    decoded: decodedGrid,
    midiInput,
    midiBytes,
  });
  const derivedSubdivisionsResult = deriveCustomSubdivisionsFromMidi({
    snapshot,
    decoded: decodedGrid,
    midiInput,
    midiBytes,
  });
  const derivedSubdivisions = derivedSubdivisionsResult.subdivisions;
  const rebuiltGridToken = encodePackedGridToken({
    bars: snapshot.bars,
    syllables: snapshot.syllables,
    customSyllables: decodedGrid.customSyllables,
    accents: decodedGrid.accents,
    taDingKeys: decodedGrid.taDingKeys,
    customSubdivisions: derivedSubdivisions,
    customMultipliers: decodedGrid.customMultipliers,
    pulseMeterUnlinked: decodedGrid.pulseMeterUnlinked,
    cellStepMasks: derivedMask.masks,
  });
  const analyzed = analyzeMidi(midiBytes);
  analyzed.noteTruth = verifyNoteTruth(snapshot, midiBytes);
  const roundtrip = buildRoundtripSnapshot(snapshot, analyzed, rebuiltGridToken);
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
    maskDerivation: {
      source: 'midi_quantized_onsets',
      sampledMappings: derivedMask.quantizationSamples,
      recoveredMaskCells: Object.keys(derivedMask.masks).length,
      recoveredSubdivisions: Object.keys(derivedSubdivisions).length,
      subdivisionTraceByLinearCell: derivedSubdivisionsResult.traceByLinearCell,
      expectedMaskedCells: derivedMask.expectedMaskedCells,
      reconstructedMaskedCells: derivedMask.reconstructedMaskedCells,
      extraMaskedCells: derivedMask.extraMaskedCells,
      missingMaskedCells: derivedMask.missingMaskedCells,
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

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href;
})();

if (isMain) {
  run().catch((err) => {
    console.error('[snapshot-roundtrip] failed:', err);
    process.exitCode = 1;
  });
}
