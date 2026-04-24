import { describe, expect, it, vi } from 'vitest';

import { fetchSessionSection } from './api';
import type { SessionDocumentPlan } from './session-document';
import { loadSessionDocument } from './session-document';

vi.mock('./api', () => ({
  fetchSessionSection: vi.fn(async (filePath: string) => ({
    messages: [
      {
        uuid: filePath,
        role: 'user',
        content: [{ type: 'text', text: filePath }],
        timestamp: null,
        model: null,
      },
    ],
    analysis: {
      total: {
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
      },
      by_model: {},
      usage_timeline: [],
      tool_stats: {
        tool_counts: {},
        bash_commands: {},
        skill_calls: {},
        agent_calls: {},
        tool_errors: 0,
        tool_results_total: 0,
      },
      time_range: [null, null],
    },
  })),
}));

describe('loadSessionDocument', () => {
  it('loads every section for export', async () => {
    const plan: SessionDocumentPlan = {
      filename: 'session.html',
      title: 'session',
      sections: [
        {
          filePath: '/tmp/main.jsonl',
          kind: 'session',
          title: 'Main',
          subtitle: '',
          navTitle: 'Main',
          parentFilePath: null,
        },
        {
          filePath: '/tmp/subagent.jsonl',
          kind: 'subagent',
          title: 'Subagent',
          subtitle: '',
          navTitle: 'Subagent',
          parentFilePath: '/tmp/main.jsonl',
        },
      ],
    };

    const document = await loadSessionDocument(plan);

    expect(fetchSessionSection).toHaveBeenCalledTimes(2);
    expect(document.sections.map((section) => section.filePath)).toEqual([
      '/tmp/main.jsonl',
      '/tmp/subagent.jsonl',
    ]);
  });
});
