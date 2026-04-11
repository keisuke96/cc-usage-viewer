import { renderToStaticMarkup } from 'react-dom/server';

import type { LoadedSessionDocument } from './session-document';
import {
  SessionDocument,
  SESSION_DOCUMENT_CSS_TEXT,
} from '../app/SessionDocument';

type DownloadSessionExportArgs = {
  projectName: string;
  document: LoadedSessionDocument;
};

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const EXPORT_TAB_CSS = `
.export-tab-bar {
  display: flex;
  border-bottom: 1px solid rgba(255,255,255,0.12);
  margin-bottom: 0;
  overflow-x: auto;
}
.export-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: rgba(255,255,255,0.6);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.15s, border-color 0.15s;
  margin-bottom: -1px;
}
.export-tab-btn:hover {
  color: rgba(255,255,255,0.88);
}
.export-tab-btn.active {
  color: #90caf9;
  border-bottom-color: #90caf9;
}
.export-tab-btn__kind {
  font-size: 10px;
  opacity: 0.6;
}
.export-tab-panel { display: none; }
.export-tab-panel.active { display: block; }
.export-tab-panel .session-document--export {
  padding-top: 24px;
  padding-left: 0;
  padding-right: 0;
  max-width: none;
  margin: 0;
}
`;

const EXPORT_TAB_JS = `
(function(){
  var btns=document.querySelectorAll('.export-tab-btn');
  var panels=document.querySelectorAll('.export-tab-panel');
  btns.forEach(function(btn,i){
    btn.addEventListener('click',function(){
      btns.forEach(function(b){b.classList.remove('active');});
      panels.forEach(function(p){p.classList.remove('active');});
      btn.classList.add('active');
      panels[i].classList.add('active');
    });
  });
})();
`;

function sectionKindLabel(kind: string): string {
  if (kind === 'subagent') return 'Subagent';
  if (kind === 'team') return 'Team';
  return '';
}

function ExportHtmlPage({
  projectName,
  document,
}: DownloadSessionExportArgs) {
  const hasTabs = document.sections.length > 1;
  const totalMessages = document.sections.reduce((n, s) => n + s.messages.length, 0);

  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{document.title}</title>
        <style>{SESSION_DOCUMENT_CSS_TEXT}</style>
        {hasTabs && <style>{EXPORT_TAB_CSS}</style>}
      </head>
      <body className="session-export-body">
        <div className="session-document session-document--export">
          <header className="session-document__header">
            <h1>{document.title}</h1>
            <div className="session-document__meta">
              {projectName && <span>{projectName}</span>}
              <span>{document.sections.length} sections</span>
              <span>{totalMessages} messages</span>
              <span>exported {new Date().toISOString()}</span>
            </div>
          </header>

          {hasTabs && (
            <div className="export-tab-bar">
              {document.sections.map((section, index) => (
                <button
                  key={section.filePath}
                  type="button"
                  className={`export-tab-btn${index === 0 ? ' active' : ''}`}
                >
                  {sectionKindLabel(section.kind) && (
                    <span className="export-tab-btn__kind">
                      {sectionKindLabel(section.kind)}
                    </span>
                  )}
                  {section.title}
                </button>
              ))}
            </div>
          )}

          {hasTabs ? (
            document.sections.map((section, index) => (
              <div
                key={section.filePath}
                className={`export-tab-panel${index === 0 ? ' active' : ''}`}
              >
                <SessionDocument
                  document={{ ...document, sections: [section] }}
                  mode="export"
                  view="both"
                />
              </div>
            ))
          ) : (
            <SessionDocument
              document={document}
              mode="export"
              view="both"
              projectName={projectName}
            />
          )}
        </div>
        {hasTabs && (
          <script dangerouslySetInnerHTML={{ __html: EXPORT_TAB_JS }} />
        )}
      </body>
    </html>
  );
}

export async function downloadSessionExportHtmlClient({
  projectName,
  document,
}: DownloadSessionExportArgs): Promise<void> {
  const html = `<!doctype html>${renderToStaticMarkup(
    <ExportHtmlPage projectName={projectName} document={document} />,
  )}`;

  downloadTextFile(document.filename, html, 'text/html;charset=utf-8');
}
