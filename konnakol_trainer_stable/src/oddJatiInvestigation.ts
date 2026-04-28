import { mulberry32, type BarRandomizerMutable } from './randomLogic';
import { ALL_MUTATION_TYPES, applyParentModeBar, buildPhraseSchedule, type BarGenome, type ParentGenome } from './parentMode';
import { buildBarLogForParentRow, computeMuktayiCheck, type BarLog } from './lessonLogger';

function makeEmpty(): BarRandomizerMutable {
	return {
		customSyllables: {},
		accents: new Set<string>(),
		customSubdivisions: {},
		customCellSyllables: {},
		customMultipliers: {},
		deadCells: {},
	};
}

function makeParent(): ParentGenome {
	const b0: BarGenome = {
		curSyl: 4,
		accents: new Set([0, 2]),
		subdivisions: {},
	};
	return { bars: [b0] };
}

function computeLandingModulo(bars: readonly BarLog[], cycle: number = 8): { mod: number; globalPulse: number; idx: number } {
	const lastBar = bars[bars.length - 1]!;
	let lastIdx = lastBar.syllables.length - 1;
	while (lastIdx >= 0) {
		const tok = (lastBar.syllables[lastIdx] ?? '').trim().toLowerCase();
		if (tok !== '' && tok !== '-' && tok !== '—' && tok !== '.') break;
		lastIdx--;
	}
	let pulsesBefore = 0;
	for (let i = 0; i < bars.length - 1; i++) pulsesBefore += bars[i]!.syllables.length;
	const globalPulse = pulsesBefore + Math.max(0, lastIdx);
	return { mod: ((globalPulse % cycle) + cycle) % cycle, globalPulse, idx: lastIdx };
}

type SeedResult = {
	seed: number;
	ok: boolean;
	mod: number;
	globalPulse: number;
	oddCycleKinds: number[];
	bridgeKind?: string;
	prepLen?: number;
	lastBars: Array<{
		bar: number;
		role: string;
		localCycleLength?: number;
		deSyncJati?: boolean;
		bridgeKind?: string;
		pulseOffsetBeforeBar?: number;
		totalCells: number;
	}>;
};

function runSeed(seed: number): SeedResult | null {
	const schedule = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(seed),
		progressiveDensityMode: 'gati_mode',
		deSyncJati: false,
		chaosLevel: 35,
		motifPulseLen: 4,
	});
	const oddCycles = new Set<number>();
	for (const role of schedule) {
		const l = (role as { localCycleLength?: number }).localCycleLength;
		if (l === 7 || l === 9) oddCycles.add(l);
	}
	if (oddCycles.size === 0) return null;

	const m = makeEmpty();
	const parent = makeParent();
	const bars: BarLog[] = [];
	for (let i = 0; i < schedule.length; i++) {
		applyParentModeBar({
			barIdx: i,
			parent,
			schedule,
			chaos: 70,
			syllablesDefault: 4,
			m,
			rng: mulberry32(seed + i),
			freeAxes: {
				randomPulsation: false,
				randomPattern: false,
				randomSpeed: false,
				randomBarSpeed: false,
				forceFirstBeat: false,
			},
		});
		bars.push(
			buildBarLogForParentRow(i, schedule[i]!, 60, 4, {
				customSyllables: m.customSyllables,
				accents: m.accents,
				customSubdivisions: m.customSubdivisions,
				customCellSyllables: m.customCellSyllables,
				deadCells: m.deadCells,
			}),
		);
	}
	const check = computeMuktayiCheck(bars);
	const landing = computeLandingModulo(bars);
	const tail = bars.slice(-10);
	const tailBridge = tail.find((b) => b.bridgeKind === 'gati_prep');
	return {
		seed,
		ok: check.ok,
		mod: landing.mod,
		globalPulse: landing.globalPulse,
		oddCycleKinds: [...oddCycles].sort((a, b) => a - b),
		bridgeKind: tailBridge?.bridgeKind,
		prepLen: tailBridge?.totalCells,
		lastBars: tail.map((b) => ({
			bar: b.index + 1,
			role: b.mutationKind ?? 'unknown',
			localCycleLength: b.localJati,
			deSyncJati: b.deSyncJati,
			bridgeKind: b.bridgeKind,
			pulseOffsetBeforeBar: b.pulseOffsetBeforeBar,
			totalCells: b.totalCells ?? b.subdivision,
		})),
	};
}

function collect(limit: number): void {
	const pass: SeedResult[] = [];
	const fail: SeedResult[] = [];
	const near: SeedResult[] = [];
	for (let seed = 1; seed <= limit; seed++) {
		const r = runSeed(seed);
		if (!r) continue;
		if (r.ok) pass.push(r);
		else fail.push(r);
		if (Math.abs(r.mod - 7) <= 1 || r.mod === 0) near.push(r);
	}
	const out = {
		limit,
		collected: pass.length + fail.length,
		pass: pass.length,
		fail: fail.length,
		near: near.length,
		samplePass: pass.slice(0, 6),
		sampleFail: fail.slice(0, 6),
		sampleNear: near.slice(0, 6),
		reference: runSeed(3478844360),
	};
	console.log(JSON.stringify(out, null, 2));
}

const max = Number.parseInt(process.argv[2] ?? '10000', 10);
collect(Number.isFinite(max) && max > 0 ? max : 10000);
