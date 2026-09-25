import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/deepseek-model.js', import.meta.url), 'utf8');

// Honours the comma-separated tag / [role="button"] / .class selectors the adapter uses, so a
// selector that misses DeepSeek's real controls fails here too.
function matchesSelector(node, selector) {
  return selector.split(',').map((part) => part.trim()).some((part) => {
    if (part === '[role="button"]') return node.getAttribute('role') === 'button';
    if (part.startsWith('.')) return node.getAttribute('class').split(/\s+/).includes(part.slice(1));
    return node.tagName === part.toUpperCase();
  });
}

function element({ tag = 'DIV', text = '', cls = '', attrs = {}, children = [], matchesSend = false } = {}) {
  const node = {
    tagName: tag,
    textContent: text,
    children,
    parentElement: null,
    getAttribute: (name) => (name === 'class' ? cls : attrs[name] ?? null),
    matches: () => matchesSend,
    contains: (other) => node.children.includes(other) || node.children.some((child) => child.contains(other)),
    querySelectorAll: (selector) => node.children
      .flatMap((child) => [child, ...child.querySelectorAll(selector)])
      .filter((child) => matchesSelector(child, selector)),
  };
  for (const child of children) child.parentElement = node;
  return node;
}
const button = (text, cls = '', attrs = {}, extra = {}) => element({ tag: 'BUTTON', text, cls, attrs, ...extra });

function load(buttons, { origin = 'https://chat.deepseek.com', clock = { now: 0 } } = {}) {
  const composer = element();
  const bar = element({ children: [composer, ...buttons] });
  element({ children: [bar] });
  const sent = [];
  let tick = null;
  const win = {};
  win.top = win;
  vm.runInNewContext(source, {
    location: { origin },
    window: win,
    Date: { now: () => clock.now },
    document: { querySelector: () => composer },
    setInterval: (fn) => { tick = fn; },
    chrome: { runtime: { id: 'x', sendMessage: async (message) => { sent.push(message); } } },
  });
  return { sent, tick: () => tick?.() };
}
test('reports DeepSeek with the mode buttons that are switched on', () => {
  const { sent } = load([button('DeepThink', 'ds-toggle-button ds-toggle-button--selected'), button('Search', 'ds-toggle-button')]);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: 'model.status', model: { model: 'DeepSeek', mode: 'DeepThink' } }]);
});

test('reads the live DeepSeek mode toggles: DIV.ds-toggle-button without a role (2026-09-25 DOM)', () => {
  const toggle = (text, on) => element({ text, cls: `f79352dc ds-toggle-button ds-toggle-button--m${on ? ' ds-toggle-button--selected' : ''}`, attrs: { 'aria-pressed': String(on) } });
  const icon = (cls) => element({ cls: `ds-button ${cls}`, attrs: { role: 'button' } });
  const { sent } = load([toggle('深度思考', false), toggle('智能搜索', true), icon('ds-button--iconLabelPrimary'), icon('ds-button--primary ds-button--circle')]);
  assert.equal(sent[0].model.mode, '智能搜索');
});

test('aria-pressed counts as on; nothing on reports the model without a mode; Send is ignored', () => {
  const { sent } = load([button('深度思考', '', { 'aria-pressed': 'true' }), button('联网搜索', '', { 'aria-pressed': 'true' }), button('Send', '', {}, { matchesSend: true })]);
  assert.equal(sent[0].model.mode, '深度思考 · 联网搜索');
  const idle = load([button('DeepThink', 'ds-toggle-button'), button('Search', 'ds-toggle-button')]);
  assert.equal(idle.sent[0].model.mode, null);
  assert.equal(load([]).sent[0].model.model, 'DeepSeek', 'no recognisable buttons still reports DeepSeek');
});

test('an unchanged mode is repeated only every 10 s; other sites get nothing', () => {
  const clock = { now: 0 };
  const page = load([button('DeepThink', 'selected')], { clock });
  page.tick();
  clock.now = 9000;
  page.tick();
  assert.equal(page.sent.length, 1);
  clock.now = 10000;
  page.tick();
  assert.equal(page.sent.length, 2, 'a report dropped before the window was bound is sent again');
  assert.deepEqual(load([button('DeepThink', 'selected')], { origin: 'https://chatgpt.com' }).sent, []);
});
