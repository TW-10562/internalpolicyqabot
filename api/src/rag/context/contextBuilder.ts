import { extractQueryTermsForRerank } from '@/rag/retrieval/reranker';
import { deduplicateContext } from './deduplicateContext';

export type ContextSource = {
  docId: string;
  title?: string;
  page?: number;
};

export type ContextBuildDetail = {
  docId: string;
  contentLength: number;
};

export type BuildContextInput = {
  docs: any[];
  retrievalQuery: string;
  maxChunks: number;
  contextBudgetChars: number;
  docContextChars: number;
};

export type BuildContextOutput = {
  documentContent: string;
  usedChars: number;
  usedChunks: number;
  sources: ContextSource[];
  details: ContextBuildDetail[];
};

export const normalizeEvidenceLine = (value: string): string =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[“”"'`]/g, '')
    .trim()
    .toLowerCase();

export const extractRelevantSnippet = (raw: string, terms: string[], maxChars: number): string => {
  const sourceText = String(raw || '').trim();
  if (!sourceText) return '';
  const compactText = sourceText.replace(/\s+/g, ' ');
  if (compactText.length <= maxChars) return compactText;

  const sortedTerms = [...(terms || [])]
    .map((t) => String(t || '').trim())
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);
  const obligationPattern =
    /(?:\b(?:must|shall|required|prohibited|return|delete|submit|immediately)\b|しなければならない|すること|禁止|返還|削除|廃棄|提出|直ちに|速やかに|遅滞なく|退職|離職)/i;
  const articlePattern =
    /(?:第\s*[0-9０-９一二三四五六七八九十百]+\s*(?:章|条|項)|article\s*[0-9０-９]+|clause\s*[0-9０-９]+)/i;

  const scoreCoverage = (textValue: string): number => {
    const lower = String(textValue || '').toLowerCase();
    let coverage = 0;
    for (const term of sortedTerms) {
      const token = String(term || '').trim().toLowerCase();
      if (!token) continue;
      if (lower.includes(token)) coverage += 1;
    }
    const obligationBoost = obligationPattern.test(textValue) ? 1 : 0;
    const articleBoost = articlePattern.test(textValue) ? 1 : 0;
    return (coverage * 4) + obligationBoost + articleBoost;
  };

  const sectionMarkers = /(第\s*[0-9０-９一二三四五六七八九十百]+\s*(?:章|条|項)|article\s*[0-9０-９]+|clause\s*[0-9０-９]+)/gim;
  const markerMatches = [...sourceText.matchAll(sectionMarkers)];
  let text = compactText;
  if (markerMatches.length >= 2) {
    const sections: string[] = [];
    for (let i = 0; i < markerMatches.length; i += 1) {
      const current = markerMatches[i];
      const start = Number(current.index || 0);
      const end = i + 1 < markerMatches.length
        ? Number(markerMatches[i + 1].index || sourceText.length)
        : sourceText.length;
      const section = String(sourceText.slice(start, end) || '').trim();
      if (!section) continue;
      sections.push(section);
    }
    if (sections.length > 0) {
      const rankedSections = sections
        .map((section) => ({
          section,
          compact: section.replace(/\s+/g, ' '),
          score: scoreCoverage(section),
        }))
        .sort((a, b) => (b.score - a.score) || (a.compact.length - b.compact.length));
      const selectedSections = rankedSections
        .filter((row) => row.score > 0)
        .slice(0, 2);
      if (selectedSections.length > 0) {
        const merged = selectedSections
          .map((row) => row.compact)
          .join(' ')
          .trim();
        if (merged.length <= maxChars) {
          return merged;
        }
        text = merged.slice(0, maxChars);
      }
    }
  }

  const normalized = text.toLowerCase();

  const toWindow = (anchor: number): { start: number; end: number; snippet: string; score: number } => {
    const half = Math.floor(maxChars / 2);
    let start = Math.max(0, anchor - half);
    let end = Math.min(text.length, start + maxChars);
    if ((end - start) < maxChars) start = Math.max(0, end - maxChars);
    const snippet = text.slice(start, end).trim();
    const lower = snippet.toLowerCase();
    let coverage = 0;
    for (const term of sortedTerms) {
      const token = String(term || '').trim().toLowerCase();
      if (!token) continue;
      if (lower.includes(token)) coverage += 1;
    }
    const obligationBoost = obligationPattern.test(snippet) ? 1 : 0;
    return {
      start,
      end,
      snippet,
      score: (coverage * 4) + obligationBoost,
    };
  };

  const candidateAnchors: number[] = [];
  for (const term of sortedTerms) {
    const idx = normalized.indexOf(term.toLowerCase());
    if (idx >= 0) candidateAnchors.push(idx);
  }
  const uniqueAnchors = Array.from(new Set(candidateAnchors)).slice(0, 10);

  if (!uniqueAnchors.length) return text.slice(0, maxChars);
  const candidates = uniqueAnchors
    .map((anchor) => toWindow(anchor))
    .sort((a, b) => (b.score - a.score) || (a.start - b.start));
  const best = candidates[0];

  const prefix = best.start > 0 ? '... ' : '';
  const suffix = best.end < text.length ? ' ...' : '';
  return `${prefix}${best.snippet}${suffix}`.trim();
};

type PreparedChunk = {
  doc: any;
  content: string;
};

export const buildContextFromDocs = (input: BuildContextInput): BuildContextOutput => {
  const docs = Array.isArray(input.docs) ? input.docs : [];
  const maxChunks = Math.min(8, Math.max(1, Number(input.maxChunks || 1)));
  const contextBudgetChars = Math.max(800, Number(input.contextBudgetChars || 800));
  const docContextChars = Math.max(180, Number(input.docContextChars || 180));
  const maxChunksPerSource = Math.max(1, Number(process.env.RAG_CONTEXT_MAX_CHUNKS_PER_SOURCE || 1));
  const retrievalTerms = extractQueryTermsForRerank(input.retrievalQuery);

  const preSelected: PreparedChunk[] = [];
  const perSourceCount = new Map<string, number>();

  for (const doc of docs) {
    if (preSelected.length >= Math.max(maxChunks * 3, maxChunks + 2)) break;

    let docContent = doc.content_txt || doc.content_txt_ja || doc.content || '';
    if (Array.isArray(docContent)) {
      docContent = docContent.join(' ');
    }
    docContent = String(docContent || '');

    const sourceKey = String(
      (Array.isArray(doc?.title) ? doc.title[0] : doc?.title) ||
      doc?.file_name_s ||
      doc?.id ||
      '',
    ).trim();
    if (sourceKey) {
      const sourceUsed = Number(perSourceCount.get(sourceKey) || 0);
      if (sourceUsed >= maxChunksPerSource) continue;
    }

    const contentToInclude = extractRelevantSnippet(
      docContent,
      retrievalTerms,
      Math.min(docContextChars, Math.max(180, contextBudgetChars)),
    );
    if (!contentToInclude) continue;

    preSelected.push({ doc, content: contentToInclude });
    if (sourceKey) {
      perSourceCount.set(sourceKey, Number(perSourceCount.get(sourceKey) || 0) + 1);
    }
  }

  const deduped = deduplicateContext({
    chunks: preSelected.map((row, index) => ({
      text: row.content,
      metadata: { index },
    })),
    similarityThreshold: Number(process.env.RAG_CONTEXT_DUPLICATE_SIMILARITY_THRESHOLD || 0.9),
    maxChunks: Math.max(maxChunks * 2, maxChunks),
  });

  if (deduped.removedCount > 0) {
    console.log(`[RAG PIPELINE] duplicate_chunks_removed=${deduped.removedCount}`);
  }

  const sources: ContextSource[] = [];
  const details: ContextBuildDetail[] = [];
  let documentContent = '';
  let usedChars = 0;
  let usedChunks = 0;

  for (const chunk of deduped.chunks) {
    if (usedChunks >= maxChunks || usedChars >= contextBudgetChars) break;
    const index = Number(chunk?.metadata?.index);
    if (!Number.isFinite(index) || index < 0 || index >= preSelected.length) continue;

    const selected = preSelected[index];
    const doc = selected.doc;
    const contentToInclude = selected.content;

    const header = `\n--- Document: ${Array.isArray(doc.title) ? doc.title[0] : doc.title || doc.id} ---\n`;
    let block = `${header}${contentToInclude}\n`;
    const remaining = contextBudgetChars - usedChars;
    if (block.length > remaining) {
      if (remaining < 160) break;
      const snippetBudget = Math.max(80, remaining - header.length - 4);
      const trimmed = contentToInclude.slice(0, snippetBudget).trim();
      if (!trimmed) break;
      block = `${header}${trimmed}\n`;
    }

    documentContent += block;
    usedChars += block.length;
    usedChunks += 1;
    details.push({
      docId: String(doc?.id || ''),
      contentLength: contentToInclude.length,
    });

    sources.push({
      docId: String(doc.id),
      title: Array.isArray(doc.title) ? String(doc.title[0]) : (doc.title ? String(doc.title) : undefined),
    });
  }

  return {
    documentContent,
    usedChars,
    usedChunks,
    sources,
    details,
  };
};
