import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blocksToPlainText, normalizeBlocks, safeHref } from '../extension/answer-blocks.js';
import { renderBlocks } from '../extension/answer-render.js';

const run = (text, extra = {}) => ({ text, ...extra });
const paragraph = (...runs) => ({ type: 'paragraph', runs });

test('links are limited to http, https and mailto; anything else keeps its text but loses the link', () => {
  assert.equal(safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHref('mailto:a@example.com'), 'mailto:a@example.com');
  for (const hostile of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '/relative', '//host/x', '', 42, null]) {
    assert.equal(safeHref(hostile), null, String(hostile));
  }

  const [block] = normalizeBlocks([paragraph(run('click me', { href: 'javascript:alert(1)' }), run('safe', { href: 'https://example.com/' }))]);
  assert.deepEqual(block.runs, [{ text: 'click me' }, { text: 'safe', href: 'https://example.com/' }]);
});

test('unknown block types, non-object entries and non-string text are dropped, not passed through', () => {
  const blocks = normalizeBlocks([
    { type: 'script', src: 'x' },
    null,
    'text',
    paragraph({ text: 5 }, run('kept'), { text: '' }),
    { type: 'heading', level: 99, runs: [run('h')] },
  ]);
  assert.deepEqual(blocks, [paragraph(run('kept')), { type: 'heading', level: 6, runs: [run('h')] }]);
});

test('a structure beyond the limits falls back to no blocks so the panel shows the plain answer', () => {
  const nested = (depth) => (depth === 0 ? paragraph(run('x')) : { type: 'quote', blocks: [nested(depth - 1)] });
  assert.equal(normalizeBlocks([nested(2)]).length, 1);
  assert.deepEqual(normalizeBlocks([nested(3)]), [], 'nesting deeper than three levels');

  const rows = Array.from({ length: 101 }, () => [[run('c')]]);
  assert.deepEqual(normalizeBlocks([{ type: 'table', head: null, rows }]), [], 'too many table rows');
  assert.deepEqual(normalizeBlocks([{ type: 'table', head: null, rows: [Array.from({ length: 21 }, () => [run('c')])] }]), [], 'too many columns');
  assert.deepEqual(normalizeBlocks([paragraph(run('a'.repeat(64 * 1024 + 1)))]), [], 'too much text');
  assert.deepEqual(normalizeBlocks(Array.from({ length: 301 }, () => ({ type: 'rule' }))), [], 'too many blocks');
  assert.deepEqual(normalizeBlocks('not an array'), []);
  assert.deepEqual(normalizeBlocks(undefined), []);
});

test('code language is kept only when it is a plain identifier', () => {
  const [safe, hostile] = normalizeBlocks([
    { type: 'code', lang: 'python', text: 'print(1)' },
    { type: 'code', lang: '"><img src=x>', text: 'x' },
  ]);
  assert.equal(safe.lang, 'python');
  assert.equal(hostile.lang, '');
});

const sample = [
  { type: 'heading', level: 2, runs: [run('Plan')] },
  paragraph(run('Use '), run('bold', { bold: true }), run(' and '), run('code', { code: true }), run('.')),
  { type: 'list', ordered: false, items: [
    { runs: [run('one')], blocks: [{ type: 'list', ordered: true, start: 3, items: [{ runs: [run('nested')], blocks: [] }] }] },
    { runs: [run('two')], blocks: [] },
  ] },
  { type: 'quote', blocks: [paragraph(run('quoted'))] },
  { type: 'code', lang: 'js', text: 'a();\nb();\n' },
  { type: 'table', head: [[run('Name')], [run('Qty')]], rows: [[[run('pen')], [run('3')]]] },
  { type: 'rule' },
];

test('plain-text copy of an answer keeps its reading order and structure without markup noise', () => {
  const blocks = normalizeBlocks(sample);
  assert.equal(blocksToPlainText(blocks), [
    'Plan',
    '',
    'Use bold and code.',
    '',
    '- one',
    '  3. nested',
    '- two',
    '',
    '> quoted',
    '',
    'a();',
    'b();',
    '',
    'Name | Qty',
    'pen | 3',
    '',
    '---',
  ].join('\n'));
  assert.equal(blocksToPlainText([]), '');
});

// Just enough DOM to see what the renderer builds.
function fakeDocument() {
  const make = (tag) => {
    const node = {
      tag,
      children: [],
      attrs: {},
      dataset: {},
      _text: '',
      append(...items) { this.children.push(...items); },
      set textContent(value) { this._text = value; },
      get textContent() { return this._text + this.children.map((child) => child.textContent ?? '').join(''); },
    };
    return node;
  };
  return {
    createElement: make,
    createTextNode: (text) => ({ tag: '#text', children: [], textContent: text }),
    createDocumentFragment: () => make('#fragment'),
  };
}

const flatten = (node, out = []) => {
  out.push(node.tag);
  for (const child of node.children) flatten(child, out);
  return out;
};
const find = (node, tag) => flatten(node).includes(tag);

test('the panel rebuilds structure with plain elements and never through HTML parsing', async () => {
  const doc = fakeDocument();
  const root = renderBlocks(doc, doc.createElement('div'), normalizeBlocks(sample));
  const tags = flatten(root);
  for (const expected of ['h2', 'p', 'strong', 'code', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'th', 'tbody', 'td', 'hr']) {
    assert.ok(tags.includes(expected), `missing <${expected}>`);
  }
  assert.equal(root.textContent.includes('<'), false);

  for (const file of ['answer-render.js', 'answer-blocks.js', 'sidepanel.js']) {
    const source = await readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|document\.write/, file);
  }
});

test('markup-looking answer text is shown as text and a hostile link never becomes an anchor', () => {
  const doc = fakeDocument();
  const root = renderBlocks(doc, doc.createElement('div'), [
    paragraph(run('<img src=x onerror=alert(1)>', { bold: true }), run('bad', { href: 'javascript:alert(1)' })),
  ]);
  assert.equal(find(root, 'img'), false);
  assert.equal(find(root, 'a'), false, 'render re-checks the link even for un-normalized input');
  assert.equal(root.textContent, '<img src=x onerror=alert(1)>bad');

  const safe = renderBlocks(doc, doc.createElement('div'), [paragraph(run('ok', { href: 'https://example.com/' }))]);
  const anchor = safe.children[0].children[0];
  assert.equal(anchor.tag, 'a');
  assert.equal(anchor.href, 'https://example.com/');
  assert.equal(anchor.target, '_blank');
  assert.equal(anchor.rel, 'noopener noreferrer');
});
