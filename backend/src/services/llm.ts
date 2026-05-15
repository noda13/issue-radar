import { config } from '../lib/config.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  text: string;
  usage: TokenUsage;
}

// --- Groq Provider ---

interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GroqResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

async function callGroq(systemPrompt: string, userMessage: string): Promise<LLMResponse> {
  const model = config.llmModel || 'llama-3.3-70b-versatile';
  const messages: GroqMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.groqApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as GroqResponse;
  const text = data.choices[0]?.message?.content ?? '';
  const usage: TokenUsage = {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };

  return { text, usage };
}

// --- Gemini Provider ---

async function callGemini(systemPrompt: string, userMessage: string): Promise<LLMResponse> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const modelName = config.llmModel || 'gemini-2.0-flash';
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
  });

  const result = await model.generateContent(userMessage);
  const response = result.response;
  const text = response.text();
  const usage: TokenUsage = {
    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
  };

  return { text, usage };
}

// --- OpenAI Provider ---

interface OpenAIMessage {
  role: 'system' | 'user';
  content: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

async function callOpenAI(systemPrompt: string, userMessage: string): Promise<LLMResponse> {
  const model = config.llmModel || 'gpt-4o-mini';
  const messages: OpenAIMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as OpenAIResponse;
  const text = data.choices[0]?.message?.content ?? '';
  const usage: TokenUsage = {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };

  return { text, usage };
}

// --- Retry Logic ---

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      console.log(`  [LLM] Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Unreachable');
}

// --- Provider Detection ---

export type LLMProvider = 'groq' | 'gemini' | 'openai';

function detectProvider(): LLMProvider {
  const explicit = config.llmProvider as LLMProvider | '';
  if (explicit === 'groq' || explicit === 'gemini' || explicit === 'openai') {
    const keyMap: Record<LLMProvider, string> = {
      groq: config.groqApiKey,
      gemini: config.geminiApiKey,
      openai: config.openaiApiKey,
    };
    if (keyMap[explicit]) return explicit;
    console.warn(`[LLM] LLM_PROVIDER=${explicit} set but API key is missing, falling back to auto-detect`);
  }
  if (config.groqApiKey) return 'groq';
  if (config.geminiApiKey) return 'gemini';
  if (config.openaiApiKey) return 'openai';
  throw new Error('No LLM provider configured. Set GROQ_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY.');
}

// --- Public API ---

export async function callLLM(systemPrompt: string, userMessage: string): Promise<{ text: string; usage: TokenUsage }> {
  const provider = detectProvider();
  console.log(`  [LLM] Using provider: ${provider}`);

  const result = await withRetry(async () => {
    switch (provider) {
      case 'groq':
        return callGroq(systemPrompt, userMessage);
      case 'gemini':
        return callGemini(systemPrompt, userMessage);
      case 'openai':
        return callOpenAI(systemPrompt, userMessage);
    }
  });

  return result;
}

export function parseJsonLLM(text: string): unknown {
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  return JSON.parse(stripped);
}

export function getActiveProvider(): string {
  try {
    return detectProvider();
  } catch {
    return 'none';
  }
}

export function isConfigured(): boolean {
  return getActiveProvider() !== 'none';
}
