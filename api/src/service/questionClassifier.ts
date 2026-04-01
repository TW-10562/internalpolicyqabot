import { openaiClient } from '@/service/openai_client';
import {
  ClassificationResult,
  ClassificationInput,
  FaqDepartment,
  isFaqDepartment,
  CONFIDENCE_THRESHOLD,
} from '@/service/classification.types';

const CLASSIFIER_SYSTEM_PROMPT = `You are a strict enterprise question classifier.
Classify every user question into exactly one of these 4 departments: HR, ACC, GA, OTHERS.

Department definitions — classify by INTENT AND MEANING, not surface keywords:

HR — Human Resources:
Employment rules, employee types (full-time, contract, part-time, seconded), work rules,
leave/attendance/probation, contract renewal, remote work rules, conduct/discipline,
benefits policy from an HR perspective, onboarding/offboarding process, evaluation/appraisal.

ACC — Accounting:
Allowance amounts, subsidy amounts, reimbursement amounts, employee self-burden rates,
payment ratios, deductions, salary/payroll financial questions, meal subsidy monetary amounts,
burden rates, financial calculations, invoice processing, tax handling.

GA — General Affairs:
Business trip rules, travel policy, airfare class rules, office operations,
facility/asset/equipment policy, administrative procedures, company-provided devices
as operational/asset usage policy, parking, security access, office logistics.

OTHERS — Fallback:
Unclear questions, mixed questions spanning multiple departments without a clear primary owner,
questions not belonging to HR/ACC/GA, low-confidence or ambiguous cases.

Rules:
- Classify by the INTENT of the question, not just keywords.
- Choose exactly ONE department.
- If uncertain, choose OTHERS.
- Return ONLY a single JSON object, no markdown, no prose.

Output schema:
{
  "department": "HR" | "ACC" | "GA" | "OTHERS",
  "confidence": 0.0 to 1.0,
  "reason": "short explanation (max 120 chars)",
  "normalized_question": "normalized form of the user question"
}`;

const FALLBACK_RESULT: ClassificationResult = {
  department: 'OTHERS',
  confidence: 0,
  reason: 'classification_failed',
  normalized_question: '',
};

const extractJson = (raw: string): Record<string, unknown> => {
  const text = String(raw || '').trim();
  if (!text) throw new Error('empty model output');
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('no JSON object found');
  const parsed = JSON.parse(cleaned.slice(first, last + 1));
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('model JSON must be an object');
  }
  return parsed;
};

const normalizeConfidence = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
};

const parseClassificationResult = (raw: string, question: string): ClassificationResult => {
  const parsed = extractJson(raw);
  const dept = String(parsed.department || '').toUpperCase().trim();
  const confidence = normalizeConfidence(parsed.confidence);
  const reason = String(parsed.reason || '').trim().slice(0, 120);
  const normalized = String(parsed.normalized_question || question).trim();

  if (!isFaqDepartment(dept) || confidence < CONFIDENCE_THRESHOLD) {
    return {
      department: 'OTHERS',
      confidence,
      reason: confidence < CONFIDENCE_THRESHOLD
        ? `low_confidence(${confidence.toFixed(2)}): ${reason}`
        : `invalid_department(${dept}): ${reason}`,
      normalized_question: normalized,
    };
  }

  return {
    department: dept as FaqDepartment,
    confidence,
    reason,
    normalized_question: normalized,
  };
};

export async function classifyQuestion(input: ClassificationInput): Promise<ClassificationResult> {
  const question = String(input.question || '').trim();
  if (!question) return { ...FALLBACK_RESULT, reason: 'empty_question' };

  try {
    const content = await openaiClient.complete(
      question,
      CLASSIFIER_SYSTEM_PROMPT,
      {
        temperature: 0.1,
        max_tokens: 300,
        top_p: 0.15,
        response_format: { type: 'json_object' },
        timeout_ms: 8000,
        max_attempts: 1,
      },
    );
    return parseClassificationResult(content, question);
  } catch (e: any) {
    console.warn('[QuestionClassifier] LLM classification failed:', String(e?.message || e));
    return { ...FALLBACK_RESULT, normalized_question: question, reason: `llm_error: ${String(e?.message || '').slice(0, 80)}` };
  }
}

export async function classifyQuestionBatch(
  questions: string[],
): Promise<Map<string, ClassificationResult>> {
  const results = new Map<string, ClassificationResult>();
  const deduped = Array.from(new Set(questions.filter(Boolean)));

  await Promise.all(
    deduped.map(async (q) => {
      const result = await classifyQuestion({ question: q });
      results.set(q, result);
    }),
  );

  return results;
}
