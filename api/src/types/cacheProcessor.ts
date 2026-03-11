export interface CacheProcessor {
  search(prompt: string): Promise<string> | string;
}