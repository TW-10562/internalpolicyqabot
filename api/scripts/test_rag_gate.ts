import assert from 'node:assert/strict';
import { parseStructuredResponse, validateCitations, RagDoc } from '@/service/ragGuard';

const docs: RagDoc[] = [
  {
    id: 'doc-1',
    title: 'Overtime Policy',
    content: 'Overtime requires manager approval. Submit the request in the HR system.',
  },
];

const validPayload = JSON.stringify({
  answer: 'Overtime requires manager approval.[1]',
  citations: [
    { source_id: 'doc-1', title: 'Overtime Policy', quote: 'Overtime requires manager approval.' },
  ],
  confidence: 'high',
  clarifying_question: null,
  cannot_answer_reason: null,
});

const invalidQuotePayload = JSON.stringify({
  answer: 'Overtime requires manager approval.[1]',
  citations: [
    { source_id: 'doc-1', title: 'Overtime Policy', quote: 'Approval is automatic.' },
  ],
  confidence: 'high',
});

const missingInlineCitationPayload = JSON.stringify({
  answer: 'Overtime requires manager approval.',
  citations: [
    { source_id: 'doc-1', title: 'Overtime Policy', quote: 'Overtime requires manager approval.' },
  ],
  confidence: 'high',
});

const parsedValid = parseStructuredResponse(validPayload);
assert.equal(parsedValid.ok, true, 'valid JSON should parse');
const validCheck = validateCitations(parsedValid.data!, docs);
assert.equal(validCheck.ok, true, `valid citations should pass: ${validCheck.reasons.join(', ')}`);

const parsedInvalid = parseStructuredResponse(invalidQuotePayload);
assert.equal(parsedInvalid.ok, true, 'invalid quote JSON should parse');
const invalidCheck = validateCitations(parsedInvalid.data!, docs);
assert.equal(invalidCheck.ok, false, 'invalid quote should fail validation');

const parsedMissingInline = parseStructuredResponse(missingInlineCitationPayload);
assert.equal(parsedMissingInline.ok, true, 'missing inline citation JSON should parse');
const missingInlineCheck = validateCitations(parsedMissingInline.data!, docs);
assert.equal(missingInlineCheck.ok, false, 'missing inline citations should fail validation');

console.log('[test_rag_gate] OK');

