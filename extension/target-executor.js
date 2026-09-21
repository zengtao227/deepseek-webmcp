(() => {
  'use strict';

  const INSTALL_KEY = '__webMcpBrowserTargetV1';
  if (globalThis[INSTALL_KEY]) return;
  globalThis[INSTALL_KEY] = true;

  const MAX_ELEMENTS = 80;
  const MAX_TEXT_CHARS = 6000;
  const MAX_OPTIONS = 25;
  const MAX_REFS = 500;
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

  function refFor(element) {
    const existing = elementToRef.get(element);
    if (existing && refToElement.get(existing) === element) return existing;

    const ref = `e${nextRef}`;
    nextRef += 1;
    elementToRef.set(element, ref);
    refToElement.set(ref, element);

    while (refToElement.size > MAX_REFS) {
      refToElement.delete(refToElement.keys().next().value);
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

  function visiblePageText() {
    const raw = document.body?.innerText ?? '';
    return cleanText(raw, MAX_TEXT_CHARS);
  }

  function inspectPage() {
    const elements = uniqueVisible(document.querySelectorAll?.(PAGE_INTERACTIVE_SELECTOR) ?? []).map(describe);
    const crossOriginIframes = crossOriginFrameCount();
    return success({
      title: cleanText(document.title, 500),
      text: visiblePageText(),
      elements,
      truncated: elements.length >= MAX_ELEMENTS,
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
