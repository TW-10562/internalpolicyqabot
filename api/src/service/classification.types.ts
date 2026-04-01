export type FaqDepartment = 'HR' | 'ACC' | 'GA' | 'OTHERS';

export const FAQ_DEPARTMENTS: readonly FaqDepartment[] = ['HR', 'ACC', 'GA', 'OTHERS'] as const;

export interface ClassificationResult {
  department: FaqDepartment;
  confidence: number;
  reason: string;
  normalized_question: string;
}

export interface ClassificationInput {
  question: string;
  sourceIds?: string[];
  ragUsed?: boolean;
}

export const isFaqDepartment = (value: unknown): value is FaqDepartment =>
  FAQ_DEPARTMENTS.includes(String(value || '').toUpperCase() as FaqDepartment);

export const CONFIDENCE_THRESHOLD = 0.60;
