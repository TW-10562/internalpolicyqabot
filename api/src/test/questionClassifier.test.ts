/**
 * Test suite for QuestionClassifier and FaqCategoryService.
 *
 * Run: npx ts-node -r tsconfig-paths/register src/test/questionClassifier.test.ts
 *
 * Requires LLM endpoint to be available (LLM_BASE_URL).
 */

import { classifyQuestion, classifyQuestionBatch } from '@/service/questionClassifier';
import { ClassificationResult, FaqDepartment } from '@/service/classification.types';
import { resolveFaqDepartment } from '@/service/faqCategoryService';

type TestCase = {
  question: string;
  expected: FaqDepartment;
  description: string;
};

const TEST_CASES: TestCase[] = [
  // ─── HR cases ───
  {
    question: 'What kind of person is referred to as a contracted employee?',
    expected: 'HR',
    description: 'EN: employee type classification',
  },
  {
    question: '契約更新の最大回数は何ですか？',
    expected: 'HR',
    description: 'JA: contract renewal policy',
  },
  {
    question: 'Is it allowed to use a PC for purposes other than work while working from home?',
    expected: 'HR',
    description: 'EN: remote work conduct rules',
  },
  {
    question: '嘱託社員は出張を命じられることはありますか？',
    expected: 'HR',
    description: 'JA: seconded employee work rules',
  },
  {
    question: 'How many paid leave days do I get after 6 months?',
    expected: 'HR',
    description: 'EN: leave entitlement',
  },

  // ─── ACC cases ───
  {
    question: '食事電子マネーの会社補助率と従業員の自己負担率はそれぞれ何％ですか',
    expected: 'ACC',
    description: 'JA: meal subsidy burden rate',
  },
  {
    question: 'how much money for meal subsidy?',
    expected: 'ACC',
    description: 'EN: subsidy amount',
  },
  {
    question: '有効期限が切れた食事電子マネーはどうなりますか。',
    expected: 'ACC',
    description: 'JA: expired meal e-money handling',
  },
  {
    question: 'What is the reimbursement amount for commuting expenses?',
    expected: 'ACC',
    description: 'EN: reimbursement calculation',
  },

  // ─── GA cases ───
  {
    question: '役員はいつビジネスクラスの航空運賃を利用できますか？',
    expected: 'GA',
    description: 'JA: airfare class policy',
  },
  {
    question: '出張旅費のルールは？',
    expected: 'GA',
    description: 'JA: business trip rules',
  },
  {
    question: 'What is the policy for domestic business trip expenses?',
    expected: 'GA',
    description: 'EN: travel expense policy',
  },

  // ─── OTHERS cases ───
  {
    question: 'hello',
    expected: 'OTHERS',
    description: 'EN: greeting / non-question',
  },
  {
    question: 'What is the weather today?',
    expected: 'OTHERS',
    description: 'EN: unrelated question',
  },

  // ─── Mixed-signal cases: monetary vocabulary + HR policy intent ───
  {
    question: '勤続年数が3年未満で自己都合退職した場合、事業主掛金はどのように扱われますか？',
    expected: 'HR',
    description: 'JA: retirement vesting policy — monetary words but HR policy ownership',
  },
  {
    question: '育児休業中の社会保険料はどうなりますか？',
    expected: 'HR',
    description: 'JA: childcare leave insurance — insurance terms but HR leave policy',
  },
  {
    question: '食事補助の支給条件は？',
    expected: 'HR',
    description: 'JA: meal benefit eligibility — subsidy term but asking about eligibility rules',
  },
  {
    question: 'What are the conditions to qualify for the retirement pension plan?',
    expected: 'HR',
    description: 'EN: pension eligibility — pension/money context but HR policy question',
  },

  // ─── Mixed-signal cases: GA context with monetary surface ───
  {
    question: '出張時のホテル代の上限金額は？',
    expected: 'GA',
    description: 'JA: hotel limit for business trip — amount question but GA travel policy',
  },

  // ─── Genuine ACC cases that should remain ACC ───
  {
    question: '通勤手当の金額はいくらですか？',
    expected: 'ACC',
    description: 'JA: commuting allowance specific amount — genuine financial question',
  },
  {
    question: '退職金の計算方法を教えてください',
    expected: 'ACC',
    description: 'JA: retirement pay calculation method — asking for formula/number',
  },
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function runTests() {
  console.log('=== QuestionClassifier Test Suite ===\n');

  // Test 1: Individual classification
  console.log('--- Test: Individual Classification ---');
  for (const tc of TEST_CASES) {
    const result = await classifyQuestion({ question: tc.question });
    const ok = result.department === tc.expected;
    const icon = ok ? '✓' : '✗';
    console.log(`  ${icon} [${tc.expected}] ${tc.description}`);
    console.log(`    Q: "${tc.question.slice(0, 70)}${tc.question.length > 70 ? '...' : ''}"`);
    console.log(`    Got: ${result.department} (${result.confidence.toFixed(2)}) — ${result.reason}`);
    if (ok) {
      passed++;
    } else {
      failed++;
      failures.push(`Expected ${tc.expected}, got ${result.department}: "${tc.question}"`);
    }
  }

  // Test 2: Batch classification
  console.log('\n--- Test: Batch Classification ---');
  const batchQuestions = TEST_CASES.slice(0, 5).map((tc) => tc.question);
  const batchResults = await classifyQuestionBatch(batchQuestions);
  const batchOk = batchResults.size === batchQuestions.length;
  console.log(`  ${batchOk ? '✓' : '✗'} Batch returned ${batchResults.size}/${batchQuestions.length} results`);
  if (batchOk) passed++;
  else { failed++; failures.push('Batch size mismatch'); }

  // Test 3: Semantic classification overrides conflicting source-doc metadata
  console.log('\n--- Test: Semantic Override of Metadata ---');
  const pensionQ = '勤続年数が3年未満で自己都合退職した場合、事業主掛金はどのように扱われますか？';
  const overrideResult = await resolveFaqDepartment(pensionQ, 'ACC');
  const overrideOk = overrideResult.department === 'HR';
  console.log(`  ${overrideOk ? '✓' : '✗'} Semantic HR classification overrides source-doc ACC`);
  console.log(`    Q: "${pensionQ.slice(0, 60)}..."`);
  console.log(`    Source-doc: ACC | Got: ${overrideResult.department} (${overrideResult.confidence.toFixed(2)}) — ${overrideResult.reason}`);
  if (overrideOk) passed++;
  else { failed++; failures.push(`Semantic override failed: expected HR, got ${overrideResult.department} for pension vesting Q with ACC source-doc`); }

  // Test 4: Agreement between LLM and source-doc boosts confidence
  console.log('\n--- Test: Source-Doc Agreement Boost ---');
  const leaveQ = 'How many paid leave days do I get after 6 months?';
  const agreeResult = await resolveFaqDepartment(leaveQ, 'HR');
  const agreeOk = agreeResult.department === 'HR' && agreeResult.confidence > 0.6;
  console.log(`  ${agreeOk ? '✓' : '✗'} LLM+source-doc agreement produces HR with high confidence`);
  console.log(`    Got: ${agreeResult.department} (${agreeResult.confidence.toFixed(2)}) — ${agreeResult.reason}`);
  if (agreeOk) passed++;
  else { failed++; failures.push('Source-doc agreement boost failed'); }

  // Test 5: Null source-doc falls through to LLM
  console.log('\n--- Test: Null Source-Doc Fallback ---');
  const nullSrcResult = await resolveFaqDepartment(leaveQ, null);
  const nullSrcOk = nullSrcResult.department === 'HR';
  console.log(`  ${nullSrcOk ? '✓' : '✗'} Null source-doc → LLM-only classification`);
  console.log(`    Got: ${nullSrcResult.department} (${nullSrcResult.confidence.toFixed(2)}) — ${nullSrcResult.reason}`);
  if (nullSrcOk) passed++;
  else { failed++; failures.push('Null source-doc fallback failed'); }

  // Test 6: Empty question fallback
  console.log('\n--- Test: Edge Cases ---');
  const emptyResult = await classifyQuestion({ question: '' });
  const emptyOk = emptyResult.department === 'OTHERS';
  console.log(`  ${emptyOk ? '✓' : '✗'} Empty question -> OTHERS`);
  if (emptyOk) passed++;
  else { failed++; failures.push('Empty question did not fallback to OTHERS'); }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
