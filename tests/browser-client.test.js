import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSER_TOOL_NAMES,
  validateBrowserToolArguments,
} from '../extension/browser-client.js';

test('Browser WebMCP V1 exposes exactly the five bounded browser tools', () => {
  assert.deepEqual(BROWSER_TOOL_NAMES, ['inspect_page', 'inspect_form', 'fill', 'select', 'click']);
});

test('browser tool arguments never let the model choose a tab, URL, selector, XPath, or arbitrary extra field', () => {
  const forbidden = [
    ['inspect_page', { tabId: 9 }],
    ['inspect_form', { url: 'https://example.com' }],
    ['fill', { ref: 'e1', value: 'x', selector: '#name' }],
    ['select', { ref: 'e2', value: 'CH', xpath: '//select' }],
    ['click', { ref: 'e3', tabId: 9 }],
  ];
  for (const [name, args] of forbidden) {
    assert.equal(validateBrowserToolArguments(name, args)?.code, 'INVALID_ARGUMENTS', name);
  }

  assert.equal(validateBrowserToolArguments('inspect_page', {}), null);
  assert.equal(validateBrowserToolArguments('inspect_form', {}), null);
  assert.equal(validateBrowserToolArguments('fill', { ref: 'e1', value: 'Ada' }), null);
  assert.equal(validateBrowserToolArguments('select', { ref: 'e2', value: 'Switzerland' }), null);
  assert.equal(validateBrowserToolArguments('click', { ref: 'e3' }), null);
});
