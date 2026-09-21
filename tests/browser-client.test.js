import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSER_TOOL_NAMES,
  validateBrowserToolArguments,
} from '../extension/browser-client.js';

test('Browser WebMCP exposes exactly the six bounded browser tools', () => {
  assert.deepEqual(BROWSER_TOOL_NAMES, ['inspect_page', 'inspect_form', 'fill', 'select', 'click', 'scroll']);
});

test('browser tool arguments never let the model choose a tab, URL, selector, XPath, or arbitrary extra field', () => {
  const forbidden = [
    ['inspect_page', { tabId: 9 }],
    ['inspect_form', { url: 'https://example.com' }],
    ['fill', { ref: 'e1', value: 'x', selector: '#name' }],
    ['select', { ref: 'e2', value: 'CH', xpath: '//select' }],
    ['click', { ref: 'e3', tabId: 9 }],
    ['scroll', { deltaY: 100, tabId: 9 }],
    ['scroll', { deltaY: 100, selector: '#feed' }],
    ['scroll', { deltaX: 100 }],
    ['scroll', { deltaY: '100' }],
    ['scroll', { deltaY: Number.NaN }],
    ['scroll', { deltaY: 100, ref: '' }],
    ['scroll', { deltaY: 100, ref: 'e'.repeat(65) }],
    ['scroll', ['deltaY']],
  ];
  for (const [name, args] of forbidden) {
    assert.equal(validateBrowserToolArguments(name, args)?.code, 'INVALID_ARGUMENTS', name);
  }

  assert.equal(validateBrowserToolArguments('inspect_page', {}), null);
  assert.equal(validateBrowserToolArguments('inspect_form', {}), null);
  assert.equal(validateBrowserToolArguments('fill', { ref: 'e1', value: 'Ada' }), null);
  assert.equal(validateBrowserToolArguments('select', { ref: 'e2', value: 'Switzerland' }), null);
  assert.equal(validateBrowserToolArguments('click', { ref: 'e3' }), null);
  assert.equal(validateBrowserToolArguments('scroll', { deltaY: 700 }), null);
  assert.equal(validateBrowserToolArguments('scroll', { deltaY: -700, deltaX: 30, ref: 'e4' }), null);
});
