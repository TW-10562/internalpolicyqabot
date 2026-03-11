/**
 * OpenAI-Compatible LLM Client
 * 
 * A centralized client for OpenAI-compatible API gateways.
 * Supports both streaming and non-streaming chat completions.
 * 
 * Configuration:
 * - LLM_BASE_URL: http://localhost:9080/v1 (OpenAI-compatible gateway)
 * - LLM_API_KEY: Bearer token for authentication
 * - LLM_MODEL: Model name (default: openai/gpt-oss-20b)
 */

import axios, { AxiosRequestConfig } from 'axios';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  model?: string;
  response_format?: { type: 'json_object' | 'text' };
  retry_on_empty?: boolean;
  timeout_ms?: number;
  extra_body?: Record<string, any>;
  allow_reasoning_fallback?: boolean;
}

export interface ChatCompletionResponse {
  content: string;
  tokens_used?: number;
  finish_reason?: string;
  generation_status?: 'ok' | 'empty_llm_response';
  used_fallback?: boolean;
  error?: {
    code: string;
    message: string;
    retryAttempted?: boolean;
  };
}

class OpenAIClient {
  private baseUrl: string;
  private apiKey: string;
  private apiKeyHeader: string;
  private model: string;
  private timeout: number = 120000; // 2 minutes default
  private verbose: boolean;

  constructor() {
    // Read from environment variables
    this.baseUrl = (process.env.LLM_BASE_URL || 'http://localhost:9080/v1').replace(/\/+$/, '');
    this.apiKey =
      process.env.LLM_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.APISIX_API_KEY ||
      '';
    this.apiKeyHeader = (process.env.LLM_API_KEY_HEADER || 'Authorization').trim();
    this.model = process.env.LLM_MODEL || 'openai/gpt-oss-20b';
    this.verbose = process.env.OPENAI_CLIENT_VERBOSE === '1';

    if (!this.apiKey) {
      console.warn('[OpenAIClient] LLM_API_KEY not set; API calls may fail with 401');
    }

    if (this.verbose) {
      console.log(`[OpenAIClient] Initialized with:`);
      console.log(`  - Base URL: ${this.baseUrl}`);
      console.log(`  - Model: ${this.model}`);
      console.log(`  - API Key: ${this.apiKey ? '***set***' : '(not set)'}`);
    }
  }

  private buildAuthHeaders(): Record<string, string> {
    if (!this.apiKey) return {};
    const header = this.apiKeyHeader || 'Authorization';
    const headers: Record<string, string> = {};

    if (/^authorization$/i.test(header)) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else {
      headers[header] = this.apiKey;
    }

    // APISIX/Gateway compatibility:
    // many key-auth plugins expect `apikey` or `x-api-key` instead of Authorization.
    // keep these unless explicitly disabled.
    if (process.env.LLM_API_KEY_COMPAT_HEADERS !== '0') {
      headers.apikey = this.apiKey;
      headers['x-api-key'] = this.apiKey;
    }

    return headers;
  }

  private getGenerateMaxAttempts(): number {
    return Math.max(1, Math.min(2, Number(process.env.LLM_GENERATE_MAX_ATTEMPTS || 2)));
  }

  private getGenerateRetryDelayMs(): number {
    return Math.max(200, Number(process.env.LLM_GENERATE_RETRY_DELAY_MS || 1000));
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shouldRetryGenerateError(error: any): boolean {
    const status = Number(error?.response?.status || 0);
    if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
      return true;
    }

    const code = String(error?.code || '').toUpperCase();
    if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(code)) {
      return true;
    }

    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('socket hang up') ||
      message.includes('temporarily unavailable')
    );
  }

  private joinTextParts(parts: string[]): string {
    let out = '';
    for (const rawPart of parts) {
      const part = String(rawPart || '');
      if (!part) continue;
      if (!out) {
        out = part;
        continue;
      }
      const prevChar = out.slice(-1);
      const nextChar = part[0];
      const needsSpace =
        !/\s/.test(prevChar) &&
        !/\s/.test(nextChar) &&
        /[A-Za-z0-9]$/.test(prevChar) &&
        /^[A-Za-z0-9]/.test(nextChar);
      out += needsSpace ? ` ${part}` : part;
    }
    return out;
  }

  private extractText(value: any): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const parts = value
        .map((item) => this.extractText(item))
        .filter((part) => String(part || '').length > 0);
      return this.joinTextParts(parts);
    }
    if (typeof value === 'object') {
      const blockType = String(value.type || '').toLowerCase();
      if (blockType && /(reasoning|analysis|thought|thinking)/.test(blockType)) {
        return '';
      }
      // OpenAI-compatible content blocks may be arrays of { type: "text", text: "..." }.
      return this.extractText(
        value.text ??
          value.content ??
          value.value ??
          value.output_text ??
          value.message ??
          value.answer ??
          value.response ??
          value.delta ??
          value.partial ??
          value.parts ??
          value.choices ??
          '',
      );
    }
    return String(value || '');
  }

  private extractToolOutputText(payload: any): string {
    const parts: string[] = [];
    const pushText = (candidate: any) => {
      const text = this.extractText(candidate).trim();
      if (!text) return;
      parts.push(text);
    };

    const firstChoice = payload?.choices?.[0] || {};
    const message = firstChoice?.message || payload?.message || {};

    const toolOutputGroups = [
      message?.tool_outputs,
      payload?.tool_outputs,
      payload?.response?.tool_outputs,
    ];
    for (const group of toolOutputGroups) {
      if (!Array.isArray(group)) continue;
      for (const item of group) {
        pushText(item?.content ?? item?.text ?? item?.output ?? item?.result ?? item?.arguments ?? item);
      }
    }

    const toolCallGroups = [
      message?.tool_calls,
      firstChoice?.tool_calls,
      payload?.tool_calls,
    ];
    for (const group of toolCallGroups) {
      if (!Array.isArray(group)) continue;
      for (const call of group) {
        pushText(
          call?.function?.output ??
          call?.function?.arguments ??
          call?.output ??
          call?.result ??
          call?.content ??
          call?.text ??
          call,
        );
      }
    }

    const outputItems = Array.isArray(payload?.output) ? payload.output : [];
    for (const item of outputItems) {
      const itemType = String(item?.type || item?.role || '').toLowerCase();
      if (itemType.includes('tool') || itemType === 'tool') {
        pushText(
          item?.content ??
          item?.text ??
          item?.output_text ??
          item?.output ??
          item?.result ??
          item?.arguments ??
          item,
        );
      }
    }

    return this.joinTextParts(parts).trim();
  }

  private hasIgnoredReasoningField(payload: any): boolean {
    const firstChoice = payload?.choices?.[0] || {};
    const candidates = [
      firstChoice?.message?.reasoning_content,
      firstChoice?.message?.thinking,
      firstChoice?.message?.analysis,
      firstChoice?.delta?.reasoning_content,
      firstChoice?.delta?.thinking,
      firstChoice?.delta?.analysis,
      firstChoice?.reasoning_content,
      firstChoice?.thinking,
      firstChoice?.analysis,
      payload?.message?.reasoning_content,
      payload?.message?.thinking,
      payload?.message?.analysis,
      payload?.reasoning_content,
      payload?.thinking,
      payload?.analysis,
    ];
    return candidates.some((value) => value != null && String(value).trim().length > 0);
  }

  private extractLLMContent(
    payload: any,
    allowReasoningFallback: boolean = false,
  ): { content: string | null; source: string } {
    const firstChoice = payload?.choices?.[0] || {};
    if (this.hasIgnoredReasoningField(payload)) {
      console.warn('LLM_REASONING_FIELD_IGNORED');
    }

    const contentArray = firstChoice?.message?.content;
    if (Array.isArray(contentArray)) {
      const joined = contentArray
        .map((item: any) => {
          if (typeof item === 'string') return item;
          if (item?.text) return item.text;
          if (item?.content) return item.content;
          return '';
        })
        .filter(Boolean)
        .join('');

      if (joined.trim().length > 0) {
        return { content: joined.trim(), source: 'choices[0].message.content[].text' };
      }
    }

    const candidates = [
      { source: 'choices[0].message.content', value: firstChoice?.message?.content },
      { source: 'choices[0].delta.content', value: firstChoice?.delta?.content },
      { source: 'choices[0].text', value: firstChoice?.text },
      { source: 'message.content', value: payload?.message?.content },
      { source: 'delta.content', value: payload?.delta?.content },
      { source: 'text', value: payload?.text },
      { source: 'output_text', value: payload?.output_text },
      { source: 'content', value: payload?.content },
    ];

    for (const candidate of candidates) {
      const text = this.extractText(candidate.value).trim();
      if (text) {
        return { content: text, source: candidate.source };
      }
    }

    const toolOutput = this.extractToolOutputText(payload);
    if (toolOutput) {
      return { content: toolOutput, source: 'tool_outputs_concat' };
    }

    if (Array.isArray(payload?.choices)) {
      const choiceParts = payload.choices
        .map((choice: any) =>
          this.extractText(
            choice?.message?.content ??
            choice?.delta?.content ??
            choice?.text ??
            choice?.message ??
            choice?.delta ??
            choice?.content ??
            '',
          ),
        )
        .filter((part: string) => String(part || '').trim().length > 0);
      const merged = this.joinTextParts(choiceParts).trim();
      if (merged) {
        return { content: merged, source: 'choices_concat' };
      }
    }

    if (Array.isArray(payload?.output)) {
      const outputParts = payload.output
        .map((item: any) => this.extractText(item))
        .filter((part: string) => String(part || '').trim().length > 0);
      const merged = this.joinTextParts(outputParts).trim();
      if (merged) {
        return { content: merged, source: 'output_concat' };
      }
    }

    if (allowReasoningFallback) {
      const reasoningCandidates = [
        firstChoice?.message?.reasoning_content,
        firstChoice?.delta?.reasoning_content,
        firstChoice?.reasoning_content,
        payload?.message?.reasoning_content,
        payload?.reasoning_content,
        firstChoice?.message?.thinking,
        firstChoice?.delta?.thinking,
        firstChoice?.thinking,
        payload?.message?.thinking,
        payload?.thinking,
      ];
      for (const candidate of reasoningCandidates) {
        const text = this.extractText(candidate).trim();
        if (!text) continue;
        console.warn('[RAG LLM CLIENT] reasoning_content_recovery');
        return { content: text, source: 'reasoning_content_fallback' };
      }
    }

    return { content: null, source: 'none' };
  }

  /**
   * Send a non-streaming chat completion request
   */
  async generate(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {}
  ): Promise<ChatCompletionResponse> {
    const {
      temperature = 0.2,
      max_tokens = 1000,
      top_p = 0.9,
      stream = false,
      model = this.model,
      response_format = undefined,
      retry_on_empty = true,
      timeout_ms = undefined,
      extra_body = undefined,
      allow_reasoning_fallback = false,
    } = options;

    try {
      if (this.verbose) {
        console.log(`[OpenAIClient] Sending non-streaming request to ${this.baseUrl}/chat/completions`);
        console.log(`[OpenAIClient] Model: ${model}, Temp: ${temperature}, MaxTokens: ${max_tokens}`);
      }

      const config: AxiosRequestConfig = {
        headers: {
          ...this.buildAuthHeaders(),
          'Content-Type': 'application/json',
        },
        timeout: Number(timeout_ms || this.timeout),
      };
      const maxRequestAttempts = this.getGenerateMaxAttempts();
      const retryDelayMs = this.getGenerateRetryDelayMs();
      const requestOnce = async (args: {
        temperature: number;
        maxTokens: number;
        topP: number;
        attempt: number;
      }): Promise<{
        data: any;
        content: string | null;
        source: string;
        tokensUsed: number;
        finishReason: string;
      }> => {
        const payload = {
          model,
          messages,
          temperature: args.temperature,
          max_tokens: args.maxTokens,
          top_p: args.topP,
          stream,
          ...(response_format && { response_format }),
          ...(extra_body && typeof extra_body === 'object' ? extra_body : {}),
        };

        let lastError: any = null;
        for (let requestAttempt = 1; requestAttempt <= maxRequestAttempts; requestAttempt += 1) {
          try {
            const response = await axios.post(
              `${this.baseUrl}/chat/completions`,
              payload,
              config,
            );

            if (response.status !== 200) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = response.data;
            const firstChoice = data?.choices?.[0] || {};
            const extracted = this.extractLLMContent(data, allow_reasoning_fallback);
            const tokensUsed = Number(data?.usage?.total_tokens || 0);
            const finishReason = String(firstChoice?.finish_reason || data?.finish_reason || 'stop');
            const content = extracted.content ? String(extracted.content).trim() : null;
            const choiceCount = Array.isArray(data?.choices) ? data.choices.length : 0;

            console.log(
              `[RAG LLM CLIENT] raw_response_received attempt=${args.attempt}.${requestAttempt} status=${response.status} choice_count=${choiceCount}`,
            );
            console.log(
              `[RAG LLM CLIENT] content_extracted attempt=${args.attempt}.${requestAttempt} source=${extracted.source} length=${content ? content.length : 0}`,
            );

            return {
              data,
              content,
              source: extracted.source,
              tokensUsed,
              finishReason,
            };
          } catch (error: any) {
            lastError = error;
            if (requestAttempt >= maxRequestAttempts || !this.shouldRetryGenerateError(error)) {
              throw error;
            }

            const errorMessage = this.formatErrorMessage(error);
            console.warn(
              `[OpenAIClient] Retrying generate request ${requestAttempt + 1}/${maxRequestAttempts} after transient error: ${errorMessage}`,
            );
            await this.sleep(retryDelayMs * requestAttempt);
          }
        }

        throw lastError;
      };

      const firstAttempt = await requestOnce({
        temperature,
        maxTokens: max_tokens,
        topP: top_p,
        attempt: 1,
      });

      if (firstAttempt.content) {
        if (this.verbose) {
          console.log(
            `[OpenAIClient] Generation complete: ${firstAttempt.content.length} chars, finish_reason=${firstAttempt.finishReason}`,
          );
        }
        return {
          content: firstAttempt.content,
          tokens_used: firstAttempt.tokensUsed,
          finish_reason: firstAttempt.finishReason,
          generation_status: 'ok',
          used_fallback: false,
        };
      }

      if (!retry_on_empty) {
        return {
          content: '',
          tokens_used: firstAttempt.tokensUsed,
          finish_reason: firstAttempt.finishReason,
          generation_status: 'empty_llm_response',
          used_fallback: true,
          error: {
            code: 'EMPTY_LLM_RESPONSE',
            message: `No content extracted (attempt1=${firstAttempt.source}, retry_skipped=true)`,
            retryAttempted: false,
          },
        };
      }

      console.warn('[RAG LLM CLIENT] empty_response_retry');
      console.warn('LLM_EMPTY_RESPONSE_RETRY');
      const retryMaxTokens = Math.max(800, Number(max_tokens || 0));
      const retryAttempt = await requestOnce({
        temperature: 0.1,
        maxTokens: retryMaxTokens,
        topP: top_p,
        attempt: 2,
      });
      if (retryAttempt.content) {
        console.log('[RAG LLM CLIENT] retry_success');
        return {
          content: retryAttempt.content,
          tokens_used: retryAttempt.tokensUsed || firstAttempt.tokensUsed,
          finish_reason: retryAttempt.finishReason || firstAttempt.finishReason,
          generation_status: 'ok',
          used_fallback: true,
        };
      }

      console.warn('[OpenAIClient] Response contains empty content after retry');
      return {
        content: '',
        tokens_used: retryAttempt.tokensUsed || firstAttempt.tokensUsed,
        finish_reason: retryAttempt.finishReason || firstAttempt.finishReason,
        generation_status: 'empty_llm_response',
        used_fallback: true,
        error: {
          code: 'EMPTY_LLM_RESPONSE',
          message: `No content extracted (attempt1=${firstAttempt.source}, attempt2=${retryAttempt.source})`,
          retryAttempted: true,
        },
      };
    } catch (error: any) {
      const errorMessage = this.formatErrorMessage(error);
      // Some gateways inject stream_options and reject non-stream requests.
      // Recover by retrying once via streaming API and concatenating chunks.
      const streamOptionError =
        /stream options can only be defined when/i.test(errorMessage) ||
        /stream_options/i.test(errorMessage);
      if (streamOptionError) {
        try {
          let streamed = '';
          for await (const chunk of this.generateStream(messages, {
            temperature,
            max_tokens,
            top_p,
            response_format,
            extra_body,
          })) {
            streamed += chunk;
          }
          if (streamed.trim()) {
            return {
              content: streamed,
              finish_reason: 'stop',
            };
          }
        } catch (streamRetryError: any) {
          const streamErrorMessage = this.formatErrorMessage(streamRetryError);
          console.error(`[OpenAIClient] Stream fallback failed: ${streamErrorMessage}`);
        }
      }
      console.error(`[OpenAIClient] Generation failed: ${errorMessage}`);
      throw new Error(`OpenAI API error: ${errorMessage}`);
    }
  }

  /**
   * Send a streaming chat completion request
   * Yields content chunks as they arrive from the server
   */
  async *generateStream(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {}
  ): AsyncGenerator<string, void, unknown> {
    const {
      temperature = 0.2,
      max_tokens = 1000,
      top_p = 0.9,
      model = this.model,
      response_format = undefined,
      timeout_ms = undefined,
      extra_body = undefined,
    } = options;

    const payload = {
      model,
      messages,
      temperature,
      max_tokens,
      top_p,
      stream: true,
      ...(response_format && { response_format }),
      ...(extra_body && typeof extra_body === 'object' ? extra_body : {}),
    };

    const streamTimeoutMs = Number(timeout_ms || this.timeout);
    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | null = null;
    const refreshTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        console.error(`[OpenAIClient] Stream idle timeout after ${streamTimeoutMs}ms, aborting`);
        controller.abort();
      }, streamTimeoutMs);
    };
    refreshTimeout();

    try {
      if (this.verbose) {
        console.log(`[OpenAIClient] Starting streaming request to ${this.baseUrl}/chat/completions`);
        console.log(`[OpenAIClient] Model: ${model}, Temp: ${temperature}, MaxTokens: ${max_tokens}`);
      }

      const headers: Record<string,string> = {
        'Content-Type': 'application/json',
        ...this.buildAuthHeaders(),
      };

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (timeoutId) clearTimeout(timeoutId);
        const errorText = await response.text();
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${errorText}`
        );
      }

      if (!response.body) {
        if (timeoutId) clearTimeout(timeoutId);
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let chunkCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (this.verbose) {
            console.log(`[OpenAIClient] Stream complete. Total chunks: ${chunkCount}`);
          }
          if (timeoutId) clearTimeout(timeoutId);
          break;
        }

        chunkCount++;
        refreshTimeout();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          // Handle SSE format: "data: {...}"
          const payloadLine = line.startsWith('data: ')
            ? line.substring(6).trim()
            : line.trim();
          if (!payloadLine) continue;

          // Check for stream termination
          if (payloadLine === '[DONE]') {
            if (this.verbose) console.log('[OpenAIClient] Stream termination marker received');
            continue;
          }

          try {
            const chunk = JSON.parse(payloadLine);
            const firstChoice = chunk?.choices?.[0] || {};
            const text = this.extractText(
              firstChoice?.delta?.content ??
              firstChoice?.message?.content ??
              firstChoice?.delta ??
              firstChoice?.message ??
              firstChoice?.delta?.text ??
              firstChoice?.text ??
              firstChoice?.content ??
              chunk?.delta?.content ??
              chunk?.delta ??
              chunk?.message?.content ??
              chunk?.message ??
              chunk?.text ??
              chunk?.output_text ??
              chunk?.output ??
              chunk?.response?.output_text ??
              chunk?.response?.output ??
              chunk?.response ??
              chunk?.content ??
              '',
            );

            if (text.length > 0) {
              yield text;
            }

            if (chunk.choices?.[0]?.finish_reason) {
              if (this.verbose) {
                console.log(`[OpenAIClient] Finish reason: ${chunk.choices[0].finish_reason}`);
              }
            }
          } catch (parseError) {
            // Some gateways may occasionally emit keepalive/comment lines; ignore them.
            if (this.verbose) {
              console.warn(`[OpenAIClient] Failed to parse stream chunk: ${payloadLine.slice(0, 200)}`);
            }
          }
        }
      }

      // Process any remaining buffered line
      if (buffer.trim()) {
        const jsonStr = buffer.startsWith('data: ')
          ? buffer.substring(6).trim()
          : buffer.trim();
        if (jsonStr && jsonStr !== '[DONE]') {
          try {
            const chunk = JSON.parse(jsonStr);
            const firstChoice = chunk?.choices?.[0] || {};
            const text = this.extractText(
              firstChoice?.delta?.content ??
              firstChoice?.message?.content ??
              firstChoice?.delta ??
              firstChoice?.message ??
              firstChoice?.delta?.text ??
              firstChoice?.text ??
              firstChoice?.content ??
              chunk?.delta?.content ??
              chunk?.delta ??
              chunk?.message?.content ??
              chunk?.message ??
              chunk?.text ??
              chunk?.output_text ??
              chunk?.output ??
              chunk?.response?.output_text ??
              chunk?.response?.output ??
              chunk?.response ??
              chunk?.content ??
              '',
            );
            if (text.length > 0) {
              yield text;
            }
          } catch (parseError) {
            if (this.verbose) {
              console.warn('[OpenAIClient] Failed to parse final buffer chunk');
            }
          }
        }
      }
    } catch (error: any) {
      if (timeoutId) clearTimeout(timeoutId);
      const errorMessage = this.formatErrorMessage(error);
      console.error(`[OpenAIClient] Stream failed: ${errorMessage}`);
      throw new Error(`OpenAI streaming error: ${errorMessage}`);
    }
  }

  /**
   * Simple completion with optional system prompt
   */
  async complete(
    prompt: string,
    systemPrompt?: string,
    options: ChatCompletionOptions = {}
  ): Promise<string> {
    const messages: ChatMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await this.generate(messages, options);
    return response.content;
  }

  /**
   * Translate text to target language
   */
  async translate(
    text: string,
    targetLanguage: string,
    options: ChatCompletionOptions = {}
  ): Promise<string> {
    const systemPrompt = `You are a translator. Translate the following text to ${targetLanguage}.
Return ONLY the translation, nothing else. No explanations, no markers, no formatting.`;

    try {
      const result = await this.complete(text, systemPrompt, {
        ...options,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.max_tokens ?? 1000,
        top_p: options.top_p ?? 0.9,
      });
      return this.cleanTranslation(result);
    } catch (error: any) {
      console.error(`[OpenAIClient] Translation failed: ${error.message}`);
      return text; // Return original on failure
    }
  }

  /**
   * Check if the API is reachable (health check)
   */
  async ping(): Promise<boolean> {
    const checkModelsEndpoint = async (): Promise<boolean> => {
      try {
        const config: AxiosRequestConfig = {
          headers: this.buildAuthHeaders(),
          timeout: Math.min(this.timeout, 10000),
        };
        const res = await axios.get(`${this.baseUrl}/models`, config);
        const models = Array.isArray(res?.data?.data) ? res.data.data : [];
        const healthy = res.status >= 200 && res.status < 300 && models.length >= 0;
        if (healthy) {
          console.log(`[OpenAIClient] /models health check PASSED (status=${res.status})`);
        }
        return healthy;
      } catch (error: any) {
        const message = this.formatErrorMessage(error);
        console.error(`[OpenAIClient] /models health check failed: ${message}`);
        return false;
      }
    };

    const testMessages: ChatMessage[] = [
      { role: 'user', content: 'Say "OK".' },
    ];

    console.log('[OpenAIClient] Sending health check...');
    try {
      const response = await this.generate(testMessages, {
        temperature: 0.1,
        max_tokens: 10,
      });

      const normalized = String(response.content || '').trim();
      if (normalized.includes('OK')) {
        console.log(`[OpenAIClient] Health check PASSED: "${normalized}"`);
        return true;
      }

      if (normalized.length > 0) {
        console.log(`[OpenAIClient] Health check PASSED (non-empty response): "${normalized}"`);
        return true;
      }

      console.warn('[OpenAIClient] Health check response was empty; verifying via /models endpoint...');
      return await checkModelsEndpoint();
    } catch (error: any) {
      const message = this.formatErrorMessage(error);
      console.error(`[OpenAIClient] Health check generate() failed: ${message}`);
      console.log('[OpenAIClient] Falling back to /models endpoint health check...');
      return await checkModelsEndpoint();
    }
  }

  /**
   * Clean translation output - remove markdown and formatting markers
   */
  private cleanTranslation(text: string): string {
    return text
      .replace(/\[EN\]/gi, '')
      .replace(/\[JA\]/gi, '')
      .replace(/\[ENGLISH\]/gi, '')
      .replace(/\[JAPANESE\]/gi, '')
      .replace(/\*\*/g, '')
      .replace(/#{1,6}\s*/g, '')
      .replace(/\n+/g, ' ')
      .trim();
  }

  /**
   * Format error messages with HTTP status and response body
   */
  private formatErrorMessage(error: any): string {
    if (error.response) {
      const status = error.response.status;
      const statusText = error.response.statusText;
      const data = error.response.data;

      let detail = '';
      if (typeof data === 'string') {
        detail = data;
      } else if (data?.error?.message) {
        detail = data.error.message;
      } else if (data?.message) {
        detail = data.message;
      } else if (typeof data === 'object') {
        detail = JSON.stringify(data).slice(0, 200);
      }

      return `HTTP ${status} ${statusText}${detail ? ': ' + detail : ''}`;
    }

    if (error.code === 'ECONNREFUSED') {
      return `Connection refused to ${this.baseUrl} (check gateway is running)`;
    }

    if (error.code === 'ENOTFOUND') {
      return `Cannot resolve hostname in ${this.baseUrl}`;
    }

    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      const timeoutMs = Number(error?.config?.timeout || error?.timeout || this.timeout);
      return `Request timeout after ${timeoutMs}ms`;
    }

    return error.message || String(error);
  }
}

// Export singleton instance
export const openaiClient = new OpenAIClient();
