import File from '@/mysql/model/file.model';
import KrdGenTaskOutput from '@/mysql/model/gen_task_output.model';
import { IGenTaskOutputSer } from '@/types/genTaskOutput';
import dns from 'node:dns';
import { Op } from 'sequelize';
import { execute } from '../service/task.dispatch';
import { put, queryList } from '../utils/mapper';
import { openaiClient } from '@/service/openai_client';
import { config } from '@/config/index';
import { STRICT_OLLAMA_MODEL } from '@/constants/llm';

dns.setDefaultResultOrder('ipv4first');

const getModelName = () => {
  return STRICT_OLLAMA_MODEL;
};

const TOKENIZER_CHARACTERS_PER_TOKEN = config.Backend.Tokenizer.charactersPerToken;

// maximum tokens for LLM responses, matched with chat worker
const CHAT_MAX_PREDICT = Math.max(
  120,
  Number(process.env.RAG_CHAT_MAX_PREDICT || process.env.RAG_MAX_OUTPUT_TOKENS || 420),
);


// TODO: modify this to use a more accurate tokenization method if needed for Japanese Language
// Basic token counting using character length approximation
const getTokenCount = (text: string): number => {
  // Simple approximation: divide text length by 4
  return Math.ceil(text.length / TOKENIZER_CHARACTERS_PER_TOKEN);
};


// Count tokens for an array of messages (ChatML format)
const countMessageTokens = (messages: any[]): number => {
  let totalTokens = 0;

  for (const message of messages) {
    // Each message has overhead tokens for role and formatting
    totalTokens += 4; // Overhead per message
    totalTokens += getTokenCount(message.role || '');
    totalTokens += getTokenCount(message.content || '');
  }
  totalTokens += 2; // Overhead for the conversation
  return totalTokens;
};


const callLLM = async (messages: any[], temperature = 0.5, outputId?: number): Promise<string> => {
  // use shared OpenAI client instead of legacy Ollama API
  const maxTokens = CHAT_MAX_PREDICT;

  if (outputId) {
    let content = '';
    for await (const chunk of openaiClient.generateStream(messages, { temperature, max_tokens: maxTokens })) {
      const [curOutput] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: outputId } });
      if (!curOutput) {
        console.error(`Output with ID ${outputId} not found.`);
        break;
      }
      if (curOutput.status === 'CANCEL') {
        await put<IGenTaskOutputSer>(
          KrdGenTaskOutput,
          { id: outputId },
          {
            status: 'CANCEL',
            update_by: 'JOB',
          },
        );
        break;
      }

      content += chunk;
      await put<IGenTaskOutputSer>(
        KrdGenTaskOutput,
        { id: outputId },
        {
          content,
          status: 'PROCESSING',
          update_by: 'JOB',
        },
      );
    }
    return content || '';
  } else {
    const resp = await openaiClient.generate(messages, { temperature, max_tokens: maxTokens });
    return resp.content;
  }
};


const generateWithLLM = async (messages: any[], outputId: number) => {
  try {
    return await callLLM(messages, 0.1, outputId);
  } catch (error) {
    console.error('LLM 呼び出し失敗:', error);
    return 'error happen';
  }
};


const splitTextByTokens = (text: string, maxTokens: number = 2000, overlapTokens: number = 200): string[] => {
  if (maxTokens <= 0) {
    throw new Error('maxTokens must be > 0');
  }

  if (!text) {
    return [];
  }

  if (overlapTokens < 0) {
    overlapTokens = 0;
  }
  if (overlapTokens >= maxTokens) {
    overlapTokens = maxTokens - 1;
  }

  const chunks: string[] = [];
  const totalTokens = getTokenCount(text);

  // If text is small enough, return as single chunk
  if (totalTokens <= maxTokens) {
    return [text];
  }

  // Split text into sentences first for better chunking
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = '';
  let currentTokens = 0;

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const sentenceTokens = getTokenCount(sentence);

    // If adding this sentence would exceed the limit, save current chunk and start new one
    if (currentTokens + sentenceTokens > maxTokens && currentChunk) {
      chunks.push(currentChunk.trim());

      // Start new chunk with overlap from previous chunk if specified
      if (overlapTokens > 0 && chunks.length > 0) {
        const previousChunk = chunks[chunks.length - 1];
        const overlapText = getTextWithTokenLimit(previousChunk, overlapTokens, true);
        currentChunk = overlapText + ' ' + sentence;
        currentTokens = getTokenCount(currentChunk);
      } else {
        currentChunk = sentence;
        currentTokens = sentenceTokens;
      }
    } else {
      // Add sentence to current chunk
      currentChunk += (currentChunk ? ' ' : '') + sentence;
      currentTokens = getTokenCount(currentChunk);
    }
  }

  // Add the last chunk if it has content
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
};


// Helper function to truncate text to fit within token limit
const getTextWithTokenLimit = (text: string, maxTokens: number, fromEnd: boolean = false): string => {
  const currentTokens = getTokenCount(text);

  if (currentTokens <= maxTokens) {
    return text;
  }

  // TODO: modify this to use a more accurate tokenization method if needed for Japanese Language
  // Simple character-based truncation using the 4:1 character to token ratio
  const charLimit = maxTokens * TOKENIZER_CHARACTERS_PER_TOKEN;

  // TODO: improve the truncation process with LLM-based summary?
  if (fromEnd) {
    return '...' + text.slice(-charLimit);
  } else {
    return text.slice(0, charLimit) + '...';
  }
};


const summaryGenProcess = async (job) => {
  const { taskId } = job.data;
  const type = 'SUMMARY';

  const callAviary = async (outputId: number, metadata: string) => {
    const outputs = await queryList(KrdGenTaskOutput, {
      task_id: { [Op.eq]: taskId },
      status: { [Op.ne]: 'IN_PROCESS' },
    });

    const data = JSON.parse(metadata);

    let content = '';
    let isOk = true;

    const CONTEXT_WINDOW_LIMIT = config.Backend.ModelContextWindowLimits.totalLimit;
    const SYSTEM_PROMPT_RESERVE = config.Backend.ModelContextWindowLimits.systemPromptReserve;
    const FORMATTING_RESERVE = config.Backend.ModelContextWindowLimits.formattingReserve;
    const OUTPUT_RESERVE = config.Backend.ModelContextWindowLimits.outputReserve;
    const AVAILABLE_TOKENS = CONTEXT_WINDOW_LIMIT - SYSTEM_PROMPT_RESERVE - FORMATTING_RESERVE - OUTPUT_RESERVE;

    const inputTokens = getTokenCount(data.text);

    if (inputTokens <= AVAILABLE_TOKENS) {
      console.log('Text token count within limit:', inputTokens);
      // Process normally if text is within limit
      const messages = [
        {
          role: 'system',
          content: `あなたはユーザーが提供する文章や情報をもとに、分かりやすく簡潔な要約を作成する専門アシスタントです。  
要約は以下の指針に従ってください：  
- 内容の核心を正確に抽出し、重要なポイントを漏らさないこと  
- 不要な詳細や繰り返しは省き、全体を整理して簡潔にまとめること  
- 原文の意味を歪めず、中立的かつ客観的に表現すること  
- 読み手がすぐに理解できる自然で明瞭な日本語を用いること  
- ユーザーが特に指定しない限り、要約の長さは適度に短く、数行程度に抑えること  

ユーザーの入力を読み取り、その内容に最もふさわしい要約を生成してください。`
        },
        {
          role: 'user',
          content: `以下の内容を日本語で要約してください：
---
${data.text}
---
以上はすべての内容です、日本語で要約してください。`
        }
      ];

      // Verify total token count including system prompt
      const totalTokens = countMessageTokens(messages);
      if (totalTokens > CONTEXT_WINDOW_LIMIT - OUTPUT_RESERVE) {
        console.warn(`Total tokens (${totalTokens}) exceed limit, truncating input...`);
        const maxInputTokens = AVAILABLE_TOKENS - getTokenCount(messages[0].content) - 100; // 100 for user message formatting
        const truncatedText = getTextWithTokenLimit(data.text, maxInputTokens);
        messages[1].content = `以下の内容を日本語で要約してください：
---
${truncatedText}
---
以上はすべての内容です、日本語で要約してください。`;
      }

      content = await generateWithLLM(messages, outputId);
    } else {
      // Split text and process sequentially based on token limits
      console.log('Text token count exceeds limit:', inputTokens);
      const chunkMaxTokens = Math.floor(AVAILABLE_TOKENS * 0.7); // Leave room for previous summary
      const chunks = splitTextByTokens(data.text, chunkMaxTokens, 100);
      let previousSummary = '';

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        let textToProcess = chunk;

        // Prepend previous summary if this is not the first chunk
        if (i > 0 && previousSummary) {
          const summaryPrefix = `前のセクションの要約：
${previousSummary}

続きの内容：
`;
          const prefixTokens = getTokenCount(summaryPrefix);
          const chunkTokens = getTokenCount(chunk);
          const totalTextTokens = prefixTokens + chunkTokens;

          // If combined text is too long, truncate the previous summary
          if (totalTextTokens > chunkMaxTokens) {
            const maxSummaryTokens = chunkMaxTokens - chunkTokens - getTokenCount('前のセクションの要約：\n...\n\n続きの内容：\n');
            const truncatedSummary = getTextWithTokenLimit(previousSummary, maxSummaryTokens) + '...';
            textToProcess = `前のセクションの要約：
${truncatedSummary}

続きの内容：
${chunk}`;
          } else {
            textToProcess = `前のセクションの要約：
${previousSummary}

続きの内容：
${chunk}`;
          }
        }

        const messages = [
          {
            role: 'system',
            content: `あなたはユーザーが提供する文章や情報をもとに、分かりやすく簡潔な要約を作成する専門アシスタントです。  
要約は以下の指針に従ってください：  
- 内容の核心を正確に抽出し、重要なポイントを漏らさないこと  
- 不要な詳細や繰り返しは省き、全体を整理して簡潔にまとめること  
- 原文の意味を歪めず、中立的かつ客観的に表現すること  
- 読み手がすぐに理解できる自然で明瞭な日本語を用いること  
- 前のセクションの要約がある場合は、それと現在の内容を統合して包括的な要約を作成すること  

ユーザーの入力を読み取り、その内容に最もふさわしい要約を生成してください。`
          },
          {
            role: 'user',
            content: `以下の内容を日本語で要約してください${i > 0 ? '（前のセクションの要約と統合して）' : ''}：
---
${textToProcess}
---
以上${i === chunks.length - 1 ? 'はすべての内容です' : 'の内容を要約し'}、日本語で要約してください。`
          }
        ];

        // Verify token count for this chunk
        const chunkMessageTokens = countMessageTokens(messages);
        console.log(`Chunk ${i + 1} token count:`, chunkMessageTokens);

        const chunkSummary = await generateWithLLM(messages, outputId);

        // Check if task was cancelled
        const [curOutput] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: outputId } });
        if (curOutput.status === 'CANCEL') return { outputId, isOk: false, content: '' };

        if (chunkSummary === 'error happen') {
          isOk = false;
          break;
        }

        previousSummary = chunkSummary;

        // Update progress
        await put<IGenTaskOutputSer>(
          KrdGenTaskOutput,
          { id: outputId },
          {
            content: `処理中... (${i + 1}/${chunks.length})\n\n${chunkSummary}`,
            status: 'PROCESSING',
            update_by: 'JOB',
          },
        );
      }

      content = previousSummary;
    }

    isOk = content !== 'error happen';

    const [curOutput] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: outputId } });
    if (curOutput.status === 'CANCEL') return { outputId, isOk: false, content: '' };

    await put<IGenTaskOutputSer>(
      KrdGenTaskOutput,
      { id: outputId },
      {
        content,
        status: isOk ? 'FINISHED' : 'FAILED',
        update_by: 'JOB',
      },
    );

    return { outputId, isOk, content };
  };
  await execute(type, taskId, callAviary);
};

export default summaryGenProcess;
