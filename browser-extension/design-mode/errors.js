// Records the page's own failures. This world has no extension API: it only posts to errorsBridge.js,
// which treats every record as untrusted. Failed script/link/img loads are observable here; fetch/XHR
// 404s are not (that would need patching fetch).
(() => {
  const post = (record) => { try { window.postMessage({tuicDesignError: record}, '*'); } catch { /* opaque origin */ } };
  const text = (value) => {
    try { return typeof value === 'string' ? value : value instanceof Error || typeof value !== 'object' || !value ? String(value) : JSON.stringify(value); }
    catch { return 'unprintable value'; }
  };
  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target instanceof Element) {
      const source = target.currentSrc || target.src || target.href || '';
      if (/^(SCRIPT|LINK|IMG)$/.test(target.tagName)) post({kind: 'resource', message: `Failed to load <${target.tagName.toLowerCase()}>`, source});
      return;
    }
    post({kind: 'error', message: text(event.message), source: event.filename, line: event.lineno, column: event.colno, stack: event.error?.stack});
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    post({kind: 'unhandledrejection', message: text(reason?.message ?? reason), stack: reason?.stack});
  });
  const original = console.error;
  console.error = function (...args) {
    post({kind: 'console.error', message: args.map(text).join(' '), stack: new Error().stack?.split('\n').filter((line) => !line.includes('errors.js')).join('\n')});
    return original.apply(this, args);
  };
})();
