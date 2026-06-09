import assert from 'node:assert/strict';
import {
	cycleBarRepriseCount,
	DEFAULT_BAR_REPRISE_COUNT,
	resolveBarRepriseCount,
} from './fusedBarGroups';

assert.equal(DEFAULT_BAR_REPRISE_COUNT, 1);
assert.equal(cycleBarRepriseCount(undefined), 2);
assert.equal(cycleBarRepriseCount(2), 4);
assert.equal(cycleBarRepriseCount(4), 1);
assert.equal(resolveBarRepriseCount(0, {}), 1);
assert.equal(resolveBarRepriseCount(0, { 0: 2 }), 2);
assert.equal(resolveBarRepriseCount(0, { 0: 4 }), 4);

console.log('fusedBarGroups reprise: ok');
