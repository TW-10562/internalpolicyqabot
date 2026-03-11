import { put, queryPage, queryList, queryConditionsDataByOrder } from '@/utils/mapper';
import KrdGenTask from '@/mysql/model/gen_task.model';
import KrdGenTaskOutput from '@/mysql/model/gen_task_output.model';
import { userType } from '@/types';
import { IGenTask, IGenTaskQuerySerType, IGenTaskQueryType, IGenTaskSer } from '@/types/genTask';
import { IGenTaskOutputQuerySerType, IGenTaskOutputQueryType, IGenTaskOutputReNameSer, IGenTaskOutputSer } from '@/types/genTaskOutput';
import { Context } from 'koa';
import { Op } from 'sequelize';

import { queryConditionsData } from '@/service';
import { handleAddGenTask } from '@/service/genTaskService';
import { createChatStreamSubscriber } from '@/service/chatStreamService';
import { recordFeedbackEvent } from '@/service/analyticsService';
import { detectLanguage } from '@/utils/languageDetector';
import { classifyQueryIntent, QueryIntent } from '@/utils/queryIntentClassifier';

const GEN_TASK_VERBOSE = process.env.GEN_TASK_VERBOSE === '1';
const genTaskLog = (...args: any[]) => {
  if (GEN_TASK_VERBOSE) console.log(...args);
};
const CHAT_OUTPUT_STREAM_TIMEOUT_MS = Math.max(15000, Number(process.env.CHAT_OUTPUT_STREAM_TIMEOUT_MS || 300000));
const CHAT_OUTPUT_STREAM_POLL_MS = Math.max(30, Number(process.env.CHAT_OUTPUT_STREAM_POLL_MS || 40));
const CHAT_OUTPUT_STREAM_CHUNK_SIZE = Math.max(1, Number(process.env.CHAT_OUTPUT_STREAM_CHUNK_SIZE || 4));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const writeSseEvent = (ctx: Context, event: string, payload: Record<string, any>) => {
  ctx.res.write(`event: ${event}\n`);
  ctx.res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

export const getAddMid = async (ctx: any, next: () => Promise<void>) => {
  try {
    const { userName, userId } = ctx.state.user as userType;
    const accessScope = (ctx.state?.accessScope || {}) as {
      roleCode?: string;
      departmentCode?: string;
    };
    const addContent = ctx.request.body as IGenTask;

    genTaskLog('\n' + '='.repeat(80));
    genTaskLog('🚀 [GenTask] Processing new task...');
    genTaskLog('='.repeat(80));
    genTaskLog('📋 [GenTask] Task Details:', {
      type: addContent.type,
      userId: userId,
      userName: userName,
      timestamp: new Date().toISOString(),
    });

    let enhancedContent = addContent;
    let detectedLanguage = 'en';
    let isCompanyQuery = false;
    let processingPath = 'GENERAL';
    let queryIntent: QueryIntent = 'general_chat';

    // ========== TWO-PATH QUERY PROCESSING ==========
    // Only process if this is a CHAT with actual content (not empty chat creation)
    const chatFormData = addContent.formData as any;
    const userQuery = chatFormData?.prompt || '';
    const hasActualContent = addContent.type === 'CHAT' && chatFormData && userQuery.trim().length > 0;
    
    if (hasActualContent) {

      genTaskLog('💬 [GenTask] Chat request detected');
      genTaskLog('📝 [GenTask] User query:', {
        query: userQuery.substring(0, 100) + (userQuery.length > 100 ? '...' : ''),
        length: userQuery.length,
      });

      try {
        // ===== STEP 1: LANGUAGE DETECTION =====
        genTaskLog('\n--- STEP 1: LANGUAGE DETECTION ---');
        detectedLanguage = detectLanguage(userQuery);
        genTaskLog('✅ [GenTask] Language detected:', {
          language: detectedLanguage === 'ja' ? 'Japanese (日本語)' : 'English (EN)',
          confidence: 'High',
        });

        // ===== STEP 2: QUERY CLASSIFICATION =====
        genTaskLog('\n--- STEP 2: QUERY CLASSIFICATION ---');
        const queryIntentResult = classifyQueryIntent(userQuery);
        queryIntent = queryIntentResult.intent;
        isCompanyQuery = queryIntent === 'rag_query';
        processingPath =
          queryIntent === 'rag_query'
            ? 'COMPANY'
            : (queryIntent === 'translation_request'
              ? 'TRANSLATION_REQUEST'
              : (queryIntent === 'faq_lookup' ? 'FAQ_LOOKUP' : 'GENERAL_CHAT'));

        genTaskLog('📊 [GenTask] RAG Processing:', {
          intent: queryIntent,
          isCompanyQuery,
          path: processingPath,
          language: detectedLanguage === 'ja' ? 'Japanese' : 'English',
          ragEnabled: queryIntent === 'rag_query',
          reason: queryIntentResult.matchedRule || 'shared query intent classifier',
        });

        genTaskLog('\n--- STEP 2.1: QUERY ROUTING ---');
        genTaskLog(
          queryIntent === 'rag_query'
            ? 'ℹ️  [GenTask] Routing query to company-document retrieval.'
            : `ℹ️  [GenTask] Bypassing RAG and routing query as ${queryIntent}.`,
        );
        
        // Keep enqueue path deterministic/lightweight.
        // Query translation is handled in worker (chatGenProcess) with retry/fallback.
        const queryForRAG = userQuery;

        // Do not pre-filter files at enqueue time.
        // Let worker retrieval search all allowed/indexed docs for best recall.
        enhancedContent = {
          ...addContent,
          formData: {
            ...chatFormData,
            prompt: userQuery,
            processingPath,
            departmentCode: accessScope.departmentCode || chatFormData.departmentCode,
            roleCode: accessScope.roleCode || chatFormData.roleCode,
            detectedLanguage: detectedLanguage,
            originalQuery: userQuery,
            queryForRAG: queryForRAG,
            queryIntent,
            ragTriggered: queryIntent === 'rag_query',
            usedFileIds: [],
            fileId: [],
            allFileSearch: queryIntent === 'rag_query',
            dualLanguageEnabled: false,
          },
        };
        genTaskLog('✨ [GenTask] Query path prepared');
      } catch (error) {
        console.error('❌ [GenTask] Error in query processing:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        processingPath = 'COMPANY_FALLBACK';
        isCompanyQuery = true;
        queryIntent = 'rag_query';
        
        // Fallback: process with RAG enabled
        enhancedContent = {
          ...addContent,
          formData: {
            ...chatFormData,
            prompt: userQuery,
            processingPath: 'COMPANY_FALLBACK',
            departmentCode: accessScope.departmentCode || chatFormData.departmentCode,
            roleCode: accessScope.roleCode || chatFormData.roleCode,
            detectedLanguage: detectedLanguage,
            queryIntent: 'rag_query',
            ragTriggered: true,
            allFileSearch: true,
            dualLanguageEnabled: true,
          },
        };
      }
    }

    genTaskLog('\n--- TASK CREATION ---');
    genTaskLog('📤 [GenTask] Sending task to processing queue...');
    const result = await handleAddGenTask(enhancedContent, userName, Number(userId));
    const ragTriggered = Boolean((enhancedContent as any)?.formData?.ragTriggered);

    genTaskLog('✅ [GenTask] Task created successfully:', {
      taskId: result.taskId,
      type: addContent.type,
      processingPath: processingPath,
      detectedLanguage: detectedLanguage,
      ragEnabled: ragTriggered ? 'YES' : 'NO',
    });

    ctx.state.formatData = {
      taskId: result.taskId,
      task: result.task,
      metadata: {
        processingPath: processingPath,
        detectedLanguage: detectedLanguage,
        isCompanyQuery: isCompanyQuery,
        queryIntent,
        ragTriggered: ragTriggered,
        usedFiles: null,
        dualLanguageEnabled: true,
      },
    };

    genTaskLog('='.repeat(80) + '\n');

    await next();
  } catch (error) {
    console.error('❌ [GenTask] FATAL ERROR:', error);
    return ctx.app.emit(
      'error',
      {
        code: '400',
        message: 'アップロードパラメータを確認してください',
      },
      ctx,
    );
  }
};

export const getListMid = async (ctx: any, next: () => Promise<void>) => {
  try {
    const { userName } = ctx.state.user as userType;
    const { pageNum, pageSize, ...params } = ctx.query as unknown as IGenTaskQueryType;
    const newParams = { pageNum, pageSize } as IGenTaskQuerySerType;

    if (userName) newParams.create_by = userName;
    if (params.type) newParams.type = params.type;
    if (params.status) newParams.status = params.status;

    const res = await queryPage<IGenTaskQuerySerType>(KrdGenTask, newParams);

    ctx.state.formatData = res;
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit(
      'error',
      {
        code: '500',
        message: 'リストの取得に失敗しました',
      },
      ctx,
    );
  }
};

export const getOutputListMid = async (ctx: any, next: () => Promise<void>) => {
  try {
    const { pageNum, pageSize, ...params } = ctx.query as unknown as IGenTaskOutputQueryType;
    const newParams = { pageNum, pageSize } as IGenTaskOutputQuerySerType;
    if (params.taskId) newParams.task_id = params.taskId;
    if (params.status) newParams.status = params.status;
    if (params.sort) newParams.sort = params.sort;

    const res = await queryPage<IGenTaskOutputQuerySerType>(KrdGenTaskOutput, newParams);

    ctx.state.formatData = res;
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit(
      'error',
      {
        code: '500',
        message: 'リストの取得に失敗しました',
      },
      ctx,
    );
  }
};

export const streamTaskOutputMid = async (ctx: Context) => {
  const taskId = String(ctx.query?.taskId || '').trim();
  const sortNum = Number(ctx.query?.sort);
  if (!taskId || !Number.isFinite(sortNum)) {
    ctx.status = 400;
    ctx.body = { code: 400, message: 'taskId and sort are required' };
    return;
  }

  ctx.req.setTimeout(0);
  ctx.status = 200;
  ctx.respond = false;
  ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
  ctx.set('Cache-Control', 'no-cache, no-transform');
  ctx.set('Connection', 'keep-alive');
  ctx.set('X-Accel-Buffering', 'no');
  ctx.res.flushHeaders?.();

  let closed = false;
  const markClosed = () => {
    closed = true;
  };
  ctx.req.on('close', markClosed);
  ctx.req.on('aborted', markClosed);
  ctx.res.on('close', markClosed);

  let outputId: number | undefined;
  let lastContent = '';
  let lastStatus = '';
  const startedAt = Date.now();
  let lastHeartbeatAt = 0;
  let lastPubSubAt = 0;
  let doneByPubSub = false;
  const streamSubscriber = await createChatStreamSubscriber(taskId, (event, payload) => {
    if (closed || ctx.res.writableEnded) return;
    const now = Date.now();
    lastPubSubAt = now;
    const status = String(payload?.status || '').toUpperCase();
    if (status) lastStatus = status;
    if (Number.isFinite(Number(payload?.outputId))) outputId = Number(payload.outputId);
    if (event === 'replace' && typeof payload?.content === 'string') {
      lastContent = String(payload.content || '');
    }
    if (event === 'chunk' && typeof payload?.delta === 'string') {
      lastContent += String(payload.delta || '');
    }
    if (event === 'done') {
      if (typeof payload?.content === 'string') lastContent = String(payload.content || lastContent);
      doneByPubSub = true;
    }
    writeSseEvent(ctx, event, payload || {});
  }).catch(() => ({
    close: async () => undefined,
  }));

  try {
    writeSseEvent(ctx, 'status', { status: 'WAIT' });

    while (!closed) {
      if (doneByPubSub) break;
      if (Date.now() - startedAt > CHAT_OUTPUT_STREAM_TIMEOUT_MS) {
        writeSseEvent(ctx, 'timeout', {
          status: lastStatus || 'WAIT',
          outputId,
          content: lastContent,
        });
        break;
      }

      const outputs = await queryConditionsDataByOrder(
        KrdGenTaskOutput,
        { task_id: taskId, sort: { [Op.gte]: sortNum } },
        [['sort', 'ASC'], ['id', 'ASC']],
      );
      const current = Array.isArray(outputs) && outputs.length > 0 ? outputs[0] : null;

      if (current) {
        outputId = Number(current.id);
        const status = String(current.status || 'WAIT').toUpperCase();
        const content = String(current.content || '');

        if (status !== lastStatus) {
          lastStatus = status;
          writeSseEvent(ctx, 'status', { status, outputId });
        }

        if (content !== lastContent) {
          const preferPubSub = (Date.now() - lastPubSubAt) < 1200;
          if (!preferPubSub) {
            if (content.startsWith(lastContent)) {
              const delta = content.slice(lastContent.length);
              if (delta) {
                const slices = delta.match(new RegExp(`([\\s\\S]{1,${CHAT_OUTPUT_STREAM_CHUNK_SIZE}})`, 'g')) || [];
                for (const piece of slices) {
                  writeSseEvent(ctx, 'chunk', { delta: piece, outputId, status });
                }
              }
            } else {
              writeSseEvent(ctx, 'replace', { content, outputId, status });
            }
          }
          lastContent = content;
        }

        if (status === 'FINISHED' || status === 'FAILED' || status === 'CANCEL') {
          writeSseEvent(ctx, 'done', { status, outputId, content: lastContent });
          break;
        }
      }

      const now = Date.now();
      if (now - lastHeartbeatAt > 5000) {
        writeSseEvent(ctx, 'status', { status: lastStatus || 'WAIT', outputId });
        lastHeartbeatAt = now;
      }

      await sleep(CHAT_OUTPUT_STREAM_POLL_MS);
    }
  } catch (error: any) {
    writeSseEvent(ctx, 'error', {
      message: String(error?.message || error || 'stream_error'),
      status: lastStatus || 'FAILED',
      outputId,
      content: lastContent,
    });
  } finally {
    await streamSubscriber.close().catch(() => undefined);
    ctx.req.off('close', markClosed);
    ctx.req.off('aborted', markClosed);
    ctx.res.off('close', markClosed);
    if (!ctx.res.writableEnded) ctx.res.end();
  }
};

export const updateTaskOutputMid = async (ctx: any, next: () => Promise<void>) => {
  const { userName } = ctx.state.user as userType;
  const { taskOutputId } = ctx.params;
  const { status, metadata, feedback, content } = ctx.request.body;

  await put<IGenTaskOutputSer>(KrdGenTaskOutput, { id: taskOutputId }, {
    status,
    metadata,
    feedback,
    content,
    update_by: userName,
  } as IGenTaskOutputSer);

  await next();
};

export const reNameTaskOutputMid = async (ctx: any, next: () => Promise<void>) => {
  const { userName } = ctx.state.user as userType;
  const { taskId } = ctx.params;
  const { newName } = ctx.request.body;

  await put<IGenTaskOutputReNameSer>(KrdGenTask, { id: taskId }, {
    form_data: newName,
    update_by: userName,
  } as IGenTaskOutputReNameSer);

  await next();
};

export const deleteTaskOutputMid = async (ctx: any, next: () => Promise<void>) => {
  const { taskId } = ctx.params;

  await KrdGenTask.destroy({
    where: { id: taskId },
  });

  await KrdGenTaskOutput.destroy({
    where: { task_id: taskId },
  });

  await next();
};

export const stopTaskOutputMid = async (ctx: any, next: () => Promise<void>) => {
  try {
    const taskId = ctx.query?.taskId;
    const fieldSort = ctx.params?.fieldSort ?? ctx.query?.fieldSort;
    const { userName } = ctx.state.user as userType;

    if (!taskId || !fieldSort) {
      return ctx.app.emit(
        'error',
        {
          code: '400',
          message: 'taskId and fieldSort are required',
        },
        ctx,
      );
    }


    const outputData = await queryConditionsData(KrdGenTaskOutput, {
      task_id: taskId,
      sort: fieldSort,
      status: { [Op.in]: ['IN_PROCESS', 'PROCESSING', 'WAIT'] },
    });

    if (outputData && outputData.length > 0) {
      await put<IGenTaskOutputSer>(
        KrdGenTaskOutput,
        {
          task_id: taskId,
          sort: fieldSort,
          status: { [Op.in]: ['IN_PROCESS', 'PROCESSING', 'WAIT'] },
        },
        {
          // content: 'CANCEL',
          status: 'CANCEL',
          update_by: userName,
        },
      );

      const outputs = await queryConditionsData(KrdGenTaskOutput, {
        task_id: outputData[0].task_id,
        status: { [Op.in]: ['IN_PROCESS', 'PROCESSING', 'WAIT'] },
      });

      if (!outputs || outputs.length === 0) {
        await put<IGenTaskSer>(KrdGenTask, { id: outputData[0].task_id }, { status: 'FINISHED', update_by: userName });
      }
    }
  } catch (error) {
    console.error('Error in stopTaskOutputMid:', error);
  }

  await next();
};

export const getChatTitleMid = async (ctx: any, next: () => Promise<void>) => {
  const { userName } = ctx.state.user as userType;
  const { chatId } = ctx.query;
  const newParams = { id: chatId, pageNum: 1, pageSize: 1, create_By: userName } as IGenTaskQuerySerType;

  try {
    const res = await queryPage<IGenTaskQuerySerType>(KrdGenTask, newParams);
    ctx.state.formatData = res;
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit(
      'error',
      {
        code: '500',
        message: 'リストの取得に失敗しました',
      },
      ctx,
    );
  }
};

export const sendFeedbackToCache = async (ctx: any, next: () => Promise<void>) => {
  try {
    const { userId, userName } = ctx.state.user as userType;
    const accessScope = (ctx.state?.accessScope || {}) as {
      departmentCode?: string;
    };
    const { taskOutputId: rawTaskOutputId, cache_signal, query, answer } = ctx.request.body as {
      taskOutputId: number;
      cache_signal: number;
      query: string;
      answer: string;
    };

    // Convert taskOutputId to string if it's a number
    const taskOutputId = String(rawTaskOutputId);

    console.log(`[FEEDBACK] User ${userName} sending feedback: signal=${cache_signal}, taskOutputId=${taskOutputId}`);
    console.log(`[FEEDBACK] Query: ${query?.substring(0, 50)}...`);
    console.log(`[FEEDBACK] Answer: ${answer?.substring(0, 50)}...`);

    // Validate input
    if (cache_signal !== 0 && cache_signal !== 1) {
      return ctx.app.emit('error', {
        code: '400',
        message: 'cache_signal must be 0 or 1',
      }, ctx);
    }

    await recordFeedbackEvent({
      taskOutputId: Number(rawTaskOutputId),
      userId: Number(userId || 0) || undefined,
      userName: String(userName || ''),
      departmentCode: accessScope.departmentCode,
      cacheSignal: cache_signal,
      query,
      answer,
      metadata: {
        source: 'chat_feedback',
      },
    });

    let faqCacheStatus: 'stored' | 'skipped' | 'failed' = 'skipped';
    let faqCacheResult: any = null;
    let faqCacheMessage = '';

    if (query && answer) {
      const feedbackData = {
        cache_signal,
        query,
        answer,
      };

      const faqCacheUrl = (
        process.env.FAQ_CACHE_API_URL ||
        process.env.FAQ_CACHE_URL ||
        'http://localhost:8001'
      ).replace(/\/+$/, '');
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 5000);

      try {
        const response = await fetch(`${faqCacheUrl}/feedback`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(feedbackData),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          faqCacheStatus = 'failed';
          faqCacheMessage = `FAQ cache service error: ${response.status}`;
          console.error(`[FEEDBACK] FAQ cache service error: ${response.status} - ${errorText}`);
        } else {
          faqCacheResult = await response.json();
          faqCacheStatus = 'stored';
          faqCacheMessage = String(faqCacheResult?.message || 'Feedback sent successfully');
          console.log('[FEEDBACK] FAQ cache response:', faqCacheResult);
        }
      } catch (error: any) {
        faqCacheStatus = 'failed';
        faqCacheMessage = `FAQ cache unavailable: ${String(error?.message || error)}`;
        console.error('[FEEDBACK] FAQ cache request failed:', error);
      } finally {
        clearTimeout(timeout);
      }
    }

    const responseMessage = faqCacheStatus === 'stored'
      ? faqCacheMessage
      : 'Feedback recorded for analytics';

    // Return success response
    ctx.state.formatData = {
      success: true,
      message: responseMessage,
      action_taken: faqCacheResult?.action_taken || null,
      cache_signal,
      taskOutputId: taskOutputId,
      faq_cache_status: faqCacheStatus,
      faq_cache_message: faqCacheMessage || null,
      faq_cache_response: faqCacheResult,
    };

    await next();
  } catch (error) {
    console.error('[FEEDBACK] Error recording feedback:', error);
    return ctx.app.emit('error', {
      code: '500',
      message: `Failed to record feedback: ${error.message}`,
    }, ctx);
  }
};
export const translateContentOnDemandMid = async (ctx: any, next: () => Promise<void>) => {
  try {
    const userName = ctx.state?.user?.userName || 'anonymous';
    const { outputId: rawOutputId, targetLanguage } = ctx.request.body as {
      outputId: number | string;
      targetLanguage: 'ja' | 'en';
    };
    const outputId = Number(rawOutputId);

    console.log(`\n[TRANSLATION-CONTROLLER] Starting translation request`);
    console.log(`[TRANSLATION-CONTROLLER] User: ${userName}, OutputId: ${outputId}, Target: ${targetLanguage}`);

    // Validate input
    if (!Number.isFinite(outputId) || outputId <= 0) {
      console.error(`[TRANSLATION-CONTROLLER] Invalid outputId: ${rawOutputId}`);
      return ctx.app.emit('error', {
        code: '400',
        message: 'outputId is required and must be a number',
      }, ctx);
    }

    if (!targetLanguage || !['ja', 'en'].includes(targetLanguage)) {
      console.error(`[TRANSLATION-CONTROLLER] Invalid targetLanguage: ${targetLanguage}`);
      return ctx.app.emit('error', {
        code: '400',
        message: 'targetLanguage must be "ja" or "en"',
      }, ctx);
    }

    try {
      // Fetch the original output from database
      console.log(`[TRANSLATION-CONTROLLER] Fetching output ${outputId} from database...`);
      const [output] = await queryList(KrdGenTaskOutput, { 
        id: { [Op.eq]: outputId } 
      });

      if (!output) {
        console.error(`[TRANSLATION-CONTROLLER] Output ${outputId} not found in database`);
        return ctx.app.emit('error', {
          code: '404',
          message: `Output with ID ${outputId} not found`,
        }, ctx);
      }

      if (!output.content || output.content.trim().length === 0) {
        console.error(`[TRANSLATION-CONTROLLER] Output content is empty`);
        return ctx.app.emit('error', {
          code: '400',
          message: 'Output content is empty',
        }, ctx);
      }

      console.log(`[TRANSLATION-CONTROLLER] Found output, content length: ${output.content.length}`);

      // Parse the stored output format
      const { parseDualLanguageOutput } = await import('@/utils/translation');
      const parsed = parseDualLanguageOutput(output.content);
      
      console.log(`[TRANSLATION-CONTROLLER] Parsed output:`, {
        isDualLanguage: parsed.isDualLanguage,
        hasSingleContent: !!parsed.singleContent,
        language: parsed.language,
        hasTranslationPending: parsed.translationPending,
      });

      // Determine the current language and content to translate
      let contentToTranslate = '';
      let currentLanguage: 'ja' | 'en' = 'en';

      if (parsed.singleContent) {
        // New single-language format (from formatSingleLanguageOutput)
        contentToTranslate = parsed.singleContent;
        currentLanguage = (parsed.language || 'en') as 'ja' | 'en';
        console.log(`[TRANSLATION-CONTROLLER] Using single-language format, current language: ${currentLanguage}`);
      } else if (parsed.isDualLanguage && parsed.translated) {
        // Old dual-language format (backwards compatibility)
        contentToTranslate = parsed.translated;
        currentLanguage = (parsed.targetLanguage || 'en') as 'ja' | 'en';
        console.log(`[TRANSLATION-CONTROLLER] Using dual-language format, current language: ${currentLanguage}`);
      } else {
        // Fallback to raw content
        contentToTranslate = parsed.rawContent;
        console.warn(`[TRANSLATION-CONTROLLER] Using fallback (raw content)`);
      }

      if (!contentToTranslate || contentToTranslate.trim().length === 0) {
        console.error(`[TRANSLATION-CONTROLLER] Content to translate is empty after parsing`);
        return ctx.app.emit('error', {
          code: '400',
          message: 'Unable to extract translatable content from output',
        }, ctx);
      }

      console.log(`[TRANSLATION-CONTROLLER] Content to translate (first 100 chars): "${contentToTranslate.substring(0, 100)}..."`);
      console.log(`[TRANSLATION-CONTROLLER] Current language: ${currentLanguage}, Target: ${targetLanguage}`);

      // Perform direct translation with status reporting.
      console.log(`[TRANSLATION-CONTROLLER] Calling translation function...`);
      const { translateContentOnDemandWithStatus } = await import('@/utils/translation');
      const translationResult = await translateContentOnDemandWithStatus(
        contentToTranslate,
        currentLanguage,
        targetLanguage,
      );

      if (!translationResult.content && translationResult.status === 'error') {
        console.error(`[TRANSLATION-CONTROLLER] Translation returned empty content`);
        return ctx.app.emit('error', {
          code: '500',
          message: 'Translation service returned empty content',
        }, ctx);
      }

      console.log(`[TRANSLATION-CONTROLLER] Translation completed`);
      console.log(`[TRANSLATION-CONTROLLER] Translation status: ${translationResult.status}`);
      console.log(`[TRANSLATION-CONTROLLER] Translated content length: ${translationResult.content.length}`);
      console.log(`[TRANSLATION-CONTROLLER] Translated content (first 100 chars): "${translationResult.content.substring(0, 100)}..."`);

      // Return the translation result
      ctx.state.formatData = {
        outputId,
        translated: translationResult.status === 'translated',
        status: translationResult.status,
        translation_status: translationResult.translation_status,
        content: translationResult.content,
        sourceLanguage: translationResult.sourceLanguage,
        targetLanguage: translationResult.targetLanguage,
        outputLanguage: translationResult.outputLanguage,
        timestamp: new Date().toISOString(),
      };

      console.log(`[TRANSLATION-CONTROLLER] Setting formatData for response`);
      await next();
    } catch (translationError) {
      console.error('[TRANSLATION-CONTROLLER] Translation operation error:', translationError);
      const errorMessage = translationError instanceof Error ? translationError.message : String(translationError);
      return ctx.app.emit('error', {
        code: '500',
        message: `Translation failed: ${errorMessage}`,
      }, ctx);
    }
  } catch (error) {
    console.error('[TRANSLATION-CONTROLLER] Outer error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return ctx.app.emit('error', {
      code: '500',
      message: `Failed to process translation: ${errorMessage}`,
    }, ctx);
  }
};
