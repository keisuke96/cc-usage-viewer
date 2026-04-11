export type ToolUseLike = {
  tool_name: string;
  input: Record<string, unknown>;
};

export type DiffOpType = 'context' | 'remove' | 'add';

export type DiffOp = {
  type: DiffOpType;
  text: string;
};

export type LocatedDiffOp = DiffOp & {
  oldStart: number;
  newStart: number;
  oldNo: number | null;
  newNo: number | null;
};

export type DiffSegment = {
  text: string;
  variant: 'same' | 'remove' | 'add';
};

export type RenderableDiffCard = {
  title: string;
  filePath?: string;
  oldText: string;
  newText: string;
  pills: string[];
};

export type RenderableAskUserQuestionOption = {
  label: string;
  description: string;
};

export type RenderableAskUserQuestionCard = {
  header: string;
  question: string;
  multiSelect: boolean;
  options: RenderableAskUserQuestionOption[];
};

export type RenderableToolUse = {
  badge: string;
  preview: string;
  rawInput: string;
  summaryPills: string[];
  diffCards: RenderableDiffCard[];
  askUserQuestionCards: RenderableAskUserQuestionCard[];
};

type MultiEditEntry = {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
};

type AskUserQuestionOptionEntry = {
  label?: string;
  description?: string;
};

type AskUserQuestionEntry = {
  header?: string;
  question?: string;
  multiSelect?: boolean;
  options?: unknown;
};

function asMultiEditEntry(value: unknown): MultiEditEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as MultiEditEntry;
}

function asAskUserQuestionEntry(value: unknown): AskUserQuestionEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as AskUserQuestionEntry;
}

function asAskUserQuestionOptionEntry(
  value: unknown,
): AskUserQuestionOptionEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as AskUserQuestionOptionEntry;
}

function isAskUserQuestionTool(toolName: string): boolean {
  return toolName === 'AskUserQuestion' || toolName === 'request_user_input';
}

export function toolBadgeAndParam(
  toolName: string,
  input: Record<string, unknown>,
): { badge: string; param: string } {
  if (isAskUserQuestionTool(toolName) && Array.isArray(input.questions)) {
    const firstQuestion = asAskUserQuestionEntry(input.questions[0]);
    if (typeof firstQuestion?.question === 'string') {
      return { badge: toolName, param: firstQuestion.question };
    }
  }

  if (toolName === 'Skill') {
    const skill = typeof input.skill === 'string' ? input.skill : '';
    const args = typeof input.args === 'string' ? input.args : '';
    return { badge: skill ? `Skill(${skill})` : 'Skill', param: args };
  }

  if (toolName === 'Agent') {
    const agentType =
      typeof input.subagent_type === 'string' ? input.subagent_type : '';
    const desc = typeof input.description === 'string' ? input.description : '';
    return { badge: agentType ? `Agent(${agentType})` : 'Agent', param: desc };
  }

  for (const key of [
    'file_path',
    'command',
    'pattern',
    'path',
    'query',
    'url',
    'prompt',
  ]) {
    if (typeof input[key] === 'string') {
      return { badge: toolName, param: input[key] as string };
    }
  }

  const firstStr = Object.values(input).find(
    (value) => typeof value === 'string',
  );
  return {
    badge: toolName,
    param: typeof firstStr === 'string' ? firstStr : '',
  };
}

export function buildToolUsePresentation(item: ToolUseLike): RenderableToolUse {
  const { badge, param } = toolBadgeAndParam(item.tool_name, item.input);
  const rawInput = JSON.stringify(item.input, null, 2);
  const diffCards: RenderableDiffCard[] = [];
  const askUserQuestionCards: RenderableAskUserQuestionCard[] = [];
  const summaryPills: string[] = [];

  if (
    item.tool_name === 'Edit' &&
    typeof item.input.old_string === 'string' &&
    typeof item.input.new_string === 'string'
  ) {
    const filePath =
      typeof item.input.file_path === 'string'
        ? item.input.file_path
        : undefined;
    if (filePath) summaryPills.push(filePath);
    if (item.input.replace_all) summaryPills.push('replace_all');

    diffCards.push({
      title: '差分',
      filePath,
      oldText: item.input.old_string,
      newText: item.input.new_string,
      pills: [],
    });
  }

  if (item.tool_name === 'MultiEdit' && Array.isArray(item.input.edits)) {
    const baseFilePath =
      typeof item.input.file_path === 'string'
        ? item.input.file_path
        : undefined;
    const edits = item.input.edits
      .map((entry) => asMultiEditEntry(entry))
      .filter((entry): entry is MultiEditEntry => entry !== null)
      .filter(
        (entry) =>
          typeof entry.old_string === 'string' &&
          typeof entry.new_string === 'string',
      );

    if (baseFilePath) summaryPills.push(baseFilePath);
    if (edits.length > 0) summaryPills.push(`${edits.length} edits`);

    edits.forEach((edit, index) => {
      const filePath = baseFilePath ?? edit.file_path;
      diffCards.push({
        title: `編集 ${index + 1}`,
        filePath,
        oldText: edit.old_string ?? '',
        newText: edit.new_string ?? '',
        pills: [
          filePath ?? '',
          `編集 ${index + 1}`,
          edit.replace_all ? 'replace_all' : '',
        ].filter(Boolean),
      });
    });
  }

  if (
    isAskUserQuestionTool(item.tool_name) &&
    Array.isArray(item.input.questions)
  ) {
    const questions = item.input.questions
      .map((entry) => asAskUserQuestionEntry(entry))
      .filter((entry): entry is AskUserQuestionEntry => entry !== null)
      .map((entry) => {
        const options = Array.isArray(entry.options)
          ? entry.options
              .map((option) => asAskUserQuestionOptionEntry(option))
              .filter(
                (option): option is AskUserQuestionOptionEntry =>
                  option !== null,
              )
              .map((option) => ({
                label: typeof option.label === 'string' ? option.label : '',
                description:
                  typeof option.description === 'string'
                    ? option.description
                    : '',
              }))
              .filter((option) => option.label || option.description)
          : [];

        return {
          header: typeof entry.header === 'string' ? entry.header : '',
          question: typeof entry.question === 'string' ? entry.question : '',
          multiSelect: Boolean(entry.multiSelect),
          options,
        };
      })
      .filter(
        (entry) => entry.question || entry.header || entry.options.length > 0,
      );

    askUserQuestionCards.push(...questions);

    if (questions.length > 0) {
      summaryPills.push(`${questions.length}問`);
      if (questions.every((question) => question.multiSelect)) {
        summaryPills.push('複数選択');
      } else if (questions.every((question) => !question.multiSelect)) {
        summaryPills.push('単一選択');
      }
    }
  }

  return {
    badge,
    preview: param,
    rawInput,
    summaryPills,
    diffCards,
    askUserQuestionCards,
  };
}

function normalizeDiffText(text: string): string {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

function splitDiffLines(text: string): string[] {
  const normalized = normalizeDiffText(text);
  if (!normalized) return [];
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function buildSimpleReplaceDiff(
  oldLines: string[],
  newLines: string[],
): DiffOp[] {
  return [
    ...oldLines.map((text) => ({ type: 'remove' as const, text })),
    ...newLines.map((text) => ({ type: 'add' as const, text })),
  ];
}

export function computeLineDiff(oldText: string, newText: string): DiffOp[] {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);

  if (oldLines.length === 0 && newLines.length === 0) return [];
  if (oldLines.length * newLines.length > 20_000) {
    return buildSimpleReplaceDiff(oldLines, newLines);
  }

  const dp = Array.from({ length: oldLines.length + 1 }, () =>
    Array<number>(newLines.length + 1).fill(0),
  );

  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'context', text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'remove', text: oldLines[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', text: newLines[j] });
      j += 1;
    }
  }

  while (i < oldLines.length) {
    ops.push({ type: 'remove', text: oldLines[i] });
    i += 1;
  }

  while (j < newLines.length) {
    ops.push({ type: 'add', text: newLines[j] });
    j += 1;
  }

  return ops;
}

export function buildInlineDiffSegments(
  oldLine: string,
  newLine: string,
): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } {
  const a = String(oldLine ?? '');
  const b = String(newLine ?? '');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const aMidEnd = a.length - suffix;
  const bMidEnd = b.length - suffix;

  return {
    oldSegments: [
      { text: a.slice(0, prefix), variant: 'same' },
      { text: a.slice(prefix, aMidEnd), variant: 'remove' },
      { text: a.slice(aMidEnd), variant: 'same' },
    ] satisfies DiffSegment[],
    newSegments: [
      { text: b.slice(0, prefix), variant: 'same' },
      { text: b.slice(prefix, bMidEnd), variant: 'add' },
      { text: b.slice(bMidEnd), variant: 'same' },
    ] satisfies DiffSegment[],
  };
}

export function buildDiffHunks(
  oldText: string,
  newText: string,
  contextLines = 3,
): LocatedDiffOp[][] {
  const ops = computeLineDiff(oldText, newText);
  if (!ops.length) return [];

  let oldCursor = 1;
  let newCursor = 1;
  const located: LocatedDiffOp[] = ops.map((op) => {
    const item: LocatedDiffOp = {
      ...op,
      oldStart: oldCursor,
      newStart: newCursor,
      oldNo: op.type === 'add' ? null : oldCursor,
      newNo: op.type === 'remove' ? null : newCursor,
    };
    if (op.type !== 'add') oldCursor += 1;
    if (op.type !== 'remove') newCursor += 1;
    return item;
  });

  const changedIndexes = located
    .map((op, index) => (op.type === 'context' ? -1 : index))
    .filter((index) => index >= 0);
  if (!changedIndexes.length) return [];

  const hunks: LocatedDiffOp[][] = [];
  let start = Math.max(0, changedIndexes[0] - contextLines);
  let end = Math.min(located.length - 1, changedIndexes[0] + contextLines);

  for (let index = 1; index < changedIndexes.length; index += 1) {
    const nextStart = Math.max(0, changedIndexes[index] - contextLines);
    const nextEnd = Math.min(
      located.length - 1,
      changedIndexes[index] + contextLines,
    );
    if (nextStart <= end + 1) {
      end = Math.max(end, nextEnd);
    } else {
      hunks.push(located.slice(start, end + 1));
      start = nextStart;
      end = nextEnd;
    }
  }

  hunks.push(located.slice(start, end + 1));
  return hunks;
}

export function formatDiffRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}
