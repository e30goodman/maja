import {buildPhraseSchedule,applyParentModeBar} from './src/parentMode';
import {mulberry32} from './src/randomLogic';
import {buildBarLogForParentRow} from './src/lessonLogger';
const seed=3478844360;
const parent={bars:[{curSyl:4,accents:new Set([0,2]),subdivisions:{}}]};
const enabled=['substitution','retrograde','inversion','rotation','truncation','augmentation','diminution','prepend_append','fractal','tihai','echo_decay','neighbour_pulsation','call_fill','yati'] as any;
const sched=buildPhraseSchedule({bars:32,enabledMutations:enabled,preset:'progressive',parentLength:1,rng:mulberry32(seed),progressiveDensityMode:'gati_mode',deSyncJati:false,chaosLevel:35,motifPulseLen:4});
const m={customSyllables:{},accents:new Set<string>(),customSubdivisions:{},customCellSyllables:{},customMultipliers:{},deadCells:{}} as any;
const bars:any[]=[];
for(let i=0;i<sched.length;i++){
 applyParentModeBar({barIdx:i,parent,schedule:sched,chaos:70,syllablesDefault:4,m,rng:mulberry32(seed+i),freeAxes:{randomPulsation:false,randomPattern:false,randomSpeed:false,randomBarSpeed:false,forceFirstBeat:false}});
 bars.push(buildBarLogForParentRow(i,sched[i]!,60,4,m));
}
const start=sched.findIndex((r,idx)=>idx>=24&&r.type==='tihai'&&r.phraseStep===0);
console.log('tihaiStart',start,'prevType',start>0?sched[start-1]!.type:null,'prevKind',start>0?(sched[start-1] as any).bridgeKind:null,'prevLen',start>0?(sched[start-1] as any).localCycleLength:null);
for(let i=24;i<32;i++){
 const r:any=sched[i]; const b=bars[i]; let last=b.syllables.length-1; while(last>=0&&['-','.','—',''].includes((b.syllables[last]??'').trim())) last--;
 console.log('bar',i+1,'type',r.type,'step',r.phraseStep,'off',r.pulseOffsetBeforeBar,'land',r.tihaiLandingIndex,'cells',b.syllables.length,'lastSig',last,'tok',last>=0?b.syllables[last]:null);
}
let pulses=0; for(let i=0;i<31;i++) pulses+=bars[i].syllables.length;
let last=bars[31].syllables.length-1; while(last>=0&&['-','.','—',''].includes((bars[31].syllables[last]??'').trim())) last--;
const global=pulses+Math.max(0,last);
console.log('finalGlobal',global,'mod',global%8);
