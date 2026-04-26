import type { Issue, CategorySummary, MetaInfo } from '../lib/types';

const isStatic = import.meta.env.VITE_STATIC_DATA === 'true';
const BASE_URL = import.meta.env.BASE_URL || '/';

async function fetchStatic<T>(filename: string): Promise<T> {
  const res = await fetch(`${BASE_URL}data/${filename}`);
  if (!res.ok) throw new Error(`Failed to fetch ${filename}: ${res.status}`);
  return res.json() as Promise<T>;
}

interface IssuesParams {
  category?: string;
  limit?: number;
  offset?: number;
  sourceType?: string;
}

interface IdeasParams {
  category?: string;
  difficulty?: string;
  limit?: number;
}

export async function fetchIssues(params?: IssuesParams): Promise<Issue[]> {
  if (isStatic) {
    let issues = await fetchStatic<Issue[]>('issues.json');
    if (params?.category) {
      issues = issues.filter((i) => i.category === params.category);
    }
    if (params?.sourceType) {
      issues = issues.filter((i) => i.sourceType === params.sourceType);
    }
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? issues.length;
    return issues.slice(offset, offset + limit);
  }

  const url = new URL('/api/issues', window.location.origin);
  if (params?.category) url.searchParams.set('category', params.category);
  if (params?.limit != null) url.searchParams.set('limit', String(params.limit));
  if (params?.offset != null) url.searchParams.set('offset', String(params.offset));
  if (params?.sourceType) url.searchParams.set('sourceType', params.sourceType);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Failed to fetch issues: ${res.status}`);
  return res.json() as Promise<Issue[]>;
}

export async function fetchIssue(id: number): Promise<Issue> {
  if (isStatic) {
    const issues = await fetchStatic<Issue[]>('issues.json');
    const issue = issues.find((i) => i.id === id);
    if (!issue) throw new Error(`Issue ${id} not found`);
    return issue;
  }

  const res = await fetch(`/api/issues/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch issue ${id}: ${res.status}`);
  return res.json() as Promise<Issue>;
}

export async function fetchIdeas(params?: IdeasParams): Promise<Issue[]> {
  if (isStatic) {
    let ideas = await fetchStatic<Issue[]>('ideas.json');
    if (params?.category) {
      ideas = ideas.filter((i) => i.category === params.category);
    }
    if (params?.difficulty) {
      ideas = ideas.filter((i) => i.difficulty === params.difficulty);
    }
    const limit = params?.limit ?? ideas.length;
    return ideas.slice(0, limit);
  }

  const url = new URL('/api/ideas', window.location.origin);
  if (params?.category) url.searchParams.set('category', params.category);
  if (params?.difficulty) url.searchParams.set('difficulty', params.difficulty);
  if (params?.limit != null) url.searchParams.set('limit', String(params.limit));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Failed to fetch ideas: ${res.status}`);
  return res.json() as Promise<Issue[]>;
}

export async function fetchIdeaById(id: number): Promise<Issue> {
  if (isStatic) {
    const ideas = await fetchStatic<Issue[]>('ideas.json');
    const idea = ideas.find((i) => i.id === id);
    if (!idea) throw new Error(`Idea ${id} not found`);
    return idea;
  }

  const res = await fetch(`/api/ideas/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch idea ${id}: ${res.status}`);
  return res.json() as Promise<Issue>;
}

export async function fetchCategorySummary(): Promise<CategorySummary[]> {
  if (isStatic) {
    return fetchStatic<CategorySummary[]>('category-summary.json');
  }

  const res = await fetch('/api/category-summary');
  if (!res.ok) throw new Error(`Failed to fetch category summary: ${res.status}`);
  return res.json() as Promise<CategorySummary[]>;
}

export async function fetchMeta(): Promise<MetaInfo> {
  if (isStatic) {
    return fetchStatic<MetaInfo>('meta.json');
  }

  const res = await fetch('/api/meta');
  if (!res.ok) throw new Error(`Failed to fetch meta: ${res.status}`);
  return res.json() as Promise<MetaInfo>;
}
