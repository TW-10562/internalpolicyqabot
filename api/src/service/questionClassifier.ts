import { openaiClient } from '@/service/openai_client';
import {
  ClassificationResult,
  ClassificationInput,
  FaqDepartment,
  isFaqDepartment,
  CONFIDENCE_THRESHOLD,
} from '@/service/classification.types';

const CLASSIFIER_SYSTEM_PROMPT = `You are a strict enterprise FAQ classifier for a Japanese corporation.
Classify every user question into exactly one department: HR, ACC, GA, or OTHERS.

─── CLASSIFICATION PRINCIPLE ───
Classify by POLICY OWNERSHIP: which department writes, maintains, and interprets the policy the question asks about.
Do NOT classify by surface vocabulary alone. Monetary words do not automatically mean ACC.
Office-related words do not automatically mean GA. Always identify the underlying policy domain first.

─── DEPARTMENT DEFINITIONS ───

HR — Human Resources (人事):
Questions about policies that HR owns and interprets.
• Employment lifecycle: hiring, onboarding, probation, contract types/renewal, termination, resignation, retirement, offboarding
• Work rules: attendance, leave, remote work, working hours, conduct, discipline
• Employee types and status: full-time, contract, part-time, seconded, probationary
• Benefit and welfare POLICY: eligibility rules, vesting conditions, enrollment criteria, plan structure
• Retirement/pension POLICY: vesting schedules, what happens to contributions upon resignation, plan rules, eligibility periods
• Evaluation, promotion, transfer, secondment policy
Key test: the answer would come from an HR policy manual or employment rulebook, even if the question mentions money or contributions.

ACC — Accounting (経理):
Questions about financial calculations, specific monetary amounts, and payment processing.
• Specific amounts: "how much is X?", "what percentage is Y?"
• Subsidy/allowance monetary values, self-burden percentages, reimbursement amounts
• Payroll calculations: salary components, tax withholding, deduction amounts
• Invoice and payment processing, financial reporting, expense settlement
• Meal subsidy monetary amounts, commuting allowance calculations
Key test: the asker wants a NUMBER, a RATE, or a CALCULATION — not an eligibility rule or policy interpretation.

GA — General Affairs (総務):
Questions about operational, facility, and administrative policies that GA manages.
• Business travel rules and logistics: trip approval, airfare class policy, hotel standards
• Office operations: facility access, parking, security, meeting rooms
• Equipment and asset policy: company devices, fleet, supplies
• Administrative procedures: document management, mail, vendor coordination
Key test: the policy governs how the company's physical or operational infrastructure is used.

OTHERS — Fallback:
• Questions not clearly belonging to HR, ACC, or GA
• Ambiguous questions where no single department is the obvious policy owner
• Off-topic, greetings, or non-work questions

─── DECISION PROCESS ───
Follow these steps:
1. Identify the USER'S INTENT: What does the asker actually want to know?
2. Identify the POLICY DOMAIN: Which department's rulebook or manual contains the answer?
3. Apply the OWNERSHIP TEST: Which department would be responsible for writing and updating this policy?
4. CHECK FOR SURFACE-WORD TRAPS: If the question mentions money/contributions but asks about eligibility, conditions, or rules → the policy owner (often HR), not ACC. If it mentions office/facilities but asks about work conduct → likely HR, not GA.
5. Output your classification.

─── RULES ───
- Choose exactly ONE department.
- When a question contains monetary or financial vocabulary but the core intent is about policy rules, eligibility, or conditions, classify by the policy owner, not by the vocabulary.
- If genuinely uncertain after applying the ownership test, choose OTHERS.
- Return ONLY a single JSON object, no markdown, no prose.

Output schema:
{
  "department": "HR" | "ACC" | "GA" | "OTHERS",
  "confidence": 0.0 to 1.0,
  "reason": "short explanation referencing the ownership test (max 150 chars)",
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
  const reason = String(parsed.reason || '').trim().slice(0, 150);
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
