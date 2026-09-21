import test from 'node:test';
import assert from 'node:assert/strict';
import { launchDeepSeek, waitFor } from './harness.mjs';
import { ask, openInWorkWindow, pageStatus, providerPage, toolPayload, turnDone } from './steps.mjs';

// Pages served under the test host `scroll.test`: real layout and real scroll containers, so the
// scroll tool and the viewport-first inspection run against what a browser really does.
const links = (prefix, count, height = 40) => Array.from({ length: count }, (_, index) => `<div style="height:${height}px"><a href="#${prefix}${index}">${prefix}-${index}</a></div>`).join('');

const LONG = `<body style="margin:0">${links('long', 300)}</body>`;
const INNER = `<body style="margin:0;height:100vh;overflow:hidden"><div id="c" style="height:500px;width:600px;overflow-y:auto;border:1px solid">${links('inner', 120)}</div></body>`;
const virtual = (mode) => `<body style="margin:0"><div id="c" style="height:400px;width:500px;overflow-y:auto;position:relative"><div style="height:40000px"></div></div><script>
const c = document.getElementById('c'); const rows = []; const N = 10;
function render() {
  const first = Math.floor(c.scrollTop / 40);
  if ('${mode}' === 'remount') {
    for (const r of rows) r.remove(); rows.length = 0;
    for (let i = 0; i < N; i++) { const a = document.createElement('a'); a.href = '#v' + (first + i); a.textContent = 'virt-' + (first + i); a.style.cssText = 'position:absolute;left:0;height:40px;top:' + ((first + i) * 40) + 'px'; c.appendChild(a); rows.push(a); }
  } else {
    while (rows.length < N) { const a = document.createElement('a'); a.style.cssText = 'position:absolute;left:0;height:40px'; c.appendChild(a); rows.push(a); }
    rows.forEach((a, i) => { a.href = '#v' + (first + i); a.textContent = 'virt-' + (first + i); a.style.top = ((first + i) * 40) + 'px'; });
  }
}
c.addEventListener('scroll', render); render();
</script></body>`;

const page = (request, response, url) => {
  const html = url.pathname === '/long' ? LONG
    : url.pathname === '/inner' ? INNER
      : url.pathname === '/virtual' ? virtual(url.searchParams.get('mode') === 'recycle' ? 'recycle' : 'remount')
        : null;
  response.statusCode = html ? 200 : 404;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html ?? 'not found');
};

const env = await launchDeepSeek({ hosts: { 'scroll.test': page } });
test.after(() => env.close());

let work;
let panel;
let provider;

const release = async () => {
  if ((await pageStatus(panel)).task.mode !== 'idle') {
    await panel.click('#stop');
    await waitFor(async () => (await pageStatus(panel)).task.mode === 'idle', { message: 'the task to be idle' });
  }
};
const go = async (url) => {
  await release();
  await work.close();
  work = await openInWorkWindow(env, panel, url);
};

test('setup: the assistant is active on the long page', async () => {
  ({ work, panel } = await env.startAssistant('https://scroll.test/long'));
  provider = await providerPage(env);
});

test('long page: a link past the first 80 gets a ref after scrolling, and the click reaches it', async () => {
  await ask(panel, provider, 'Open the link long-150', () => {
    const mock = window.__mock;
    mock.replies.push(
      () => mock.toolCall('l1', 'inspect_page'),
      () => mock.toolCall('l2', 'scroll', { deltaY: 3000 }),
      () => mock.toolCall('l3', 'scroll', { deltaY: 3000 }),
      () => mock.toolCall('l4', 'inspect_page'),
      (text) => {
        const element = mock.resultOf(text).result.elements.find((entry) => entry.name === 'long-150');
        return mock.toolCall('l5', 'click', { ref: element ? element.ref : 'e0' });
      },
    );
  });
  const received = await turnDone(env, panel, provider, 6);
  const first = toolPayload(received[1]);
  assert.equal(first.result.truncated, true);
  assert.equal(first.result.elements.some((element) => element.name === 'long-150'), false, 'past the cap before scrolling');
  const scrolled = toolPayload(received[3]);
  assert.deepEqual({ moved: scrolled.result.moved, target: scrolled.result.target, y: scrolled.result.y }, { moved: true, target: 'page', y: 6000 });
  const second = toolPayload(received[4]);
  assert.equal(second.result.elements[0].name, 'long-150', 'what is on screen comes first');
  assert.equal(second.result.viewport.y, 6000);
  const clicked = toolPayload(received[5]);
  assert.equal(clicked.isError, false);
  await waitFor(() => work.url().endsWith('#long150'), { message: 'the click to reach link long-150' });
});

test('inner scroll container: the page does not scroll, the container does, by default and by ref', async () => {
  await go('https://scroll.test/inner');
  await ask(panel, provider, 'Scroll the list', () => {
    const mock = window.__mock;
    mock.replies.push(
      () => mock.toolCall('i1', 'scroll', { deltaY: 1000 }),
      () => mock.toolCall('i2', 'inspect_page'),
      (text) => {
        const element = mock.resultOf(text).result.elements.find((entry) => entry.name === 'inner-25');
        window.__innerRef = element ? element.ref : 'e0';
        return mock.toolCall('i3', 'scroll', { ref: window.__innerRef, deltaY: 3000 });
      },
      () => mock.toolCall('i4', 'scroll', { ref: window.__innerRef, deltaY: 3000 }),
    );
  });
  const received = await turnDone(env, panel, provider, 5);
  const first = toolPayload(received[1]);
  assert.deepEqual({ moved: first.result.moved, target: first.result.target, y: first.result.y }, { moved: true, target: 'container', y: 1000 });
  assert.equal(toolPayload(received[2]).result.elements[0].name, 'inner-25', 'the item now on screen is first and has a ref');
  const last = toolPayload(received[4]);
  assert.deepEqual({ moved: last.result.moved, target: last.result.target, atEnd: last.result.atEnd }, { moved: true, target: 'container', atEnd: true });
  assert.equal(await work.evaluate(() => window.scrollY), 0, 'the page itself never moved');
  assert.ok(await work.evaluate(() => document.getElementById('c').scrollTop) > 4000);
});

for (const mode of ['remount', 'recycle']) {
  test(`windowed list (${mode}): scrolling replaces the rows, the old ref fails closed, a new inspect gives usable refs`, async () => {
    await go(`https://scroll.test/virtual?mode=${mode}`);
    await ask(panel, provider, 'Walk the list', (scenario) => {
      const mock = window.__mock;
      mock.replies.push(
        () => mock.toolCall(`${scenario}-v1`, 'inspect_page'),
        (text) => {
          const first = mock.resultOf(text).result.elements[0];
          window.__old = { ref: first.ref, name: first.name };
          return mock.toolCall(`${scenario}-v2`, 'scroll', { deltaY: 3000 });
        },
        () => mock.toolCall(`${scenario}-v3`, 'inspect_page'),
        (text) => {
          const first = mock.resultOf(text).result.elements[0];
          window.__fresh = { ref: first.ref, name: first.name };
          return mock.toolCall(`${scenario}-v4`, 'click', { ref: window.__old.ref });
        },
        () => mock.toolCall(`${scenario}-v5`, 'click', { ref: window.__fresh.ref }),
      );
    }, mode);
    const received = await turnDone(env, panel, provider, 6);
    const before = toolPayload(received[1]).result.elements[0].name;
    const after = toolPayload(received[3]).result.elements[0];
    assert.notEqual(after.name, before, 'the rows changed');
    const stale = toolPayload(received[4]);
    assert.equal(stale.isError, true);
    assert.equal(stale.error.code, 'STALE_REF', 'the old ref is not redirected to the new row');
    const fresh = toolPayload(received[5]);
    assert.equal(fresh.isError, false, 'the ref from the newest read works');
    await waitFor(() => work.url().endsWith(`#v${after.name.replace('virt-', '')}`), { message: 'the fresh click to reach the row shown now' });
  });
}
