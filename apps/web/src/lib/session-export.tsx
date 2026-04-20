import { renderToStaticMarkup } from 'react-dom/server';

import { SESSION_DOCUMENT_CSS_TEXT } from '../app/SessionDocument';
import { SessionPane, SESSION_PANE_CSS_TEXT } from '../app/SessionPane';
import type { LoadedSessionDocument } from './session-document';

type DownloadSessionExportArgs = {
  document: LoadedSessionDocument;
  selectedSectionIndex?: number;
};

const SESSION_PANE_EXPORT_JS = `
(function(){
  var roots = document.querySelectorAll('[data-session-pane-root="true"]');
  roots.forEach(function(root){
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[data-session-pane-tab]'));
    var panels = Array.prototype.slice.call(root.querySelectorAll('[data-session-pane-panel]'));
    if (!tabs.length || !panels.length) return;

    function activate(index){
      tabs.forEach(function(tab){
        var tabIndex = Number(tab.getAttribute('data-session-pane-tab'));
        var active = tabIndex === index;
        tab.classList.toggle('session-pane__tab--active', active);
        tab.classList.toggle('session-pane__menu-item--active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      panels.forEach(function(panel){
        var panelIndex = Number(panel.getAttribute('data-session-pane-panel'));
        var active = panelIndex === index;
        panel.hidden = !active;
        panel.classList.toggle('session-pane__panel--active', active);
      });
    }

    tabs.forEach(function(tab){
      tab.addEventListener('click', function(){
        var index = Number(tab.getAttribute('data-session-pane-tab'));
        if (!Number.isNaN(index)) activate(index);
        var details = tab.closest('details');
        if (details) details.removeAttribute('open');
      });
    });
  });
})();
`;

function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string,
): void {
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

function ExportHtmlPage({
  document,
  selectedSectionIndex,
}: DownloadSessionExportArgs) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{document.title}</title>
        <style>{SESSION_DOCUMENT_CSS_TEXT}</style>
        <style>{SESSION_PANE_CSS_TEXT}</style>
      </head>
      <body className="session-export-body">
        <SessionPane
          document={document}
          mode="export"
          selectedSectionIndex={selectedSectionIndex}
        />
        <script dangerouslySetInnerHTML={{ __html: SESSION_PANE_EXPORT_JS }} />
      </body>
    </html>
  );
}

export async function downloadSessionExportHtmlClient({
  document,
  selectedSectionIndex,
}: DownloadSessionExportArgs): Promise<void> {
  const html = `<!doctype html>${renderToStaticMarkup(
    <ExportHtmlPage
      document={document}
      selectedSectionIndex={selectedSectionIndex}
    />,
  )}`;

  downloadTextFile(document.filename, html, 'text/html;charset=utf-8');
}
