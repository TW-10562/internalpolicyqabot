import { config } from '@/config/index';
import { RAGProcessor, UploadedFile, UploadResult } from "@/types/ragProcessor";
import File from '@/mysql/model/file.model';
import { FILE_UPLOAD_DIR } from '@/config/uploadPath';
import axios from 'axios';
import fs from 'fs';
import FormData from "form-data";
import { nanoid } from "nanoid";
import path from 'path';
import { solrService } from '@/service/solrService';
import { computeTitleImportanceWeight } from '@/rag/retrieval/importanceWeight';


interface IHybridRAGResultItemMetadata {
    DocumentStandardNumber: string;
    ChapterNumber: string;
    ResponsibleDepartment: string;
    SectionNumber: string;
    LastRevised: string;
    ChapterName: string;
    DocumentName: string;
    Established: string;
    SectionName: string;
    ArticleName: string;
    ArticleNumber: string;
    file_path_s: string;
    uploaded_by_s: string;
    rag_tag_s: string;
}

interface IHybridRAGResultItem {
    id: string;
    metadata: IHybridRAGResultItemMetadata;
    page_content: string;
    type: string;
}


export default class splitByArticleWithHybridSearch implements RAGProcessor {
    name = "splitByArticleWithHybridSearch";

    async upload(file: UploadedFile, tagsIdList: number[], userName: string): Promise<UploadResult> {
        try {
            if (!file.originalFilename) {
                throw new Error("The originalFilename property is missing or invalid.");
            }

            const fileOriginalFilename = file.originalFilename.split('/').pop();
            const fileExtname = path.extname(file.originalFilename);
            const importanceWeight = computeTitleImportanceWeight(String(fileOriginalFilename || ''));

            if (fileExtname !== ".pdf") {
                throw new Error("Only PDF files are supported for upload in splitByArticleWithHybridSearch mode.");
            }

            const uniqueFileName = nanoid() + fileExtname;
            const newPath = path.join(FILE_UPLOAD_DIR, uniqueFileName);

            await fs.promises.rename(file.filepath, newPath);

            const mysqlFileRecord = await File.create({
                filename: fileOriginalFilename,
                tag: tagsIdList.length > 0 ? tagsIdList : null,
                storage_key: uniqueFileName,
                mime_type: file.mimetype,
                size: file.size,
                create_by: userName,
            });

            if (!mysqlFileRecord) {
                throw new Error("Failed to create file record in the database.");
            }

            const mysqlUploadResult = {
                id: mysqlFileRecord.getDataValue('id'),
                filename: mysqlFileRecord.getDataValue('filename'),
                storage_key: mysqlFileRecord.getDataValue('storage_key'),
                mime_type: mysqlFileRecord.getDataValue('mime_type'),
                size: mysqlFileRecord.getDataValue('size'),
                created_at: mysqlFileRecord.getDataValue('created_at') ?? mysqlFileRecord.getDataValue('createdAt'),
            };
            const departmentCode = String(mysqlFileRecord.getDataValue('department_code') || 'HR').toUpperCase();

            // Keep Solr and DB consistent: chat retrieval pipeline queries Solr.
            const solrIndexed = await solrService.indexDocument(
                newPath,
                uniqueFileName,
                fileOriginalFilename,
                {
                    file_id: String(mysqlFileRecord.getDataValue('id')),
                    uploaded_by_s: String(userName || ''),
                    rag_tag_s: this.name,
                    department_code_s: departmentCode,
                    system_s: departmentCode.toLowerCase(),
                    importance_weight_f: String(importanceWeight),
                },
            );
            if (!solrIndexed) {
                File.destroy({ where: { id: mysqlFileRecord.getDataValue('id') } });
                throw new Error('Solr indexing failed in splitByArticleWithHybridSearch mode.');
            }

            const form = new FormData();
            form.append('collection_name', config.RAG.PreProcess.PDF.splitByArticle.collectionName ?? this.name);
            form.append('file', fs.createReadStream(newPath));
            form.append('file_original_name', fileOriginalFilename);
            form.append('extra_metadata', JSON.stringify({
                file_path_s: uniqueFileName,
                file_abs_path_s: newPath,
                file_id: mysqlFileRecord.getDataValue('id').toString(),
                uploaded_by_s: userName,
                rag_tag_s: this.name,
                department_code_s: departmentCode,
                system_s: departmentCode.toLowerCase(),
                importance_weight_f: importanceWeight,
                chunking_strategy: 'smart_sectional',
                chunk_size_tokens: Number(process.env.RAG_SMART_CHUNK_SIZE_TOKENS || 500),
                chunk_overlap_tokens: Number(process.env.RAG_SMART_CHUNK_OVERLAP_TOKENS || 80),
                chunk_boundaries: ['section_header', 'paragraph', 'bullet_list'],
                chunk_metadata_required: ['doc_id', 'chunk_id', 'section_title', 'page_number'],
            }));

            const RAGBackendResponse = await axios.post(
                `${config.RAG.Backend.url}/upload/split-by-article`,
                form,
                { headers: form.getHeaders() },
            );

            if (RAGBackendResponse.status !== 200) {
                File.destroy({ where: { id: mysqlFileRecord.getDataValue('id') } });
                throw new Error(`RAG backend upload failed with status ${RAGBackendResponse.status}`);
            }

            return { result: mysqlUploadResult, status: "fulfilled" } as UploadResult;
        } catch (error) {
            throw new Error(`Failed to upload file in splitByArticleWithHybridSearch: ${error.message}`);
        }
    }

    async search(prompt: string): Promise<string> {
        try {
            const requestTimeoutMs = Math.max(800, Number(process.env.RAG_BACKEND_TIMEOUT_MS || 6000));
            console.log(`[RAG] splitByArticleWithHybridSearch.search called with query: "${prompt}"`);
            console.log(`[RAG] RAG Backend URL: ${config.RAG.Backend.url}`);
            
            const hybridSearchRequestData = {
                collection_name: config.RAG.PreProcess.PDF.splitByArticle.collectionName ?? this.name,
                query: prompt,
                top_k: config.RAG.Retrieval.topK,
                vector_only: config.RAG.Retrieval.HybridSearch.vector_only,
                bm25_only: config.RAG.Retrieval.HybridSearch.bm25_only,
                vector_weight: config.RAG.Retrieval.HybridSearch.vector_weight,
                bm25_weight: config.RAG.Retrieval.HybridSearch.bm25_weight,
                bm25_params: config.RAG.Retrieval.HybridSearch.bm25_params || { k1: 1.8, b: 0.75 },
            }

            console.log(`[RAG] Sending request to ${config.RAG.Backend.url}/search/hybrid`);
            let RAGBackendResponse;
            try {
                RAGBackendResponse = await axios.post(
                    `${config.RAG.Backend.url}/search/hybrid`,
                    hybridSearchRequestData,
                    { timeout: requestTimeoutMs }
                );
            } catch (error: any) {
                if (axios.isAxiosError(error) && Number(error?.response?.status || 0) === 404) {
                    console.warn(
                        `[RAG] /search/hybrid returned 404 at ${config.RAG.Backend.url}. Check RAG_BACKEND_URL; current service may not be the RAG backend.`,
                    );
                    return '';
                }
                if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                    console.error(`[RAG] Connection failed to ${config.RAG.Backend.url}. Is the RAG service running?`);
                    throw new Error(`RAG service is not available at ${config.RAG.Backend.url}. Please check RAG_BACKEND_URL/RAG_SERVICE_URL and ensure the RAG service is running.`);
                }
                throw error;
            }
            
            console.log(`[RAG] Response status: ${RAGBackendResponse.status}`);
            console.log(`[RAG] Response data type: ${typeof RAGBackendResponse.data}, keys: ${RAGBackendResponse.data ? Object.keys(RAGBackendResponse.data).join(', ') : 'null'}`);

            if (RAGBackendResponse.status !== 200) {
                throw new Error(`RAG backend search failed with status ${RAGBackendResponse.status}`);
            }

            const responseData = RAGBackendResponse.data as IHybridRAGResultItem[];
            console.log(`[RAG] Received ${responseData.length} results from RAG backend`);

            if (!Array.isArray(responseData) || responseData.length === 0) {
                return '';
            }

            const hybridSearchResultString = responseData.map(item => item.page_content).join('\n\n---\n\n');
            console.log(`[RAG] Combined search result length: ${hybridSearchResultString.length} characters`);

            const RAGPrompt = `あなたは株式会社IJTT（英文名称 IJTT Co., Ltd.）の社内人事Q&Aボットです。

## あなたの役割
社員からの人事・労務関連の質問に対して、正確で分かりやすい回答を提供することです。社内規定や人事制度に基づいた信頼性の高い情報を提供してください。

## 回答の基本方針
1. **検索結果に基づく回答**
- 提供された参考情報（検索結果）を最優先に使用してください
- 情報源が不明確な場合は、推測ではなく「確認が必要」と明示してください

2. **明確で簡潔な表現**
- 専門用語を使う場合は、必要に応じて補足説明を加えてください
- 箇条書きや段落分けを活用し、読みやすい構成にしてください

# 出力スタイル
- 先に結論 → 次に根拠要約 → 注意点/例外（必要があれば）→ 参考条文（文書名/章/節/条/項のフルパス）
- 箇条書き中心、1 項目は 2～3 文で簡潔に。
- 必要に応じてミニ表（勤務区分、起算日、対象者など）を提示。

## 禁止事項
- 検索結果にない情報を推測して回答すること
- 個人情報や機密情報を開示すること
- 法律や社内規定に反するアドバイスをすること
- 不確実な情報を断定的に伝えること


以下の参考情報を基に、質問に回答してください。

【参考情報】
${hybridSearchResultString}

【質問】
${prompt}`;

            return RAGPrompt;
        } catch (error) {
            console.error("Error during hybrid search:", error);
            return `ただ今は参考資料の取得に失敗しました。時間をおいて再度お試しください。`;
        }
    }
}
