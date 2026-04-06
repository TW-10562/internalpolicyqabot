import { classifyQuestion, classifyQuestionBatch } from '@/service/questionClassifier';
import { ClassificationResult, FaqDepartment, isFaqDepartment } from '@/service/classification.types';

export type FaqClassificationEntry = {
  question: string;
  department: FaqDepartment;
  confidence: number;
  reason: string;
};

/**
 * Confidence level at which the LLM classification is considered strong enough
 * to override a conflicting source-document department signal.
 */
const SEMANTIC_OVERRIDE_THRESHOLD = 0.75;

/**
 * Confidence assigned when metadata is used as a tie-breaker for a low-confidence
 * LLM result. Intentionally set above CONFIDENCE_THRESHOLD so the result is not
 * immediately downgraded to OTHERS.
 */
const METADATA_TIEBREAK_CONFIDENCE = 0.70;

/**
 * Resolve FAQ department for a single question.
 *
 * Strategy:
 *  1. Always run LLM semantic classification first.
 *  2. If LLM and source-doc agree → use the result with boosted confidence.
 *  3. If LLM is high-confidence (>=0.75) → trust LLM even if it disagrees with source-doc.
 *  4. If LLM is low-confidence and source-doc is valid → use source-doc as a careful tie-breaker.
 *  5. Otherwise → use LLM result as-is (may fall through to OTHERS via confidence threshold).
 */
export async function resolveFaqDepartment(
  question: string,
  sourceDocDepartment: string | null,
): Promise<FaqClassificationEntry> {
  const llmResult = await classifyQuestion({ question });

  const normalizedSourceDept = String(sourceDocDepartment || '').toUpperCase().trim();
  const sourceIsValid = isFaqDepartment(normalizedSourceDept) && normalizedSourceDept !== 'OTHERS';

  // Case 1: LLM and source-doc agree — boost confidence
  if (sourceIsValid && llmResult.department === normalizedSourceDept) {
    return {
      question,
      department: llmResult.department,
      confidence: Math.min(1.0, llmResult.confidence + 0.15),
      reason: `${llmResult.reason} [confirmed by source-doc]`,
    };
  }

  // Case 2: LLM is confident — trust semantic classification over metadata
  if (llmResult.confidence >= SEMANTIC_OVERRIDE_THRESHOLD) {
    return {
      question,
      department: llmResult.department,
      confidence: llmResult.confidence,
      reason: llmResult.reason,
    };
  }

  // Case 3: LLM is uncertain but source-doc is valid — use metadata as tie-breaker
  if (sourceIsValid && llmResult.confidence < SEMANTIC_OVERRIDE_THRESHOLD) {
    return {
      question,
      department: normalizedSourceDept as FaqDepartment,
      confidence: METADATA_TIEBREAK_CONFIDENCE,
      reason: `llm_uncertain(${llmResult.confidence.toFixed(2)}), using source_doc as tiebreak`,
    };
  }

  // Case 4: No useful metadata — use LLM result as-is
  return {
    question,
    department: llmResult.department,
    confidence: llmResult.confidence,
    reason: llmResult.reason,
  };
}

/**
 * Classify a batch of FAQ questions.
 * Runs LLM classification for all items, then reconciles with source-doc metadata.
 */
export async function classifyFaqBatch(
  items: Array<{ question: string; sourceDocDepartment: string | null }>,
): Promise<Map<string, FaqClassificationEntry>> {
  const results = new Map<string, FaqClassificationEntry>();
  if (items.length === 0) return results;

  // Run LLM classification for all questions
  const allQuestions = items.map((i) => i.question).filter(Boolean);
  const llmResults = await classifyQuestionBatch(allQuestions);

  // Build a map of question→sourceDocDepartment for reconciliation
  const sourceMap = new Map<string, string | null>();
  for (const item of items) {
    sourceMap.set(item.question, item.sourceDocDepartment);
  }

  // Reconcile each result with its source-doc metadata
  for (const [question, llmResult] of llmResults) {
    const sourceDocDept = sourceMap.get(question) ?? null;
    const normalizedSourceDept = String(sourceDocDept || '').toUpperCase().trim();
    const sourceIsValid = isFaqDepartment(normalizedSourceDept) && normalizedSourceDept !== 'OTHERS';

    if (sourceIsValid && llmResult.department === normalizedSourceDept) {
      // Agreement: boost confidence
      results.set(question, {
        question,
        department: llmResult.department,
        confidence: Math.min(1.0, llmResult.confidence + 0.15),
        reason: `${llmResult.reason} [confirmed by source-doc]`,
      });
    } else if (llmResult.confidence >= SEMANTIC_OVERRIDE_THRESHOLD) {
      // LLM confident: trust semantic classification
      results.set(question, {
        question,
        department: llmResult.department,
        confidence: llmResult.confidence,
        reason: llmResult.reason,
      });
    } else if (sourceIsValid) {
      // LLM uncertain + valid metadata: tie-break with source-doc
      results.set(question, {
        question,
        department: normalizedSourceDept as FaqDepartment,
        confidence: METADATA_TIEBREAK_CONFIDENCE,
        reason: `llm_uncertain(${llmResult.confidence.toFixed(2)}), using source_doc as tiebreak`,
      });
    } else {
      // No useful metadata: use LLM as-is
      results.set(question, {
        question,
        department: llmResult.department,
        confidence: llmResult.confidence,
        reason: llmResult.reason,
      });
    }
  }

  return results;
}

/**
 * Resolve department from a pre-computed classification result.
 */
export function departmentFromClassification(result: ClassificationResult): FaqDepartment {
  return result.department;
}
