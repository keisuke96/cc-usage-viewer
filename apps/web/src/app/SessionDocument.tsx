import type {
  AnalyzeResponse,
  ChatContentItem,
  ChatMessage,
  DiffSegment,
  LocatedDiffOp,
  RenderableToolUse,
  TokenStats,
  ToolStats,
  UsageTimelinePoint,
} from '@ccuv/shared';
import {
  buildDiffHunks,
  buildInlineDiffSegments,
  buildToolUsePresentation,
  formatDiffRange,
} from '@ccuv/shared';
import { BarChart } from 'echarts/charts';
import type { EChartsCoreOption } from 'echarts/core';
import * as echarts from 'echarts/core';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';
import type { MouseEvent, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type {
  LoadedSessionDocument,
  LoadedSessionDocumentSection,
  SessionDocumentSectionKind,
} from '../lib/session-document';
import {
  fmtCost,
  fmtPct,
  fmtTokens,
  formatModelName,
  modelColor,
} from '../lib/analysis-format';
import './session-document.css';
import sessionDocumentCssText from './session-document.css?raw';

echarts.use([
  BarChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
  SVGRenderer,
]);

export const SESSION_DOCUMENT_CSS_TEXT = sessionDocumentCssText;

type ToolUseItem = Extract<ChatContentItem, { type: 'tool_use' }>;
type ToolResultItem = Extract<ChatContentItem, { type: 'tool_result' }>;
type SearchableMessageEntry = {
  searchId: string;
  text: string;
};

export type SessionDocumentMode = 'interactive' | 'export';
export type SessionDocumentView = 'messages' | 'analysis' | 'both';

type SessionDocumentProps = {
  document: LoadedSessionDocument;
  mode: SessionDocumentMode;
  view: SessionDocumentView;
  selectedFilePath?: string | null;
};

function renderTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return '';
  }

  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'たった今';
    if (diffMin < 60) return `${diffMin}分前`;
    if (diffHour < 24) return `${diffHour}時間前`;
    if (diffDay < 7) return `${diffDay}日前`;
    return date.toLocaleDateString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return timestamp;
  }
}

function renderContentBody(item: ChatContentItem): string {
  if (item.type === 'tool_use') return JSON.stringify(item.input, null, 2);
  if (item.type === 'tool_result') return item.content;
  if (item.type === 'advisor_call') return '[Advisor 呼び出し]';
  if (item.type === 'advisor_result') return item.text ?? '[暗号化されたレスポンス]';
  return item.text;
}

function contentKey(item: ChatContentItem): string {
  return [item.type, renderContentBody(item)].join(':');
}

function buildMessageSearchId(sectionFilePath: string, index: number): string {
  return `${sectionFilePath}::${index}`;
}

function buildMessageSearchText(message: ChatMessage): string {
  return message.content.map((item) => renderContentBody(item)).join('\n');
}

function formatSectionKindLabel(kind: SessionDocumentSectionKind): string {
  if (kind === 'session') return 'Main Session';
  if (kind === 'subagent') return 'Subagent';
  return 'Team Session';
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function handleClick(
    event: MouseEvent<HTMLButtonElement>,
  ): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    try {
      await copyToClipboard(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      console.error('Failed to copy text', error);
    }
  }

  return (
    <button
      type="button"
      className="copy-button"
      onClick={(event) => {
        void handleClick(event);
      }}
      title={copied ? 'コピー済み' : label}
      aria-label={copied ? 'コピー済み' : label}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function MarkdownContent({
  text,
  variant,
}: {
  text: string;
  variant: 'default' | 'user' | 'thinking';
}) {
  const className =
    variant === 'thinking'
      ? 'markdown-body markdown-body--thinking'
      : variant === 'user'
        ? 'markdown-body markdown-body--user'
        : 'markdown-body';

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function DiffInlineText({ segments }: { segments: DiffSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => {
        const className =
          segment.variant === 'add'
            ? 'diff-inline-add'
            : segment.variant === 'remove'
              ? 'diff-inline-remove'
              : undefined;

        if (!className) {
          return (
            <span key={`same-${index}-${segment.text.length}`}>
              {segment.text}
            </span>
          );
        }

        return (
          <span
            key={`${segment.variant}-${index}-${segment.text.length}`}
            className={className}
          >
            {segment.text}
          </span>
        );
      })}
    </>
  );
}

function DiffRows({ hunk }: { hunk: LocatedDiffOp[] }) {
  const rows: ReactNode[] = [];
  const oldCount = hunk.filter((op) => op.type !== 'add').length;
  const newCount = hunk.filter((op) => op.type !== 'remove').length;
  const header = `@@ -${formatDiffRange(hunk[0].oldStart, oldCount)} +${formatDiffRange(hunk[0].newStart, newCount)} @@`;

  rows.push(
    <tr
      key={`hunk-${hunk[0].oldStart}-${hunk[0].newStart}`}
      className="diff-row hunk"
    >
      <td className="diff-sign">@</td>
      <td colSpan={3} className="diff-code">
        {header}
      </td>
    </tr>,
  );

  for (let i = 0; i < hunk.length; ) {
    const op = hunk[i];
    if (op.type === 'context') {
      rows.push(
        <tr
          key={`context-${op.oldNo}-${op.newNo}`}
          className="diff-row context"
        >
          <td className="diff-sign"> </td>
          <td className="diff-line-no">{op.oldNo ?? ''}</td>
          <td className="diff-line-no">{op.newNo ?? ''}</td>
          <td className="diff-code">{op.text || ' '}</td>
        </tr>,
      );
      i += 1;
      continue;
    }

    const removed: LocatedDiffOp[] = [];
    const added: LocatedDiffOp[] = [];
    while (i < hunk.length && hunk[i].type !== 'context') {
      if (hunk[i].type === 'remove') removed.push(hunk[i]);
      if (hunk[i].type === 'add') added.push(hunk[i]);
      i += 1;
    }

    const maxLen = Math.max(removed.length, added.length);
    for (let index = 0; index < maxLen; index += 1) {
      const removedLine = removed[index];
      const addedLine = added[index];

      if (removedLine && addedLine) {
        const inline = buildInlineDiffSegments(
          removedLine.text,
          addedLine.text,
        );
        rows.push(
          <tr
            key={`remove-${removedLine.oldNo}-${index}`}
            className="diff-row remove"
          >
            <td className="diff-sign">-</td>
            <td className="diff-line-no">{removedLine.oldNo ?? ''}</td>
            <td className="diff-line-no" />
            <td className="diff-code">
              <DiffInlineText segments={inline.oldSegments} />
            </td>
          </tr>,
        );
        rows.push(
          <tr key={`add-${addedLine.newNo}-${index}`} className="diff-row add">
            <td className="diff-sign">+</td>
            <td className="diff-line-no" />
            <td className="diff-line-no">{addedLine.newNo ?? ''}</td>
            <td className="diff-code">
              <DiffInlineText segments={inline.newSegments} />
            </td>
          </tr>,
        );
        continue;
      }

      if (removedLine) {
        rows.push(
          <tr key={`remove-${removedLine.oldNo}`} className="diff-row remove">
            <td className="diff-sign">-</td>
            <td className="diff-line-no">{removedLine.oldNo ?? ''}</td>
            <td className="diff-line-no" />
            <td className="diff-code">{removedLine.text || ' '}</td>
          </tr>,
        );
      }

      if (addedLine) {
        rows.push(
          <tr key={`add-${addedLine.newNo}`} className="diff-row add">
            <td className="diff-sign">+</td>
            <td className="diff-line-no" />
            <td className="diff-line-no">{addedLine.newNo ?? ''}</td>
            <td className="diff-code">{addedLine.text || ' '}</td>
          </tr>,
        );
      }
    }
  }

  return <>{rows}</>;
}

function DiffCard({
  title,
  oldText,
  newText,
  path,
}: {
  title: string;
  oldText: string;
  newText: string;
  path?: string;
}) {
  const hunks = buildDiffHunks(oldText, newText);

  return (
    <div className="diff-card">
      <div className="diff-card-title">{title}</div>
      <div className="diff-file-meta">
        <span className="diff-file-label old">--- before</span>
        <span className="diff-file-label new">+++ after</span>
        {path && <span>{path}</span>}
      </div>
      {hunks.length === 0 ? (
        <div className="diff-empty">変更なし</div>
      ) : (
        <div className="diff-scroll">
          <table className="diff-table">
            <tbody>
              {hunks.map((hunk) => (
                <DiffRows
                  key={`${hunk[0].oldStart}-${hunk[0].newStart}`}
                  hunk={hunk}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ToolMetaRow({ values }: { values: string[] }) {
  if (!values.length) {
    return null;
  }

  return (
    <div className="pill-row">
      {values.map((value) => (
        <span key={value} className="pill">
          {value}
        </span>
      ))}
    </div>
  );
}

function askUserQuestionCardKey(
  presentation: RenderableToolUse,
  cardIndex: number,
): string {
  const card = presentation.askUserQuestionCards[cardIndex];
  const optionsKey = card.options
    .map((option) => `${option.label}::${option.description}`)
    .join('|');

  return [
    card.header,
    card.question,
    card.multiSelect ? 'multi' : 'single',
    optionsKey,
  ].join('::');
}

function askUserQuestionOptionKey(
  cardKey: string,
  label: string,
  description: string,
): string {
  return [cardKey, label, description].join('::');
}

function EditToolContent({
  presentation,
}: {
  presentation: RenderableToolUse;
}) {
  if (!presentation.diffCards.length) {
    return null;
  }

  return (
    <div className="diff-stack">
      {presentation.summaryPills.length > 0 && (
        <ToolMetaRow values={presentation.summaryPills} />
      )}
      {presentation.diffCards.map((card, index) => (
        <div key={`${card.filePath ?? 'diff'}-${index}`}>
          {card.pills.length > 0 && <ToolMetaRow values={card.pills} />}
          <DiffCard
            title={card.title}
            oldText={card.oldText}
            newText={card.newText}
            path={card.filePath}
          />
        </div>
      ))}
      <details className="raw-toggle">
        <summary>Raw input</summary>
        <pre className="tool-pre">{presentation.rawInput}</pre>
      </details>
    </div>
  );
}

function AskUserQuestionContent({
  presentation,
}: {
  presentation: RenderableToolUse;
}) {
  if (!presentation.askUserQuestionCards.length) {
    return null;
  }

  return (
    <div className="ask-user-question-stack">
      {presentation.summaryPills.length > 0 && (
        <ToolMetaRow values={presentation.summaryPills} />
      )}
      {presentation.askUserQuestionCards.map((card, index) => {
        const cardKey = askUserQuestionCardKey(presentation, index);

        return (
          <section key={cardKey} className="ask-user-question-card">
            <div className="ask-user-question-card__header">
              <div>
                {card.header && (
                  <div className="ask-user-question-card__eyebrow">
                    {card.header}
                  </div>
                )}
                {card.question && (
                  <div className="ask-user-question-card__question">
                    {card.question}
                  </div>
                )}
              </div>
              <span className="ask-user-question-card__select-mode">
                {card.multiSelect ? '複数選択' : '単一選択'}
              </span>
            </div>

            {card.options.length > 0 && (
              <div className="ask-user-question-options">
                {card.options.map((option) => (
                  <div
                    key={askUserQuestionOptionKey(
                      cardKey,
                      option.label,
                      option.description,
                    )}
                    className="ask-user-question-option"
                  >
                    <div
                      className="ask-user-question-option__control"
                      aria-hidden="true"
                    >
                      {card.multiSelect ? (
                        <span className="ask-user-question-option__checkbox" />
                      ) : (
                        <span className="ask-user-question-option__radio" />
                      )}
                    </div>
                    <div className="ask-user-question-option__body">
                      {option.label && (
                        <div className="ask-user-question-option__label">
                          {option.label}
                        </div>
                      )}
                      {option.description && (
                        <div className="ask-user-question-option__description">
                          {option.description}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}

      <details className="raw-toggle">
        <summary>Raw input</summary>
        <pre className="tool-pre">{presentation.rawInput}</pre>
      </details>
    </div>
  );
}

function ToolUseBlock({
  item,
  mode,
}: {
  item: ToolUseItem;
  mode: SessionDocumentMode;
}) {
  const presentation = buildToolUsePresentation(item);

  return (
    <details className="tool-block">
      <summary>
        <span className="tool-badge">{presentation.badge}</span>
        <span className="tool-preview">{presentation.preview}</span>
        {mode === 'interactive' && (
          <span className="tool-summary__actions">
            <CopyButton text={presentation.rawInput} label="入力をコピー" />
          </span>
        )}
      </summary>
      <div className="tool-body">
        {presentation.askUserQuestionCards.length > 0 ? (
          <AskUserQuestionContent presentation={presentation} />
        ) : presentation.diffCards.length > 0 ? (
          <EditToolContent presentation={presentation} />
        ) : (
          <pre className="tool-pre">{presentation.rawInput}</pre>
        )}
      </div>
    </details>
  );
}

function ToolResultBlock({
  item,
  mode,
}: {
  item: ToolResultItem;
  mode: SessionDocumentMode;
}) {
  const preview = item.content.replaceAll('\n', ' ').slice(0, 96);
  const className = item.is_error
    ? 'result-block result-block--error'
    : 'result-block';

  return (
    <details className={className}>
      <summary>
        <span className="result-badge">
          {item.is_error ? 'エラー' : '結果'}
        </span>
        <span className="result-preview">{preview}</span>
        {mode === 'interactive' && (
          <span className="tool-summary__actions">
            <CopyButton text={item.content} label="結果をコピー" />
          </span>
        )}
      </summary>
      <pre className="result-pre">{item.content}</pre>
    </details>
  );
}

function AdvisorCallBlock() {
  return (
    <div className="advisor-call-block">
      <span className="advisor-badge">Advisor</span>
      <span className="advisor-call-label">レビューを依頼</span>
    </div>
  );
}

function AdvisorResultBlock({ item, mode }: { item: Extract<ChatContentItem, { type: 'advisor_result' }>; mode: SessionDocumentMode }) {
  if (item.text === null) {
    return (
      <div className="advisor-result-block advisor-result-block--redacted">
        <span className="advisor-badge">Advisor</span>
        <span className="advisor-result-redacted">暗号化されたレスポンス</span>
      </div>
    );
  }

  return (
    <details className="advisor-result-block" open>
      <summary>
        <span className="advisor-badge">Advisor</span>
        <span className="advisor-result-preview">{item.text.slice(0, 80).replaceAll('\n', ' ')}</span>
        {mode === 'interactive' && (
          <span className="tool-summary__actions">
            <CopyButton text={item.text} label="レスポンスをコピー" />
          </span>
        )}
      </summary>
      <div className="advisor-result-body">
        <MarkdownContent text={item.text} variant="default" />
      </div>
    </details>
  );
}

function MessageContentItem({
  item,
  mode,
}: {
  item: ChatContentItem;
  mode: SessionDocumentMode;
}) {
  if (item.type === 'tool_use') return <ToolUseBlock item={item} mode={mode} />;
  if (item.type === 'tool_result')
    return <ToolResultBlock item={item} mode={mode} />;
  if (item.type === 'advisor_call') return <AdvisorCallBlock />;
  if (item.type === 'advisor_result') return <AdvisorResultBlock item={item} mode={mode} />;

  const isThinking = item.type === 'thinking';
  const className = [
    'message-bubble',
    isThinking ? 'message-bubble--thinking' : '',
    mode === 'export' ? 'message-bubble--export' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      {mode === 'interactive' && (
        <div className="message-bubble__copy">
          <CopyButton text={item.text} label="Markdown をコピー" />
        </div>
      )}
      <div className="message-bubble__content">
        {isThinking && <div className="message-bubble__thinking">thinking</div>}
        <MarkdownContent
          text={item.text}
          variant={isThinking ? 'thinking' : 'default'}
        />
      </div>
    </div>
  );
}

function MessageView({
  message,
  mode,
  searchId,
  registerSearchTarget,
  isSearchHit,
  isSearchActive,
}: {
  message: ChatMessage;
  mode: SessionDocumentMode;
  searchId?: string;
  registerSearchTarget?: (searchId: string, node: HTMLElement | null) => void;
  isSearchHit?: boolean;
  isSearchActive?: boolean;
}) {
  const articleClassName = [
    'session-message',
    isSearchHit ? 'session-message--search-hit' : '',
    isSearchActive ? 'session-message--search-active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const articleProps =
    mode === 'interactive' && searchId && registerSearchTarget
      ? {
          ref: (node: HTMLElement | null) => {
            registerSearchTarget(searchId, node);
          },
          'data-search-id': searchId,
          ...(message.uuid ? { id: `msg-${message.uuid}` } : {}),
        }
      : {};

  if (message.role === 'user') {
    const textItems = message.content.filter((item) => item.type === 'text');
    const resultItems = message.content.filter(
      (item): item is ToolResultItem => item.type === 'tool_result',
    );

    return (
      <article className={articleClassName} {...articleProps}>
        {textItems.length > 0 && (
          <div className="session-message__row session-message__row--user">
            <div className="session-message__main session-message__main--user">
              <div className="session-message__stack">
                {textItems.map((item) => (
                  <div
                    key={contentKey(item)}
                    className={`message-bubble message-bubble--user ${mode === 'export' ? 'message-bubble--export' : ''}`}
                  >
                    {mode === 'interactive' && (
                      <div className="message-bubble__copy">
                        <CopyButton
                          text={item.text}
                          label="Markdown をコピー"
                        />
                      </div>
                    )}
                    <div className="message-bubble__content">
                      <MarkdownContent text={item.text} variant="user" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="session-avatar session-avatar--user">U</div>
          </div>
        )}
        {resultItems.length > 0 && (
          <div className="tool-result-row">
            {resultItems.map((item) => (
              <ToolResultBlock key={contentKey(item)} item={item} mode={mode} />
            ))}
          </div>
        )}
      </article>
    );
  }

  return (
    <article className={articleClassName} {...articleProps}>
      <div className="session-message__row">
        <div className="session-avatar session-avatar--assistant">C</div>
        <div className="session-message__main">
          <div className="session-message__meta">
            {message.model && (
              <span
                className="model-chip"
                style={{ color: modelColor(message.model) }}
              >
                <span
                  className="model-chip__dot"
                  style={{ backgroundColor: modelColor(message.model) }}
                />
                {formatModelName(message.model)}
              </span>
            )}
            {message.timestamp && (
              <span className="session-message__time">
                {renderTimestamp(message.timestamp)}
              </span>
            )}
          </div>
          <div className="session-message__stack">
            {message.content.map((item) => (
              <MessageContentItem
                key={contentKey(item)}
                item={item}
                mode={mode}
              />
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

function SummaryStat({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClassName?: string;
}) {
  const className = valueClassName
    ? `summary-stat__value ${valueClassName}`
    : 'summary-stat__value';

  return (
    <div className="summary-stat">
      <div className="summary-stat__label">{label}</div>
      <div className={className}>{value}</div>
      {sub && <div className="summary-stat__sub">{sub}</div>}
    </div>
  );
}

function ModelChips({ byModel }: { byModel: Record<string, TokenStats> }) {
  const entries = Object.entries(byModel).sort(
    ([, a], [, b]) => b.requests - a.requests,
  );
  if (!entries.length) {
    return null;
  }

  return (
    <div className="summary-stat">
      <div className="summary-stat__label">Model</div>
      <div className="model-chip-stack">
        {entries.map(([model]) => (
          <span
            key={model}
            className="model-chip"
            style={{ color: modelColor(model) }}
          >
            <span
              className="model-chip__dot"
              style={{ backgroundColor: modelColor(model) }}
            />
            {formatModelName(model)}
          </span>
        ))}
      </div>
    </div>
  );
}

function TopN({
  title,
  counts,
  n = 10,
}: {
  title: string;
  counts: Record<string, number>;
  n?: number;
}) {
  const entries = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n);

  if (!entries.length) {
    return null;
  }

  return (
    <div>
      <div className="top-list__title">{title}</div>
      {entries.map(([name, count]) => (
        <div key={name} className="top-list__row">
          <span>{name}</span>
          <strong>{count}</strong>
        </div>
      ))}
    </div>
  );
}

const SERIES_COLORS = {
  input: '#a5a5a5',
  cacheRead: '#70ad47',
  cacheWrite: '#ed7d31',
  output: '#5b9bd5',
  advisorCacheRead: '#9c4dcc',
  advisorCacheWrite: '#b06fe0',
  advisorInput: '#ce93d8',
  advisorOutput: '#f48fb1',
};

function buildTimelineLabels(points: UsageTimelinePoint[]): string[] {
  return points.map((point, index) =>
    point.timestamp
      ? new Date(point.timestamp).toLocaleString('ja-JP')
      : String(index + 1),
  );
}

export function buildTimelineOption(
  points: UsageTimelinePoint[],
): EChartsCoreOption {
  const xLabels = buildTimelineLabels(points);

  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: {
      color: 'rgba(255,255,255,0.72)',
      fontFamily:
        'ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
      backgroundColor: 'rgba(24,24,24,0.94)',
      borderColor: 'rgba(255,255,255,0.12)',
      textStyle: {
        color: '#f2f2f2',
        fontSize: 12,
      },
      extraCssText:
        'max-width: 320px; white-space: normal; word-break: break-all;',
      formatter: (params: unknown) => {
        const items = params as {
          dataIndex: number;
          seriesName: string;
          value: number;
          marker: string;
        }[];
        if (!items.length) return '';

        const idx = items[0].dataIndex;
        const point = points[idx];
        const advisorTotal = (point.advisor_input_tokens ?? 0) + (point.advisor_cache_read_tokens ?? 0) + (point.advisor_cache_write_tokens ?? 0) + (point.advisor_output_tokens ?? 0);
        const lines = [
          `<b>${xLabels[idx]}</b>`,
          `Total: ${fmtTokens(point.token_usage + advisorTotal)}`,
          ...items.map(
            (item) =>
              `${item.marker}${item.seriesName}: ${fmtTokens(item.value)}`,
          ),
        ];

        if (point.user_summary) {
          lines.push(
            `<i style="color:rgba(255,255,255,0.6)">"${point.user_summary}"</i>`,
          );
        }

        return lines.join('<br/>');
      },
    },
    legend: {
      data: ['Cache Hit', 'Cache Write', 'Input', 'Output', 'Adv Cache Hit', 'Adv Cache Write', 'Adv Input', 'Adv Output'],
      bottom: 0,
      textStyle: {
        color: 'rgba(255,255,255,0.72)',
        fontSize: 11,
      },
    },
    grid: {
      left: 60,
      right: 12,
      top: 12,
      bottom: 48,
    },
    xAxis: {
      type: 'category',
      data: xLabels,
      axisLabel: { show: false },
      axisTick: { show: false },
      axisLine: {
        lineStyle: { color: 'rgba(255,255,255,0.14)' },
      },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        formatter: (value: number) => fmtTokens(value),
        fontSize: 10,
        color: 'rgba(255,255,255,0.6)',
      },
      splitLine: {
        lineStyle: { color: 'rgba(255,255,255,0.08)' },
      },
    },
    series: [
      {
        name: 'Cache Hit',
        type: 'bar',
        stack: 'total',
        data: points.map((point) => point.cache_read_tokens),
        itemStyle: { color: SERIES_COLORS.cacheRead },
        barMaxWidth: 10,
        barCategoryGap: '5%',
      },
      {
        name: 'Cache Write',
        type: 'bar',
        stack: 'total',
        data: points.map((point) => point.cache_write_tokens),
        itemStyle: { color: SERIES_COLORS.cacheWrite },
        barMaxWidth: 10,
      },
      {
        name: 'Input',
        type: 'bar',
        stack: 'total',
        data: points.map((point) => point.input_tokens),
        itemStyle: { color: SERIES_COLORS.input },
        barMaxWidth: 10,
      },
      {
        name: 'Output',
        type: 'bar',
        stack: 'total',
        data: points.map((point) => point.output_tokens),
        itemStyle: { color: SERIES_COLORS.output },
        barMaxWidth: 10,
      },
      {
        name: 'Adv Cache Hit',
        type: 'bar',
        stack: 'total',
        data: points.map((point) => point.advisor_cache_read_tokens ?? 0),
        itemStyle: { color: SERIES_COLORS.advisorCacheRead },
        barMaxWidth: 10,
      },
      {
        name: 'Adv Cache Write',
        type: 'bar',
        stack: 'total',
        data: points.map((point) => point.advisor_cache_write_tokens ?? 0),
        itemStyle: { color: SERIES_COLORS.advisorCacheWrite },
        barMaxWidth: 10,
      },
      {
        name: 'Adv Input',
        type: 'bar',
        stack: 'total',
        data: points.map((point) => point.advisor_input_tokens ?? 0),
        itemStyle: { color: SERIES_COLORS.advisorInput },
        barMaxWidth: 10,
      },
      {
        name: 'Adv Output',
        type: 'bar',
        stack: 'total',
        data: points.map((point) => point.advisor_output_tokens ?? 0),
        itemStyle: { color: SERIES_COLORS.advisorOutput },
        barMaxWidth: 10,
      },
    ],
  };
}

function renderTimelineSvg(
  points: UsageTimelinePoint[],
  width: number,
  height: number,
): string {
  if (typeof document === 'undefined') {
    return '';
  }

  const container = document.createElement('div');
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;

  const chart = echarts.init(container, undefined, {
    renderer: 'svg',
    width,
    height,
  });

  try {
    chart.setOption(buildTimelineOption(points));
    return container.innerHTML;
  } finally {
    chart.dispose();
  }
}

function escapeAttributeValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function UsageTimelineChart({
  points,
  mode,
}: {
  points: UsageTimelinePoint[];
  mode: SessionDocumentMode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const chartWidth = Math.max(points.length * 20, 480);
  const chartHeight = 260;

  useEffect(() => {
    if (
      mode !== 'interactive' ||
      !containerRef.current ||
      points.length === 0
    ) {
      return;
    }

    chartRef.current = echarts.init(containerRef.current, undefined, {
      renderer: 'canvas',
      width: chartWidth,
      height: chartHeight,
    });

    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [chartHeight, chartWidth, mode, points.length]);

  useEffect(() => {
    if (mode !== 'interactive' || !chartRef.current || points.length === 0) {
      return;
    }

    chartRef.current.setOption(buildTimelineOption(points), true);
    chartRef.current.resize({
      width: chartWidth,
      height: chartHeight,
    });
  }, [chartHeight, chartWidth, mode, points]);

  useEffect(() => {
    if (mode !== 'interactive' || !chartRef.current) {
      return;
    }

    const chart = chartRef.current;
    const handler = (params: { dataIndex: number }) => {
      const uuid = points[params.dataIndex]?.uuid;
      if (!uuid) return;
      const el = document.getElementById(`msg-${uuid}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.remove('session-message--timeline-highlight');
      void el.offsetWidth; // reflow to restart animation
      el.classList.add('session-message--timeline-highlight');
      el.addEventListener(
        'animationend',
        () => el.classList.remove('session-message--timeline-highlight'),
        { once: true },
      );
    };
    chart.on('click', handler);
    return () => {
      chart.off('click', handler);
    };
  }, [mode, points]);

  const svgMarkup = useMemo(() => {
    if (mode !== 'export' || points.length === 0) {
      return null;
    }

    return renderTimelineSvg(points, chartWidth, chartHeight);
  }, [chartHeight, chartWidth, mode, points]);

  if (!points.length) {
    return null;
  }

  return (
    <div className="timeline-chart-card">
      <div className="timeline-chart-scroll">
        {mode === 'interactive' ? (
          <div
            ref={containerRef}
            className="timeline-chart"
            style={{ width: `${chartWidth}px`, height: `${chartHeight}px` }}
          />
        ) : (
          <div
            className="timeline-chart timeline-chart--static"
            dangerouslySetInnerHTML={{ __html: svgMarkup ?? '' }}
          />
        )}
      </div>
    </div>
  );
}

function AnalysisSummary({
  analysis,
  mode,
  title,
  subtitle,
  className,
  dataFilePath,
}: {
  analysis: AnalyzeResponse;
  mode: SessionDocumentMode;
  title: string;
  subtitle?: string;
  className?: string;
  dataFilePath?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const isInteractive = mode === 'interactive';

  const total = analysis.total;
  const byModel = analysis.by_model;
  const latestContext =
    total.latest_total_input_tokens + total.latest_output_tokens;
  const totalInput =
    total.input_tokens +
    total.cache_read_tokens +
    total.cache_creation_5m +
    total.cache_creation_1h;
  const modelEntries = Object.entries(byModel).sort(
    ([, a], [, b]) => b.requests - a.requests,
  );
  const toolStats = analysis.tool_stats;

  const expandedContent = (
    <>
      <div className="summary-grid" style={{ marginTop: 12 }}>
        <SummaryStat label="Total Input" value={fmtTokens(totalInput)} />
        <SummaryStat label="Output" value={fmtTokens(total.output_tokens)} />
        <SummaryStat label="Cache Hit" value={fmtTokens(total.cache_read_tokens)} />
        <SummaryStat label="Cache Write" value={fmtTokens(total.cache_creation_5m + total.cache_creation_1h)} />
      </div>
      <div className="analysis-summary__note">
        Token Usage = 最新リクエスト 1 件の総入力 + 総出力。Total Output と
        Cache 系はセッション累計です。
      </div>
      {modelEntries.length > 0 && (
        <div className="analysis-block">
          <h3>モデル別</h3>
          <div className="table-wrap">
            <table className="analysis-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Req</th>
                  <th>Input</th>
                  <th>Cache Hit</th>
                  <th>Cache Write</th>
                  <th>Output</th>
                  <th>Hit Rate</th>
                  <th>Cost (est.)</th>
                </tr>
              </thead>
              <tbody>
                {modelEntries.map(([model, stats]) => (
                  <tr key={model}>
                    <td>{model}</td>
                    <td>{stats.requests}</td>
                    <td>{fmtTokens(stats.input_tokens)}</td>
                    <td>{fmtTokens(stats.cache_read_tokens)}</td>
                    <td>{fmtTokens(stats.cache_creation_5m + stats.cache_creation_1h)}</td>
                    <td>{fmtTokens(stats.output_tokens)}</td>
                    <td>{fmtPct(stats.cache_hit_rate)}</td>
                    <td>{fmtCost(stats.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ToolStatsSection toolStats={toolStats} />
    </>
  );

  return (
    <section
      className={className ? className : 'session-document__analysis'}
      data-session-file-path={dataFilePath}
    >
      <div
        className={`analysis-summary__header${isInteractive ? ' analysis-summary__header--toggle' : ''}`}
        onClick={isInteractive ? () => setIsOpen((v) => !v) : undefined}
        role={isInteractive ? 'button' : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        onKeyDown={isInteractive ? (e) => { if (e.key === 'Enter' || e.key === ' ') setIsOpen((v) => !v); } : undefined}
      >
        <h2 className="analysis-summary__title">{title}</h2>
        {isInteractive && (
          <span className="analysis-summary__chevron">{isOpen ? '▴' : '▾'}</span>
        )}
        {subtitle && (
          <div className="analysis-summary__subtitle">{subtitle}</div>
        )}
      </div>

      {/* 常時表示: 主要カード */}
      <div className="summary-grid">
        <SummaryStat
          label="Token Usage"
          value={fmtTokens(latestContext)}
          valueClassName="summary-stat__value--primary"
        />
        <SummaryStat
          label="推定コスト"
          value={fmtCost(total.cost_usd)}
          valueClassName="summary-stat__value--warning"
        />
        <SummaryStat label="Requests" value={String(total.requests)} />
        <ModelChips byModel={byModel} />
      </div>

      {/* 常時表示: タイムライン */}
      {analysis.usage_timeline.length > 0 && (
        <div className="analysis-block">
          <h3>
            Token 使用量タイムライン ({analysis.usage_timeline.length} requests)
          </h3>
          <UsageTimelineChart points={analysis.usage_timeline} mode={mode} />
        </div>
      )}

      {/* 展開時のみ: 詳細カード・テーブル・ツール統計 */}
      {isInteractive ? (
        isOpen && expandedContent
      ) : (
        <details className="analysis-summary__details">
          <summary className="analysis-summary__details-summary">詳細 ▾</summary>
          {expandedContent}
        </details>
      )}
    </section>
  );
}

function ToolStatsSection({ toolStats }: { toolStats: ToolStats }) {
  return (
    <div className="analysis-block">
      <h3>ツール統計</h3>
      <div className="tool-stats-grid">
        <div className="tool-stat-card">
          <div className="tool-stat-card__headline">
            <span>Tool errors</span>
            <strong>
              {toolStats.tool_errors} / {toolStats.tool_results_total}
            </strong>
          </div>
          <TopN title="Tool calls" counts={toolStats.tool_counts} />
        </div>
        {Object.keys(toolStats.bash_commands).length > 0 && (
          <div className="tool-stat-card">
            <TopN title="Bash commands" counts={toolStats.bash_commands} />
          </div>
        )}
        {Object.keys(toolStats.skill_calls).length > 0 && (
          <div className="tool-stat-card">
            <TopN title="Skill calls" counts={toolStats.skill_calls} />
          </div>
        )}
        {Object.keys(toolStats.agent_calls).length > 0 && (
          <div className="tool-stat-card">
            <TopN title="Agent calls" counts={toolStats.agent_calls} />
          </div>
        )}
      </div>
    </div>
  );
}

function SessionMessages({
  section,
  mode,
  searchHitIds,
  activeSearchId,
  registerSearchTarget,
}: {
  section: LoadedSessionDocumentSection;
  mode: SessionDocumentMode;
  searchHitIds: Set<string>;
  activeSearchId: string | null;
  registerSearchTarget: (searchId: string, node: HTMLElement | null) => void;
}) {
  if (section.messages.length === 0) {
    return <div className="empty-state">メッセージなし</div>;
  }

  return (
    <>
      {section.messages.map((message, index) => {
        const searchId = buildMessageSearchId(section.filePath, index);

        return (
          <MessageView
            key={searchId}
            message={message}
            mode={mode}
            searchId={searchId}
            registerSearchTarget={registerSearchTarget}
            isSearchHit={searchHitIds.has(searchId)}
            isSearchActive={activeSearchId === searchId}
          />
        );
      })}
    </>
  );
}

function SearchToolbar({
  query,
  matchCount,
  activeIndex,
  isFocused,
  onQueryChange,
  onFocus,
  onBlur,
  onPrevious,
  onNext,
  onClear,
  onScrollTop,
}: {
  query: string;
  matchCount: number;
  activeIndex: number;
  isFocused: boolean;
  onQueryChange: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onClear: () => void;
  onScrollTop: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasQuery = query.trim().length > 0;
  const hasMatches = matchCount > 0;
  const isCompact = !hasQuery && !isFocused;
  const resultLabel = hasQuery
    ? hasMatches
      ? `${activeIndex + 1} / ${matchCount}`
      : '0 件'
    : '未検索';

  function handleIconClick() {
    onFocus();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <div
      className={['session-search', isCompact ? 'session-search--compact' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {isCompact ? (
        <>
          <button
            type="button"
            className="session-search__icon-btn"
            onClick={handleIconClick}
            aria-label="チャット内を検索"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="22" y2="22" />
            </svg>
          </button>
          <button
            type="button"
            className="session-search__icon-btn"
            onClick={onScrollTop}
            aria-label="一番上へ"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </>
      ) : (
        <div className="session-search__row">
          <input
            ref={inputRef}
            type="search"
            className="session-search__input"
            value={query}
            placeholder="チャット内を検索"
            onFocus={onFocus}
            onBlur={onBlur}
            onChange={(event) => {
              onQueryChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') {
                return;
              }
              event.preventDefault();
              if (event.shiftKey) {
                onPrevious();
                return;
              }
              onNext();
            }}
          />
          <div className="session-search__meta">{resultLabel}</div>
          <button
            type="button"
            className="session-search__button"
            onMouseDown={(event) => { event.preventDefault(); }}
            onClick={onPrevious}
            disabled={!hasMatches}
          >
            前へ
          </button>
          <button
            type="button"
            className="session-search__button"
            onMouseDown={(event) => { event.preventDefault(); }}
            onClick={onNext}
            disabled={!hasMatches}
          >
            次へ
          </button>
          <button
            type="button"
            className="session-search__button session-search__button--ghost"
            onMouseDown={(event) => { event.preventDefault(); }}
            onClick={onClear}
            disabled={!hasQuery}
          >
            クリア
          </button>
          <button
            type="button"
            className="session-search__icon-btn"
            onMouseDown={(event) => { event.preventDefault(); }}
            onClick={onScrollTop}
            aria-label="一番上へ"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

export function SessionDocument({
  document,
  mode,
  view,
  selectedFilePath,
}: SessionDocumentProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchTargetRefs = useRef(new Map<string, HTMLElement>());
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const showAnalysis = view === 'analysis' || view === 'both';
  const showMessages = view === 'messages' || view === 'both';
  const searchableMessages = useMemo(
    () =>
      document.sections.flatMap((section) =>
        section.messages.map((message, index) => ({
          searchId: buildMessageSearchId(section.filePath, index),
          text: buildMessageSearchText(message),
        })),
      ),
    [document.sections],
  );
  const trimmedSearchQuery = searchQuery.trim();
  const normalizedSearchQuery = trimmedSearchQuery.toLocaleLowerCase('ja-JP');
  const matchedSearchEntries = useMemo(() => {
    if (!normalizedSearchQuery) {
      return [] satisfies SearchableMessageEntry[];
    }

    return searchableMessages.filter((entry) =>
      entry.text.toLocaleLowerCase('ja-JP').includes(normalizedSearchQuery),
    );
  }, [normalizedSearchQuery, searchableMessages]);
  const searchHitIds = useMemo(
    () => new Set(matchedSearchEntries.map((entry) => entry.searchId)),
    [matchedSearchEntries],
  );
  const activeSearchEntry =
    matchedSearchEntries.length > 0
      ? matchedSearchEntries[
          Math.min(activeSearchIndex, matchedSearchEntries.length - 1)
        ]
      : null;

  function registerSearchTarget(
    searchId: string,
    node: HTMLElement | null,
  ): void {
    if (node) {
      searchTargetRefs.current.set(searchId, node);
      return;
    }

    searchTargetRefs.current.delete(searchId);
  }

  function moveSearchIndex(direction: -1 | 1): void {
    if (matchedSearchEntries.length === 0) {
      return;
    }

    setActiveSearchIndex((current) => {
      const nextIndex = current + direction;
      if (nextIndex < 0) {
        return matchedSearchEntries.length - 1;
      }
      if (nextIndex >= matchedSearchEntries.length) {
        return 0;
      }
      return nextIndex;
    });
  }

  useEffect(() => {
    if (
      mode !== 'interactive' ||
      !selectedFilePath ||
      (!showMessages && !showAnalysis) ||
      !rootRef.current
    ) {
      return;
    }

    const target = rootRef.current.querySelector<HTMLElement>(
      `[data-session-file-path="${escapeAttributeValue(selectedFilePath)}"]`,
    );
    target?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, [mode, selectedFilePath, showAnalysis, showMessages]);

  useEffect(() => {
    if (activeSearchIndex < matchedSearchEntries.length) {
      return;
    }

    setActiveSearchIndex(0);
  }, [activeSearchIndex, matchedSearchEntries.length]);

  useEffect(() => {
    if (mode !== 'interactive' || !activeSearchEntry) {
      return;
    }

    const target = searchTargetRefs.current.get(activeSearchEntry.searchId);
    target?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, [activeSearchEntry, mode]);

  const rootClassName = [
    'session-document',
    mode === 'export'
      ? 'session-document--export'
      : 'session-document--interactive',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={rootRef} className={rootClassName}>
      {document.sections.map((section) => {
        const sectionClassName = [
          'session-section',
          selectedFilePath === section.filePath
            ? 'session-section--selected'
            : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div key={section.filePath}>
            {showAnalysis && (
              <AnalysisSummary
                analysis={section.analysis}
                mode={mode}
                title={`${formatSectionKindLabel(section.kind)} Analysis`}
                subtitle={section.kind !== 'session' ? section.subtitle : undefined}
                dataFilePath={section.filePath}
                className={[
                  'session-document__analysis',
                  selectedFilePath === section.filePath
                    ? 'session-section--selected'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            )}
            {showMessages && (
              <section
                className={sectionClassName}
                data-session-file-path={section.filePath}
              >
                <div className="session-section__header">
                  <div>
                    <div className="session-kind">
                      {formatSectionKindLabel(section.kind)}
                    </div>
                    <h2 className="session-section__title">{section.title}</h2>
                    <div className="session-subtitle">{section.subtitle}</div>
                  </div>
                </div>
                <div className="session-section__body">
                  <SessionMessages
                    section={section}
                    mode={mode}
                    searchHitIds={searchHitIds}
                    activeSearchId={activeSearchEntry?.searchId ?? null}
                    registerSearchTarget={registerSearchTarget}
                  />
                </div>
              </section>
            )}
          </div>
        );
      })}

      {mode === 'interactive' && showMessages && (
        <SearchToolbar
          query={searchQuery}
          matchCount={matchedSearchEntries.length}
          activeIndex={activeSearchIndex}
          isFocused={isSearchFocused}
          onQueryChange={(value) => {
            setSearchQuery(value);
            setActiveSearchIndex(0);
          }}
          onFocus={() => setIsSearchFocused(true)}
          onBlur={() => setIsSearchFocused(false)}
          onPrevious={() => moveSearchIndex(-1)}
          onNext={() => moveSearchIndex(1)}
          onClear={() => {
            setSearchQuery('');
            setActiveSearchIndex(0);
          }}
          onScrollTop={() => {
            rootRef.current?.parentElement?.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}
    </div>
  );
}
