import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const cases = JSON.parse(await readFile(new URL('evals/ai-cases.json', root), 'utf8'));
assert.ok(Array.isArray(cases) && cases.length > 0);
assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
for (const item of cases) {
  assert.equal(typeof item.text, 'string');
  assert.match(item.referenceDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(item.expected) && item.expected.length > 0);
}
if (!process.argv.includes('--live')) {
  console.log(`Validated ${cases.length} synthetic cases. No model was called; this is not an AI accuracy result.`);
  console.log('Run with --live --limit 2 to evaluate real DeepSeek responses using the server-side .env key.');
  process.exit(0);
}
if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('Configure DEEPSEEK_API_KEY in the ignored .env file before live evaluation.');
const limitIndex = process.argv.indexOf('--limit');
const limit = limitIndex < 0 ? cases.length : Number(process.argv[limitIndex + 1]);
assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= cases.length, `--limit must be 1..${cases.length}`);
const { createDeepSeekAI } = await import('../server/ai.mjs');
const ai = createDeepSeekAI({ apiKey:process.env.DEEPSEEK_API_KEY, model:process.env.DEEPSEEK_MODEL || 'deepseek-flash' });
const results = [];
for (const item of cases.slice(0, limit)) {
  try {
    const output = await ai.extract({text:item.text, referenceDate:item.referenceDate});
    const checks = [];
    const remaining = [...output.events];
    for (const expected of item.expected) {
      const index = remaining.findIndex(event => event.kind === expected.kind && event.title.includes(expected.titleIncludes));
      const actual = index >= 0 ? remaining.splice(index, 1)[0] : null;
      checks.push({field:'event_match',expected:expected.titleIncludes,passed:Boolean(actual)});
      for (const [field,value] of Object.entries(expected)) {
        if (['kind','titleIncludes'].includes(field)) continue;
        checks.push({field,expected:value,actual:actual?.[field] ?? null,passed:actual?.[field] === value});
      }
    }
    checks.push({field:'unexpected_event_count',expected:0,actual:remaining.length,passed:remaining.length === 0});
    // Traceability proves that a quote was located in the input; it does not
    // establish whether the event's interpretation or extracted fields are right.
    checks.push({field:'all_evidence_verified',expected:true,actual:output.events.every(event => event.aiEvidence?.verified === true),passed:output.events.every(event => event.aiEvidence?.verified === true)});
    checks.push({field:'all_unconfirmed',passed:output.events.every(event => event.dateConfirmed === false)});
    const result = {id:item.id,provider:output.provider,model:output.model,promptVersion:output.promptVersion,checks,passed:checks.every(check => check.passed),eventCount:output.events.length,usage:output.usage};
    results.push(result);
    console.log(`${item.id}: ${result.passed ? 'PASS' : 'REVIEW'} (${checks.filter(check => check.passed).length}/${checks.length} defined checks)`);
  } catch (error) {
    // Error codes are safe metadata; never print upstream bodies or credentials.
    results.push({id:item.id,passed:false,errorCode:error.code || 'EVALUATION_FAILED'});
    console.log(`${item.id}: FAILED (${error.code || 'EVALUATION_FAILED'})`);
  }
}
const report = {evaluatedAt:new Date().toISOString(),dataset:'synthetic notices; not a user study',evidenceScope:'Evidence verification checks quote traceability only, not semantic correctness.',caseCount:results.length,passedCases:results.filter(result => result.passed).length,results};
await mkdir(new URL('artifacts/', root), {recursive:true});
await writeFile(new URL('artifacts/ai-eval-latest.json', root), JSON.stringify(report,null,2));
console.log(`Live report saved locally. ${report.passedCases}/${report.caseCount} cases passed the defined checks.`);
if (report.passedCases !== report.caseCount) process.exitCode = 1;
