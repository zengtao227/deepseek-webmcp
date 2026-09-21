(() => {
  'use strict';

  const INSTALL_KEY = '__webMcpBrowserTargetV1';
  if (globalThis[INSTALL_KEY]) return;
  globalThis[INSTALL_KEY] = true;

  const MAX_ELEMENTS = 80;
  const MAX_TEXT_CHARS = 6000;
  const MAX_OPTIONS = 25;
  const MAX_REFS = 500;
  // inspect_page examines at most this many candidates before choosing which 80 to return.
  const MAX_SCAN = 1500;
  const MAX_SCROLL_DELTA = 3000;
  const SCROLL_EPSILON = 1;
  const SCROLL_CANDIDATE_ATTEMPTS = 3;
  // inspect_page text: text nodes examined at most, and the window around the viewport it is taken from.
  const MAX_TEXT_SCAN = 20000;
  const TEXT_WINDOW_ABOVE = 0.5;
  const TEXT_WINDOW_BELOW = 2;
  const TEXT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const REDACTED = '[REDACTED]';
  const FORM_CONTROL_SELECTOR = [
    'input',
    'textarea',
    'select',
    'button',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="spinbutton"]',
  ].join(',');

  const PAGE_INTERACTIVE_SELECTOR = [
    FORM_CONTROL_SELECTOR,
    'a[href]',
    '[role="link"]',
    '[role="row"]',
    '[role="tab"]',
    '[role="treeitem"]',
    '[role="option"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  let nextRef = 1;
  const refToElement = new Map();
  const elementToRef = new WeakMap();
  const refIdentity = new Map();

  function cleanText(value, max = 300) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function error(code, message, details) {
    return {
      version: 1,
      ok: false,
      error: details === undefined ? { code, message } : { code, message, details },
    };
  }

  function success(result) {
    return { version: 1, ok: true, result };
  }

  function isInactive(element) {
    if (!element || element.disabled === true) return true;
    if (element.hidden === true || element.getAttribute?.('hidden') !== null) return true;
    if (element.getAttribute?.('aria-hidden') === 'true') return true;
    if (element.closest?.('[inert]')) return true;
    return false;
  }

  function isVisible(element) {
    if (!element || isInactive(element)) return false;
    const type = String(element.type ?? '').toLowerCase();
    if (type === 'hidden') return false;

    try {
      const style = getComputedStyle(element);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0') {
        return false;
      }
    } catch {
      return false;
    }

    if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false;
    return true;
  }

  function isEditable(element) {
    const tag = String(element.tagName ?? '').toLowerCase();
    const role = element.getAttribute?.('role');
    return ['input', 'textarea', 'select'].includes(tag)
      || element.getAttribute?.('contenteditable') === 'true'
      || ['textbox', 'combobox', 'spinbutton'].includes(role);
  }

  // What a ref was when it was handed out. Windowed lists reuse one DOM node for different rows; if that
  // node no longer is what was inspected, the ref must not act on the new content. Editable controls
  // are identified without their live text, which changes when they are filled.
  function identityOf(element) {
    const role = nativeRole(element);
    if (isEditable(element)) {
      const stable = cleanText(element.getAttribute?.('aria-label') ?? element.getAttribute?.('name') ?? element.getAttribute?.('placeholder') ?? '');
      return `${role}|${String(element.tagName ?? '').toLowerCase()}|${stable}`;
    }
    const href = String(element.tagName ?? '').toLowerCase() === 'a' ? cleanText(element.getAttribute?.('href'), 500) : '';
    return `${role}|${href}|${accessibleName(element)}`;
  }

  // A ref stands for an element as it was when inspected. If a reused node now shows something else it
  // gets a new ref, and the old ref stays bound to the old identity, so it keeps failing closed.
  function refFor(element) {
    const identity = identityOf(element);
    const existing = elementToRef.get(element);
    if (existing && refToElement.get(existing) === element && refIdentity.get(existing) === identity) return existing;

    const ref = `e${nextRef}`;
    nextRef += 1;
    elementToRef.set(element, ref);
    refToElement.set(ref, element);
    refIdentity.set(ref, identity);

    while (refToElement.size > MAX_REFS) {
      const oldest = refToElement.keys().next().value;
      refToElement.delete(oldest);
      refIdentity.delete(oldest);
    }
    return ref;
  }

  function lookup(ref) {
    if (typeof ref !== 'string' || !/^e\d{1,10}$/.test(ref)) {
      return { error: error('INVALID_REF', 'Element ref is invalid.') };
    }
    const element = refToElement.get(ref);
    if (!element) return { error: error('INVALID_REF', 'Element ref is unknown. Inspect the page again.') };
    if (element.isConnected === false || !isVisible(element)) {
      return { error: error('STALE_REF', 'Element ref is stale or no longer interactive. Inspect the page again.') };
    }
    if (refIdentity.get(ref) !== identityOf(element)) {
      return { error: error('STALE_REF', 'Element ref no longer matches what was inspected. Inspect the page again.') };
    }
    return { element };
  }

  function nativeRole(element) {
    const explicit = cleanText(element.getAttribute?.('role'), 40);
    if (explicit) return explicit;

    const tag = String(element.tagName ?? '').toLowerCase();
    const type = String(element.type ?? '').toLowerCase();
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'number' || type === 'range') return 'spinbutton';
      return 'textbox';
    }
    return 'control';
  }

  function labelledByText(element) {
    const ids = cleanText(element.getAttribute?.('aria-labelledby'), 500);
    if (!ids) return '';
    return cleanText(
      ids.split(/\s+/)
        .map((id) => document.getElementById?.(id)?.textContent ?? '')
        .filter(Boolean)
        .join(' '),
    );
  }

  function accessibleName(element) {
    const aria = cleanText(element.getAttribute?.('aria-label'));
    if (aria) return aria;

    const labelled = labelledByText(element);
    if (labelled) return labelled;

    if (element.labels && typeof element.labels.length === 'number') {
      const labels = Array.from(element.labels).map((label) => cleanText(label.textContent)).filter(Boolean);
      if (labels.length > 0) return cleanText(labels.join(' '));
    }

    const wrappingLabel = element.closest?.('label');
    const wrapping = cleanText(wrappingLabel?.textContent);
    if (wrapping) return wrapping;

    const placeholder = cleanText(element.getAttribute?.('placeholder'));
    if (placeholder) return placeholder;

    const text = cleanText(element.innerText ?? element.textContent);
    if (text) return text;

    const value = cleanText(element.value);
    const type = String(element.type ?? '').toLowerCase();
    if (value && ['button', 'submit', 'reset'].includes(type)) return value;

    return nativeRole(element);
  }

  function currentValue(element) {
    const tag = String(element.tagName ?? '').toLowerCase();
    const type = String(element.type ?? '').toLowerCase();
    if (type === 'password') return REDACTED;
    if (tag === 'select') return cleanText(element.value, 1000);
    if (type === 'checkbox' || type === 'radio') return element.checked === true;
    if ('value' in element) return cleanText(element.value, 2000);
    return '';
  }

  function optionsFor(element) {
    if (String(element.tagName ?? '').toLowerCase() !== 'select' || !element.options) return undefined;
    return Array.from(element.options).slice(0, MAX_OPTIONS).map((option) => ({
      value: cleanText(option.value, 300),
      label: cleanText(option.textContent ?? option.label, 300),
      selected: option.selected === true,
    }));
  }

  function describe(element) {
    const type = cleanText(element.type, 40);
    const descriptor = {
      ref: refFor(element),
      role: nativeRole(element),
      name: accessibleName(element),
      value: currentValue(element),
    };
    if (type) descriptor.type = type;
    if (typeof element.checked === 'boolean' && ['checkbox', 'radio'].includes(String(element.type ?? '').toLowerCase())) {
      descriptor.checked = element.checked;
    }
    const options = optionsFor(element);
    if (options) descriptor.options = options;
    return descriptor;
  }

  function uniqueVisible(elements) {
    const seen = new Set();
    const result = [];
    for (const element of elements) {
      if (seen.has(element) || !isVisible(element)) continue;
      seen.add(element);
      result.push(element);
      if (result.length >= MAX_ELEMENTS) break;
    }
    return result;
  }

  function viewportSize() {
    return {
      width: globalThis.innerWidth ?? document.documentElement?.clientWidth ?? 0,
      height: globalThis.innerHeight ?? document.documentElement?.clientHeight ?? 0,
    };
  }

  function inViewport(element) {
    if (typeof element.getBoundingClientRect !== 'function') return true;
    const { width, height } = viewportSize();
    try {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
    } catch {
      return false;
    }
  }

  // Elements in the current viewport come first (document order), then the rest fill the remaining
  // slots. A long page therefore shows what is on screen even when it has more than MAX_ELEMENTS
  // controls, and scrolling changes which ones are returned.
  function selectPageElements(nodes) {
    const inside = [];
    const outside = [];
    const seen = new Set();
    let scanned = 0;
    let capped = false;
    for (const element of nodes) {
      if (seen.has(element)) continue;
      seen.add(element);
      if (scanned >= MAX_SCAN) {
        capped = true;
        break;
      }
      scanned += 1;
      if (!isVisible(element)) continue;
      (inViewport(element) ? inside : outside).push(element);
      if (inside.length >= MAX_ELEMENTS) break;
    }
    const chosen = inside.concat(outside).slice(0, MAX_ELEMENTS);
    return { chosen, truncated: chosen.length >= MAX_ELEMENTS || capped };
  }

  function scrollRoot() {
    return document.scrollingElement ?? document.documentElement ?? null;
  }

  function pageViewport() {
    const root = scrollRoot();
    const { width, height } = viewportSize();
    return {
      x: Math.round(globalThis.scrollX ?? 0),
      y: Math.round(globalThis.scrollY ?? 0),
      width,
      height,
      scrollWidth: root?.scrollWidth ?? width,
      scrollHeight: root?.scrollHeight ?? height,
    };
  }

  function crossOriginFrameCount() {
    let count = 0;
    for (const frame of document.querySelectorAll?.('iframe') ?? []) {
      try {
        const childLocation = frame.contentWindow?.location;
        if (!childLocation || childLocation.origin !== location.origin) count += 1;
      } catch {
        count += 1;
      }
    }
    return count;
  }

  function textBox(element) {
    try {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      const hidden = typeof element.checkVisibility === 'function'
        ? !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : (() => {
          const style = getComputedStyle(element);
          return style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.display === 'none' || style?.opacity === '0';
        })();
      return hidden ? null : { top: rect.top, bottom: rect.bottom };
    } catch {
      return null;
    }
  }

  // Text around the viewport (half a screen above to one screen below its bottom edge), in document order.
  // If that is more than the budget, only what is actually on screen is kept. Returns null when the page
  // gives no usable geometry, so the caller can fall back to the whole-page text.
  function viewportText() {
    if (typeof document.createTreeWalker !== 'function' || !document.body) return null;
    const { height } = viewportSize();
    if (!height) return null;
    const windowTop = -height * TEXT_WINDOW_ABOVE;
    const windowBottom = height * TEXT_WINDOW_BELOW;
    const walker = document.createTreeWalker(document.body, 4);
    const boxes = new Map();
    const pieces = [];
    let scanned = 0;
    for (let node = walker.nextNode(); node && scanned < MAX_TEXT_SCAN; node = walker.nextNode()) {
      scanned += 1;
      const value = String(node.nodeValue ?? '').trim();
      const parent = node.parentElement;
      if (!value || !parent || TEXT_SKIP_TAGS.has(parent.tagName)) continue;
      if (!boxes.has(parent)) boxes.set(parent, textBox(parent));
      const box = boxes.get(parent);
      if (!box || box.bottom < windowTop || box.top > windowBottom) continue;
      pieces.push({ value, onScreen: box.bottom > 0 && box.top < height });
    }
    const joined = (list) => list.map((piece) => piece.value).join(' ');
    let chosen = pieces;
    if (cleanText(joined(chosen), MAX_TEXT_CHARS + 1).length > MAX_TEXT_CHARS) chosen = pieces.filter((piece) => piece.onScreen);
    const text = cleanText(joined(chosen), MAX_TEXT_CHARS);
    return text ? text : null;
  }

  function pageText() {
    const near = viewportText();
    if (near !== null) return { text: near, textScope: 'viewport' };
    return { text: cleanText(document.body?.innerText ?? '', MAX_TEXT_CHARS), textScope: 'page' };
  }

  function inspectPage() {
    const { chosen, truncated } = selectPageElements(document.querySelectorAll?.(PAGE_INTERACTIVE_SELECTOR) ?? []);
    const elements = chosen.map(describe);
    const crossOriginIframes = crossOriginFrameCount();
    return success({
      title: cleanText(document.title, 500),
      ...pageText(),
      elements,
      truncated,
      viewport: pageViewport(),
      ...(crossOriginIframes > 0 ? { warnings: [{ code: 'CROSS_ORIGIN_IFRAME_UNSUPPORTED', count: crossOriginIframes }] } : {}),
    });
  }

  function inspectForm() {
    const forms = uniqueVisible(document.querySelectorAll?.('form') ?? []);
    const source = forms.length > 0
      ? forms.flatMap((form) => Array.from(form.querySelectorAll?.(FORM_CONTROL_SELECTOR) ?? []))
      : Array.from(document.querySelectorAll?.(FORM_CONTROL_SELECTOR) ?? []);
    const controls = uniqueVisible(source).map(describe);
    const crossOriginIframes = crossOriginFrameCount();
    return success({
      title: cleanText(document.title, 500),
      formCount: forms.length,
      controls,
      truncated: controls.length >= MAX_ELEMENTS,
      ...(crossOriginIframes > 0 ? { warnings: [{ code: 'CROSS_ORIGIN_IFRAME_UNSUPPORTED', count: crossOriginIframes }] } : {}),
    });
  }

  function dispatchInputEvents(element, value) {
    try {
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    } catch {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  function fill(args) {
    const found = lookup(args.ref);
    if (found.error) return found.error;
    const element = found.element;
    const tag = String(element.tagName ?? '').toLowerCase();
    const type = String(element.type ?? '').toLowerCase();
    const contentEditable = element.getAttribute?.('contenteditable') === 'true'
      || element.getAttribute?.('role') === 'textbox' && element.isContentEditable === true;

    if (element.readOnly === true || element.getAttribute?.('aria-readonly') === 'true') {
      return error('READ_ONLY', 'The referenced field is read-only.');
    }

    if (contentEditable) {
      element.focus?.();

      let inserted = false;
      try {
        const selection = globalThis.getSelection?.();
        if (selection && document.createRange) {
          const range = document.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        inserted = document.execCommand?.('insertText', false, args.value) === true;
      } catch {
        inserted = false;
      }

      if (!inserted) {
        element.textContent = args.value;
      }
      dispatchInputEvents(element, args.value);
      return success({
        ref: args.ref,
        value: cleanText(element.innerText ?? element.textContent, 2000),
      });
    }

    if (!['input', 'textarea'].includes(tag) || ['hidden', 'file', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image'].includes(type)) {
      return error('UNSUPPORTED_CONTROL', 'fill supports visible text-like inputs, textareas, and editable textbox regions only.');
    }

    setNativeValue(element, args.value);
    dispatchInputEvents(element, args.value);
    return success({
      ref: args.ref,
      value: type === 'password' ? REDACTED : cleanText(element.value, 2000),
    });
  }

  function selectOption(args) {
    const found = lookup(args.ref);
    if (found.error) return found.error;
    const element = found.element;
    if (String(element.tagName ?? '').toLowerCase() !== 'select') {
      return error('UNSUPPORTED_CONTROL', 'select requires a native select/combobox control.');
    }

    const options = Array.from(element.options ?? []);
    const exact = options.find((option) => String(option.value) === args.value)
      ?? options.find((option) => cleanText(option.textContent ?? option.label, 1000) === cleanText(args.value, 1000));
    if (!exact || exact.disabled === true) {
      return error('OPTION_NOT_FOUND', 'The requested option is not available on the referenced select.');
    }

    setNativeValue(element, exact.value);
    for (const option of options) option.selected = option === exact;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return success({
      ref: args.ref,
      value: cleanText(element.value, 1000),
      label: cleanText(exact.textContent ?? exact.label, 1000),
    });
  }

  function clickRiskReason(element) {
    const tag = String(element.tagName ?? '').toLowerCase();
    const type = String(element.type ?? '').toLowerCase();
    const name = accessibleName(element).toLowerCase();

    const commitPattern = /\b(submit|send|pay|purchase|buy|checkout|place\s+order|confirm\s+booking|book\s+now|delete|remove|publish|post|save|apply|transfer|authorize|accept|sign)\b/i;
    const explicitSafePattern = /^(reply(?:\s+all)?|forward|open|view|show|details?|expand|collapse|next|previous|back|more)(?:\b|\s|:|-)/i;
    if (explicitSafePattern.test(name) && !commitPattern.test(name)) return null;

    if ((tag === 'button' && type === 'submit') || (tag === 'input' && ['submit', 'image'].includes(type))) {
      return 'form submit control';
    }

    const match = commitPattern.exec(name);
    if (match) return `commit-like action: ${match[0]}`;

    if (tag === 'a') {
      const href = cleanText(element.getAttribute?.('href'), 2000);
      const download = element.getAttribute?.('download');
      const hasUnsafeScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)
        && !/^https?:/i.test(href);
      if (href && download === null && !hasUnsafeScheme) return null;
    }

    const role = nativeRole(element);
    const reversibleRoles = new Set(['checkbox', 'radio', 'switch', 'tab', 'link', 'row', 'treeitem', 'option']);
    if (reversibleRoles.has(role)) return null;

    const safeActionPattern = /\b(reply|open|view|show|details?|expand|collapse|next|previous|back|more)\b/i;
    if (safeActionPattern.test(name)) return null;

    if (
      element.getAttribute?.('aria-expanded') !== null
      || element.getAttribute?.('aria-haspopup') !== null
      || element.getAttribute?.('aria-controls') !== null
    ) {
      return null;
    }

    return 'unclassified click action';
  }

  function click(args) {
    const found = lookup(args.ref);
    if (found.error) return found.error;
    const element = found.element;
    const reason = clickRiskReason(element);
    if (reason) {
      return error(
        'CONFIRMATION_REQUIRED',
        'This click is not proven reversible. V1 does not execute it automatically.',
        { ref: args.ref, name: accessibleName(element), reason },
      );
    }
    if (typeof element.click !== 'function') return error('UNSUPPORTED_CONTROL', 'The referenced element is not clickable.');

    element.click();
    const type = String(element.type ?? '').toLowerCase();
    const result = { ref: args.ref, name: accessibleName(element) };
    if (type === 'checkbox' || type === 'radio') result.checked = element.checked === true;
    return success(result);
  }

  function clampDelta(value) {
    return Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, Math.round(value)));
  }

  function overflowAllows(element, axis) {
    try {
      const style = getComputedStyle(element);
      const value = axis === 'y' ? style?.overflowY : style?.overflowX;
      return ['auto', 'scroll', 'overlay'].includes(value);
    } catch {
      return false;
    }
  }

  function scrollMetrics(target) {
    const element = target.element;
    const page = target.kind === 'page';
    return {
      x: page ? (globalThis.scrollX ?? element.scrollLeft ?? 0) : (element.scrollLeft ?? 0),
      y: page ? (globalThis.scrollY ?? element.scrollTop ?? 0) : (element.scrollTop ?? 0),
      maxX: Math.max(0, (element.scrollWidth ?? 0) - (element.clientWidth ?? 0)),
      maxY: Math.max(0, (element.scrollHeight ?? 0) - (element.clientHeight ?? 0)),
    };
  }

  function hasRange(target, dx, dy) {
    const m = scrollMetrics(target);
    return (dy !== 0 && m.maxY > SCROLL_EPSILON) || (dx !== 0 && m.maxX > SCROLL_EPSILON);
  }

  function hasRoom(target, dx, dy) {
    const m = scrollMetrics(target);
    return (dy > 0 && m.y < m.maxY - SCROLL_EPSILON)
      || (dy < 0 && m.y > SCROLL_EPSILON)
      || (dx > 0 && m.x < m.maxX - SCROLL_EPSILON)
      || (dx < 0 && m.x > SCROLL_EPSILON);
  }

  function containerAllowed(element, dx, dy) {
    return (dy === 0 || overflowAllows(element, 'y')) && (dx === 0 || overflowAllows(element, 'x'));
  }

  // The nearest scrollable area around a referenced element: the element itself, then its ancestors, then
  // the page. Nothing else is ever scrolled on its behalf.
  function targetForRef(element, dx, dy) {
    const root = scrollRoot();
    for (let node = element; node && node !== root && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const target = { kind: 'container', element: node };
      if (containerAllowed(node, dx, dy) && hasRange(target, dx, dy)) return target;
    }
    const page = root ? { kind: 'page', element: root } : null;
    return page && hasRange(page, dx, dy) ? page : null;
  }

  // Containers under a coarse grid of points in the viewport that can still move in the requested
  // direction, largest visible area first.
  function visibleContainers(dx, dy) {
    if (typeof document.elementsFromPoint !== 'function') return [];
    const { width, height } = viewportSize();
    const root = scrollRoot();
    const seen = new Set();
    const found = [];
    for (let row = 1; row <= 5; row += 1) {
      for (let column = 1; column <= 5; column += 1) {
        const stack = document.elementsFromPoint((width * column) / 6, (height * row) / 6) ?? [];
        for (const start of stack) {
          for (let node = start; node && node !== root && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            if (seen.has(node)) break;
            seen.add(node);
            const target = { kind: 'container', element: node };
            if (containerAllowed(node, dx, dy) && hasRange(target, dx, dy) && hasRoom(target, dx, dy)) {
              let area = 0;
              try {
                const rect = node.getBoundingClientRect();
                area = Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));
              } catch {
                area = 0;
              }
              found.push({ target, area });
            }
          }
        }
      }
    }
    return found.sort((a, b) => b.area - a.area).map((entry) => entry.target);
  }

  function attemptScroll(target, dx, dy) {
    const before = scrollMetrics(target);
    const options = { left: dx, top: dy, behavior: 'instant' };
    if (target.kind === 'page') globalThis.scrollBy?.(options);
    else target.element.scrollBy?.(options);
    const after = scrollMetrics(target);
    return Math.abs(after.x - before.x) > 0.01 || Math.abs(after.y - before.y) > 0.01;
  }

  function scrollResult(target, moved, dx, dy) {
    const m = scrollMetrics(target);
    const vertical = Math.abs(dy) >= Math.abs(dx);
    return success({
      moved,
      target: target.kind,
      axis: vertical ? 'y' : 'x',
      x: Math.round(m.x),
      y: Math.round(m.y),
      maxX: Math.round(m.maxX),
      maxY: Math.round(m.maxY),
      atStart: vertical ? m.y <= SCROLL_EPSILON : m.x <= SCROLL_EPSILON,
      atEnd: vertical ? m.y >= m.maxY - SCROLL_EPSILON : m.x >= m.maxX - SCROLL_EPSILON,
    });
  }

  function scroll(args) {
    const dx = clampDelta(args.deltaX ?? 0);
    const dy = clampDelta(args.deltaY);
    if (dx === 0 && dy === 0) return error('INVALID_ARGUMENTS', 'scroll needs a non-zero deltaX or deltaY.');

    if (args.ref !== undefined) {
      const found = lookup(args.ref);
      if (found.error) return found.error;
      const target = targetForRef(found.element, dx, dy);
      if (!target) return error('SCROLL_TARGET_NOT_FOUND', 'No scrollable area contains the referenced element.');
      return scrollResult(target, attemptScroll(target, dx, dy), dx, dy);
    }

    const root = scrollRoot();
    const page = root ? { kind: 'page', element: root } : null;
    if (page && hasRoom(page, dx, dy) && attemptScroll(page, dx, dy)) return scrollResult(page, true, dx, dy);
    for (const target of visibleContainers(dx, dy).slice(0, SCROLL_CANDIDATE_ATTEMPTS)) {
      if (attemptScroll(target, dx, dy)) return scrollResult(target, true, dx, dy);
    }
    if (!page) return error('SCROLL_TARGET_NOT_FOUND', 'This page has no scrollable area.');
    return scrollResult(page, false, dx, dy);
  }

  function exactArgs(args, keys) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const actual = Object.keys(args).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  }

  function execute(tool, args) {
    if (tool === 'inspect_page') {
      if (!exactArgs(args, [])) return error('INVALID_ARGUMENTS', 'inspect_page accepts no arguments.');
      return inspectPage();
    }
    if (tool === 'inspect_form') {
      if (!exactArgs(args, [])) return error('INVALID_ARGUMENTS', 'inspect_form accepts no arguments.');
      return inspectForm();
    }
    if (tool === 'fill') {
      if (!exactArgs(args, ['ref', 'value']) || typeof args.ref !== 'string' || typeof args.value !== 'string') {
        return error('INVALID_ARGUMENTS', 'fill requires exactly ref and value strings.');
      }
      return fill(args);
    }
    if (tool === 'select') {
      if (!exactArgs(args, ['ref', 'value']) || typeof args.ref !== 'string' || typeof args.value !== 'string') {
        return error('INVALID_ARGUMENTS', 'select requires exactly ref and value strings.');
      }
      return selectOption(args);
    }
    if (tool === 'click') {
      if (!exactArgs(args, ['ref']) || typeof args.ref !== 'string') {
        return error('INVALID_ARGUMENTS', 'click requires exactly one ref string.');
      }
      return click(args);
    }
    if (tool === 'scroll') {
      const keys = args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : null;
      const valid = keys
        && keys.every((key) => ['deltaY', 'deltaX', 'ref'].includes(key))
        && Number.isFinite(args.deltaY)
        && (args.deltaX === undefined || Number.isFinite(args.deltaX))
        && (args.ref === undefined || typeof args.ref === 'string');
      if (!valid) return error('INVALID_ARGUMENTS', 'scroll requires deltaY (number) and accepts optional deltaX (number) and ref (string).');
      return scroll(args);
    }
    return error('TOOL_NOT_ALLOWED', 'Unknown browser tool.');
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;

    if (message.type === 'webmcp.browser.ping') {
      sendResponse({ version: 1, ok: true, result: { ready: true } });
      return false;
    }

    if (message.type !== 'webmcp.browser.tool' || message.version !== 1) return false;
    sendResponse(execute(message.tool, message.arguments));
    return false;
  });
})();
