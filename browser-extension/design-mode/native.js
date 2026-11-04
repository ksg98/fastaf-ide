const pending = new Map();
let port;
let lastError = 'Native host not connected. Open Design Mode from TUICommander first.';
export function connectNative(onStatus) {
  if (port) return;
  try {
    port = chrome.runtime.connectNative('com.tuic.design_mode');
    port.onMessage.addListener((message) => {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(message.error ?? 'TUICommander rejected the request.'));
    });
    port.onDisconnect.addListener(() => {
      lastError = chrome.runtime.lastError?.message ?? 'TUICommander disconnected.';
      port = undefined;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(lastError)); }
      pending.clear(); onStatus(lastError);
    });
  } catch (error) { lastError = String(error); onStatus(lastError); }
}
export function nativeRequest(message) {
  if(new TextEncoder().encode(JSON.stringify(message)).length>1024*1024-256) return Promise.reject(new Error('Feedback exceeds the native-message limit. Send fewer picks.'));
  if (!port) return Promise.reject(new Error(lastError));
  if (pending.size >= 32) return Promise.reject(new Error('Too many pending requests.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('TUICommander did not respond. Retry after checking its connection.')); }, 15000);
    pending.set(id, {resolve, reject, timer});
    try { port.postMessage({id, ...message}); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}
