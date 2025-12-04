import { describe, it, expect, vi } from 'vitest';

import {
  analyzeStory,
  batchAnalyzeStories,
  generateEmbedding,
  batchGenerateEmbeddings,
} from '../ai-analysis';
import type { AIBinding, VectorizeBinding, HNItem } from '../types';

function createEmbedding(): number[] {
  return Array.from({ length: 768 }, (_, i) => i / 768);
}

describe('ai-analysis', () => {
  it('skips non-story items in analyzeStory', async () => {
    const ai: AIBinding = { run: vi.fn() };
    const result = await analyzeStory(ai, {
      id: 1,
      type: 'comment',
      time: Date.now() / 1000,
    });
    expect(result).toBeNull();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns structured analysis for valid AI responses', async () => {
    const ai: AIBinding = {
      run: vi.fn(async (model: string, inputs: unknown) => {
        if (model === '@cf/meta/llama-3.2-1b-instruct') {
          const prompt = (inputs as { prompt: string }).prompt;
          if (prompt.includes('Categories:')) {
            return { response: 'programming' };
          }
          return { response: 'news' };
        }
        if (model === '@cf/huggingface/distilbert-sst-2-int8') {
          return [{ label: 'POSITIVE', score: 0.9 }];
        }
        throw new Error(`Unknown model ${model}`);
      }),
    };

    const result = await analyzeStory(ai, {
      id: 1,
      type: 'story',
      title: 'Test Title',
      time: Date.now() / 1000,
    });

    expect(result).not.toBeNull();
    expect(result?.topic).toBe('programming');
    expect(result?.contentType).toBe('news');
    expect(result?.sentiment).toBeGreaterThan(0.5);
  });

  it('batchAnalyzeStories respects maxItems and filters nulls', async () => {
    const ai: AIBinding = {
      run: vi.fn(async () => ({ response: 'programming' })),
    };
    const items: HNItem[] = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      type: 'story',
      title: `Story ${i}`,
      time: Date.now() / 1000,
    }));

    const results = await batchAnalyzeStories(ai, items, 50);
    expect(results.size).toBeLessThanOrEqual(50);
    expect(ai.run).toHaveBeenCalled();
  });

  it('generateEmbedding returns vector when AI returns data', async () => {
    const ai: AIBinding = {
      run: vi.fn(async () => ({ data: [createEmbedding()] })),
    };
    const vector = await generateEmbedding(ai, 'Example');
    expect(vector).toHaveLength(768);
  });

  it('batchGenerateEmbeddings upserts generated vectors', async () => {
    const ai: AIBinding = {
      run: vi.fn(async () => ({ data: [createEmbedding()] })),
    };

    const upsert = vi.fn().mockResolvedValue({ mutationId: '1', count: 1 });
    const vectorize: VectorizeBinding = {
      insert: vi.fn(),
      upsert,
      query: vi.fn(),
      getByIds: vi.fn(),
      deleteByIds: vi.fn(),
      describe: vi.fn(),
    };

    const stories = [
      { id: 1, title: 'Story 1', ai_topic: 'programming', score: 10 },
      { id: 2, title: 'Story 2', ai_topic: 'ai', score: 20 },
    ];

    const result = await batchGenerateEmbeddings(ai, vectorize, stories, 10);
    expect(result.success).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
