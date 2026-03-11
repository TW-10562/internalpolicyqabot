/* global OpTypes */
export interface IFileQueryType {
  pageNum: number;
  pageSize: number;
  fileContent?: string;
  tags?: number[];
}

export interface IFileQuerySerType {
  pageNum: number;
  pageSize: number;
  sort?: number;
  params?: any;
}

export interface IFile {
  id?: string;
  filename?: string;
  storageKey?: string;
  mimeType?: string;
  size?: number;
}

export interface IFileSer {
  id?: number;
  tag?: number;
  filename?: string;
  storage_key?: string;
  mime_type?: string;
  size?: number;
}
