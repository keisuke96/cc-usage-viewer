import type { LoadedSessionDocument } from '../lib/session-document';
import { fmtTokens, modelColor } from '../lib/analysis-format';
import { SessionDocument, type SessionDocumentMode } from './SessionDocument';
import './session-pane.css';
import sessionPaneCssText from './session-pane.css?raw';

export const SESSION_PANE_CSS_TEXT = sessionPaneCssText;
const SECTION_MENU_THRESHOLD = 5;

type SessionPaneProps = {
  document: LoadedSessionDocument;
  mode: SessionDocumentMode;
  selectedSectionIndex?: number;
  onSectionSelect?: (index: number) => void;
  onExportHtml?: () => void;
  isExportingHtml?: boolean;
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
  const activeSection = document.sections[activeIndex] ?? null;
  const visibleDocument = activeSection
    ? { ...document, sections: [activeSection] }
    : document;
  const showSectionMenu = document.sections.length > SECTION_MENU_THRESHOLD;

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

      {document.sections.length > 1 && (
        <div className="session-pane__tabs-shell">
          <div
            className="session-pane__tabs"
            role="tablist"
            aria-label="Session Sections"
          >
            {document.sections.map((section, index) => {
              const total = section.analysis.total;
              const totalTokens =
                total.latest_total_input_tokens + total.latest_output_tokens;
              const modelKeys = Object.keys(section.analysis.by_model);
              const isActive = index === activeIndex;
              const className = [
                'session-pane__tab',
                isActive ? 'session-pane__tab--active' : '',
              ]
                .filter(Boolean)
                .join(' ');

              const tabContent = (
                <>
                  <div className="session-pane__tab-headline">
                    <span className="session-pane__tab-title">
                      {section.title}
                    </span>
                  </div>
                  {(section.kind !== 'session' && section.subtitle) ||
                  modelKeys.length > 0 ||
                  totalTokens > 0 ? (
                    <div className="session-pane__tab-meta">
                      {section.kind !== 'session' && section.subtitle && (
                        <span className="session-pane__tab-subtitle">
                          {section.subtitle}
                        </span>
                      )}
                      {modelKeys.length > 0 && (
                        <span
                          className="session-pane__tab-models"
                          aria-hidden="true"
                        >
                          {modelKeys.map((model) => (
                            <span
                              key={model}
                              className="session-pane__tab-model-dot"
                              style={{ backgroundColor: modelColor(model) }}
                            />
                          ))}
                        </span>
                      )}
                      {totalTokens > 0 && (
                        <span className="session-pane__tab-tokens">
                          {fmtTokens(totalTokens)}
                        </span>
                      )}
                    </div>
                  ) : null}
                </>
              );

              if (mode === 'interactive' && onSectionSelect) {
                return (
                  <button
                    key={`${section.filePath}:${index}`}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={className}
                    onClick={() => onSectionSelect(index)}
                  >
                    {tabContent}
                  </button>
                );
              }

              return (
                <button
                  key={`${section.filePath}:${index}`}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={className}
                  data-session-pane-tab={index}
                >
                  {tabContent}
                </button>
              );
            })}
          </div>
          {showSectionMenu && (
            <details className="session-pane__menu">
              <summary className="session-pane__menu-trigger">一覧</summary>
              <div className="session-pane__menu-list">
                {document.sections.map((section, index) => {
                  const isActive = index === activeIndex;
                  const className = [
                    'session-pane__menu-item',
                    isActive ? 'session-pane__menu-item--active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');

                  if (mode === 'interactive' && onSectionSelect) {
                    return (
                      <button
                        key={`${section.filePath}:${index}`}
                        type="button"
                        className={className}
                        onClick={(event) => {
                          onSectionSelect(index);
                          const details =
                            event.currentTarget.closest('details');
                          if (details instanceof HTMLDetailsElement) {
                            details.open = false;
                          }
                        }}
                      >
                        <span className="session-pane__menu-title">
                          {section.title}
                        </span>
                        {section.subtitle && (
                          <span className="session-pane__menu-subtitle">
                            {section.subtitle}
                          </span>
                        )}
                      </button>
                    );
                  }

                  return (
                    <button
                      key={`${section.filePath}:${index}`}
                      type="button"
                      className={className}
                      data-session-pane-tab={index}
                    >
                      <span className="session-pane__menu-title">
                        {section.title}
                      </span>
                      {section.subtitle && (
                        <span className="session-pane__menu-subtitle">
                          {section.subtitle}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </details>
          )}
        </div>
      )}

      <div className="session-pane__body">
        {mode === 'export' ? (
          document.sections.map((section, index) => (
            <div
              key={`${section.filePath}:${index}`}
              className={[
                'session-pane__panel',
                index === activeIndex ? 'session-pane__panel--active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-session-pane-panel={index}
              hidden={index !== activeIndex}
            >
              <SessionDocument
                document={{ ...document, sections: [section] }}
                mode={mode}
                view="both"
              />
            </div>
          ))
        ) : activeSection ? (
          <SessionDocument
            document={visibleDocument}
            mode={mode}
            view="both"
            selectedFilePath={activeSection.filePath}
          />
        ) : (
          <div className="empty-state">document を読み込めませんでした。</div>
        )}
      </div>
    </div>
  );
}
