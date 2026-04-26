import prisma from '../lib/prisma.js';
import { callLLM, parseJsonLLM, getSessionTokenUsage, resetSessionTokenUsage } from './llm.js';
import { ISSUE_CATEGORIES, type IssueCategoryType } from '../schemas/api.js';

const BATCH_SIZE = 10;
const MAX_ISSUES = 50;

const SYSTEM_PROMPT = `あなたは社会課題アナリストです。与えられたニュース記事・投稿を社会課題として分析し、JSON形式で応答してください。

各記事について:
- summaryJa: 日本語で2-3文。課題の本質（誰が何に困っているか）を明確に
- category: 以下から1つ選択: employment_economy, healthcare_welfare, education, childcare_family, aging_care, governance, environment_disaster, community_regional
- severityScore: 課題の深刻度・影響範囲 (0-100)
  - 80-100: 多くの人に深刻な影響、早急な対応が必要
  - 50-79: 重要だが即座の危機ではない
  - 0-49: 限定的・局所的な影響
- urgencyScore: 対処の緊急性 (0-100)
- appifiabilityScore: アプリ/ソフトウェアで解決・支援できる可能性 (0-100)
  - 80-100: 情報提供・マッチング・自動化でほぼ解決可能
  - 50-79: アプリで部分的に支援可能
  - 0-49: 制度変更・物理介入が主な解決策でアプリの効果は限定的
- affectedDomain: 影響を受ける領域のキーワード配列（例: ["高齢者","介護","家族"]）

応答は必ず以下のJSON形式:
{"results":[{"index":0,"summaryJa":"...","category":"...","severityScore":70,"urgencyScore":60,"appifiabilityScore":50,"affectedDomain":["...","..."]}]}`;

interface ClassificationResult {
  index: number;
  summaryJa: string;
  category: string;
  severityScore: number;
  urgencyScore: number;
  appifiabilityScore: number;
  affectedDomain: string[];
}

interface LLMClassificationResponse {
  results: ClassificationResult[];
}

function isValidCategory(value: string): value is IssueCategoryType {
  return (ISSUE_CATEGORIES as readonly string[]).includes(value);
}

function clampScore(value: unknown): number {
  const n = typeof value === 'number' ? value : 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

async function classifyBatch(
  issues: Array<{ id: number; originalTitle: string; rawContent: string }>,
): Promise<number> {
  const userMessage = issues
    .map(
      (issue, idx) =>
        `[${idx}] タイトル: ${issue.originalTitle}\n本文: ${issue.rawContent.slice(0, 500)}`,
    )
    .join('\n\n---\n\n');

  let rawText: string;
  try {
    rawText = await callLLM(SYSTEM_PROMPT, userMessage);
  } catch (error) {
    console.error(`[Classifier] LLM call failed for batch: ${String(error)}`);
    return 0;
  }

  let parsed: LLMClassificationResponse;
  try {
    const data = parseJsonLLM(rawText) as LLMClassificationResponse;
    if (!data || !Array.isArray(data.results)) {
      throw new Error('Invalid response shape: missing results array');
    }
    parsed = data;
  } catch (error) {
    console.error(`[Classifier] JSON parse failed: ${String(error)}\nRaw: ${rawText.slice(0, 500)}`);
    return 0;
  }

  let updated = 0;

  for (const result of parsed.results) {
    const issue = issues[result.index];
    if (!issue) continue;

    const category = isValidCategory(result.category) ? result.category : 'governance';
    const affectedDomain = Array.isArray(result.affectedDomain)
      ? result.affectedDomain.filter((d): d is string => typeof d === 'string')
      : [];

    try {
      await prisma.issue.update({
        where: { id: issue.id },
        data: {
          summaryJa: result.summaryJa ?? '',
          category,
          severityScore: clampScore(result.severityScore),
          urgencyScore: clampScore(result.urgencyScore),
          appifiabilityScore: clampScore(result.appifiabilityScore),
          affectedDomain: JSON.stringify(affectedDomain),
          classifiedAt: new Date(),
        },
      });
      updated++;
    } catch (error) {
      console.error(`[Classifier] DB update failed for issue ${issue.id}: ${String(error)}`);
    }
  }

  return updated;
}

export async function classifyIssues(): Promise<{ classified: number; tokensUsed: number }> {
  console.log('[Classifier] Starting classification...');
  resetSessionTokenUsage();

  const unclassified = await prisma.issue.findMany({
    where: { classifiedAt: null },
    select: { id: true, originalTitle: true, rawContent: true },
    orderBy: { publishedAt: 'desc' },
    take: MAX_ISSUES,
  });

  if (unclassified.length === 0) {
    console.log('[Classifier] No unclassified issues found.');
    return { classified: 0, tokensUsed: 0 };
  }

  console.log(`[Classifier] Found ${unclassified.length} unclassified issues.`);
  let totalClassified = 0;

  for (let i = 0; i < unclassified.length; i += BATCH_SIZE) {
    const batch = unclassified.slice(i, i + BATCH_SIZE);
    console.log(
      `[Classifier] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(unclassified.length / BATCH_SIZE)} (${batch.length} issues)`,
    );
    const count = await classifyBatch(batch);
    totalClassified += count;
  }

  const usage = getSessionTokenUsage();
  const tokensUsed = usage.inputTokens + usage.outputTokens;
  console.log(
    `[Classifier] Done. classified=${totalClassified}, tokens=${tokensUsed}`,
  );

  return { classified: totalClassified, tokensUsed };
}
