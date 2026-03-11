const DEFAULT_TITLE_HINTS = [
  '規程',
  '規則',
  'ガイドライン',
  'ポリシー',
  'policy',
  'guideline',
  'regulation',
];

const getConfiguredHints = (): string[] => {
  const envHints = String(process.env.RAG_IMPORTANCE_TITLE_HINTS || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (envHints.length > 0) return envHints;
  return DEFAULT_TITLE_HINTS;
};

export const extractDocumentTitle = (docOrTitle: any): string => {
  if (typeof docOrTitle === 'string') return String(docOrTitle || '').trim();
  const title = Array.isArray(docOrTitle?.title)
    ? String(docOrTitle.title[0] || '')
    : String(docOrTitle?.title || docOrTitle?.file_name_s || docOrTitle?.id || '');
  return title.trim();
};

export const computeTitleImportanceWeight = (title: string): number => {
  const value = String(title || '').trim().toLowerCase();
  if (!value) return 0;

  const hints = getConfiguredHints();
  const maxWeight = Math.max(0, Number(process.env.RAG_IMPORTANCE_MAX_WEIGHT || 3));
  const baseWeight = Math.max(0, Number(process.env.RAG_IMPORTANCE_BASE_WEIGHT || 1.5));

  let matches = 0;
  for (const hint of hints) {
    const token = String(hint || '').trim();
    if (!token) continue;
    const normalized = token.toLowerCase();
    if (value.includes(normalized)) matches += 1;
  }
  if (matches <= 0) return 0;

  const weight = baseWeight + ((matches - 1) * 0.5);
  return Number(Math.min(maxWeight, weight).toFixed(3));
};

export const resolveDocumentImportanceWeight = (doc: any): number => {
  const metadataWeight = Number(
    doc?.importance_weight_f ??
      doc?.importance_weight ??
      doc?.importanceWeight ??
      doc?.metadata?.importance_weight_f ??
      doc?.metadata?.importance_weight,
  );
  if (Number.isFinite(metadataWeight) && metadataWeight > 0) {
    return Number(metadataWeight.toFixed(3));
  }

  const title = extractDocumentTitle(doc);
  return computeTitleImportanceWeight(title);
};
