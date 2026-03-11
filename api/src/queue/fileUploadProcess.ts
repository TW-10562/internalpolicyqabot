import { execute } from '../service/task.dispatch';
import { Op } from 'sequelize';
import { put, queryList } from '../utils/mapper';
import { IGenTaskOutputSer } from '@/types/genTaskOutput';
import { IGenTaskSer } from '@/types/genTask';
import KrdGenTaskOutput from '@/mysql/model/gen_task_output.model';
import { config } from '@/config/index';
import { loadRagProcessor } from '@/service/loadRagProcessor';

export type UploadResult = {
    id: number;
    filename: string;
    storage_key: string;
    mime_type: string;
    size: number;
    created_at: Date;
};

const fileUploadProcess = async (job) => {
    const { taskId } = job.data;
    const type = 'FILEUPLOAD';
    const mode: string = (config.RAG.mode || ['splitByPage'])[0];
    const ragProcessor = await loadRagProcessor(mode);
    if (!ragProcessor) {
        throw new Error('RAG Processorの初期化に失敗しました');
    }

    const fileUpload = async (outputId: number, metadata: string) => {
        let content = '',
            isOk = true;

        const { files, tags, userName } = JSON.parse(metadata) as {
            files: { newFilename: string; originalFilename: string; mimetype: string; size: number; filepath: string }[];
            tags: number[];
            userName: string;
        };
        // アップロード処理の実行
        console.log('[FileUpload] Starting upload for', files.length, 'file(s)');
        const uploadedFiles = await Promise.allSettled(
            files.map(async (file) => {
                console.log('[FileUpload] Processing file:', file.originalFilename);
                try {
                    const { result, status } = await ragProcessor.upload(file, tags, userName);
                    console.log('[FileUpload] Upload result for', file.originalFilename, ':', status);
                    return { file, result, status };
                } catch (error: any) {
                    console.error('[FileUpload] Error uploading', file.originalFilename, ':', error.message || error);
                    throw { file, error };
                }
            }),
        );

        const successFileNames: string[] = [];
        const failedFileNames: string[] = [];

        for (const item of uploadedFiles) {
            if (item.status === 'fulfilled') {
                console.log('[FileUpload] Item fulfilled, inner status:', item.value.status);
                if (item.value.status === 'fulfilled') {
                    const fileName = item.value.file.originalFilename;
                    successFileNames.push(fileName);
                    console.log('[FileUpload] SUCCESS:', fileName);
                } else {
                    const fileName = item.value.file.originalFilename;
                    failedFileNames.push(fileName);
                    console.log('[FileUpload] FAILED (rejected status):', fileName);
                }
            } else {
                const fileName = item.reason.file?.originalFilename ?? item.reason.file?.name ?? '(不明なファイル)';
                failedFileNames.push(fileName);
                console.error('[FileUpload] FAILED (promise rejected):', fileName, item.reason.error?.message || item.reason);
            }
        }

        content = JSON.stringify({
            success: successFileNames,
            failed: failedFileNames,
        });
        isOk = failedFileNames.length === 0;

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
    }
    await execute(type, taskId, fileUpload);
};

export default fileUploadProcess;
