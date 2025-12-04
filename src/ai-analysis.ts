/**
 * AI Analysis Module
 * Uses Cloudflare Workers AI to analyze HN stories for:
 * - Topic classification (tech, business, politics, science, etc.)
 * - Content type detection (Show HN, Ask HN, news, tutorial, etc.)
 * - Sentiment analysis
 * - Text embeddings for similarity search (via Vectorize)
 */

import type { HNItem, VectorizeBinding, VectorizeVector } from './types';

// AI binding type (added to WorkerEnv)
export interface AIBinding {
  run(model: string, inputs: unknown): Promise<unknown>;
}

export interface AIAnalysisResult {
  topic: string | null;
  contentType: string | null;
  sentiment: number | null;
  analyzedAt: number;
}

export interface EmbeddingResult {
  id: number;
  embedding: number[];
  metadata: {
    topic: string;
    score: number;
    title: string;
  };
}

// Topic categories for classification
const TOPICS = [
  'artificial-intelligence',
  'programming',
  'web-development', 
  'startups',
  'science',
  'security',
  'crypto-blockchain',
  'hardware',
  'career',
  'politics',
  'business',
  'gaming',
  'other'
] as const;

/**
 * Analyze a story using Workers AI
 * Only analyzes stories (not comments, jobs, etc.)
 */
export async function analyzeStory(
  ai: AIBinding,
  item: HNItem
): Promise<AIAnalysisResult | null> {
  // Only analyze stories with titles
  if (item.type !== 'story' || !item.title) {
    return null;
  }

  const analyzedAt = Date.now();
  
  try {
    // Run all analyses in parallel for efficiency
    // Note: Embedding generation disabled to save neurons (enable when vector search is needed)
    const [topicResult, contentTypeResult, sentimentResult] = await Promise.allSettled([
      classifyTopic(ai, item.title, item.url),
      classifyContentType(ai, item.title),
      analyzeSentiment(ai, item.title),
    ]);

    return {
      topic: topicResult.status === 'fulfilled' ? topicResult.value : null,
      contentType: contentTypeResult.status === 'fulfilled' ? contentTypeResult.value : null,
      sentiment: sentimentResult.status === 'fulfilled' ? sentimentResult.value : null,
      analyzedAt,
    };
  } catch (error) {
    console.error('[AI] Analysis failed for item', item.id, error);
    return {
      topic: null,
      contentType: null,
      sentiment: null,
      analyzedAt,
    };
  }
}

/**
 * Classify the topic of a story using Llama 3.2-1B (cheapest LLM)
 * ~27 neurons per 1k input tokens, ~200 neurons per 1k output tokens
 */
async function classifyTopic(
  ai: AIBinding,
  title: string,
  url?: string
): Promise<string> {
  const domain = url ? extractDomain(url) : '';
  
  const prompt = `Classify this HackerNews post into exactly ONE topic category.

Title: "${title}"
${domain ? `Domain: ${domain}` : ''}

Categories: ${TOPICS.join(', ')}

Reply with ONLY the category name, nothing else.`;

  const response = await ai.run('@cf/meta/llama-3.2-1b-instruct', {
    prompt,
    max_tokens: 20,
    temperature: 0.1, // Low temperature for consistent classification
  }) as { response: string };

  const result = response.response?.toLowerCase().trim() || 'other';
  
  // Validate the response is a known topic
  const matchedTopic = TOPICS.find(t => result.includes(t.replace('-', ' ')) || result.includes(t));
  return matchedTopic || 'other';
}

/**
 * Classify the content type of a story
 */
async function classifyContentType(
  ai: AIBinding,
  title: string
): Promise<string> {
  // Quick pattern matching for obvious cases (saves AI calls)
  const titleLower = title.toLowerCase();
  if (titleLower.startsWith('show hn:') || titleLower.startsWith('show hn –')) {
    return 'show-hn';
  }
  if (titleLower.startsWith('ask hn:') || titleLower.startsWith('ask hn –')) {
    return 'ask-hn';
  }
  if (titleLower.startsWith('tell hn:') || titleLower.startsWith('tell hn –')) {
    return 'tell-hn';
  }
  if (titleLower.includes('is hiring') || titleLower.includes('job:') || titleLower.includes('(yc ')) {
    return 'job';
  }

  const prompt = `Classify this HackerNews post into exactly ONE content type.

Title: "${title}"

Types: news, tutorial, opinion, research, launch, discussion, other

Reply with ONLY the type name, nothing else.`;

  const response = await ai.run('@cf/meta/llama-3.2-1b-instruct', {
    prompt,
    max_tokens: 15,
    temperature: 0.1,
  }) as { response: string };

  const result = response.response?.toLowerCase().trim() || 'other';
  
  // Validate the response
  const contentTypes = ['news', 'tutorial', 'opinion', 'research', 'launch', 'discussion', 'other'];
  const matched = contentTypes.find(t => result.includes(t));
  return matched || 'other';
}

/**
 * Analyze sentiment of the title using DistilBERT (very cheap - ~2 neurons per item)
 * Returns a score from 0 (negative) to 1 (positive)
 */
async function analyzeSentiment(
  ai: AIBinding,
  title: string
): Promise<number> {
  const response = await ai.run('@cf/huggingface/distilbert-sst-2-int8', {
    text: title,
  });

  // DistilBERT returns [{ label: "POSITIVE" | "NEGATIVE", score: number }]
  // Validate response structure before using
  if (!Array.isArray(response) || response.length === 0) {
    return 0.5; // Neutral default
  }

  // Validate each result has expected structure
  const validResults = response.filter(
    (r): r is { label: string; score: number } =>
      r != null &&
      typeof r === 'object' &&
      typeof r.label === 'string' &&
      typeof r.score === 'number' &&
      r.score >= 0 &&
      r.score <= 1
  );

  if (validResults.length === 0) {
    return 0.5; // Neutral default if no valid results
  }

  const positive = validResults.find(r => r.label === 'POSITIVE');
  const negative = validResults.find(r => r.label === 'NEGATIVE');

  if (positive && negative) {
    // Return positive score as 0-1 value
    return positive.score;
  }
  
  // If only one sentiment found, use it
  if (positive) return positive.score;
  if (negative) return 1 - negative.score; // Invert negative to get positive scale
  
  return 0.5;
}

/**
 * Extract domain from URL for context
 */
function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace('www.', '');
  } catch {
    return '';
  }
}

/**
 * Batch analyze multiple stories (for efficiency)
 * Limits to avoid exceeding neuron quota
 */
export async function batchAnalyzeStories(
  ai: AIBinding,
  items: HNItem[],
  maxItems: number = 50 // Limit to avoid quota issues
): Promise<Map<number, AIAnalysisResult>> {
  const results = new Map<number, AIAnalysisResult>();
  
  // Filter to only stories with titles
  const stories = items
    .filter(item => item.type === 'story' && item.title)
    .slice(0, maxItems);

  if (stories.length === 0) {
    return results;
  }

  console.log(`[AI] Analyzing ${stories.length} stories`);

  // Process in smaller batches to avoid rate limits
  const batchSize = 10;
  for (let i = 0; i < stories.length; i += batchSize) {
    const batch = stories.slice(i, i + batchSize);
    
    const batchResults = await Promise.allSettled(
      batch.map(story => analyzeStory(ai, story))
    );

    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        results.set(batch[index].id, result.value);
      }
    });
  }

  console.log(`[AI] Successfully analyzed ${results.size}/${stories.length} stories`);
  return results;
}

/**
 * Generate embedding for a story title using BGE-base model
 * Returns 768-dimensional vector for Vectorize storage
 * Cost: ~2-3 neurons per embedding
 */
export async function generateEmbedding(
  ai: AIBinding,
  title: string
): Promise<number[] | null> {
  try {
    const response = await ai.run('@cf/baai/bge-base-en-v1.5', {
      text: title,
    }) as { data: number[][] };

    // BGE returns { data: [[...768 floats]] }
    if (response?.data?.[0]?.length === 768) {
      return response.data[0];
    }
    
    console.warn('[AI] Unexpected embedding response format');
    return null;
  } catch (error) {
    console.error('[AI] Embedding generation failed:', error);
    return null;
  }
}

/**
 * Batch generate embeddings for multiple stories
 * Stores them in Vectorize with metadata for filtered search
 */
export async function batchGenerateEmbeddings(
  ai: AIBinding,
  vectorize: VectorizeBinding,
  stories: Array<{
    id: number;
    title: string;
    ai_topic: string | null;
    score: number | null;
  }>,
  maxItems: number = 50
): Promise<{ success: number; failed: number }> {
  const toProcess = stories.slice(0, maxItems);
  
  if (toProcess.length === 0) {
    return { success: 0, failed: 0 };
  }

  console.log(`[AI] Generating embeddings for ${toProcess.length} stories`);

  const vectors: VectorizeVector[] = [];
  let failed = 0;

  // Process in small batches to avoid overwhelming the AI
  const batchSize = 10;
  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    
    const results = await Promise.allSettled(
      batch.map(async (story) => {
        const embedding = await generateEmbedding(ai, story.title);
        if (embedding) {
          return {
            id: String(story.id),
            values: embedding,
            metadata: {
              topic: story.ai_topic || 'other',
              score: story.score || 0,
              // Truncate title for metadata (10KB limit per vector)
              title: story.title.slice(0, 200),
            },
          } as VectorizeVector;
        }
        return null;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        vectors.push(result.value);
      } else {
        failed++;
      }
    }
  }

  // Upsert all vectors to Vectorize
  if (vectors.length > 0) {
    try {
      await vectorize.upsert(vectors);
      console.log(`[AI] Upserted ${vectors.length} vectors to Vectorize`);
    } catch (error) {
      console.error('[AI] Vectorize upsert failed:', error);
      return { success: 0, failed: toProcess.length };
    }
  }

  return { success: vectors.length, failed };
}
