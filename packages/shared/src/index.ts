import { z } from 'zod';

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  app: z.literal('cc-usage-viewer'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const worktreeProjectSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  path: z.string(),
  session_count: z.number().int().nonnegative(),
});

export const projectSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  path: z.string(),
  session_count: z.number().int().nonnegative(),
  worktrees: z.array(worktreeProjectSchema),
});

export const subagentSchema = z.object({
  agent_id: z.string(),
  jsonl_path: z.string(),
  agent_type: z.string(),
  description: z.string(),
});

export const teamSessionSchema = z.object({
  session_id: z.string(),
  jsonl_path: z.string(),
  description: z.string(),
  name: z.string(),
  team_name: z.string(),
  subagents: z.array(subagentSchema),
});

export const sessionSchema = z.object({
  session_id: z.string(),
  jsonl_path: z.string(),
  timestamp: z.string().nullable(),
  first_message: z.string(),
  request_count: z.number().int().nonnegative(),
  subagents: z.array(subagentSchema),
  team_sessions: z.array(teamSessionSchema),
});

export const projectsResponseSchema = z.array(projectSchema);
export const sessionsResponseSchema = z.array(sessionSchema);

export const chatTextItemSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const chatThinkingItemSchema = z.object({
  type: z.literal('thinking'),
  text: z.string(),
});

export const chatToolUseItemSchema = z.object({
  type: z.literal('tool_use'),
  tool_name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

export const chatToolResultItemSchema = z.object({
  type: z.literal('tool_result'),
  content: z.string(),
  is_error: z.boolean(),
});

export const chatAdvisorCallItemSchema = z.object({
  type: z.literal('advisor_call'),
});

export const chatAdvisorResultItemSchema = z.object({
  type: z.literal('advisor_result'),
  text: z.string().nullable(),
});

export const chatContentItemSchema = z.discriminatedUnion('type', [
  chatTextItemSchema,
  chatThinkingItemSchema,
  chatToolUseItemSchema,
  chatToolResultItemSchema,
  chatAdvisorCallItemSchema,
  chatAdvisorResultItemSchema,
]);

export const chatMessageSchema = z.object({
  uuid: z.string().nullable(),
  role: z.union([z.literal('user'), z.literal('assistant')]),
  content: z.array(chatContentItemSchema),
  timestamp: z.string().nullable(),
  model: z.string().nullable(),
});

export const chatMessagesResponseSchema = z.array(chatMessageSchema);

export type WorktreeProject = z.infer<typeof worktreeProjectSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Subagent = z.infer<typeof subagentSchema>;
export type TeamSession = z.infer<typeof teamSessionSchema>;
export type ChatContentItem = z.infer<typeof chatContentItemSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;

// ============================================================
// Analyze
// ============================================================

export const tokenStatsSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_5m: z.number(),
  cache_creation_1h: z.number(),
  cache_read_tokens: z.number(),
  requests: z.number(),
  cost_usd: z.number().nullable(),
  cache_hit_rate: z.number(),
  latest_total_input_tokens: z.number(),
  latest_output_tokens: z.number(),
});

export const usageTimelinePointSchema = z.object({
  uuid: z.string().nullable(),
  timestamp: z.string().nullable(),
  model: z.string(),
  input_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  total_input_tokens: z.number(),
  output_tokens: z.number(),
  token_usage: z.number(),
  content_types: z.array(z.string()),
  user_summary: z.string(),
  advisor_input_tokens: z.number().default(0),
  advisor_cache_read_tokens: z.number().default(0),
  advisor_cache_write_tokens: z.number().default(0),
  advisor_output_tokens: z.number().default(0),
});

export const toolStatsSchema = z.object({
  tool_counts: z.record(z.string(), z.number()),
  bash_commands: z.record(z.string(), z.number()),
  skill_calls: z.record(z.string(), z.number()),
  agent_calls: z.record(z.string(), z.number()),
  tool_errors: z.number(),
  tool_results_total: z.number(),
});

export const analyzeResponseSchema = z.object({
  total: tokenStatsSchema,
  by_model: z.record(z.string(), tokenStatsSchema),
  usage_timeline: z.array(usageTimelinePointSchema),
  tool_stats: toolStatsSchema,
  time_range: z.tuple([z.string().nullable(), z.string().nullable()]),
});

export type TokenStats = z.infer<typeof tokenStatsSchema>;
export type UsageTimelinePoint = z.infer<typeof usageTimelinePointSchema>;
export type ToolStats = z.infer<typeof toolStatsSchema>;
export type AnalyzeResponse = z.infer<typeof analyzeResponseSchema>;

export * from './chat-presentation';
