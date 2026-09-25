import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/deepseek-model.js', import.meta.url), 'utf8');

function element({ text = '', cls = '', attrs = {}, children = [], matchesSend = false } = {}) {
  const node = {
    textContent: text,
    children,
    parentElement: null,
    getAttribute: (name) => (name === 'class' ? cls : attrs[name] ?? null),
    matches: () => matchesSend,
    contains: (other) => node.children.includes(other) || node.children.some((child) => child.contains(other)),
    querySelectorAll: () => node.children.flatMap((child) => [child, ...child.querySelectorAll()]).filter((child) => child.isButton),
  };
  for (const child of children) child.parentElement = node;
  return node;
}
const button = (text, cls = '', attrs = {}, extra = {}) => Object.assign(element({ text, cls, attrs, ...extra }), { isButton: true });

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
