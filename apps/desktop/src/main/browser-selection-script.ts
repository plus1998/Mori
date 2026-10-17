/** Runs in the selected node's own document, without exposing an Electron bridge to websites. */
export const BROWSER_SELECTION_FUNCTION = String.raw`function(kind) {
  const selection = window.getSelection();
  const range = kind === 'text' && selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
  if (kind === 'text' && !range) return null;
  const anchor = range ? range.commonAncestorContainer : this;
  const element = anchor.nodeType === 1 ? anchor : anchor.parentElement;
  if (!element || !element.isConnected) throw new Error('选中的元素已不存在。');
  if (element.closest('input[type="password"]')) throw new Error('密码输入框不能作为网页内容引用。');
  const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
  const rootSelector = node => {
    const root = node.getRootNode();
    if (node.id && root.querySelectorAll('#' + CSS.escape(node.id)).length === 1) return '#' + CSS.escape(node.id);
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1) {
      let part = CSS.escape(current.localName);
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(child => child.localName === current.localName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  };
  const selectorPath = [];
  let node = element;
  while (node) {
    selectorPath.unshift(rootSelector(node));
    const root = node.getRootNode();
    if (root.nodeType === 11 && root.mode !== 'open') throw new Error('暂不支持引用封闭 Shadow DOM 中的元素。');
    node = root.host || null;
  }
  const elementText = normalize(element.innerText || element.textContent);
  const name = normalize(element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title'));
  const text = range ? normalize(range.toString()) : elementText;
  const rect = range ? range.getBoundingClientRect() : element.getBoundingClientRect();
  return {
    kind, frameUrl: location.href, documentToken: String(performance.timeOrigin), selectorPath,
    tag: element.localName, role: element.getAttribute('role') || '', name: name.slice(0, 500),
    text: text.slice(0, 8000), context: normalize(element.parentElement && element.parentElement.innerText).slice(0, 2000),
    textTruncated: text.length > 8000,
    fingerprint: JSON.stringify([element.localName, name.slice(0, 500), elementText.slice(0, 8000), element.getAttribute('role') || '', element.getAttribute('href') || '', element.getAttribute('src') || '']),
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  };
}`;

/** Returns a node only when the captured document and its content still match exactly. */
export const BROWSER_SELECTION_LOCATE_FUNCTION = String.raw`function(reference, reveal) {
  if (String(performance.timeOrigin) !== reference.documentToken || location.href !== reference.frameUrl) return null;
  let root = document;
  let element;
  for (let index = 0; index < reference.selectorPath.length; index++) {
    const matches = root.querySelectorAll(reference.selectorPath[index]);
    if (matches.length !== 1) throw new Error('引用的元素已删除或定位不唯一，请重新选择。');
    element = matches[0];
    if (index < reference.selectorPath.length - 1) {
      root = element.shadowRoot;
      if (!root) throw new Error('引用的 Shadow DOM 已变化，请重新选择。');
    }
  }
  if (!element || !element.isConnected) throw new Error('引用的元素已删除，请重新选择。');
  const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
  const name = normalize(element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title'));
  const fingerprint = JSON.stringify([element.localName, name.slice(0, 500), normalize(element.innerText || element.textContent).slice(0, 8000), element.getAttribute('role') || '', element.getAttribute('href') || '', element.getAttribute('src') || '']);
  if (fingerprint !== reference.fingerprint) throw new Error('引用的元素内容已变化，请重新选择。');
  if (reveal) {
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    element.animate([{ outline: '3px solid #6c8cff', outlineOffset: '3px' }, { outline: '3px solid transparent', outlineOffset: '3px' }], { duration: 1800 });
  }
  return { tag: element.localName, text: reference.text, selectorPath: reference.selectorPath };
}`;
