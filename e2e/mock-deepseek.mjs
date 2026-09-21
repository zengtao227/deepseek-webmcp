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
// A test scripts the "model" from the page: window.__mock.replies.push({ reasoning?, html, hold? }).
// `hold: true` keeps the reply generating until window.__mock.release() is called; `delayMs` sets how long
// an unheld reply generates (default 600 ms; real short tool-call replies were seen at ~680 ms).
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
const mock = window.__mock = { received: [], replies: [], keepComposerText: true, release: null };
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
  const reply = mock.replies.shift() ?? { html: '<p>OK</p>' };
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
