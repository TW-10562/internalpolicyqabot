// ✅ Load polyfills FIRST - before any other imports
import '../polyfills';

import dayjs from 'dayjs';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { handleAddGenTask } from '../service/genTaskService';
import { jobQueue } from './jobQueue';
import { IFileQuerySerType } from '@/types/file';
import { queryPage } from '@/utils/mapper';
import Tag from '@/mysql/model/file_tag.model';
import { postNewTag } from '@/service/file';
import { initializeZSet } from '@/utils/redis';
import { chatGenProcess } from './chatGenProcess';
import summaryGenProcess from './summaryGenProcess';
import translateGenProcess from './translateGenProcess';
import fileUploadProcess from './fileUploadProcess';
import { chatGenQueue, summaryGenQueue, translateGenQueue, fileUploadQueue } from './queue';

initializeZSet().catch((error) => {
  console.error('Failed to initialize Ollama endpoint set in worker:', error);
});

chatGenQueue.process(chatGenProcess);
summaryGenQueue.process(summaryGenProcess);
translateGenQueue.process(translateGenProcess);
fileUploadQueue.process(fileUploadProcess);

console.log(`[WORKER] PID ${process.pid} started. Registered chat/summary/translate/fileUpload queue consumers.`);
console.log(`[WORKER] This process also handles jobQueue jobs (countLoginJob/sayHelloJob/fileUploadJob).`);

// count login job
jobQueue.process('countLoginJob', async (job) => {
  console.log(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] Count login job started with data:`, job.data);

  // TODO: implement the actual logic
});

// say hello job
jobQueue.process('sayHelloJob', async (job) => {
  console.log(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] Hello, ${job.data.name}!`);
  // TODO: implement the actual logic
});

// file upload job
jobQueue.process('fileUploadJob', async (job) => {
  console.log(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] File upload job started with data:`, job.data);
  const data = job.data;
  const folderpath = data.folderpath;

  try {
    const basePath = path.isAbsolute(folderpath) ? folderpath : path.resolve(process.cwd(), folderpath);
    try {
      const stat = await fs.promises.stat(basePath);
      if (!stat.isDirectory()) {
        throw new Error(`Configured folderpath is not a directory: ${basePath}`);
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        await fs.promises.mkdir(basePath, { recursive: true });
        console.log(`[fileUploadJob] Created missing upload directory: ${basePath}. Skipping this run.`);
        return;
      }
      throw error;
    }

    type UploadFileInfo = {
      size: number;
      filepath: string;
      newFilename: string;
      mimetype: string;
      mtime: string;
      originalFilename: string;
    };

    async function collectFilesRecursively(
      dir: string,
      baseDir: string,
    ): Promise<UploadFileInfo[]> {
      const result: UploadFileInfo[] = [];
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const childFiles = await collectFilesRecursively(fullPath, baseDir);
          result.push(...childFiles);
          continue;
        }

        if (!entry.isFile()) continue;

        const stats = await fs.promises.stat(fullPath);
        const relativePath = path.relative(baseDir, fullPath);
        const mimeType = mime.lookup(fullPath) || 'application/octet-stream';

        result.push({
          size: stats.size,
          filepath: fullPath,
          newFilename: relativePath,
          mimetype: mimeType,
          mtime: stats.mtime.toISOString(),
          originalFilename: relativePath,
        });
      }
      return result;
    }

    type QueryWithOrder = IFileQuerySerType & {
      order?: [string, 'ASC' | 'DESC'][];
    };
    const res = await queryPage<QueryWithOrder>(Tag, {
      pageNum: 1,
      pageSize: Number.MAX_SAFE_INTEGER,
      order: [['created_at', 'ASC']],
    });

    const rows = res.rows as any[];
    const tagMap = new Map<string, string>(
      rows.map((t) => [t.get('name') as string, t.get('id') as string]),
    );

    const entries = await fs.promises.readdir(basePath, { withFileTypes: true });

    const tasks = entries.map(async (entry) => {
      try {
        console.log(`Entry: ${entry.name}, isDirectory: ${entry.isDirectory()}, isFile: ${entry.isFile()}`);

        if (entry.isDirectory()) {
          let tagId = tagMap.get(entry.name) ?? null;

          if (!tagId) {
            const createdTag = await postNewTag({ name: entry.name });
            tagId = createdTag.id;
            tagMap.set(entry.name, tagId);
          }

          const dirPath = path.join(basePath, entry.name);
          const fileList = await collectFilesRecursively(dirPath, basePath);

          if (fileList.length === 0) {
            console.log(`No files found in directory: ${entry.name}`);
            return;
          }

          await handleAddGenTask(
            {
              type: 'FILEUPLOAD',
              formData: {
                files: fileList,
                tags: [tagId],
                userName: 'system',
              },
            },
            'system',
          );
          return;
        }

        if (entry.isFile()) {
          const filePath = path.join(basePath, entry.name);
          const stats = await fs.promises.stat(filePath);

          const mimeType = mime.lookup(filePath) || 'application/octet-stream';

          const fileList: UploadFileInfo[] = [
            {
              size: stats.size,
              filepath: filePath,
              newFilename: entry.name,
              mimetype: mimeType,
              mtime: stats.mtime.toISOString(),
              originalFilename: entry.name,
            },
          ];

          await handleAddGenTask(
            {
              type: 'FILEUPLOAD',
              formData: {
                files: fileList,
                tags: [],
                userName: 'system',
              },
            },
            'system',
          );
        }
      } catch (error) {
        console.error(`Error processing entry ${entry.name}:`, error);
      }
    });

    await Promise.all(tasks);

  } catch (error) {
    console.error('Error processing file upload job:', error);
  }
});

jobQueue.on('completed', (job) => {
  console.log(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] Job ${job.name} completed`);
});

jobQueue.on('failed', (job, err) => {
  console.error(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] Job ${job.name} failed:`, err);
});
