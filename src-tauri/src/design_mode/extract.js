function tuicExtract() {
  const el = this;
  const doc = el.ownerDocument;
  const escape = (value) => globalThis.CSS?.escape?.(value) ?? value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  const stableClass = (value) => !/^(?:css-|sc-|_)[a-zA-Z0-9_-]*[a-fA-F0-9]{6,}$/.test(value) && !/^[a-fA-F0-9]{8,}$/.test(value);
  const tag = (node) => node.tagName.toLowerCase();
  // An element in a shadow tree is only reachable from its own root, so every
  // uniqueness check runs against that root, and paths cross to the host.
  const scope = (node) => node.getRootNode?.() ?? doc;
  const hostOf = (root) => (root.nodeType === 11 && root.host) || null;
  const unique = (root, selector) => {
    try { return root.querySelectorAll(selector).length === 1; }
    catch { return false; }
  };
  const nth = (node) => {
    let index = 1;
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.tagName === node.tagName) index += 1;
    }
    return `${tag(node)}:nth-of-type(${index})`;
  };
  // Each fragment costs document-wide queries; the selector and both paths
  // share ancestors, so compute each one once.
  const fragments = new Map();
  const fragment = (node) => {
    if (fragments.has(node)) return fragments.get(node);
    const root = scope(node);
    let result = nth(node);
    if (node.id && unique(root, `#${escape(node.id)}`)) result = `#${escape(node.id)}`;
    else {
      for (const name of node.classList) {
        if (stableClass(name) && unique(root, `${tag(node)}.${escape(name)}`)) {
          result = `${tag(node)}.${escape(name)}`;
          break;
        }
      }
    }
    fragments.set(node, result);
    return result;
  };
  const selectorFor = (node) => {
    const root = scope(node);
    let selector = fragment(node);
    for (let parent = node.parentElement; parent && !unique(root, selector); parent = parent.parentElement) {
      selector = `${fragment(parent)} > ${selector}`;
    }
    const host = hostOf(root);
    return host ? `${selectorFor(host)} >>> ${selector}` : selector;
  };
  // Ancestors from the root down; `>>>` marks where the chain enters a shadow tree.
  const chain = [];
  for (let node = el; node && node.nodeType === 1;) {
    const host = node.parentElement ? null : hostOf(node.parentNode);
    chain.unshift({ node, join: host ? " >>> " : " > " });
    node = node.parentElement ?? host;
  }
  const selector = selectorFor(el);
  const path = (max) => chain.slice(-max).map(({ node, join }, index) => (index ? join : "") + fragment(node)).join("");
  const allowed = (name) => /^(?:id|class|href|src|alt|title|role|name|type|placeholder|aria-.*)$/.test(name);
  const attributes = Object.fromEntries(Array.from(el.attributes, (attr) => [attr.name, attr.value]).filter(([name]) => allowed(name)).slice(0, 32));
  const fiberKey = Object.keys(el).find((key) => key.startsWith("__reactFiber$"));
  const fiber = fiberKey ? el[fiberKey] : undefined;
  const source = {};
  const computed = doc.defaultView?.getComputedStyle(el);
  const styleNames = ["color", "backgroundColor", "fontFamily", "fontSize", "fontWeight", "display", "position", "margin", "padding", "border", "width", "height"];
  const styles = Object.fromEntries(styleNames.map((name) => [name, computed?.[name] ?? ""]));
  // Design tokens: the custom properties this element's own rules reference,
  // resolved on the element. A theme declares hundreds; only these matter here.
  const tokens = {};
  const referenced = (style) => {
    const values = Array.from({ length: style.length }, (_, index) => style.getPropertyValue(style[index]));
    // CSSOM exposes shorthand var() declarations as empty longhands. The
    // serialized declaration retains their references; scan it only once.
    if (values.some((value) => !value)) values.push(style.cssText);
    for (const value of values) {
      for (const [, name] of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (Object.keys(tokens).length >= 32) return;
        const resolved = computed?.getPropertyValue(name).trim() ?? "";
        if (resolved && !(name in tokens)) tokens[name] = resolved.slice(0, 128);
      }
    }
  };
  const visit = (rules) => {
    for (const rule of rules) {
      // One rule that cannot be read or tested (a pseudo-element selector, an
      // inaccessible nested sheet) must not hide the rules after it.
      try {
        if (rule.cssRules) visit(rule.cssRules);
        if (rule.style && rule.selectorText && el.matches(rule.selectorText)) referenced(rule.style);
      } catch { /* skip this rule only */ }
    }
  };
  // Component-scoped styles live in each enclosing shadow root, and constructed
  // sheets in adoptedStyleSheets; document.styleSheets holds neither.
  const sheets = [];
  for (let root = scope(el); root; root = root.host ? scope(root.host) : null) {
    sheets.push(...(root.styleSheets ?? []), ...(root.adoptedStyleSheets ?? []));
    if (!root.host) break;
  }
  for (const sheet of sheets) {
    try { visit(sheet.cssRules); }
    catch { /* cross-origin sheet */ }
  }
  if (el.style) referenced(el.style);
  const box = el.getBoundingClientRect();
  if (fiber?._debugStack?.stack) source.reactStack = fiber._debugStack.stack;
  if (fiber?._debugSource) source.reactSource = fiber._debugSource;
  if (el.__vueParentComponent?.type?.__file) source.vueFile = el.__vueParentComponent.type.__file;
  if (el.__svelte_meta?.loc) source.svelteLoc = el.__svelte_meta.loc;
  return {
    url: doc.location.href,
    tagName: tag(el),
    selector,
    elementPath: path(6),
    fullPath: path(20),
    nearbyText: (el.parentElement?.textContent ?? el.textContent ?? "").trim().slice(0, 500),
    attributes,
    htmlSnippet: el.outerHTML.slice(0, 2048),
    textContent: (el.textContent ?? "").slice(0, 2048),
    styles,
    tokens,
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    source,
  };
}
