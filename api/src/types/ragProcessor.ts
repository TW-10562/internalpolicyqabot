export type UploadedFile = {
    newFilename: string;
    originalFilename: string;
    mimetype: string;
    size: number;
    filepath: string;
};

export type UploadResult = {
  result: {
    id: number;
    filename: string;
    storage_key: string;
    mime_type: string;
    size: number;
    created_at: Date;
  };
  status: 'fulfilled' | 'rejected';
};

export interface RAGProcessor {
  upload(file: UploadedFile, tagsIdList: number[], userName: string): Promise<UploadResult> | { result, status };
  search(prompt: string): Promise<string> | string;
}