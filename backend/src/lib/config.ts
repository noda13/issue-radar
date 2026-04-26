import 'dotenv/config';

export const config = {
  groqApiKey: process.env.GROQ_API_KEY ?? '',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  llmProvider: process.env.LLM_PROVIDER ?? 'groq',
  llmModel: process.env.LLM_MODEL ?? '',
  rsshubUrl: process.env.RSSHUB_URL ?? 'https://rsshub.app',
  port: parseInt(process.env.PORT ?? '8902', 10),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./prisma/dev.db',
} as const;
