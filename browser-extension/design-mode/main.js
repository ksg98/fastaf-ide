// Untrusted framework hints only; this world has no extension API or host channel.
window.addEventListener('message', (event) => {
  if (event.source !== window || typeof event.data?.tuicDesignHint !== 'string') return;
  const selector = event.data.selector;
  if (typeof selector !== 'string' || selector.length > 1024) return;
  let element;
  try { element = document.querySelector(selector); } catch { return; }
  if (!element) return;
  const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
  const fiber = fiberKey ? element[fiberKey] : undefined;
  const source = {};
  if (fiber?._debugStack?.stack) source.reactStack = String(fiber._debugStack.stack).slice(0, 4096);
  if (fiber?._debugSource) source.reactSource = fiber._debugSource;
  if (element.__vueParentComponent?.type?.__file) source.vueFile = element.__vueParentComponent.type.__file;
  if (element.__svelte_meta?.loc) source.svelteLoc = element.__svelte_meta.loc;
  window.postMessage({tuicDesignHintReply: event.data.tuicDesignHint, source}, location.origin);
});
