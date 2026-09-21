import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/target-executor.js', import.meta.url), 'utf8');

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 800;

// A minimal DOM with geometry: elements report a rectangle, scroll areas keep a position and clamp
// scrollBy, and the page root is one of them. The real executor source runs against it.
class El {
  constructor(tag, { text = '', attrs = {}, parent = null, overflowY = 'visible', overflowX = 'visible' } = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attrs));
    this.innerText = text;
    this.textContent = text;
    this.isConnected = true;
    this.parentElement = parent;
    this.overflowY = overflowY;
    this.overflowX = overflowX;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHeight = 0;
    this.scrollWidth = 0;
    this.clientHeight = 0;
    this.clientWidth = 0;
    this.layout = () => ({ top: 0, left: 0, bottom: 0, right: 0 });
    this.clicks = 0;
  }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  closest() { return null; }
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return this.layout(); }
  click() { this.clicks += 1; }
  focus() {}
  dispatchEvent() { return true; }

  scrollBy({ left = 0, top = 0 }) {
    this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + top));
    this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + left));
  }
}

function scrollArea(element, { scrollHeight, clientHeight, scrollWidth = VIEW_WIDTH, clientWidth = VIEW_WIDTH }) {
  Object.assign(element, { scrollHeight, clientHeight, scrollWidth, clientWidth });
}

function loadPage({ setup }) {
  const root = new El('html');
  scrollArea(root, { scrollHeight: VIEW_HEIGHT, clientHeight: VIEW_HEIGHT });
  const body = new El('body', { parent: root });
  const world = { root, body, interactive: [], textNodes: [], noWalker: false, stacks: () => [] };
  setup(world);

  const document = {
    title: 'Fixture',
    body: { innerText: 'Fixture page' },
    scrollingElement: root,
    documentElement: root,
    getElementById: () => null,
    querySelectorAll(selector) {
      if (selector === 'iframe' || selector === 'form') return [];
      return world.interactive;
    },
    elementsFromPoint: (x, y) => world.stacks(x, y),
    createTreeWalker: world.noWalker ? undefined : () => {
      let index = 0;
      return { nextNode: () => world.textNodes[index++] ?? null };
    },
  };
  let onMessage;
  const context = {
    globalThis: null,
    document,
    location: { origin: 'https://fixture.example' },
    innerWidth: VIEW_WIDTH,
    innerHeight: VIEW_HEIGHT,
    scrollBy: (options) => root.scrollBy(options),
    InputEvent: class { constructor(type) { this.type = type; } },
    Event: class { constructor(type) { this.type = type; } },
    getComputedStyle: (element) => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: element.overflowY, overflowX: element.overflowX }),
    chrome: { runtime: { id: 'test-extension', onMessage: { addListener: (fn) => { onMessage = fn; } } } },
  };
  Object.defineProperty(context, 'scrollY', { get: () => root.scrollTop });
  Object.defineProperty(context, 'scrollX', { get: () => root.scrollLeft });
  context.globalThis = context;
  vm.runInNewContext(source, context);

  const send = (tool, args) => new Promise((resolve) => {
    onMessage({ type: 'webmcp.browser.tool', version: 1, tool, arguments: args }, { id: 'test-extension' }, resolve);
  });
  return { send, world };
}

function link(text, parent, layout) {
  const element = new El('a', { text, attrs: { href: `/${text}` }, parent });
  element.layout = layout;
  return element;
}

const names = (result) => result.result.elements.map((element) => element.name);

test('a long page: the controls in the viewport are returned first, so scrolling reaches ones past the first 80', async () => {
  const target = loadPage({
    setup(world) {
      scrollArea(world.root, { scrollHeight: 8000, clientHeight: VIEW_HEIGHT });
      world.interactive = Array.from({ length: 200 }, (_, index) => link(`link-${index}`, world.body, () => {
        const top = index * 40 - world.root.scrollTop;
        return { top, left: 0, bottom: top + 30, right: 200 };
      }));
    },
  });

  const first = await target.send('inspect_page', {});
  assert.equal(first.ok, true);
  assert.equal(first.result.elements.length, 80);
  assert.equal(first.result.truncated, true);
  assert.equal(names(first)[0], 'link-0', 'the viewport is at the top');
  assert.equal(names(first).includes('link-150'), false);
  assert.deepEqual(
    { y: first.result.viewport.y, height: first.result.viewport.height, scrollHeight: first.result.viewport.scrollHeight },
    { y: 0, height: VIEW_HEIGHT, scrollHeight: 8000 },
  );

  // One call moves at most 3000 pixels, so 5800 takes two.
  await target.send('scroll', { deltaY: 3000 });
  const scrolled = await target.send('scroll', { deltaY: 2800 });
  assert.equal(scrolled.ok, true);
  assert.deepEqual(
    { moved: scrolled.result.moved, target: scrolled.result.target, y: scrolled.result.y, maxY: scrolled.result.maxY, atStart: scrolled.result.atStart, atEnd: scrolled.result.atEnd },
    { moved: true, target: 'page', y: 5800, maxY: 7200, atStart: false, atEnd: false },
  );

  const second = await target.send('inspect_page', {});
  assert.equal(second.result.elements.length, 80);
  assert.equal(names(second).slice(0, 3).join(), 'link-145,link-146,link-147', 'what is on screen comes first, in document order');
  assert.equal(names(second).includes('link-150'), true, 'the link that was past the cap is now returned with a ref');
  assert.equal(second.result.viewport.y, 5800);

  const target150 = second.result.elements.find((element) => element.name === 'link-150');
  const clicked = await target.send('click', { ref: target150.ref });
  assert.equal(clicked.ok, true);
  assert.equal(target.world.interactive[150].clicks, 1);
});

test('scroll reports the end of the page and never moves past it', async () => {
  const target = loadPage({ setup(world) { scrollArea(world.root, { scrollHeight: 1000, clientHeight: VIEW_HEIGHT }); } });
  const down = await target.send('scroll', { deltaY: 3000 });
  assert.deepEqual({ moved: down.result.moved, y: down.result.y, atEnd: down.result.atEnd }, { moved: true, y: 200, atEnd: true });
  const again = await target.send('scroll', { deltaY: 100 });
  assert.deepEqual({ moved: again.result.moved, y: again.result.y, atEnd: again.result.atEnd }, { moved: false, y: 200, atEnd: true });
  const up = await target.send('scroll', { deltaY: -3000 });
  assert.deepEqual({ moved: up.result.moved, y: up.result.y, atStart: up.result.atStart }, { moved: true, y: 0, atStart: true });
});

test('horizontal scrolling uses deltaX and reports the horizontal axis', async () => {
  const target = loadPage({ setup(world) { scrollArea(world.root, { scrollHeight: VIEW_HEIGHT, clientHeight: VIEW_HEIGHT, scrollWidth: 2500, clientWidth: VIEW_WIDTH }); } });
  const right = await target.send('scroll', { deltaX: 600, deltaY: 0 });
  assert.equal(right.ok, true);
  assert.deepEqual({ moved: right.result.moved, axis: right.result.axis, x: right.result.x, maxX: right.result.maxX }, { moved: true, axis: 'x', x: 600, maxX: 1500 });
});

test('an inner scroll area is found when the page itself does not scroll, and only it moves', async () => {
  let inner;
  let other;
  const target = loadPage({
    setup(world) {
      inner = new El('div', { parent: world.body, overflowY: 'auto' });
      scrollArea(inner, { scrollHeight: 3000, clientHeight: 500, clientWidth: 600 });
      inner.layout = () => ({ top: 100, left: 50, bottom: 600, right: 650 });
      other = new El('div', { parent: world.body, overflowY: 'auto' });
      scrollArea(other, { scrollHeight: 2000, clientHeight: 120, clientWidth: 100 });
      other.layout = () => ({ top: 650, left: 700, bottom: 770, right: 800 });
      const item = new El('a', { text: 'inner item', attrs: { href: '/inner' }, parent: inner });
      item.layout = () => ({ top: 200 - inner.scrollTop, left: 60, bottom: 230 - inner.scrollTop, right: 300 });
      world.interactive = [item];
      world.stacks = (x, y) => {
        if (x >= 50 && x <= 650 && y >= 100 && y <= 600) return [inner, world.body, world.root];
        if (x >= 700 && x <= 800 && y >= 650 && y <= 770) return [other, world.body, world.root];
        return [world.body, world.root];
      };
    },
  });

  const moved = await target.send('scroll', { deltaY: 700 });
  assert.equal(moved.ok, true);
  assert.deepEqual(
    { moved: moved.result.moved, target: moved.result.target, y: moved.result.y, maxY: moved.result.maxY, atEnd: moved.result.atEnd },
    { moved: true, target: 'container', y: 700, maxY: 2500, atEnd: false },
  );
  assert.equal(inner.scrollTop, 700);
  assert.equal(other.scrollTop, 0, 'the smaller area was not touched');

  const inspected = await target.send('inspect_page', {});
  const item = inspected.result.elements[0];
  const byRef = await target.send('scroll', { ref: item.ref, deltaY: 5000 });
  assert.deepEqual({ moved: byRef.result.moved, y: byRef.result.y, atEnd: byRef.result.atEnd }, { moved: true, y: 2500, atEnd: true });
  assert.equal(other.scrollTop, 0);
});

test('scroll with a ref moves the nearest scrollable ancestor and never another area; no such area is an explicit error', async () => {
  let plain;
  const target = loadPage({
    setup(world) {
      plain = new El('a', { text: 'not in a scroller', attrs: { href: '/plain' }, parent: world.body });
      plain.layout = () => ({ top: 10, left: 10, bottom: 40, right: 200 });
      world.interactive = [plain];
    },
  });
  const inspected = await target.send('inspect_page', {});
  const result = await target.send('scroll', { ref: inspected.result.elements[0].ref, deltaY: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SCROLL_TARGET_NOT_FOUND');
  assert.equal(target.world.root.scrollTop, 0);
});

test('a page nothing can move on answers moved:false instead of scrolling something else', async () => {
  const target = loadPage({ setup() {} });
  const result = await target.send('scroll', { deltaY: 400 });
  assert.equal(result.ok, true);
  assert.equal(result.result.moved, false);
  assert.equal(result.result.target, 'page');
});

test('scroll arguments are validated and clamped', async () => {
  const target = loadPage({ setup(world) { scrollArea(world.root, { scrollHeight: 20000, clientHeight: VIEW_HEIGHT }); } });
  for (const bad of [{}, { deltaX: 5 }, { deltaY: '100' }, { deltaY: Number.NaN }, { deltaY: 10, extra: true }, { deltaY: 10, ref: 5 }, { deltaY: 0 }, { deltaY: 0, deltaX: 0 }]) {
    const result = await target.send('scroll', bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.error.code, 'INVALID_ARGUMENTS', JSON.stringify(bad));
  }
  const clamped = await target.send('scroll', { deltaY: 100000 });
  assert.equal(clamped.result.y, 3000, 'one call moves at most 3000 pixels');
  const negative = await target.send('scroll', { deltaY: -100000 });
  assert.equal(negative.result.y, 0);
});

test('scan cap: a page with far more candidates than the cap still answers, and says it was cut', async () => {
  const target = loadPage({
    setup(world) {
      world.interactive = Array.from({ length: 1600 }, (_, index) => {
        const element = link(`row-${index}`, world.body, () => ({ top: index * 40, left: 0, bottom: index * 40 + 30, right: 100 }));
        element.getClientRects = () => (index < 1500 ? [] : [{}]);
        return element;
      });
    },
  });
  const result = await target.send('inspect_page', {});
  assert.equal(result.ok, true);
  assert.equal(result.result.truncated, true);
  assert.equal(result.result.elements.length, 0, 'the visible ones were past the scan cap');
});

test('a windowed list that reuses one DOM node: the old ref no longer acts on the new row', async () => {
  const rows = [];
  const target = loadPage({
    setup(world) {
      for (let index = 0; index < 5; index += 1) {
        const row = new El('a', { text: `item ${index}`, attrs: { href: `/item-${index}` }, parent: world.body });
        row.layout = () => ({ top: index * 40, left: 0, bottom: index * 40 + 30, right: 200 });
        rows.push(row);
      }
      world.interactive = rows;
    },
  });
  const first = await target.send('inspect_page', {});
  const oldRef = first.result.elements[0].ref;
  assert.equal(first.result.elements[0].name, 'item 0');

  // The list scrolls: the same node now shows another item.
  rows[0].innerText = 'item 40';
  rows[0].textContent = 'item 40';
  rows[0].attributes.set('href', '/item-40');
  const stale = await target.send('click', { ref: oldRef });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'STALE_REF');
  assert.equal(rows[0].clicks, 0, 'the recycled row was not clicked');
  const staleScroll = await target.send('scroll', { ref: oldRef, deltaY: 100 });
  assert.equal(staleScroll.error.code, 'STALE_REF');

  const second = await target.send('inspect_page', {});
  assert.equal(second.result.elements[0].name, 'item 40');
  assert.notEqual(second.result.elements[0].ref, oldRef, 'the reused node gets a new ref');
  const stillStale = await target.send('click', { ref: oldRef });
  assert.equal(stillStale.error.code, 'STALE_REF', 'inspecting again does not bring the old ref back to life');
  assert.equal(rows[0].clicks, 0);
  const fresh = await target.send('click', { ref: second.result.elements[0].ref });
  assert.equal(fresh.ok, true, 'the new ref refers to what is there now');
  assert.equal(rows[0].clicks, 1);
});

test('a list item that was unmounted fails closed, and its replacement gets its own ref', async () => {
  const rows = [];
  const target = loadPage({
    setup(world) {
      const row = new El('a', { text: 'old item', attrs: { href: '/old' }, parent: world.body });
      row.layout = () => ({ top: 0, left: 0, bottom: 30, right: 200 });
      rows.push(row);
      world.interactive = rows;
    },
  });
  const first = await target.send('inspect_page', {});
  const oldRef = first.result.elements[0].ref;
  rows[0].isConnected = false;
  const replacement = new El('a', { text: 'new item', attrs: { href: '/new' }, parent: target.world.body });
  replacement.layout = () => ({ top: 0, left: 0, bottom: 30, right: 200 });
  target.world.interactive = [replacement];

  assert.equal((await target.send('click', { ref: oldRef })).error.code, 'STALE_REF');
  const second = await target.send('inspect_page', {});
  assert.notEqual(second.result.elements[0].ref, oldRef);
  assert.equal(rows[0].clicks, 0);
});

const textNode = (element) => ({ nodeValue: element.innerText, parentElement: element });

test('inspect_page text follows the viewport, not the top of the page', async () => {
  const target = loadPage({
    setup(world) {
      scrollArea(world.root, { scrollHeight: 8000, clientHeight: VIEW_HEIGHT });
      world.interactive = Array.from({ length: 200 }, (_, index) => link(`link-${index}`, world.body, () => {
        const top = index * 40 - world.root.scrollTop;
        return { top, left: 0, bottom: top + 30, right: 200, width: 200, height: 30 };
      }));
      world.textNodes = world.interactive.map(textNode);
    },
  });
  const first = await target.send('inspect_page', {});
  assert.equal(first.result.textScope, 'viewport');
  assert.match(first.result.text, /link-0\b/);
  assert.doesNotMatch(first.result.text, /link-150\b/);

  await target.send('scroll', { deltaY: 3000 });
  await target.send('scroll', { deltaY: 2800 });
  const second = await target.send('inspect_page', {});
  assert.match(second.result.text, /link-150\b/, 'what is on screen now is in the text');
  assert.doesNotMatch(second.result.text, /link-0\b/, 'what scrolled far away is not');
  assert.doesNotMatch(second.result.text, /link-2\b/);
});

test('when the text around the viewport is more than the budget, only what is on screen is kept', async () => {
  const target = loadPage({
    setup(world) {
      const onScreen = new El('p', { text: 'ON-SCREEN', parent: world.body });
      onScreen.layout = () => ({ top: 100, left: 0, bottom: 130, right: 300, width: 300, height: 30 });
      const below = new El('p', { text: 'BELOW '.repeat(1500), parent: world.body });
      below.layout = () => ({ top: VIEW_HEIGHT + 100, left: 0, bottom: VIEW_HEIGHT + 400, right: 300, width: 300, height: 300 });
      world.textNodes = [textNode(onScreen), textNode(below)];
    },
  });
  const result = await target.send('inspect_page', {});
  assert.equal(result.result.text, 'ON-SCREEN');
});

test('hidden text, scripts and text far from the viewport are not part of the text', async () => {
  const target = loadPage({
    setup(world) {
      const make = (tag, text, layout, overflowY) => {
        const element = new El(tag, { text, parent: world.body, overflowY });
        element.layout = layout;
        return element;
      };
      const visible = make('p', 'VISIBLE', () => ({ top: 10, left: 0, bottom: 40, right: 100, width: 100, height: 30 }));
      const collapsed = make('p', 'DISPLAY-NONE', () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }));
      const script = make('script', 'SCRIPT-BODY', () => ({ top: 10, left: 0, bottom: 40, right: 100, width: 100, height: 30 }));
      const far = make('p', 'FAR-AWAY', () => ({ top: VIEW_HEIGHT * 5, left: 0, bottom: VIEW_HEIGHT * 5 + 30, right: 100, width: 100, height: 30 }));
      world.textNodes = [visible, collapsed, script, far].map(textNode);
    },
  });
  const result = await target.send('inspect_page', {});
  assert.equal(result.result.text, 'VISIBLE');
});

test('without usable geometry the text falls back to the whole page and says so', async () => {
  const target = loadPage({ setup(world) { world.noWalker = true; } });
  const result = await target.send('inspect_page', {});
  assert.equal(result.result.textScope, 'page');
  assert.equal(result.result.text, 'Fixture page');
});


function checkbox(labelText, parent, layout) {
  const element = new El('input', { parent });
  element.type = 'checkbox';
  element.checked = false;
  element.labels = [{ textContent: labelText }];
  element.layout = layout;
  return element;
}
const setLabel = (element, text) => { element.labels = [{ textContent: text }]; };
const row = (top) => () => ({ top, left: 0, bottom: top + 30, right: 200, width: 200, height: 30 });

test('a reused checkbox whose label changed is not clicked through the old ref', async () => {
  let box;
  const target = loadPage({
    setup(world) {
      box = checkbox('Buy milk', world.body, row(10));
      world.interactive = [box];
    },
  });
  const first = await target.send('inspect_page', {});
  const oldRef = first.result.elements[0].ref;
  assert.equal(first.result.elements[0].name, 'Buy milk');

  setLabel(box, 'Delete my account');
  const result = await target.send('click', { ref: oldRef });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'STALE_REF');
  assert.equal(box.clicks, 0, 'the row that now has a different label was not toggled');
});

test('a ref that stopped matching never comes back when the node shows the old content again (A to B to A)', async () => {
  const rows = [];
  const target = loadPage({
    setup(world) {
      const item = new El('a', { text: 'item A', attrs: { href: '/a' }, parent: world.body });
      item.layout = row(10);
      rows.push(item);
      world.interactive = rows;
    },
  });
  const first = await target.send('inspect_page', {});
  const oldRef = first.result.elements[0].ref;

  rows[0].innerText = 'item B';
  rows[0].textContent = 'item B';
  rows[0].attributes.set('href', '/b');
  await target.send('inspect_form', {});          // any later call notices that the ref stopped matching

  rows[0].innerText = 'item A';
  rows[0].textContent = 'item A';
  rows[0].attributes.set('href', '/a');
  const back = await target.send('click', { ref: oldRef });
  assert.equal(back.ok, false);
  assert.equal(back.error.code, 'STALE_REF', 'the old ref is not revived');
  assert.equal(rows[0].clicks, 0);

  const second = await target.send('inspect_page', {});
  assert.notEqual(second.result.elements[0].ref, oldRef, 'a new inspect gives a new ref');
  assert.equal((await target.send('click', { ref: second.result.elements[0].ref })).ok, true);
});

test('filling a field or an editor does not make its ref stale', async () => {
  let field;
  let editor;
  const target = loadPage({
    setup(world) {
      field = new El('input', { parent: world.body });
      field.type = 'text';
      field.value = '';
      field.labels = [{ textContent: 'Name' }];
      field.layout = row(10);
      editor = new El('div', { attrs: { role: 'textbox', contenteditable: 'true', 'aria-label': 'Message body' }, parent: world.body });
      editor.isContentEditable = true;
      editor.layout = row(60);
      world.interactive = [field, editor];
    },
  });
  const inspected = await target.send('inspect_page', {});
  const [nameRef, bodyRef] = ['Name', 'Message body'].map((name) => inspected.result.elements.find((element) => element.name === name).ref);
  for (const [ref, value] of [[nameRef, 'Ada'], [nameRef, 'Grace'], [bodyRef, 'Hello'], [bodyRef, 'Hello again']]) {
    editor.innerText = editor.textContent = editor.innerText;
    const result = await target.send('fill', { ref, value });
    assert.equal(result.ok, true, `${ref} <- ${value}`);
  }
});
