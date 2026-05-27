#!/usr/bin/env node
/**
 * External snapshot loop test (outside app runtime).
 * Can decode provided snapshot OR synthesize one with fake divs0.
 * Applies decoded data to fake grid, repeats encode/decode/apply in a loop.
 *
 * Usage:
 *   node regression/snapshot_loop_external.mjs "<snapshot>" [loops]
 *   node regression/snapshot_loop_external.mjs --synthesize-divs0 [loops]
 */

function fromBase64Url(token) {
	const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
	const pad = (4 - (b64.length % 4)) % 4;
	return Buffer.from(b64 + '='.repeat(pad), 'base64');
}

function readU16(bytes, offRef) {
	const off = offRef.value;
	if (off + 1 >= bytes.length) return null;
	const v = (bytes[off] << 8) | bytes[off + 1];
	offRef.value += 2;
	return v;
}

function toBase64Url(bytes) {
	return Buffer.from(bytes)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function pushU16(out, value) {
	out.push((value >> 8) & 0xff, value & 0xff);
}

function buildCellIndexMap(bars, syllables, customSyllables) {
	const out = [];
	for (let r = 0; r < bars; r++) {
		const rowSyl = Number.isFinite(customSyllables[r]) ? customSyllables[r] : syllables;
		for (let c = 0; c < rowSyl; c++) out.push(`${r}-${c}`);
	}
	return out;
}

function packP4GridToken(snapshot) {
	const out = [];
	const bars = Math.max(1, Math.min(255, snapshot.bars));
	const syllables = Math.max(1, Math.min(9, snapshot.syllables));
	const cells = buildCellIndexMap(bars, syllables, snapshot.customSyllables || {});
	// 0x50 + v4 + bars + syllables
	out.push(0x50, 0x04, bars, syllables);
	// row custom syllables (sparse)
	const rowEntries = Object.entries(snapshot.customSyllables || {})
		.map(([k, v]) => [Number.parseInt(k, 10), Number.parseInt(String(v), 10)])
		.filter(([r, v]) => Number.isFinite(r) && r >= 0 && r < bars && Number.isFinite(v) && v >= 1 && v <= 9)
		.sort((a, b) => a[0] - b[0]);
	out.push(Math.min(255, rowEntries.length));
	for (const [r, v] of rowEntries.slice(0, 255)) out.push(r & 0xff, v & 0xff);
	// cell count
	pushU16(out, Math.min(65535, cells.length));
	// accents bitmap (all zero for fake test)
	out.push(...Array.from({ length: Math.ceil(cells.length / 8) }, () => 0));
	// ta bitmap (all zero)
	out.push(...Array.from({ length: Math.ceil(cells.length / 8) }, () => 0));
	// subdivisions entries: only 2..9
	const subEntries = [];
	for (let i = 0; i < cells.length; i++) {
		const k = cells[i];
		const v = snapshot.customSubdivisions?.[k];
		if (typeof v === 'number' && v >= 2 && v <= 9) subEntries.push([i, v]);
	}
	pushU16(out, Math.min(65535, subEntries.length));
	for (const [idx, v] of subEntries.slice(0, 65535)) {
		pushU16(out, idx);
		out.push(v & 0xff);
	}
	// multipliers count=0
	out.push(0);
	// pulse unlinked count=0
	out.push(0);
	// accent map version=1
	out.push(1);
	// step masks entries (v4)
	const maskEntries = [];
	for (let i = 0; i < cells.length; i++) {
		const k = cells[i];
		const subdivs = snapshot.customSubdivisions?.[k] ?? 1;
		const mask = snapshot.cellStepMasks?.[k] ?? Array.from({ length: subdivs }, () => true);
		if (mask.every((x) => x === true)) continue;
		let bits = 0;
		for (let b = 0; b < mask.length; b++) if (mask[b]) bits |= (1 << b);
		maskEntries.push([i, mask.length, bits]);
	}
	pushU16(out, Math.min(65535, maskEntries.length));
	for (const [idx, len, bits] of maskEntries.slice(0, 65535)) {
		pushU16(out, idx);
		out.push(len & 0xff, bits & 0xff, (bits >> 8) & 0xff);
	}
	return `p4${toBase64Url(Uint8Array.from(out))}`;
}

function buildCompactSnapshotString(snapshot) {
	const gridToken = packP4GridToken(snapshot);
	return `(⁠ʘ⁠ᴗ⁠ʘ⁠)⁠♪:${snapshot.tempo}.${snapshot.bars}.${snapshot.syllables}.${gridToken}.0.${snapshot.chaosLevel}.172.0`;
}

function parseCompact(snapshotText) {
	const markerIdx = snapshotText.indexOf(':');
	if (markerIdx < 0) throw new Error('No marker ":" in snapshot text');
	const body = snapshotText.slice(markerIdx + 1).trim();
	const parts = body.split('.');
	if (parts.length !== 8) throw new Error(`Expected compact 8-part snapshot, got ${parts.length}`);

	const [tempoRaw, barsRaw, sylRaw, gridToken, deadCellsToken, chaosRaw, flagsRaw, soundRaw] = parts;
	const tempo = Number.parseInt(tempoRaw, 10);
	const bars = Number.parseInt(barsRaw, 10);
	const syllables = Number.parseInt(sylRaw, 10);
	const chaos = Number.parseInt(chaosRaw, 10);
	const flags = Number.parseInt(flagsRaw, 10);
	const sound = Number.parseInt(soundRaw, 10);
	if (![tempo, bars, syllables, chaos, flags, sound].every(Number.isFinite)) {
		throw new Error('Invalid numeric fields in compact snapshot');
	}
	if (deadCellsToken !== '0') {
		// We keep parser strict/simple for this detector script.
		throw new Error('deadCells token supported only as 0 in this external checker');
	}
	return { tempo, bars, syllables, gridToken, chaos, flags, sound };
}

function unpackGridToken(gridToken, bars, syllables) {
	if (!/^p[1-4]/.test(gridToken)) throw new Error('Grid token is not packed p1/p2/p3/p4');
	const bytes = fromBase64Url(gridToken.slice(2));
	const offRef = { value: 0 };

	const magic = bytes[offRef.value++];
	const version = bytes[offRef.value++];
	if (magic !== 0x50) throw new Error('Invalid grid token magic');
	if (![1, 2, 3, 4].includes(version)) throw new Error(`Unsupported grid token version ${version}`);

	const barsIn = bytes[offRef.value++];
	const sylIn = bytes[offRef.value++];
	const rowCount = bytes[offRef.value++];
	const customSyllables = {};
	for (let i = 0; i < rowCount; i++) {
		const r = bytes[offRef.value++];
		const v = bytes[offRef.value++];
		customSyllables[r] = v;
	}

	const cellCount = readU16(bytes, offRef);
	if (cellCount === null) throw new Error('Bad cell count');
	const cells = buildCellIndexMap(barsIn, sylIn, customSyllables);
	const cappedCellCount = Math.min(cellCount, cells.length);

	// Accents bitmap
	const accBytesLen = Math.ceil(cappedCellCount / 8);
	offRef.value += accBytesLen;
	// Ta bitmap for v3+
	if (version >= 3) {
		const taBytesLen = Math.ceil(cappedCellCount / 8);
		offRef.value += taBytesLen;
	}

	const subCount = readU16(bytes, offRef);
	if (subCount === null) throw new Error('Bad subdivision count');
	const customSubdivisions = {};
	for (let i = 0; i < subCount; i++) {
		const idx = readU16(bytes, offRef);
		if (idx === null) throw new Error('Bad subdivision idx');
		const v = bytes[offRef.value++];
		if (idx < cells.length && v >= 2 && v <= 9) customSubdivisions[cells[idx]] = v;
	}

	// multipliers
	const multCount = bytes[offRef.value++];
	offRef.value += multCount * 2;
	// pulse rows
	const pulseCount = bytes[offRef.value++];
	offRef.value += pulseCount;
	// accentMapVersion byte for v2+
	if (version >= 2 && offRef.value < bytes.length) offRef.value++;

	const cellStepMasks = {};
	if (version >= 4) {
		const maskCount = readU16(bytes, offRef);
		if (maskCount === null) throw new Error('Bad mask count');
		for (let i = 0; i < maskCount; i++) {
			const idx = readU16(bytes, offRef);
			if (idx === null) throw new Error('Bad mask idx');
			const len = bytes[offRef.value++];
			const lo = bytes[offRef.value++];
			const hi = bytes[offRef.value++];
			if (idx >= cells.length || len < 1 || len > 9) continue;
			const bits = lo | (hi << 8);
			const arr = Array.from({ length: len }, (_, b) => ((bits >> b) & 1) === 1);
			if (!arr.every((x) => x === true)) cellStepMasks[cells[idx]] = arr;
		}
	}

	return {
		version,
		barsHeader: bars,
		syllablesHeader: syllables,
		barsPacked: barsIn,
		syllablesPacked: sylIn,
		customSyllables,
		customSubdivisions,
		cellStepMasks,
		cells,
	};
}

function buildFakeGrid(decoded) {
	const grid = {};
	for (const cell of decoded.cells) {
		const subdivs = decoded.customSubdivisions[cell] ?? 1;
		const mask = decoded.cellStepMasks[cell] ?? Array.from({ length: subdivs }, () => true);
		grid[cell] = {
			subdivs,
			mask,
			isDivs0: mask.every((x) => x === false),
		};
	}
	return grid;
}

function countDivs0(grid) {
	let n = 0;
	for (const v of Object.values(grid)) if (v.isDivs0) n++;
	return n;
}

function main() {
	const synthMode = process.argv[2] === '--synthesize-divs0';
	const snapshot = synthMode ? null : process.argv[2];
	const loopsArg = synthMode ? process.argv[3] : process.argv[3];
	const loops = Number.parseInt(loopsArg ?? '200', 10);
	const requireDivs0 = process.argv.includes('--require-divs0');
	if (!snapshot && !synthMode) {
		console.error('Usage: node regression/snapshot_loop_external.mjs "<snapshot>" [loops] [--require-divs0]');
		console.error('   or: node regression/snapshot_loop_external.mjs --synthesize-divs0 [loops] [--require-divs0]');
		process.exit(1);
	}
	if (!Number.isFinite(loops) || loops < 1) {
		console.error('loops must be >= 1');
		process.exit(1);
	}

	let sourceSnapshot = snapshot;
	if (synthMode) {
		// Fake grid case requested by user: one cell with divs0 detector.
		const synthetic = {
			tempo: 100,
			bars: 4,
			syllables: 4,
			chaosLevel: 15,
			customSyllables: {},
			customSubdivisions: { '0-1': 2 },
			cellStepMasks: { '0-1': [false, false] }, // divs0 encoded as all-false mask
		};
		sourceSnapshot = buildCompactSnapshotString(synthetic);
	}
	const compact = parseCompact(sourceSnapshot);
	let decoded = unpackGridToken(compact.gridToken, compact.bars, compact.syllables);
	const hasDivs0Encoded = Object.values(decoded.cellStepMasks).some((mask) => Array.isArray(mask) && mask.every((x) => x === false));
	let baselineDivs0 = null;
	let drift = false;
	let stoppedOnLoop = null;
	for (let i = 0; i < loops; i++) {
		// "Insert snapshot automatically": re-create compact snapshot from decoded fake grid every loop.
		const regeneratedSnapshot = buildCompactSnapshotString({
			tempo: compact.tempo,
			bars: compact.bars,
			syllables: compact.syllables,
			chaosLevel: compact.chaos,
			customSyllables: decoded.customSyllables,
			customSubdivisions: decoded.customSubdivisions,
			cellStepMasks: decoded.cellStepMasks,
		});
		const compactLoop = parseCompact(regeneratedSnapshot);
		decoded = unpackGridToken(compactLoop.gridToken, compactLoop.bars, compactLoop.syllables);
		const grid = buildFakeGrid(decoded);
		const cur = countDivs0(grid);
		if (baselineDivs0 === null) baselineDivs0 = cur;
		if (cur > 0) {
			stoppedOnLoop = i;
			break;
		}
		if (cur !== baselineDivs0) {
			drift = true;
			console.error(`Loop drift at #${i}: ${cur} != ${baselineDivs0}`);
			break;
		}
	}

	console.log(JSON.stringify({
		ok: !drift,
		loops,
		hasDivs0Encoded,
		mode: synthMode ? 'synthetic_divs0' : 'provided_snapshot',
		snapshot: sourceSnapshot,
		stoppedOnDivs0Loop: stoppedOnLoop,
		gridVersion: decoded.version,
		barsHeader: compact.bars,
		syllablesHeader: compact.syllables,
		barsPacked: decoded.barsPacked,
		syllablesPacked: decoded.syllablesPacked,
		subdivisions: decoded.customSubdivisions,
		cellStepMasks: decoded.cellStepMasks,
		divs0Count: baselineDivs0,
		note: decoded.version < 4
			? 'p1/p2/p3 packed format does not carry cellStepMasks; divs0 cannot be represented there.'
			: 'p4 carries cellStepMasks; divs0 can be represented.',
	}, null, 2));

	if (requireDivs0 && !hasDivs0Encoded) {
		console.error('FAIL: snapshot does not encode divs0 (no all-false cellStepMask found).');
		process.exit(2);
	}
}

main();
