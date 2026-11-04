// Forwards MAIN-world error records to the worker. The page can post anything, so this only
// clamps field lengths; the worker re-validates every field and owns dedup and the 50-error cap.
(() => {
  const cut = (value, max) => typeof value === 'string' ? value.slice(0, max) : undefined;
  window.addEventListener('message', (event) => {
    const record = event.source === window ? event.data?.tuicDesignError : undefined;
    if (!record || typeof record !== 'object') return;
    const error = {kind: cut(record.kind, 32), message: cut(record.message, 1024), source: cut(record.source, 512), line: record.line, column: record.column, stack: cut(record.stack, 2048)};
    chrome.runtime.sendMessage({kind: 'page_error', error}).catch(() => {});
  });
})();
