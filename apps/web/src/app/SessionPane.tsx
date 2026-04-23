import { fmtTokens, modelColor } from '../lib/analysis-format';
import type {
  LoadedSessionDocument,
  LoadedSessionDocumentSection,
} from '../lib/session-document';
import { SessionDocument, type SessionDocumentMode } from './SessionDocument';
import './session-pane.css';
import sessionPaneCssText from './session-pane.css?raw';

export const SESSION_PANE_CSS_TEXT = sessionPaneCssText;

type SessionPaneProps = {
  document: LoadedSessionDocument;
  mode: SessionDocumentMode;
  selectedSectionIndex?: number;
  onSectionSelect?: (index: number) => void;
  onExportHtml?: () => void;
  isExportingHtml?: boolean;
};

type SectionTreeNode = {
  section: LoadedSessionDocumentSection;
  index: number;
  children: SectionTreeNode[];
};

function clampSectionIndex(
  sectionsLength: number,
  selectedSectionIndex: number | undefined,
): number {
  if (sectionsLength <= 0) {
    return 0;
  }
  if (selectedSectionIndex === undefined) {
    return 0;
  }
  return Math.min(Math.max(selectedSectionIndex, 0), sectionsLength - 1);
}

function buildSectionTree(
  sections: LoadedSessionDocumentSection[],
): SectionTreeNode[] {
  const nodes: SectionTreeNode[] = sections.map((section, index) => ({
    section,
    index,
    children: [],
  }));
  const nodeByFilePath = new Map(
    nodes.map((node) => [node.section.filePath, node] as const),
  );
  const roots: SectionTreeNode[] = [];

  for (const node of nodes) {
    const parentPath = node.section.parentFilePath;
    const parent = parentPath ? nodeByFilePath.get(parentPath) : null;
    if (!parent || parent === node) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  return roots;
}

function SectionOutlineNode({
  activeIndex,
  mode,
  node,
  onSelect,
}: {
  activeIndex: number;
  mode: SessionDocumentMode;
  node: SectionTreeNode;
  onSelect?: (index: number) => void;
}) {
  const total = node.section.analysis.total;
  const totalTokens =
    total.latest_total_input_tokens + total.latest_output_tokens;
  const modelKeys = Object.keys(node.section.analysis.by_model);
  const isActive = node.index === activeIndex;
  const className = [
    'session-pane__outline-item',
    isActive ? 'session-pane__outline-item--active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="session-pane__outline-node">
      <button
        type="button"
        className={className}
        title={node.section.title}
        data-session-pane-tab={node.index}
        aria-current={isActive ? 'true' : undefined}
        onClick={
          mode === 'interactive' && onSelect
            ? () => onSelect(node.index)
            : undefined
        }
      >
        <div className="session-pane__outline-headline">
          <span className="session-pane__outline-title">
            {node.section.navTitle}
          </span>
          {node.children.length > 0 && (
            <span className="session-pane__outline-branch">
              {node.children.length}
            </span>
          )}
        </div>
        {(node.section.subtitle || modelKeys.length > 0 || totalTokens > 0) && (
          <div className="session-pane__outline-meta">
            {node.section.subtitle && (
              <span className="session-pane__outline-subtitle">
                {node.section.subtitle}
              </span>
            )}
            {modelKeys.length > 0 && (
              <span className="session-pane__outline-models" aria-hidden="true">
                {modelKeys.map((model) => (
                  <span
                    key={model}
                    className="session-pane__outline-model-dot"
                    style={{ backgroundColor: modelColor(model) }}
                  />
                ))}
              </span>
            )}
            {totalTokens > 0 && (
              <span className="session-pane__outline-tokens">
                {fmtTokens(totalTokens)}
              </span>
            )}
          </div>
        )}
      </button>
      {node.children.length > 0 && (
        <div className="session-pane__outline-children">
          {node.children.map((child) => (
            <SectionOutlineNode
              key={`${child.section.filePath}:${child.index}`}
              activeIndex={activeIndex}
              mode={mode}
              node={child}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SessionPane({
  document,
  mode,
  selectedSectionIndex,
  onSectionSelect,
  onExportHtml,
  isExportingHtml = false,
}: SessionPaneProps) {
  const activeIndex = clampSectionIndex(
    document.sections.length,
    selectedSectionIndex,
  );
  const showOutline = document.sections.length > 1;
  const sectionTree = buildSectionTree(document.sections);

  return (
    <div
      data-session-pane-root={mode === 'export' ? 'true' : undefined}
      className={[
        'session-pane',
        mode === 'export'
          ? 'session-pane--export'
          : 'session-pane--interactive',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="session-pane__header">
        <div className="session-pane__header-main">
          <h1 className="session-pane__title">{document.title}</h1>
        </div>
        {mode === 'interactive' && onExportHtml && (
          <button
            type="button"
            className="session-pane__action"
            onClick={onExportHtml}
            disabled={isExportingHtml}
          >
            {isExportingHtml ? 'Exporting…' : 'HTML Export'}
          </button>
        )}
      </div>

      <div className="session-pane__content">
        {showOutline && (
          <nav className="session-pane__outline" aria-label="Session Sections">
            <div className="session-pane__outline-tree">
              {sectionTree.map((node) => (
                <SectionOutlineNode
                  key={`${node.section.filePath}:${node.index}`}
                  activeIndex={activeIndex}
                  mode={mode}
                  node={node}
                  onSelect={onSectionSelect}
                />
              ))}
            </div>
          </nav>
        )}

        <div className="session-pane__body">
          {document.sections.length > 0 ? (
            document.sections.map((section, index) => {
              const isActive = index === activeIndex;

              return (
                <div
                  key={section.filePath}
                  className={[
                    'session-pane__panel',
                    isActive ? 'session-pane__panel--active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-session-pane-panel={index}
                  hidden={!isActive}
                >
                  <SessionDocument
                    document={{ ...document, sections: [section] }}
                    mode={mode}
                    view="both"
                    selectedFilePath={isActive ? section.filePath : null}
                  />
                </div>
              );
            })
          ) : (
            <div className="empty-state">document を読み込めませんでした。</div>
          )}
        </div>
      </div>
    </div>
  );
}
