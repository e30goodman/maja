import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MidiWriter from 'midi-writer-js';

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

  // Binary packed p1/p2/p3 token decode (multiplier section only).
  let b64 = gridToken;
  if (gridToken.startsWith('p1') || gridToken.startsWith('p2') || gridToken.startsWith('p3')) {
    b64 = gridToken.slice(2);
  } else {
    return out;
  }
  const bytes = fromBase64Url(b64);
  if (!bytes || bytes.length < 6) return out;
  let off = 0;
  const magic = bytes[off++]!;
  const version = bytes[off++]!;
  if (magic !== 0x50 || (version !== 0x01 && version !== 0x02 && version !== 0x03)) return out;
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

function generateMidiFromSnapshot(snapshot: CompactSnapshot): Uint8Array {
  const ppq = 960;
  const track = new MidiWriter.Track();
  track.setTempo(snapshot.tempo, 0);
  const deadCells = parseDeadCellsToken(snapshot.deadToken, snapshot.bars);
  const barMultipliers = parseBarMultipliersFromGridToken(snapshot.gridToken, snapshot.bars);
  const gainValue = parseGainToken(snapshot.deadToken);
  if (gainValue !== null) {
    const msb = (gainValue >> 4) & 0x0f;
    const lsb = gainValue & 0x0f;
    track.addEvent(
      new MidiWriter.ControllerChangeEvent({
        controllerNumber: GAIN_CC_MSB,
        controllerValue: msb,
        channel: 10,
        tick: 0,
      }),
    );
    track.addEvent(
      new MidiWriter.ControllerChangeEvent({
        controllerNumber: GAIN_CC_LSB,
        controllerValue: lsb,
        channel: 10,
        tick: 0,
      }),
    );
  }

  // Meter-aware decoder model:
  // - nominal beats are from bar base length (dead token) or header syllables;
  // - dead tail shortens the effective meter in that bar;
  // - bar multiplier scales local tick spacing (faster bar => shorter ticks).
  let tick = 0;
  const velocity =
    gainValue === null
      ? 55
      : Math.max(1, Math.min(127, Math.round((gainValue / 255) * 127)));
  for (let bar = 0; bar < snapshot.bars; bar++) {
    const dead = deadCells[bar];
    const nominalBeats =
      dead?.baseLen !== undefined ? Math.max(1, Math.floor(dead.baseLen)) : Math.max(1, Math.floor(snapshot.syllables));
    const effectiveBeats =
      dead?.deadStart !== undefined
        ? Math.max(1, Math.min(nominalBeats, Math.floor(dead.deadStart) - 1))
        : nominalBeats;
    const barMul = Math.max(1, Math.min(4, Math.floor(barMultipliers[bar] ?? 1)));
    const cellTicks = Math.max(1, Math.floor(ppq / barMul));
    for (let cell = 0; cell < effectiveBeats; cell++) {
      track.addEvent(
        new MidiWriter.NoteEvent({
          pitch: 42,
          startTick: tick,
          duration: `T${Math.max(1, Math.floor(cellTicks / 4))}`,
          velocity,
          channel: 10,
        }),
      );
      tick += cellTicks;
    }
  }
  const writer = new MidiWriter.Writer([track], { ticksPerBeat: ppq });
  return writer.buildFile();
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
  };
}

function buildRoundtripSnapshot(source: CompactSnapshot, analyzed: MidiAnalysis): string {
  // Compatibility-first generation:
  // - Known compact binary families (p1/p2/p3) stay stable.
  // - Unknown families use derived debug token.
  const derivedGridToken =
    source.gridToken.startsWith('p1') || source.gridToken.startsWith('p2') || source.gridToken.startsWith('p3')
      ? source.gridToken
      : `rt${analyzed.onsets.toString(36)}_${Math.round(analyzed.lastOnsetMs).toString(36)}`;
  const deadTokenOut = source.deadToken.startsWith('e:') ? analyzed.derivedNonNoteGainToken : source.deadToken;
  let body = '';
  if (source.partCount === 11) {
    // Keep 11-part legacy shape stable; only update header and accent token placeholder.
    body = [
      String(analyzed.bpm),
      String(analyzed.inferredBars),
      String(analyzed.inferredSyllables),
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
      String(analyzed.bpm),
      String(analyzed.inferredBars),
      String(analyzed.inferredSyllables),
      derivedGridToken,
      source.chaosRaw,
      source.flagsRaw,
      source.soundRaw,
    ].join('.');
  } else {
    body = [
      String(analyzed.bpm),
      String(analyzed.inferredBars),
      String(analyzed.inferredSyllables),
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
