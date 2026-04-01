import { classifyQuestion, classifyQuestionBatch } from '@/service/questionClassifier';
import { ClassificationResult, FaqDepartment, isFaqDepartment } from '@/service/classification.types';

export type FaqClassificationEntry = {
  question: string;
  department: FaqDepartment;
  confidence: number;
  reason: string;
};

/**
 * Resolve FAQ department for a single question.
 * Uses source-doc department as primary signal when available,
 * falls back to LLM classification, then to OTHERS.
 */
export async function resolveFaqDepartment(
  question: string,
  sourceDocDepartment: string | null,
): Promise<FaqClassificationEntry> {
  const normalizedSourceDept = String(sourceDocDepartment || '').toUpperCase().trim();
  if (isFaqDepartment(normalizedSourceDept) && normalizedSourceDept !== 'OTHERS') {
    return {
      question,
      department: normalizedSourceDept,
      confidence: 1.0,
      reason: 'source_document_department',
    };
  }

  const result = await classifyQuestion({ question });
  return {
    question,
    department: result.department,
    confidence: result.confidence,
    reason: result.reason,
  };
}

/**
 * Classify a batch of FAQ questions.
 * For each question, uses sourceDocDepartment if available, else LLM.
 */
export async function classifyFaqBatch(
  items: Array<{ question: string; sourceDocDepartment: string | null }>,
): Promise<Map<string, FaqClassificationEntry>> {
  const results = new Map<string, FaqClassificationEntry>();
  const needsClassification: string[] = [];

  for (const item of items) {
    const normalizedSourceDept = String(item.sourceDocDepartment || '').toUpperCase().trim();
    if (isFaqDepartment(normalizedSourceDept) && normalizedSourceDept !== 'OTHERS') {
      results.set(item.question, {
        question: item.question,
        department: normalizedSourceDept,
        confidence: 1.0,
        reason: 'source_document_department',
      });
    } else {
      needsClassification.push(item.question);
    }
  }

  if (needsClassification.length > 0) {
    const classified = await classifyQuestionBatch(needsClassification);
    for (const [question, result] of classified) {
      results.set(question, {
        question,
        department: result.department,
        confidence: result.confidence,
        reason: result.reason,
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
