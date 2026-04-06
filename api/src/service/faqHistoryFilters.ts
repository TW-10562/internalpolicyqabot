type HistoryMetadata = Record<string, unknown>;

const isObjectRecord = (value: unknown): value is HistoryMetadata =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTruthyFlag = (value: unknown): boolean =>
  value === true || value === 'true' || value === 1 || value === '1';

export const parseHistoryMetadata = (raw: unknown): HistoryMetadata => {
  if (isObjectRecord(raw)) return raw;
  if (typeof raw !== 'string') return {};

  try {
    const parsed = JSON.parse(raw);
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const isModerationFlaggedHistoryMetadata = (raw: unknown): boolean => {
  const metadata = parseHistoryMetadata(raw);
  return isTruthyFlag(metadata.moderation_blocked) || isTruthyFlag(metadata.moderation_flagged);
};

export const shouldExcludeFaqTurnForModeration = (
  userMetadataRaw: unknown,
  assistantMetadataRaw: unknown,
): boolean =>
  isModerationFlaggedHistoryMetadata(userMetadataRaw)
  || isModerationFlaggedHistoryMetadata(assistantMetadataRaw);
