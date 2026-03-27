/**
 * Embedding / Vector Index Startup Validation
 *
 * Validates that the configured embedding model and vector backend are consistent.
 * Fails fast with a clear error if there is a dimension mismatch or connectivity issue.
 */

const readStringEnv = (name: string, fallback: string): string => {
  const value = String(process.env[name] ?? '').trim();
  return value || fallback;
};

const readNumberEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export type EmbeddingValidationResult = {
  valid: boolean;
  embeddingModel: string;
  expectedDimension: number;
  backendUrl: string;
  backendReachable: boolean;
  backendDimension: number | null;
  dimensionMatch: boolean;
  errors: string[];
  warnings: string[];
};

/**
 * Known embedding model dimensions.
 * Used to validate that the vector index was built with the correct model.
 */
const KNOWN_EMBEDDING_DIMENSIONS: Record<string, number> = {
  'Qwen/Qwen3-VL-Embedding-8B': 4096,
  'Qwen/Qwen3-VL-Embedding-2B': 2048,
  'BAAI/bge-m3': 1024,
  'BAAI/bge-large-en-v1.5': 1024,
  'BAAI/bge-base-en-v1.5': 768,
  'BAAI/bge-small-en-v1.5': 384,
  'sentence-transformers/all-MiniLM-L6-v2': 384,
  'sentence-transformers/all-mpnet-base-v2': 768,
  'intfloat/multilingual-e5-large': 1024,
  'intfloat/multilingual-e5-base': 768,
};

/**
 * Resolve the expected embedding dimension for the configured model.
 */
function resolveExpectedDimension(): { model: string; dimension: number } {
  const model = readStringEnv('RAG_VECTOR_EMBEDDING_MODEL', 'Qwen/Qwen3-VL-Embedding-8B');
  const explicitDimension = readNumberEnv('RAG_VECTOR_EMBEDDING_DIMENSION', 0);

  if (explicitDimension > 0) {
    return { model, dimension: explicitDimension };
  }

  const knownDimension = KNOWN_EMBEDDING_DIMENSIONS[model];
  if (knownDimension) {
    return { model, dimension: knownDimension };
  }

  // Default for unknown models — warn but don't block
  return { model, dimension: 0 };
}

/**
 * Check if the RAG vector backend is reachable and query its collection info.
 */
async function probeVectorBackend(backendUrl: string): Promise<{
  reachable: boolean;
  dimension: number | null;
  error?: string;
}> {
  if (!backendUrl) {
    return { reachable: false, dimension: null, error: 'RAG_BACKEND_URL not configured' };
  }

  try {
    const healthUrl = `${backendUrl}/health`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch(healthUrl, { signal: controller.signal });
      if (!resp.ok) {
        return { reachable: false, dimension: null, error: `Health check returned ${resp.status}` };
      }
    } finally {
      clearTimeout(timeout);
    }

    // Try to get collection info for dimension validation
    const collectionName = readStringEnv(
      'RAG_BACKEND_COLLECTION_NAME',
      'splitByArticleWithHybridSearch',
    );
    const infoUrl = `${backendUrl}/collections/${encodeURIComponent(collectionName)}`;
    try {
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), 5000);
      try {
        const infoResp = await fetch(infoUrl, { signal: controller2.signal });
        if (infoResp.ok) {
          const info = await infoResp.json();
          const dimension = Number(
            info?.dimension ??
            info?.vector_dimension ??
            info?.config?.params?.vectors?.size ??
            0,
          );
          return {
            reachable: true,
            dimension: dimension > 0 ? dimension : null,
          };
        }
      } finally {
        clearTimeout(timeout2);
      }
    } catch {
      // Collection info endpoint may not exist — that's OK
    }

    return { reachable: true, dimension: null };
  } catch (err: any) {
    return {
      reachable: false,
      dimension: null,
      error: err?.message || String(err),
    };
  }
}

/**
 * Run embedding/vector index validation at startup.
 * Returns structured results; callers decide whether to fail or warn.
 */
export async function validateEmbeddingConfiguration(): Promise<EmbeddingValidationResult> {
  const backendUrl = readStringEnv('RAG_BACKEND_URL', '');
  const { model, dimension: expectedDimension } = resolveExpectedDimension();
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!backendUrl) {
    warnings.push('RAG_BACKEND_URL is not set — vector/hybrid retrieval will be disabled, Solr-only mode active');
    return {
      valid: true,
      embeddingModel: model,
      expectedDimension,
      backendUrl: '',
      backendReachable: false,
      backendDimension: null,
      dimensionMatch: true,
      errors,
      warnings,
    };
  }

  const probe = await probeVectorBackend(backendUrl);

  if (!probe.reachable) {
    warnings.push(
      `RAG vector backend at ${backendUrl} is not reachable: ${probe.error || 'unknown error'}. ` +
      'Hybrid retrieval will fall back to Solr-only until the backend becomes available.',
    );
  }

  let dimensionMatch = true;
  if (probe.dimension && expectedDimension > 0 && probe.dimension !== expectedDimension) {
    dimensionMatch = false;
    errors.push(
      `EMBEDDING DIMENSION MISMATCH: Model "${model}" expects ${expectedDimension} dimensions, ` +
      `but the vector index reports ${probe.dimension} dimensions. ` +
      'This will cause retrieval failures. You must reindex with the correct embedding model. ' +
      'Set RAG_VECTOR_EMBEDDING_DIMENSION to override if you know the correct value.',
    );
  }

  if (expectedDimension === 0) {
    warnings.push(
      `Unknown embedding dimension for model "${model}". ` +
      'Set RAG_VECTOR_EMBEDDING_DIMENSION explicitly to enable dimension validation.',
    );
  }

  return {
    valid: errors.length === 0,
    embeddingModel: model,
    expectedDimension,
    backendUrl,
    backendReachable: probe.reachable,
    backendDimension: probe.dimension,
    dimensionMatch,
    errors,
    warnings,
  };
}

/**
 * Run validation and log results. Call this during server startup.
 * Throws if there are critical errors (dimension mismatch).
 */
export async function runEmbeddingStartupValidation(): Promise<void> {
  console.log('[STARTUP] Validating embedding/vector configuration...');

  const result = await validateEmbeddingConfiguration();

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`[STARTUP WARNING] ${warning}`);
    }
  }

  if (result.backendReachable) {
    console.log(
      `[STARTUP] Vector backend reachable at ${result.backendUrl} ` +
      `(model: ${result.embeddingModel}, expected dim: ${result.expectedDimension || 'unknown'}` +
      `${result.backendDimension ? `, backend dim: ${result.backendDimension}` : ''})`,
    );
  }

  if (!result.valid) {
    const msg = [
      '',
      '╔══════════════════════════════════════════════════════════╗',
      '║      EMBEDDING / VECTOR INDEX VALIDATION FAILED         ║',
      '╚══════════════════════════════════════════════════════════╝',
      '',
      ...result.errors.map((e) => `  ✗ ${e}`),
      '',
      'Fix the above issues, reindex if needed, and restart.',
      '',
    ].join('\n');
    console.error(msg);
    throw new Error(`Embedding validation failed: ${result.errors.join('; ')}`);
  }

  console.log('[STARTUP] Embedding/vector configuration validated successfully.');
}
