// A stand-in for chat.deepseek.com, served under the real origin by browser-webmcp-e2e.
// It implements only what extension/content.js reads and types into. Each part is marked with where
// it comes from; "assumed" means there is no recorded real-DOM source for it (see the plan, section 7).
//
//   composer      textarea[placeholder]                        live DOM 2026-09-15 (content.js COMPOSER_SELECTOR)
//   send / stop   div[role=button].ds-button--primary.ds-button--circle, disabled = class
//                 `ds-button--disabled`; Stop icon = path d^="M2 4.88"   live 2026-09-15 (docs p1 Finding 11)
//   answer        .ds-markdown.ds-assistant-message-main-content         live 2026-09-15
//   reasoning     .ds-think-content                                       live 2026-09-15
//   code block    .md-code-block > (banner, pre)                          banner content ASSUMED
//   route         first message moves / to /a/chat/s/<id>                 docs (conversation path), id ASSUMED
//   composer text after Send stays until generation ends (`keepComposerText`)   live 2026-09-20 (Bug 2)
//
//   action bar   `div.ds-flex` under the answer, six icon-only `div.ds-button.ds-button--iconLabelTertiary`
//                (copy, regenerate, like, dislike, read aloud, share; no role)   live 2026-09-21, see recorded-action-bar.mjs
//                Regenerate replaces the answer with a new reply; Share only records the click
//
// A test scripts the "model" from the page: window.__mock.replies.push({ reasoning?, html, hold? }).
// A queued reply may also be a function `(receivedText) => reply`, so a scenario can build its next tool
// call from the previous tool result (element refs). `__mock.toolCall(id, name, args)` builds a reply that
// holds one tool-call block; `__mock.resultOf(text)` parses the JSON payload of a tool-result message.
// `hold: true` keeps the reply generating until window.__mock.release() is called; `delayMs` sets how long
// an unheld reply generates (default 600 ms; real short tool-call replies were seen at ~680 ms).
import { REGENERATE_PATH, SHARE_PATH } from './recorded-action-bar.mjs';

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>DeepSeek (mock)</title>
<body>
<textarea placeholder="Message DeepSeek"></textarea>
<div id="send" role="button" class="ds-button ds-button--primary ds-button--circle ds-button--disabled"><svg viewBox="0 0 16 16"><path d="M8.3125 1"/></svg></div>
<script>
const composer = document.querySelector('textarea');
const send = document.querySelector('#send');
const IDLE = '<svg viewBox="0 0 16 16"><path d="M8.3125 1"/></svg>';
const STOP = '<svg viewBox="0 0 16 16"><path d="M2 4.88"/></svg>';
const mock = window.__mock = { received: [], replies: [], clicks: [], keepComposerText: true, release: null };
const ICONS = { regenerate: ${JSON.stringify(REGENERATE_PATH)}, share: ${JSON.stringify(SHARE_PATH)} };
const PLACEHOLDER = { copy: 'M1 1h6v6H1z', like: 'M2 2h4v4H2z', dislike: 'M3 3h4v4H3z', 'read-aloud': 'M4 4h4v4H4z' };
const control = (action, path, label) => {
  const button = document.createElement('div');
  button.className = 'ds-button ds-button--iconLabelTertiary';
  button.dataset.action = action;
  if (label) button.setAttribute('aria-label', label);
  button.innerHTML = '<svg viewBox="0 0 16 16"><path d="' + path + '"/></svg>';
  return button;
};
const actionBar = (box, answer) => {
  const bar = document.createElement('div');
  bar.className = 'ds-flex';
  bar.append(
    control('copy', PLACEHOLDER.copy),
    control('regenerate', ICONS.regenerate),
    control('like', PLACEHOLDER.like),
    control('dislike', PLACEHOLDER.dislike),
    control('read-aloud', PLACEHOLDER['read-aloud'], '朗读'),
    control('share', ICONS.share),
  );
  bar.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    mock.clicks.push(action);
    if (action !== 'regenerate') return;
    const queued = mock.replies.shift();
    const reply = (typeof queued === 'function' ? queued('') : queued) ?? { html: '<p>OK</p>' };
    bar.remove();
    send.innerHTML = STOP;
    send.classList.remove('ds-button--disabled');
    answer.innerHTML = reply.partialHtml ?? '<p>…</p>';
    setTimeout(() => {
      answer.innerHTML = reply.html;
      send.innerHTML = IDLE;
      syncDisabled();
      box.append(actionBar(box, answer));
    }, reply.delayMs ?? 600);
  });
  return bar;
};
mock.toolCall = (id, name, args = {}, delayMs = 60) => ({
  html: '<div class="md-code-block"><pre>' + '&lt;webmcp_tool_call&gt;' + JSON.stringify({ id, name, arguments: args }).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '&lt;/webmcp_tool_call&gt;</pre></div>',
  delayMs,
});
mock.resultOf = (text) => JSON.parse(text.split('\\n')[1]);
const syncDisabled = () => send.classList.toggle('ds-button--disabled', composer.value === '');
composer.addEventListener('input', syncDisabled);
send.addEventListener('click', () => {
  if (send.classList.contains('ds-button--disabled')) return;
  const text = composer.value;
  mock.received.push(text);
  if (!mock.keepComposerText) composer.value = '';
  send.innerHTML = STOP;
  send.classList.remove('ds-button--disabled');
  if (location.pathname === '/') history.pushState({}, '', '/a/chat/s/mock-1');
  const queued = mock.replies.shift();
  const reply = (typeof queued === 'function' ? queued(text) : queued) ?? { html: '<p>OK</p>' };
  const box = document.createElement('div');
  box.className = 'ds-message';
  if (reply.reasoning) {
    const think = document.createElement('div');
    think.className = 'ds-think-content';
    think.textContent = reply.reasoning;
    box.append(think);
  }
  const answer = document.createElement('div');
  answer.className = 'ds-markdown ds-assistant-message-main-content';
  answer.innerHTML = reply.partialHtml ?? '<p>…</p>';
  box.append(answer);
  document.body.append(box);
  const finish = () => {
    answer.innerHTML = reply.html;
    composer.value = '';
    send.innerHTML = IDLE;
    syncDisabled();
    box.append(actionBar(box, answer));
    mock.release = null;
  };
  if (reply.hold) mock.release = finish;
  else setTimeout(finish, reply.delayMs ?? 600);
});
</script>
</body>`;

export function mockDeepSeek(request, response) {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(PAGE);
}
