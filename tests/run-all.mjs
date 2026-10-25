import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  'verify-publication.mjs',
  'verify-quiz.mjs',
  'verify-subjective.mjs',
  'verify-judge.mjs',
  'verify-thinking.mjs',
  'verify-audit-fixes.mjs',
];

let failed = 0;
for (const suite of suites) {
  console.log(`\n===== ${suite} =====`);
  const result = spawnSync(process.execPath, [path.join(root, suite)], {
    cwd: path.dirname(root),
    stdio: 'inherit',
  });
  if (result.status !== 0) failed++;
}

console.log(`\n${failed === 0 ? 'ALL TEST SUITES PASSED' : failed + ' TEST SUITE(S) FAILED'}`);
process.exitCode = failed ? 1 : 0;
