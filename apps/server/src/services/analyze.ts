import type {
  AnalyzeResponse,
  TokenStats,
  ToolStats,
  UsageTimelinePoint,
} from '@ccuv/shared';

import { readJsonl } from '../lib/jsonl';
import { shouldSkipPrefixedText } from '../lib/skip-prefixes';

// ============================================================
// 料金表 (USD per 1M tokens)
// ============================================================
const PRICING: Record<
  string,
  {
    input: number;
    output: number;
    cache_write_5m: number;
    cache_write_1h: number;
    cache_read: number;
  }
> = {
  'claude-opus-4': {
    input: 15.0,
    output: 75.0,
    cache_write_5m: 18.75,
    cache_write_1h: 22.5,
    cache_read: 1.5,
  },
  'claude-sonnet-4': {
    input: 3.0,
    output: 15.0,
    cache_write_5m: 3.75,
    cache_write_1h: 4.5,
    cache_read: 0.3,
  },
  'claude-haiku-4': {
    input: 0.8,
    output: 4.0,
    cache_write_5m: 1.0,
    cache_write_1h: 1.2,
    cache_read: 0.08,
  },
};

function getPricing(model: string) {
  for (const [prefix, pricing] of Object.entries(PRICING)) {
    if (model.includes(prefix)) {
      return pricing;
    }
  }
  return null;
}

// ============================================================
// 型
// ============================================================
type MutableTokenStats = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_5m: number;
  cache_creation_1h: number;
  cache_read_tokens: number;
  requests: number;
  cost_usd: number | null;
  cache_hit_rate: number;
  latest_total_input_tokens: number;
  latest_output_tokens: number;
};

function zeroStats(): MutableTokenStats {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_5m: 0,
    cache_creation_1h: 0,
    cache_read_tokens: 0,
    requests: 0,
    cost_usd: 0,
    cache_hit_rate: 0,
    latest_total_input_tokens: 0,
    latest_output_tokens: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ============================================================
// JSONL 解析（分析用）— requestId で重複排除
// ============================================================
async function loadJsonlForAnalysis(
  path: string,
): Promise<Record<string, unknown>[]> {
  return collectRecordsForAnalysis(await readJsonl(path));
}

function collectRecordsForAnalysis(
  records: unknown[],
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  const noId: Record<string, unknown>[] = [];

  for (const raw of records) {
    const obj = asRecord(raw);
    if (!obj) {
      continue;
    }
    const msg = asRecord(obj.message);
    if (!msg?.usage) {
      continue;
    }
    const rid = asString(obj.requestId);
    if (rid) {
      byId.set(rid, obj);
    } else {
      noId.push(obj);
    }
  }

  return [...byId.values(), ...noId];
}

// ============================================================
// 集計
// ============================================================
function calcCost(stats: MutableTokenStats, model: string): number | null {
  const p = getPricing(model);
  if (!p) {
    return null;
  }
  return (
    (stats.input_tokens * p.input +
      stats.output_tokens * p.output +
      stats.cache_creation_5m * p.cache_write_5m +
      stats.cache_creation_1h * p.cache_write_1h +
      stats.cache_read_tokens * p.cache_read) /
    1_000_000
  );
}

function cacheHitRate(stats: MutableTokenStats): number {
  const total =
    stats.input_tokens +
    stats.cache_read_tokens +
    stats.cache_creation_5m +
    stats.cache_creation_1h;
  return total ? (stats.cache_read_tokens / total) * 100 : 0;
}

type AggResult = {
  by_model: Record<string, MutableTokenStats>;
  total: MutableTokenStats;
  time_range: [string | null, string | null];
};

function aggregate(records: Record<string, unknown>[]): AggResult {
  const byModel = new Map<string, MutableTokenStats>();
  const total = zeroStats();
  const timestamps: string[] = [];
  const latestByModelTs = new Map<string, string>();
  let latestTotalTs: string | null = null;

  for (const obj of records) {
    const msg = asRecord(obj.message);
    if (!msg) {
      continue;
    }

    const model = asString(msg.model) || 'unknown';
    // <synthetic> はサブエージェント spawn 時のダミー — スキップ
    if (model.startsWith('<') && model.endsWith('>')) {
      continue;
    }

    const usage = asRecord(msg.usage) ?? {};
    const cc = asRecord(usage.cache_creation) ?? {};

    const ts = asString(obj.timestamp) || null;
    if (ts) {
      timestamps.push(ts);
    }

    const inputTokens = asNumber(usage.input_tokens);
    const outputTokens = asNumber(usage.output_tokens);
    const cache5m = asNumber(cc.ephemeral_5m_input_tokens);
    const cache1h = asNumber(cc.ephemeral_1h_input_tokens);
    const cacheRead = asNumber(usage.cache_read_input_tokens);
    const latestTotalInput = inputTokens + cache5m + cache1h + cacheRead;

    let m = byModel.get(model);
    if (!m) {
      m = zeroStats();
      byModel.set(model, m);
    }
    m.input_tokens += inputTokens;
    m.output_tokens += outputTokens;
    m.cache_creation_5m += cache5m;
    m.cache_creation_1h += cache1h;
    m.cache_read_tokens += cacheRead;
    m.requests += 1;
    total.input_tokens += inputTokens;
    total.output_tokens += outputTokens;
    total.cache_creation_5m += cache5m;
    total.cache_creation_1h += cache1h;
    total.cache_read_tokens += cacheRead;
    total.requests += 1;

    // advisorイテレーション（by_modelに別エントリーとして集計）
    const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
    for (const it of iterations) {
      const itObj = asRecord(it);
      if (!itObj || asString(itObj.type) !== 'advisor_message') continue;
      const advisorModel = asString(itObj.model) || 'unknown';
      const advisorKey = `advisor:${advisorModel}`;
      const itCc = asRecord(itObj.cache_creation) ?? {};
      const itInput = asNumber(itObj.input_tokens);
      const itOutput = asNumber(itObj.output_tokens);
      const itCacheRead = asNumber(itObj.cache_read_input_tokens);
      const itCache5m = asNumber(itCc.ephemeral_5m_input_tokens);
      const itCache1h = asNumber(itCc.ephemeral_1h_input_tokens);
      const itTotalInput = itInput + itCacheRead + itCache5m + itCache1h;

      let am = byModel.get(advisorKey);
      if (!am) {
        am = zeroStats();
        byModel.set(advisorKey, am);
      }
      am.input_tokens += itInput;
      am.output_tokens += itOutput;
      am.cache_read_tokens += itCacheRead;
      am.cache_creation_5m += itCache5m;
      am.cache_creation_1h += itCache1h;
      am.requests += 1;
      am.latest_total_input_tokens = itTotalInput;
      am.latest_output_tokens = itOutput;

      total.input_tokens += itInput;
      total.output_tokens += itOutput;
      total.cache_read_tokens += itCacheRead;
      total.cache_creation_5m += itCache5m;
      total.cache_creation_1h += itCache1h;
    }

    if (ts) {
      const prevModelTs = latestByModelTs.get(model);
      if (!prevModelTs || ts >= prevModelTs) {
        latestByModelTs.set(model, ts);
        m.latest_total_input_tokens = latestTotalInput;
        m.latest_output_tokens = outputTokens;
      }
      if (!latestTotalTs || ts >= latestTotalTs) {
        latestTotalTs = ts;
        total.latest_total_input_tokens = latestTotalInput;
        total.latest_output_tokens = outputTokens;
      }
    } else {
      if (m.latest_total_input_tokens === 0) {
        m.latest_total_input_tokens = latestTotalInput;
        m.latest_output_tokens = outputTokens;
      }
      if (total.latest_total_input_tokens === 0) {
        total.latest_total_input_tokens = latestTotalInput;
        total.latest_output_tokens = outputTokens;
      }
    }
  }

  // コスト・キャッシュヒット率
  let totalCost = 0;
  let hasUnknown = false;
  const byModelObj: Record<string, MutableTokenStats> = {};

  for (const [model, stats] of byModel) {
    const cost = calcCost(stats, model);
    stats.cost_usd = cost;
    stats.cache_hit_rate = cacheHitRate(stats);
    if (cost === null) {
      hasUnknown = true;
    } else {
      totalCost += cost;
    }
    byModelObj[model] = stats;
  }

  total.cost_usd = hasUnknown ? null : totalCost;
  total.cache_hit_rate = cacheHitRate(total);

  const timeRange: [string | null, string | null] = timestamps.length
    ? [
        timestamps.reduce((a, b) => (a < b ? a : b)),
        timestamps.reduce((a, b) => (a > b ? a : b)),
      ]
    : [null, null];

  return { by_model: byModelObj, total, time_range: timeRange };
}

// ============================================================
// ツール統計
// ============================================================
const BASH_SEPARATORS = /&&|\|\||[;|\n]/;
const ENV_PREFIX = /^(?:[A-Z_][A-Z_0-9]*=\S*\s+)+/;
const SKIP_CMDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'do',
  'done',
  'case',
  'esac',
  'echo',
  'printf',
  'true',
  'false',
  '[',
  '[[',
  'test',
  'local',
  'export',
  'unset',
  'set',
  'read',
]);

function parseBashCmds(command: string): string[] {
  const cmds: string[] = [];
  for (const part of command.split(BASH_SEPARATORS)) {
    const trimmed = part.trim().replace(ENV_PREFIX, '').trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const words = trimmed.split(/\s+/);
    if (!words.length) {
      continue;
    }
    const name = words[0].split('/').at(-1) ?? '';
    if (
      name &&
      !SKIP_CMDS.has(name) &&
      /^[a-zA-Z_][a-zA-Z_0-9-]*$/.test(name)
    ) {
      cmds.push(name);
    }
  }
  return cmds;
}

async function extractToolStats(path: string): Promise<ToolStats> {
  let records: unknown[];
  try {
    records = await readJsonl(path);
  } catch {
    return {
      tool_counts: {},
      bash_commands: {},
      skill_calls: {},
      agent_calls: {},
      tool_errors: 0,
      tool_results_total: 0,
    };
  }

  return extractToolStatsFromRecords(records);
}

function extractToolStatsFromRecords(records: unknown[]): ToolStats {
  const toolCounts: Record<string, number> = {};
  const bashCommands: Record<string, number> = {};
  const skillCalls: Record<string, number> = {};
  const agentCalls: Record<string, number> = {};
  let toolErrors = 0;
  let toolResultsTotal = 0;

  for (const raw of records) {
    const obj = asRecord(raw);
    if (!obj) {
      continue;
    }
    const msg = asRecord(obj.message);
    if (!msg) {
      continue;
    }
    const content = msg.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const entry of content) {
      const item = asRecord(entry);
      if (!item) {
        continue;
      }
      if (item.type === 'tool_use') {
        const name = asString(item.name) || 'unknown';
        toolCounts[name] = (toolCounts[name] ?? 0) + 1;
        const inp = asRecord(item.input) ?? {};
        if (name === 'Bash') {
          for (const cmd of parseBashCmds(asString(inp.command))) {
            bashCommands[cmd] = (bashCommands[cmd] ?? 0) + 1;
          }
        } else if (name === 'Skill') {
          const key = asString(inp.skill) || 'unknown';
          skillCalls[key] = (skillCalls[key] ?? 0) + 1;
        } else if (name === 'Agent') {
          const key =
            asString(inp.subagent_type) ||
            asString(inp.description).slice(0, 40) ||
            'general-purpose';
          agentCalls[key] = (agentCalls[key] ?? 0) + 1;
        }
      } else if (item.type === 'tool_result') {
        toolResultsTotal += 1;
        if (item.is_error) {
          toolErrors += 1;
        }
      }
    }
  }

  return {
    tool_counts: toolCounts,
    bash_commands: bashCommands,
    skill_calls: skillCalls,
    agent_calls: agentCalls,
    tool_errors: toolErrors,
    tool_results_total: toolResultsTotal,
  };
}

// ============================================================
// 使用量タイムライン
// ============================================================
function contentTypesForUsage(msg: Record<string, unknown>): string[] {
  const content = msg.content;
  if (Array.isArray(content)) {
    const seen: string[] = [];
    for (const entry of content) {
      const item = asRecord(entry);
      if (!item) {
        continue;
      }
      const ctype = asString(item.type);
      if (!ctype) {
        continue;
      }
      const label = ctype === 'text' ? 'text' : ctype;
      if (!seen.includes(label)) {
        seen.push(label);
      }
    }
    return seen;
  }
  if (typeof content === 'string' && content.trim()) {
    return ['text'];
  }
  return [];
}

function summarizeUserContent(msg: Record<string, unknown>): string {
  const content = msg.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      const item = asRecord(entry);
      if (item?.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
    text = parts.join('\n');
  }
  text = text.trim();
  if (!text || shouldSkipPrefixedText(text)) {
    return '';
  }
  const oneLine = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  return oneLine.slice(0, 80);
}

async function extractUsageTimeline(
  path: string,
): Promise<UsageTimelinePoint[]> {
  let rawRecords: unknown[];
  try {
    rawRecords = await readJsonl(path);
  } catch {
    return [];
  }

  return extractUsageTimelineFromRecords(rawRecords);
}

function extractUsageTimelineFromRecords(
  rawRecords: unknown[],
): UsageTimelinePoint[] {
  const pointsById = new Map<string, UsageTimelinePoint & { _seq: number }>();
  let seq = 0;
  let latestUserSummary = '';

  for (const raw of rawRecords) {
    const obj = asRecord(raw);
    if (!obj) {
      continue;
    }
    const msg = asRecord(obj.message);
    if (!msg) {
      continue;
    }

    if (obj.type === 'user') {
      const summary = summarizeUserContent(msg);
      if (summary) {
        latestUserSummary = summary;
      }
    }

    const usage = asRecord(msg.usage);
    if (!usage) {
      continue;
    }

    const model = asString(msg.model) || 'unknown';
    if (model.startsWith('<') && model.endsWith('>')) {
      continue;
    }

    const cc = asRecord(usage.cache_creation) ?? {};
    const cacheWrite =
      asNumber(cc.ephemeral_5m_input_tokens) +
      asNumber(cc.ephemeral_1h_input_tokens);
    const inputTokens = asNumber(usage.input_tokens);
    const outputTokens = asNumber(usage.output_tokens);
    const cacheRead = asNumber(usage.cache_read_input_tokens);
    const totalInput = inputTokens + cacheRead + cacheWrite;
    const ts = asString(obj.timestamp) || null;

    // advisorイテレーション分を抽出
    const rawIterations = Array.isArray(usage.iterations)
      ? usage.iterations
      : [];
    let advisorInputTokens = 0;
    let advisorCacheReadTokens = 0;
    let advisorCacheWriteTokens = 0;
    let advisorOutputTokens = 0;
    for (const it of rawIterations) {
      const itObj = asRecord(it);
      if (!itObj || asString(itObj.type) !== 'advisor_message') continue;
      const itCc = asRecord(itObj.cache_creation) ?? {};
      advisorInputTokens += asNumber(itObj.input_tokens);
      advisorCacheReadTokens += asNumber(itObj.cache_read_input_tokens);
      advisorCacheWriteTokens +=
        asNumber(itCc.ephemeral_5m_input_tokens) +
        asNumber(itCc.ephemeral_1h_input_tokens);
      advisorOutputTokens += asNumber(itObj.output_tokens);
    }

    const point = {
      uuid: asString(obj.uuid) || null,
      timestamp: ts,
      model,
      input_tokens: inputTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      total_input_tokens: totalInput,
      output_tokens: outputTokens,
      token_usage: totalInput + outputTokens,
      content_types: contentTypesForUsage(msg),
      user_summary: latestUserSummary,
      advisor_input_tokens: advisorInputTokens,
      advisor_cache_read_tokens: advisorCacheReadTokens,
      advisor_cache_write_tokens: advisorCacheWriteTokens,
      advisor_output_tokens: advisorOutputTokens,
      _seq: seq,
    };
    seq += 1;

    const key = asString(obj.requestId) || asString(obj.uuid) || `line-${seq}`;
    const prev = pointsById.get(key);
    if (!prev) {
      pointsById.set(key, point);
      continue;
    }

    // マージ: content_types を union
    const mergedTypes = [...prev.content_types];
    for (const label of point.content_types) {
      if (!mergedTypes.includes(label)) {
        mergedTypes.push(label);
      }
    }
    point.content_types = mergedTypes;
    if (!point.user_summary) {
      point.user_summary = prev.user_summary;
    }

    const prevTs = prev.timestamp ?? '';
    const currTs = point.timestamp ?? '';
    if ((currTs && currTs >= prevTs) || (!prevTs && point._seq >= prev._seq)) {
      pointsById.set(key, point);
    } else {
      prev.content_types = mergedTypes;
      if (!prev.user_summary) {
        prev.user_summary = point.user_summary;
      }
    }
  }

  return [...pointsById.values()]
    .sort((a, b) => {
      if (a.timestamp && b.timestamp) {
        return a.timestamp.localeCompare(b.timestamp);
      }
      return a._seq - b._seq;
    })
    .map(({ _seq: _unused, ...rest }) => rest);
}

// ============================================================
// ToolStats マージ
// ============================================================
function mergeToolStats(statsList: ToolStats[]): ToolStats {
  const toolCounts: Record<string, number> = {};
  const bashCommands: Record<string, number> = {};
  const skillCalls: Record<string, number> = {};
  const agentCalls: Record<string, number> = {};
  let toolErrors = 0;
  let toolResultsTotal = 0;

  for (const s of statsList) {
    for (const [k, v] of Object.entries(s.tool_counts)) {
      toolCounts[k] = (toolCounts[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(s.bash_commands)) {
      bashCommands[k] = (bashCommands[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(s.skill_calls)) {
      skillCalls[k] = (skillCalls[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(s.agent_calls)) {
      agentCalls[k] = (agentCalls[k] ?? 0) + v;
    }
    toolErrors += s.tool_errors;
    toolResultsTotal += s.tool_results_total;
  }

  return {
    tool_counts: toolCounts,
    bash_commands: bashCommands,
    skill_calls: skillCalls,
    agent_calls: agentCalls,
    tool_errors: toolErrors,
    tool_results_total: toolResultsTotal,
  };
}

// ============================================================
// メインエントリ
// ============================================================
export async function analyzeFiles(
  jsonlPaths: string[],
): Promise<AnalyzeResponse> {
  const results = await Promise.all(
    jsonlPaths.map((p) =>
      Promise.all([
        loadJsonlForAnalysis(p),
        extractToolStats(p),
        extractUsageTimeline(p),
      ]),
    ),
  );

  const allRecords = results.flatMap(([records]) => records);
  const allToolStats = results.map(([, toolStats]) => toolStats);
  const allTimelines = results.flatMap(([, , timeline]) => timeline);

  const agg = aggregate(allRecords);

  const mergedTimeline = allTimelines.sort((a, b) => {
    if (a.timestamp && b.timestamp) {
      return a.timestamp.localeCompare(b.timestamp);
    }
    return 0;
  });

  return {
    total: agg.total as TokenStats,
    by_model: agg.by_model as Record<string, TokenStats>,
    usage_timeline: mergedTimeline,
    tool_stats: mergeToolStats(allToolStats),
    time_range: agg.time_range,
  };
}

export async function analyzeRecords(
  records: unknown[],
): Promise<AnalyzeResponse> {
  const analysisRecords = collectRecordsForAnalysis(records);
  const agg = aggregate(analysisRecords);

  return {
    total: agg.total as TokenStats,
    by_model: agg.by_model as Record<string, TokenStats>,
    usage_timeline: await extractUsageTimelineFromRecords(records),
    tool_stats: extractToolStatsFromRecords(records),
    time_range: agg.time_range,
  };
}
