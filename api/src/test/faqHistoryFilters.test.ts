/**
 * Regression checks for FAQ moderation filtering.
 *
 * Run:
 * npx ts-node-dev --transpile-only -r tsconfig-paths/register --exit-child src/test/faqHistoryFilters.test.ts
 */

import {
  isModerationFlaggedHistoryMetadata,
  parseHistoryMetadata,
  shouldExcludeFaqTurnForModeration,
} from '@/service/faqHistoryFilters';

type TestCase = {
  name: string;
  run: () => boolean;
};

const TEST_CASES: TestCase[] = [
  {
    name: 'parses JSON metadata payloads',
    run: () => parseHistoryMetadata('{"moderation_blocked":true}').moderation_blocked === true,
  },
  {
    name: 'ignores invalid metadata payloads',
    run: () => Object.keys(parseHistoryMetadata('{not-json}')).length === 0,
  },
  {
    name: 'detects moderation_blocked history turns',
    run: () => isModerationFlaggedHistoryMetadata('{"moderation_blocked":true}') === true,
  },
  {
    name: 'detects moderation_flagged history turns',
    run: () => isModerationFlaggedHistoryMetadata({ moderation_flagged: true }) === true,
  },
  {
    name: 'does not exclude normal turns',
    run: () => shouldExcludeFaqTurnForModeration('{"rag_used":true}', '{"sourceCount":2}') === false,
  },
  {
    name: 'excludes turns when the user message was moderation-flagged',
    run: () => shouldExcludeFaqTurnForModeration('{"moderation_flagged":true}', '{}') === true,
  },
  {
    name: 'excludes turns when the assistant message was moderation-blocked',
    run: () => shouldExcludeFaqTurnForModeration('{}', '{"moderation_blocked":true}') === true,
  },
];

let failed = 0;

for (const testCase of TEST_CASES) {
  const ok = testCase.run();
  console.log(`${ok ? 'PASS' : 'FAIL'} ${testCase.name}`);
  if (!ok) failed += 1;
}

process.exit(failed > 0 ? 1 : 0);
