import Parser from 'rss-parser';
import { createHash } from 'crypto';
import prisma from '../lib/prisma.js';

const RSSHUB = process.env.RSSHUB_URL ?? 'https://rsshub.app';

export interface RawIssue {
  sourceId: string;
  source: string;
  sourceType: string;
  originalTitle: string;
  originalUrl: string;
  publishedAt: Date;
  rawContent: string;
}

interface RssSource {
  url: string;
  source: string;
  sourceType: string;
}

const RSS_SOURCES: RssSource[] = [
  // 国内ニュース
  {
    url: 'https://news.yahoo.co.jp/rss/topics/domestic.xml',
    source: 'yahoo_domestic',
    sourceType: 'news_jp',
  },
  { url: 'https://www.asahi.com/rss/asahi/newsheadlines.rdf', source: 'asahi', sourceType: 'news_jp' },
  { url: 'https://www.nhk.or.jp/rss/news/cat0.xml', source: 'nhk', sourceType: 'news_jp' },
  { url: 'https://assets.wor.jp/rss/rdf/nikkei/news.rdf', source: 'nikkei', sourceType: 'news_jp' },
  // 海外ニュース
  { url: 'https://feeds.reuters.com/reuters/worldNews', source: 'reuters', sourceType: 'news_global' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', source: 'bbc', sourceType: 'news_global' },
  { url: 'https://www.theguardian.com/world/rss', source: 'guardian', sourceType: 'news_global' },
  {
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
    source: 'nyt',
    sourceType: 'news_global',
  },
  // 政府・公的機関
  { url: 'https://www.cao.go.jp/rss.xml', source: 'cao', sourceType: 'gov' },
  // Twitter via RSSHub
  { url: `${RSSHUB}/twitter/user/nhk_news`, source: 'x_nhk_news', sourceType: 'twitter' },
  { url: `${RSSHUB}/twitter/user/jijicom`, source: 'x_jijicom', sourceType: 'twitter' },
];

function buildSourceId(url: string, title: string): string {
  const raw = `${url}:${title.slice(0, 32)}`;
  return createHash('sha256').update(raw).digest('hex');
}

interface FeedItem {
  title?: string;
  link?: string;
  guid?: string;
  isoDate?: string;
  pubDate?: string;
  contentSnippet?: string;
  content?: string;
  summary?: string;
}

async function fetchFeed(rssSource: RssSource): Promise<RawIssue[]> {
  const parser = new Parser({
    timeout: 15000,
    headers: {
      'User-Agent': 'IssueRadar/1.0 (RSS Reader)',
    },
  });

  const feed = await parser.parseURL(rssSource.url);
  const items: RawIssue[] = [];

  for (const item of feed.items as FeedItem[]) {
    const title = item.title?.trim() ?? '';
    const link = item.link ?? item.guid ?? '';
    if (!title || !link) continue;

    const publishedAt = item.isoDate
      ? new Date(item.isoDate)
      : item.pubDate
        ? new Date(item.pubDate)
        : new Date();

    const rawContent = item.contentSnippet ?? item.content ?? item.summary ?? '';

    const sourceId = buildSourceId(link, title);

    items.push({
      sourceId,
      source: rssSource.source,
      sourceType: rssSource.sourceType,
      originalTitle: title,
      originalUrl: link,
      publishedAt,
      rawContent: rawContent.slice(0, 2000), // limit raw content size
    });
  }

  return items;
}

export async function collectIssues(): Promise<{ collected: number; skipped: number }> {
  console.log(`[IssueCollector] Starting collection from ${RSS_SOURCES.length} sources...`);

  const results = await Promise.allSettled(RSS_SOURCES.map((src) => fetchFeed(src)));

  let collected = 0;
  let skipped = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const src = RSS_SOURCES[i];

    if (result.status === 'rejected') {
      console.error(`[IssueCollector] Failed to fetch ${src.source}: ${String(result.reason)}`);
      continue;
    }

    const items = result.value;
    console.log(`[IssueCollector] ${src.source}: fetched ${items.length} items`);

    for (const item of items) {
      try {
        const existing = await prisma.issue.findUnique({
          where: { sourceId: item.sourceId },
          select: { id: true },
        });

        if (existing) {
          skipped++;
          continue;
        }

        await prisma.issue.create({
          data: {
            sourceId: item.sourceId,
            source: item.source,
            sourceType: item.sourceType,
            originalTitle: item.originalTitle,
            originalUrl: item.originalUrl,
            publishedAt: item.publishedAt,
            rawContent: item.rawContent,
            summaryJa: '',
            category: '',
            severityScore: 0,
            urgencyScore: 0,
            appifiabilityScore: 0,
            affectedDomain: '[]',
            proposedAppIdea: '',
            mvpFeatures: '[]',
            targetUsers: '',
            difficulty: '',
          },
        });
        collected++;
      } catch (error) {
        console.error(
          `[IssueCollector] Error upserting ${item.sourceId}: ${String(error)}`,
        );
        skipped++;
      }
    }
  }

  console.log(`[IssueCollector] Done. collected=${collected}, skipped=${skipped}`);
  return { collected, skipped };
}
