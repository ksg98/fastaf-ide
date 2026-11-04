// Only extension messages can arm this isolated-world picker. Page hints are untrusted.
(() => {
  let armed = false;
  let multi = false;
  let overlay;
  let box;
  let timer;
  let selected;
  let nonce;
  const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});
  function stop() {
    armed = false;
    clearTimeout(timer);
    overlay?.remove();
    overlay = undefined;
    selected = undefined;
  }
  function arm(keepPicking) {
    stop();
    armed = true;
    multi = keepPicking;
    overlay = document.createElement('div');
    const shadow = overlay.attachShadow({mode: 'closed'});
    const style = document.createElement('style');
    style.textContent = ':host{position:fixed;inset:0;z-index:2147483647;pointer-events:none} .box{position:fixed;border:2px solid #59a8dd;background:#59a8dd22;box-sizing:border-box} .label{position:fixed;top:8px;right:8px;background:#252526;color:#ccc;padding:8px;font:12px monospace}';
    box = document.createElement('div'); box.className = 'box';
    const label = document.createElement('div'); label.className = 'label';
    label.textContent = multi ? 'Pick elements · Escape to stop' : 'Pick one element · Escape to cancel';
    shadow.append(style, box, label);
    document.documentElement.append(overlay);
    timer = setTimeout(stop, 120000);
  }
  // A press on the icon inside a disabled control targets the icon; the control is what is picked.
  const DISABLED = 'button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled="true"]';
  const elementAt = (event) => {
    const target = event.composedPath().find((node) => node instanceof Element && node !== overlay);
    return target?.closest(DISABLED) ?? target;
  };
  window.addEventListener('pointermove', (event) => {
    if (!armed) return;
    const target = elementAt(event);
    if (!target) return;
    const r = target.getBoundingClientRect();
    Object.assign(box.style, {left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px`});
  }, true);
  window.addEventListener('keydown', (event) => {
    if (armed && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); stop(); send({kind: 'cancel'});
    }
  }, true);
  // Pick on the press: Chromium sends a disabled control pointerdown/pointerup but never
  // mousedown, mouseup or click. The picking press is consumed whole so the page never reacts.
  let consuming = false;
  const consume = (event) => {
    if (!event.isTrusted || !(armed || consuming)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    // mouseup and click follow pointerup in the same task.
    if (event.type === 'pointerup') setTimeout(() => { consuming = false; });
  };
  for (const type of ['mousedown', 'pointerup', 'mouseup', 'click']) window.addEventListener(type, consume, true);
  window.addEventListener('pointerdown', (event) => {
    if (!armed || !event.isTrusted) return;
    const target = elementAt(event);
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation();
    consuming = true;
    const raw = tuicExtract.call(target);
    nonce = crypto.randomUUID(); selected = {raw, nonce};
    window.postMessage({tuicDesignHint: nonce, selector: raw.selector}, location.origin);
    // Hints may be absent (closed shadow tree, CSP, framework). DOM evidence survives.
    const pick = selected;
    setTimeout(() => {
      send({kind: 'pick', raw: pick.raw, documentUrl: location.href, viewport: {width: innerWidth, height: innerHeight}});
      if (selected === pick) selected = undefined;
    }, 30);
    if (!multi) { const pending = selected; stop(); selected = pending; }
  }, true);
  window.addEventListener('message', (event) => {
    if (event.source !== window || !selected || event.data?.tuicDesignHintReply !== selected.nonce) return;
    // MAIN has no privileged operations: all values are sanitised again in Rust.
    const hints = event.data.source;
    if (hints && typeof hints === 'object' && JSON.stringify(hints).length < 8192) selected.raw.source = hints;
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message.kind === 'arm') arm(message.multi === true);
    if (message.kind === 'stop') stop();
  });
  window.addEventListener('pagehide', stop);
})();
