// Task API functions for chat functionality
import request from './request';

// Types
export interface TaskListParams {
  pageNum?: number;
  pageSize?: number;
}

export interface TaskOutputParams {
  pageNum?: number;
  pageSize?: number;
  taskId: string;
}

export interface AddTaskData {
  type: 'CHAT' | 'SUMMARY' | 'TRANSLATE' | 'FILEUPLOAD';
  formData: {
    prompt?: string;
    fieldSort?: number;
    fileId?: string[];
    allFileSearch?: boolean;
    useMcp?: boolean;
    taskId?: string;
  } | Record<string, never>; // Allow empty object for creating new chats
}

export interface TaskResponse {
  code: number;
  message: string;
  result: {
    count: number;
    rows: any[];
    taskId?: string;
  };
}

export interface FeedbackData {
  taskOutputId: number;
  cache_signal?: 0 | 1;
  query?: string;
  answer?: string;
  emoji?: 'like' | 'dislike';
  outputContent?: string;
  question?: string;
}

// List all chat tasks (conversations)
export function listTask(query: TaskListParams): Promise<TaskResponse> {
  return request('/api/gen-task/list', {
    method: 'GET',
    params: query,
  });
}

// List task outputs (messages in a conversation)
export function listTaskOutput(query: TaskOutputParams): Promise<TaskResponse> {
  return request('/api/gen-task-output/list', {
    method: 'GET',
    params: query,
  });
}

// Add new task (send message)
export function addTask(data: AddTaskData): Promise<TaskResponse> {
  return request('/api/gen-task', {
    method: 'POST',
    data: data,
  });
}

// Update task output
export function updateTaskOutput(taskOutputId: string, data: any): Promise<TaskResponse> {
  return request(`/api/gen-task-output/${taskOutputId}`, {
    method: 'PUT',
    data: data,
  });
}

// Rename task
export function reNameTaskOutput(taskId: string, data: { title: string }): Promise<TaskResponse> {
  return request(`/api/gen-task-output/rename/${taskId}`, {
    method: 'PUT',
    data: data,
  });
}

// Delete task
export function deleteTaskOutput(taskId: string): Promise<TaskResponse> {
  return request(`/api/gen-task-output/del/${taskId}`, {
    method: 'DELETE',
  });
}

// Stop task output generation
export function stopTaskOutput(taskId: string, fieldSort: number): Promise<TaskResponse> {
  return request(`/api/gen-task-output/stop/${fieldSort}`, {
    method: 'PUT',
    params: {
      taskId: taskId,
      fieldSort: fieldSort
    }
  });
}

// Get chat title
export function getChatTitle(query: { chatId: string }): Promise<TaskResponse> {
  return request('/api/gen-task/getChatTitle', {
    method: 'GET',
    params: query,
  });
}

// Send feedback
export function sendFeedbackToCache(data: FeedbackData): Promise<TaskResponse> {
  return request('/api/gen-task/feedback', {
    method: 'POST',
    data: data,
  });
}
