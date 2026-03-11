import { RAGProcessor, UploadedFile, UploadResult } from "@/types/ragProcessor";

export default class SplitByPage implements RAGProcessor {
  name = "SplitByPage";

  async upload(file: UploadedFile, tagsIdList: number[], userName: string): Promise<UploadResult> {
    console.log("This is splitByPage upload function");
    const { result, status } = await uploadByPage(file, tagsIdList, userName);
    return { result, status };
  }

  async search(prompt: string): Promise<string> {
    console.log(`[RAG] splitByPage.search called with query: "${prompt}"`);
    try {
      const result = await searchByPage(prompt);
      console.log(`[RAG] splitByPage search completed, result length: ${result.length}`);
      return result;
    } catch (error) {
      console.error(`[RAG] splitByPage search error:`, error);
      throw error;
    }
  }
}


import path from 'path';
import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import { nanoid } from 'nanoid';
import File from '@/mysql/model/file.model';
import { FILE_UPLOAD_DIR } from '@/config/uploadPath';
import { config } from '@/config/index';
import { deleteFile } from '@/controller/file';
import { Context } from 'koa';
import { STRICT_OLLAMA_MODEL } from '@/constants/llm';
import { getPublicApiBaseUrl } from '@/utils/publicUrl';

async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 1200): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

export async function uploadByPage(
  file: UploadedFile, tags?: Array<number>, userName?: string
): Promise<UploadResult> {
  console.log('===========================================');
  console.log('[UploadByPage] Starting upload for:', file.originalFilename);
  console.log('[UploadByPage] File details:', JSON.stringify({ filepath: file.filepath, size: file.size, mimetype: file.mimetype }));
  console.log('[UploadByPage] Tags:', tags);
  console.log('[UploadByPage] UserName:', userName);
  console.log('===========================================');
  
  if (!file.originalFilename) {
    throw new Error("The originalFilename property is missing or invalid.");
  }

  file.originalFilename = file.originalFilename.split('/').pop();
  const fileExtname = path.extname(file.originalFilename);
  if (!fileExtname) {
    throw new Error("Failed to extract file extension.");
  }

  const uniqueFileName = nanoid() + fileExtname;
  const newPath = path.join(FILE_UPLOAD_DIR, uniqueFileName);
  console.log('[UploadByPage] Target path:', newPath);

  // Use copy + delete instead of rename (cross-device moves fail with rename)
  try {
    await fs.promises.copyFile(file.filepath, newPath);
    await fs.promises.unlink(file.filepath).catch(() => {}); // Ignore if temp file already removed
    console.log('[UploadByPage] File copied successfully to:', newPath);
  } catch (moveError) {
    console.error('[UploadByPage] Failed to move file:', moveError);
    throw moveError;
  }

  let record;

  try {
    //MySQLへ登録
    console.log('[UploadByPage] Saving to database...');
    record = await File.create({
      filename: file.originalFilename,
      tag: tags && tags.length > 0 ? tags[0] : null,  // Use first tag or null
      storage_key: uniqueFileName,
      mime_type: file.mimetype,
      size: file.size,
      create_by: userName,
    });
    console.log('[UploadByPage] Database record created:', record.id);

    if (fileExtname === '.pdf') {
      // Index PDF directly to Solr (simpler and more reliable)
      console.log('[UploadByPage] Processing PDF file - indexing to Solr...');
      let solrOk = false;
      try {
        await retry(
          () => {
            const solrFormat = new FormData();
            solrFormat.append('myfile', fs.createReadStream(newPath), file.originalFilename);
            solrFormat.append('literal.id', uniqueFileName);
            solrFormat.append('literal.title', file.originalFilename);
            solrFormat.append('literal.file_name_s', uniqueFileName);
            solrFormat.append('literal.file_path_s', newPath);
            solrFormat.append('literal.rag_tag_s', "splitByPage");
            solrFormat.append('commit', 'true');
            return axios.post(
              `${config.ApacheSolr.url}/solr/${config.ApacheSolr.coreName || 'mycore'}/update/extract`,
              solrFormat,
              { headers: solrFormat.getHeaders() }
            );
          },
          3,
          1200,
        );
        solrOk = true;
        console.log('[UploadByPage] PDF indexed to Solr successfully');
      } catch (solrErr: any) {
        console.error('[UploadByPage] Solr indexing failed after retries:', solrErr.message);
      }

      // Try RAG backend (required for consistency)
      let ragOk = false;
      try {
        await retry(
          () => {
            const form = new FormData();
            form.append('file', fs.createReadStream(newPath), file.originalFilename);
            form.append('collection_name', uniqueFileName);
            return axios.post(
              `${config.RAG.Backend.url}/upload`,
              form,
              { headers: form.getHeaders() },
            );
          },
          3,
          1200,
        );
        ragOk = true;
        console.log('[UploadByPage] RAG upload successful');
      } catch (ragErr: any) {
        console.warn('[UploadByPage] RAG upload failed after retries:', ragErr.message);
      }

      if (!solrOk || !ragOk) {
        throw new Error(`Indexing failed for ${file.originalFilename} (solrOk=${solrOk}, ragOk=${ragOk})`);
      }

    } else {
      //solrへ登録
      console.log('[UploadByPage] Indexing to Solr...');
      let solrOk = false;
      try {
        await retry(
          () => {
            const solrFormat = new FormData();
            solrFormat.append('myfile', fs.createReadStream(newPath), file.originalFilename);
            solrFormat.append('literal.id', uniqueFileName);
            solrFormat.append('literal.title', file.originalFilename);
            solrFormat.append('literal.file_name_s', uniqueFileName);
            solrFormat.append('literal.file_path_s', newPath);
            solrFormat.append('literal.rag_tag_s', "splitByPage");
            solrFormat.append('commit', 'true');
            return axios.post(
              `${config.ApacheSolr.url}/solr/${config.ApacheSolr.coreName || 'mycore'}/update/extract`,
              solrFormat,
              { headers: solrFormat.getHeaders() }
            );
          },
          3,
          1200,
        );
        solrOk = true;
        console.log('[UploadByPage] Solr indexing successful');
      } catch (solrErr) {
        console.warn('[UploadByPage] Solr indexing failed after retries:', solrErr.message);
      }

      //RAGへ登録
      console.log('[UploadByPage] Uploading to RAG backend...');
      let ragOk = false;
      try {
        await retry(
          () => {
            const form = new FormData();
            form.append('file', fs.createReadStream(newPath), file.originalFilename);
            form.append('collection_name', uniqueFileName);
            return axios.post(
              `${config.RAG.Backend.url}/upload`,
              form,
              { headers: form.getHeaders() },
            );
          },
          3,
          1200,
        );
        ragOk = true;
        console.log('[UploadByPage] RAG upload successful');
      } catch (ragErr) {
        console.warn('[UploadByPage] RAG upload failed after retries:', ragErr.message);
      }

      if (!solrOk || !ragOk) {
        throw new Error(`Indexing failed for ${file.originalFilename} (solrOk=${solrOk}, ragOk=${ragOk})`);
      }
    }
    console.log('[UploadByPage] Upload completed successfully!');

    const result = {
      id: record.getDataValue('id'),
      filename: record.getDataValue('filename'),
      storage_key: record.getDataValue('storage_key'),
      mime_type: record.getDataValue('mime_type'),
      size: record.getDataValue('size'),
      created_at: record.getDataValue('created_at') ?? record.getDataValue('createdAt'),
    };
    const status = 'fulfilled';

    return { result, status };
  } catch (err) {
    console.error(`File upload error: ${err.name}: ${err.message} in ${file.originalFilename}`);

    // 登録失敗時のロールバック処理
    // delete呼び出し用のctx設定
    if (record) {
      const deleteCtx = {
        request: {
          body: {
            ids: [record.getDataValue('id')],
          },
        },
      } as unknown as Context;
      await deleteFile(deleteCtx, async () => { });
    }
    const result = record
      ? {
          id: record.getDataValue('id'),
          filename: record.getDataValue('filename'),
          storage_key: record.getDataValue('storage_key'),
          mime_type: record.getDataValue('mime_type'),
          size: record.getDataValue('size'),
          created_at: record.getDataValue('created_at') ?? record.getDataValue('createdAt'),
        }
      : {
          id: 0,
          filename: file.originalFilename,
          storage_key: uniqueFileName,
          mime_type: file.mimetype,
          size: file.size,
          created_at: new Date(),
        };
    const status = 'rejected';
    return { result, status };
  }
}


import { PDFDocument } from 'pdf-lib'
import { promises as fsp } from 'node:fs';

export type PdfSplitOptions = {
  /** Target directory; defaults to the same directory as the source file */
  targetDirectory?: string;
  /** Start page (1-based, inclusive) */
  startPage?: number;
  /** End page (1-based, inclusive) */
  endPage?: number;
  /** Filename prefix; defaults to the source filename */
  filenamePrefix?: string;
  /** Whether to copy basic metadata to child PDFs */
  copyBasicMetadata?: boolean;
  /** Maximum number of concurrent saves (increase cautiously); defaults to 1 serial to save memory */
  concurrency?: number;
};

export type PdfSplitedPageResult = {
  /** Unique identifier in the Apache Solr */
  id: string;
  /** Original file name */
  originalFileName: string;
  /** Page number (1-based) */
  pageNumber: number;
  /** Path to the split page file */
  pageFilePath: string;
};

export async function splitPdfFileByPages(
  filePath: string,
  options: PdfSplitOptions = {}
): Promise<PdfSplitedPageResult[]> {

  const {
    targetDirectory,
    startPage,
    endPage,
    filenamePrefix,
    copyBasicMetadata = true,
    concurrency = 1,
  } = options;

  // Read source PDF
  const srcBytes = await fsp.readFile(filePath);
  const srcDoc = await PDFDocument.load(srcBytes);

  const total = srcDoc.getPageCount();
  const from = Math.max(1, startPage ?? 1);
  const to = Math.min(total, endPage ?? total);
  if (from > to) {
    throw new Error(`Invalid page range: startPage(${from}) > endPage(${to})`);
  }

  const base = filenamePrefix ?? path.parse(filePath).name;
  const dir = targetDirectory ?? path.join(path.dirname(filePath), base);
  await fsp.mkdir(dir, { recursive: true });

  // Pre-fetch metadata (copy if available)
  const title = srcDoc.getTitle();
  const author = srcDoc.getAuthor();
  const subject = srcDoc.getSubject();
  const keywords = srcDoc.getKeywords();
  const producer = srcDoc.getProducer();
  const creator = srcDoc.getCreator();
  const creationDate = srcDoc.getCreationDate();
  const modificationDate = srcDoc.getModificationDate();

  // Task list (control concurrent writes)
  const tasks: Array<() => Promise<PdfSplitedPageResult>> = [];
  for (let i = from; i <= to; i++) {
    const pageIndex0 = i - 1;
    tasks.push(async () => {
      const child = await PDFDocument.create();
      const [copied] = await child.copyPages(srcDoc, [pageIndex0]);
      child.addPage(copied);

      if (copyBasicMetadata) {
        if (title) child.setTitle(`${title} (p.${i})`);
        if (author) child.setAuthor(author);
        if (subject) child.setSubject(subject);
        if (keywords) child.setKeywords(keywords.split(',').map(k => k.trim()).filter(k => k.length > 0));
        if (producer) child.setProducer(producer);
        if (creator) child.setCreator(creator);
        if (creationDate) child.setCreationDate(creationDate);
        if (modificationDate) child.setModificationDate(modificationDate);
      }

      const bytes = await child.save();
      const curPageFileName = `splitByPage-${i}__${base}.pdf`;
      const outPath = path.join(dir, curPageFileName);
      await fsp.writeFile(outPath, bytes);
      return {
        // use the current page file name as the ID
        id: curPageFileName,
        originalFileName: base,
        pageNumber: i,
        pageFilePath: outPath,
      } as PdfSplitedPageResult;
    });
  }

  // Simple concurrency control (defaults to serial, safe and memory-efficient)
  const results: PdfSplitedPageResult[] = [];
  const running: Promise<void>[] = [];
  let idx = 0;

  const runNext = async () => {
    if (idx >= tasks.length) return;
    const current = idx++;
    const p = tasks[current]().then((out) => {
      results.push(out);
    });
    running.push(
      p.finally(() => {
        running.splice(running.indexOf(p as any), 1);
      })
    );
    if (running.length >= concurrency) {
      await Promise.race(running);
    }
    await runNext();
  };

  await runNext();
  await Promise.all(running);

  return results;
}

export async function indexOnePdfPage(
  solrUrl: string,
  core: string,
  originalFilename: string,
  uniqueFileName: string,
  pageFilePath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const fname = path.basename(pageFilePath);
    const pageNumber = Number(fname.match(/splitByPage-(\d+)__/)?.[1] || -1);
    if (pageNumber === -1) {
      throw new Error(`Cannot extract page number from: ${pageFilePath}`);
    }

    const form = new FormData();
    form.append('myfile', fs.createReadStream(pageFilePath), fname);
    form.append('literal.id', fname);
    form.append('literal.chunk_number_i', String(pageNumber));
    form.append('literal.file_name_s', uniqueFileName);
    form.append('literal.file_path_s', pageFilePath);
    form.append('literal.title', originalFilename);
    form.append('literal.rag_tag_s', "splitByPage");
    form.append('commit', 'true');

    await axios.post(`${solrUrl}/solr/${core}/update/extract`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    return { success: true };
  } catch (error) {
    console.error('Error indexing PDF page:', error);
    return { success: false, error: error.message };
  }
}



import { getNextApiUrl } from '@/utils/redis';


type RAGSearchResultItem = {
  id: string;
  content: string;
  chunk_number_i: number;
  title: string;
  file_path_s: string;
  score: number;
};

async function getSearchKeywords(prompt: string): Promise<string[]> {

  const keywordSchema = {
    type: "object",
    properties: {
      keywords: {
        type: "array",
        items: {
          type: "string"
        },
        description: "入力文に含まれる重要なキーワード"
      },
      similar_words: {
        type: "array",
        items: {
          type: "string"
        },
        description: "抽出したキーワードの類似語や関連語"
      }
    },
    required: ["keywords", "similar_words"],
    additionalProperties: false
  };

  const messages = [
    {
      role: 'system',
      content: `あなたはAIアシスタントです。入力された文からキーワードを抽出し、
抽出したキーワードとその類似語を含む検索クエリを生成してください。

出力は必ず以下のJSON形式で行ってください：
{
  "keywords": ["キーワード1", "キーワード2", "キーワード3", ...],
  "similar_words": ["類似語1", "類似語2", "類似語3", ...]
}

要件：
- keywordsには入力文に含まれる重要なキーワードを抽出してください
- similar_wordsには抽出したキーワードの類似語や関連語を含めてください
- 各配列の要素数は最大5個まで
- 必ずJSONとして返してください
- 文字列は日本語で出力してください`,
    },
    // TODO: Maybe add the whole conversation history here is better (only the user's questions)
    //       By doing so, the model can have more context about the user's information need
    //       For example, if the conversation like:
    //           User: 夜勤専従制度は？
    //           Bot: 「夜勤専従制度」という制度は検索結果に見当たりません。
    //                 もしかして「徹夜明勤務」の制度のことを指していますか？
    //           User: そうです。
    //       Then the model can understand that the user is now asking about the "徹夜明勤務"
    //       otherwise, the prompt in here is just "そうです。"
    { role: "user", content: prompt }
  ];

  const url = await getNextApiUrl('ollama');

  const keywordModelName = STRICT_OLLAMA_MODEL;

  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream: false,
        model: keywordModelName,
        messages,
        // Structured outputs can fail on gpt-oss family due to Harmony response format handling.
        // refer to: https://github.com/ollama/ollama/issues/11691#issuecomment-3157223324
        format: keywordModelName.includes("gpt-oss:") ? null : keywordSchema,
        options: {
          temperature: config.Models.chatKeywordGenModel.temperature ?? 0.1,
          repeat_penalty: config.Models.chatKeywordGenModel.repeat_penalty ?? 1.5
        }
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const res = await response.json();

    const cleanRes = res.message?.content
      ? res.message.content.replace(/<think>.*?<\/think>/gs, '').trim()
      : '';

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(cleanRes);
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      console.error('Raw response:', cleanRes);
      parsedResponse = { keywords: [], similar_words: [] };
    }

    if (!parsedResponse || typeof parsedResponse !== 'object') {
      console.warn('Invalid response structure');
      return [];
    }

    const keywords = Array.isArray(parsedResponse.keywords)
      ? parsedResponse.keywords.filter(item => typeof item === 'string' && item.trim().length > 0)
      : [];

    const similarWords = Array.isArray(parsedResponse.similar_words)
      ? parsedResponse.similar_words.filter(item => typeof item === 'string' && item.trim().length > 0)
      : [];

    const allKeywords = [...keywords, ...similarWords];

    if (allKeywords.length === 0) {
      console.warn('No valid keywords extracted');
      return [];
    }

    const q = allKeywords.map((item) => `"${item.trim()}"`).join(" OR ");

    const solrResponse = await axios.get(
      `${config.ApacheSolr.url}/solr/${config.ApacheSolr.coreName || 'mycore'}/select`,
      {
        params: {
          "q": q,
          "fq": 'rag_tag_s:splitByPage',
          "indent": "true"
        }
      }
    );

    const ids = solrResponse.data.response.docs.map((doc: any) => doc.id);

    return ids;

  } catch (error) {
    console.error('Search error:', error);
    return [];
  }
}

// Group by title + page_number_i
//  const grouped = new Map<string, { doc: RAGSearchResultItem, contents: string[] }>();

// for (const doc of results) {
//    const key = `${doc.title}__${doc.page_number_i}`;
//    if (!grouped.has(key)) {
//      grouped.set(key, { doc, contents: [doc.content.trim()] });
//    } else {
//      grouped.get(key)!.contents.push(doc.content.trim());
//    }
//  }

// Sort by page_number_i (ascending), then by title
//  const sorted = Array.from(grouped.values()).sort((a, b) => {
//    if (a.doc.title === b.doc.title) {
//      return a.doc.page_number_i - b.doc.page_number_i;
//    }
//    return a.doc.title.localeCompare(b.doc.title, 'ja');
//  });

//  return sorted.map((item, index) => `
//  ### 参考資料 ${index + 1}
//    - 出典: ${item.doc.title}(ページ ${item.doc.page_number_i})
//    - 引用の形：[${item.doc.title}(ページ ${item.doc.page_number_i})](http://localhost:${process.env.PORT}/${item.doc.file_path})
//    - 内容：${item.contents.join('\n\n').trim()}
//  `).join('------\n\n');
//}

function formatRagResult(results: RAGSearchResultItem[]): string {
  return results.map((doc, index) => `
  ### 参考資料 ${index + 1}
    - 出典: ${doc.title}(ページ ${doc.chunk_number_i})
    - 引用の形：<a href="${getPublicApiBaseUrl()}/${String(doc.file_path_s || '').replace(/^\/+/, '')}" target="_blank" rel="noopener noreferrer">
    ${doc.title}(ページ ${doc.chunk_number_i})
  </a>
    - 内容：${doc.content.trim()}
  `).join('------\n\n');
}

const buildRagPrompt = async (storage_keyArray: string[], prompt: string) => {

  const response = await fetch(`${config.RAG.Backend.url}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: prompt, collection_name: storage_keyArray, top_k: config.RAG.Retrieval.topK, mode: "splitByPage" }),
  });
  const res = await response.json() as { results: RAGSearchResultItem[] };

  // Detect document versions by filename
  // Group results by original filename to identify multiple versions of same document
  const docVersionMap = new Map<string, RAGSearchResultItem[]>();
  
  for (const doc of res.results) {
    // Extract base filename (everything before .pdf)
    const baseFileName = doc.title.split('.pdf')[0] + '.pdf';
    if (!docVersionMap.has(baseFileName)) {
      docVersionMap.set(baseFileName, []);
    }
    docVersionMap.get(baseFileName)!.push(doc);
  }

  // Check if any document has multiple versions
  let versionWarning = '';
  let allResults = res.results;
  
  if (docVersionMap.size > 0) {
    for (const [baseFile, docs] of docVersionMap.entries()) {
      if (docs.length > 1) {
        // Multiple versions found - sort by storage_key which is ordered by upload time
        // Earlier storage key = older version, later = newer
        allResults = allResults.sort((a, b) => {
          const aBaseFile = a.title.split('.pdf')[0] + '.pdf';
          const bBaseFile = b.title.split('.pdf')[0] + '.pdf';
          
          if (aBaseFile === bBaseFile) {
            // Same document - older first (earlier in alphabet/timestamp)
            return a.id.localeCompare(b.id);
          }
          return 0;
        });

        // Add version indicator to results
        const versionList = allResults
          .filter(r => r.title.split('.pdf')[0] + '.pdf' === baseFile)
          .map((r, idx) => `  - ${idx === 0 ? '[古いバージョン] ' : '[新しいバージョン] '}${r.title}(ページ ${r.chunk_number_i})`)
          .join('\n');
        
        versionWarning += `\n⚠️ 注意：「${baseFile}」のポリシーは複数バージョンが存在します：\n${versionList}\n以下の回答では、古いバージョンと新しいバージョンの両方を参照しています。変更があった場合はその旨を説明してください。\n`;
      }
    }
  }

  let returnString = "";
  if (storage_keyArray.length === 0) {
    // TODO: Prompt の調整が必要
    returnString = `You are an excellent AI support. Please respond to questions accurately in Japanese.
    Use Markdown only for headings, and do not learn formatting from past logs.
    Do not use unnecessary "/" or "*".
    
    【questions】
    ${prompt}
`;
  }
  else {
    // TODO: Prompt の調整が必要
    //       LLM が ResponseFormatPrompt から自動的に適切な回答スタイルを選択するようにする
    returnString = `あなたは社内人事Q&Aボットです。
ユーザーからの「質問」に対して、「出力スタイル」と「引用ルール」に従い、
「参考資料ブロック」を根拠に、日本語で簡潔かつ正確に回答してください。

## 出力スタイル
${config.ResponseFormatPrompt.General.description}

### 回答の形
${config.ResponseFormatPrompt.General.format}

### 回答例
${config.ResponseFormatPrompt.General.example}

## 引用ルール（「引用の形」の厳守）
  - 根拠を示すときは、各参考資料に含まれる「引用の形：...」欄のテキストを**一字一句変更せず**にそのまま貼り付けて引用すること（URL、括弧、バックスラッシュ、ページ番号等を含め**改変しない**）。
  - 事実・規定・日付・数値など**根拠を要する文**の末尾に、半角スペースを挟んで「引用の形」を付すこと。
    例：有給休暇は〇年目から取得できます【<a href=\"http://...\" target=\"_blank\" rel=\"noopener noreferrer\">14-01 就業規則.pdf(ページ 16)</a>】。

----------------------------

## 参考資料ブロック

${formatRagResult(res.results)}

## 質問
${prompt}
`;
  }
  return returnString;
};

export async function searchByPage(prompt: string): Promise<string> {
  const storage_keyArray = await getSearchKeywords(prompt);
  const ragPrompt = storage_keyArray.length !== 0 ? await buildRagPrompt(storage_keyArray, prompt) : prompt;
  return ragPrompt;
}
