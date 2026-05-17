import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import Parser from 'rss-parser';

// --- Types ---

interface Issue {
  id: string;
  source: string;
  sourceType: string;
  originalTitle: string;
  originalUrl: string;
  publishedAt: string;
  rawContent: string;
  summaryJa: string;
  category: string;
  severityScore: number;
  urgencyScore: number;
  appifiabilityScore: number;
  affectedDomain: string[];
  classifiedAt: string | null;
  proposedAppIdea: string;
  mvpFeatures: string[];
  targetUsers: string;
  difficulty: string;
  ideaGeneratedAt: string | null;
  createdAt: string;
}

interface CategorySummary {
  category: string;
  count: number;
  avgSeverity: number;
  avgAppifiability: number;
}

// --- Data dir helpers ---

const DATA_DIR = join(import.meta.dirname, '..', 'frontend', 'public', 'data');
const IDEA_GEN_DELAY_MS = 3000;

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJson<T>(filename: string, defaultValue: T): T {
  const filePath = join(DATA_DIR, filename);
  if (!existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return defaultValue;
  }
}

function writeJson(filename: string, data: unknown): void {
  ensureDataDir();
  writeFileSync(join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  Wrote ${filename}`);
}

// --- RSS Sources ---

const RSSHUB = process.env.RSSHUB_URL || 'https://rsshub.app';

const RSS_SOURCES = [
  { url: 'https://news.yahoo.co.jp/rss/topics/domestic.xml', source: 'yahoo_domestic', sourceType: 'news_jp' },
  { url: 'https://www.asahi.com/rss/asahi/newsheadlines.rdf', source: 'asahi', sourceType: 'news_jp' },
  { url: 'https://www.nhk.or.jp/rss/news/cat0.xml', source: 'nhk', sourceType: 'news_jp' },
  { url: 'https://assets.wor.jp/rss/rdf/nikkei/news.rdf', source: 'nikkei', sourceType: 'news_jp' },
  { url: 'https://feeds.reuters.com/reuters/worldNews', source: 'reuters', sourceType: 'news_global' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', source: 'bbc', sourceType: 'news_global' },
  { url: 'https://www.theguardian.com/world/rss', source: 'guardian', sourceType: 'news_global' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', source: 'nyt', sourceType: 'news_global' },
  { url: 'https://www.cao.go.jp/rss.xml', source: 'cao', sourceType: 'gov' },
  { url: `${RSSHUB}/twitter/user/nhk_news`, source: 'x_nhk_news', sourceType: 'twitter' },
  { url: `${RSSHUB}/twitter/user/jijicom`, source: 'x_jijicom', sourceType: 'twitter' },
];

// --- LLM Provider ---
// Supports any OpenAI-compatible API (Groq, OpenAI, Together, OpenRouter, etc.) + Gemini
//
// Config via env vars:
//   LLM_PROVIDER=groq|gemini|openai (auto-detect if not set)
//   LLM_BASE_URL=https://api.groq.com/openai/v1 (override API endpoint)
//   LLM_MODEL=llama-3.3-70b-versatile (override model)
//   LLM_API_KEY=... (override API key)
//
// Provider-specific keys (auto-detect):
//   GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY

interface LLMConfig {
  provider: string;
  baseUrl: string;
  model: string;
  key: string;
}

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  groq:     { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openai:   { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  together: { baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct' },
};

function detectProvider(): LLMConfig | null {
  // Explicit full config
  if (process.env.LLM_API_KEY && process.env.LLM_BASE_URL) {
    return {
      provider: process.env.LLM_PROVIDER || 'custom',
      baseUrl: process.env.LLM_BASE_URL,
      model: process.env.LLM_MODEL || 'default',
      key: process.env.LLM_API_KEY,
    };
  }

  // Auto-detect from provider-specific keys
  const explicit = process.env.LLM_PROVIDER;
  const pairs: Array<[string, string | undefined]> = [
    ['groq', process.env.GROQ_API_KEY],
    ['gemini', process.env.GEMINI_API_KEY],
    ['openai', process.env.OPENAI_API_KEY],
  ];

  // Prioritize explicit provider
  if (explicit) {
    const match = pairs.find(([p]) => p === explicit);
    if (match?.[1]) {
      const defaults = PROVIDER_DEFAULTS[explicit] || { baseUrl: '', model: '' };
      return {
        provider: explicit,
        baseUrl: process.env.LLM_BASE_URL || defaults.baseUrl,
        model: process.env.LLM_MODEL || defaults.model,
        key: match[1],
      };
    }
  }

  // Auto-detect: first available key wins
  for (const [provider, key] of pairs) {
    if (key) {
      const defaults = PROVIDER_DEFAULTS[provider] || { baseUrl: '', model: '' };
      return { provider, baseUrl: defaults.baseUrl, model: defaults.model, key };
    }
  }

  return null;
}

async function callLLM(system: string, user: string): Promise<string> {
  const config = detectProvider();
  if (!config) throw new Error('No LLM configured. Set GROQ_API_KEY, GEMINI_API_KEY, or LLM_API_KEY+LLM_BASE_URL.');

  if (config.provider === 'gemini') {
    return callGemini(system, user, config.key);
  }
  return callOpenAICompatible(system, user, config);
}

async function callOpenAICompatible(system: string, user: string, config: LLMConfig): Promise<string> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.key}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.3,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`${config.provider} ${res.status}: ${await res.text()}`);
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}

async function callGemini(system: string, user: string, key: string): Promise<string> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({
    model: process.env.LLM_MODEL || 'gemini-2.0-flash',
    systemInstruction: system,
  });
  const r = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: user }] }] });
  return r.response.text();
}

function clampScore(value: unknown): number {
  if (typeof value !== 'number') {
    console.warn(`[clampScore] unexpected value: ${JSON.stringify(value)}, defaulting to 0`);
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseJson(text: string): unknown {
  try {
    let s = text.trim();
    if (s.startsWith('```')) s = s.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(s);
  } catch (e) {
    console.error('JSON parse failed:', e instanceof Error ? e.message : e);
    console.error('Raw text (first 200 chars):', text.slice(0, 200));
    throw new Error('LLM returned invalid JSON');
  }
}

// --- Collection ---

async function collectIssues(existing: Issue[]): Promise<Issue[]> {
  const parser = new Parser({
    timeout: 10000,
    headers: { 'User-Agent': 'IssueRadar/1.0' },
  });

  const existingIds = new Set(existing.map(i => i.id));
  const newItems: Issue[] = [];

  const results = await Promise.allSettled(
    RSS_SOURCES.map(async ({ url, source, sourceType }) => {
      const feed = await parser.parseURL(url);
      return { feed, source, sourceType };
    })
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn(`  Feed error: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
      continue;
    }

    const { feed, source, sourceType } = result.value;

    for (const item of feed.items ?? []) {
      const title = item.title ?? '';
      const link = item.link ?? '';
      if (!title || !link) continue;

      const sourceId = createHash('sha256')
        .update(link + ':' + title)
        .digest('hex')
        .slice(0, 32);

      if (existingIds.has(sourceId)) continue;

      const publishedAt = item.pubDate
        ? new Date(item.pubDate).toISOString()
        : new Date().toISOString();

      newItems.push({
        id: sourceId,
        source,
        sourceType,
        originalTitle: title,
        originalUrl: link,
        publishedAt,
        rawContent: item.contentSnippet ?? item.content ?? '',
        summaryJa: '',
        category: '',
        severityScore: 0,
        urgencyScore: 0,
        appifiabilityScore: 0,
        affectedDomain: [],
        classifiedAt: null,
        proposedAppIdea: '',
        mvpFeatures: [],
        targetUsers: '',
        difficulty: '',
        ideaGeneratedAt: null,
        createdAt: new Date().toISOString(),
      });

      existingIds.add(sourceId);
    }
  }

  console.log(`  New items: ${newItems.length}`);

  return [...newItems, ...existing]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, 300);
}

// --- Classification ---

const CLASSIFY_SYSTEM = `あなたは社会課題アナリストです。与えられたニュース記事・投稿を社会課題として分析し、JSON形式で応答してください。

各記事について:
- summaryJa: 日本語で2-3文。課題の本質（誰が何に困っているか）を明確に
- category: 以下から1つ選択: employment_economy, healthcare_welfare, education, childcare_family, aging_care, governance, environment_disaster, community_regional
- severityScore: 課題の深刻度・影響範囲 (0-100)
- urgencyScore: 対処の緊急性 (0-100)
- appifiabilityScore: アプリ/ソフトウェアで解決・支援できる可能性 (0-100)
  80-100: 情報提供・マッチング・自動化でほぼ解決可能
  50-79: アプリで部分的に支援可能
  0-49: 制度変更・物理介入が主でアプリ効果は限定的
- affectedDomain: 影響領域キーワード配列（例: ["高齢者","介護","家族"]）

応答形式: {"results":[{"index":0,"summaryJa":"...","category":"...","severityScore":70,"urgencyScore":60,"appifiabilityScore":50,"affectedDomain":["..."]}]}`;

async function classifyIssues(issues: Issue[]): Promise<void> {
  const targets = issues.filter(i => !i.classifiedAt);
  const batch = targets.slice(0, 50);

  if (batch.length === 0) {
    console.log('  Nothing to classify');
    return;
  }

  const BATCH_SIZE = 10;
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    const chunk = batch.slice(i, i + BATCH_SIZE);
    const userMessage = JSON.stringify(
      chunk.map((item, idx) => ({
        index: i + idx,
        title: item.originalTitle,
        content: item.rawContent.slice(0, 500),
      }))
    );

    try {
      const raw = await callLLM(CLASSIFY_SYSTEM, userMessage);
      const parsed = parseJson(raw) as { results: Array<{
        index: number;
        summaryJa: string;
        category: string;
        severityScore: number;
        urgencyScore: number;
        appifiabilityScore: number;
        affectedDomain: string[];
      }> };

      for (const r of parsed.results) {
        const chunkIssue = chunk[r.index - i];
        if (chunkIssue) {
          chunkIssue.summaryJa = r.summaryJa;
          chunkIssue.category = r.category;
          chunkIssue.severityScore = clampScore(r.severityScore);
          chunkIssue.urgencyScore = clampScore(r.urgencyScore);
          chunkIssue.appifiabilityScore = clampScore(r.appifiabilityScore);
          chunkIssue.affectedDomain = r.affectedDomain;
          chunkIssue.classifiedAt = new Date().toISOString();
        }
      }

      console.log(`  Classified batch ${Math.floor(i / BATCH_SIZE) + 1}: ${chunk.length} items`);
    } catch (err) {
      console.error(`  Classification batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err instanceof Error ? err.message : err);
    }

    if (i + BATCH_SIZE < batch.length) {
      console.log('  Waiting 30s (rate limit)...');
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }
}

// --- Idea Generation ---

const IDEA_SYSTEM = `あなたは社会課題を解決するアプリを考えるプロダクトデザイナーです。与えられた社会課題に対して、アプリ/ソフトウェアで解決するアイデアをJSON形式で提案してください。

応答形式:
{"proposedAppIdea":"概要1-2文","mvpFeatures":["機能1","機能2","機能3"],"targetUsers":"ターゲット像","difficulty":"low|medium|high"}

difficulty: low=6ヶ月以内MVP可能, medium=1年程度, high=2年以上`;

async function generateIdeas(issues: Issue[]): Promise<void> {
  const targets = issues
    .filter(i => i.appifiabilityScore >= 60 && !i.ideaGeneratedAt)
    .slice(0, 20);

  if (targets.length === 0) {
    console.log('  Nothing to generate ideas for');
    return;
  }

  for (let i = 0; i < targets.length; i++) {
    const issue = targets[i];
    const userMessage = JSON.stringify({
      title: issue.originalTitle,
      summary: issue.summaryJa,
      category: issue.category,
      appifiabilityScore: issue.appifiabilityScore,
      affectedDomain: issue.affectedDomain,
    });

    try {
      const raw = await callLLM(IDEA_SYSTEM, userMessage);
      const parsed = parseJson(raw) as {
        proposedAppIdea: string;
        mvpFeatures: string[];
        targetUsers: string;
        difficulty: string;
      };

      issue.proposedAppIdea = parsed.proposedAppIdea;
      issue.mvpFeatures = parsed.mvpFeatures;
      issue.targetUsers = parsed.targetUsers;
      issue.difficulty = parsed.difficulty;
      issue.ideaGeneratedAt = new Date().toISOString();

      console.log(`  Idea generated (${i + 1}/${targets.length}): ${issue.originalTitle.slice(0, 50)}`);
    } catch (err) {
      console.error(`  Idea generation failed for "${issue.originalTitle.slice(0, 40)}":`, err instanceof Error ? err.message : err);
    }

    if (i < targets.length - 1) {
      await new Promise(resolve => setTimeout(resolve, IDEA_GEN_DELAY_MS));
    }
  }
}

// --- Category Summary ---

function buildCategorySummary(issues: Issue[]): CategorySummary[] {
  const groups = new Map<string, Issue[]>();

  for (const issue of issues) {
    if (!issue.category) continue;
    const group = groups.get(issue.category) ?? [];
    group.push(issue);
    groups.set(issue.category, group);
  }

  const summaries: CategorySummary[] = [];

  for (const [category, items] of groups) {
    const count = items.length;
    const avgSeverity = Math.round(items.reduce((sum, i) => sum + i.severityScore, 0) / count);
    const avgAppifiability = Math.round(items.reduce((sum, i) => sum + i.appifiabilityScore, 0) / count);
    summaries.push({ category, count, avgSeverity, avgAppifiability });
  }

  return summaries.sort((a, b) => b.count - a.count);
}

// --- Main ---

async function main() {
  console.log('=== Issue Radar Static Collection ===\n');

  const prev = readJson<Issue[]>('issues.json', []);

  console.log('--- Collecting RSS ---');
  const issues = await collectIssues(prev);
  console.log(`Total: ${issues.length} issues\n`);

  const llm = detectProvider();
  if (llm) {
    console.log(`--- LLM (${llm.provider}): Classify ---`);
    await classifyIssues(issues);
    console.log(`\n--- LLM (${llm.provider}): Generate Ideas ---`);
    await generateIdeas(issues);
  } else {
    console.log('No LLM API key (GROQ_API_KEY or GEMINI_API_KEY), skipping\n');
  }

  const ideas = issues.filter(i => i.appifiabilityScore >= 60 && i.proposedAppIdea);
  const categorySummary = buildCategorySummary(issues);

  writeJson('issues.json', issues);
  writeJson('ideas.json', ideas);
  writeJson('category-summary.json', categorySummary);
  writeJson('meta.json', { lastUpdated: new Date().toISOString() });

  console.log('\n=== Saved to frontend/public/data/ ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
