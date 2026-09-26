(() => {
  'use strict';

  // ChatGPT Web Adapter for Web Provider Mode. Same worker protocol as the DeepSeek adapter
  // (content.js); only the page layer differs. Selectors come from the original ChatGPT Web
  // fallback (chatgpt-embedded-panel 7ae86f7) and the ChatGPT DOM lifecycle study.
  const ORIGIN = 'https://chatgpt.com';
  // Two ChatGPT DOM generations are live: the ProseMirror/data-testid UI, and (seen 2026-09-25,
  // logged out) a textarea UI with `li[data-message-role]` turns and `/uc/<id>` conversations.
  const ANSWER_SELECTOR = '[data-message-author-role="assistant"], li[data-message-role="assistant"]';
  const USER_SELECTOR = '[data-message-author-role="user"], li[data-message-role="user"]';
  const COMPOSER_SELECTOR = '#prompt-textarea, div.ProseMirror[contenteditable="true"]';
  const SEND_SELECTOR = '#composer-submit-button, button[data-testid="send-button"], form button[type="submit"][aria-label^="Send" i]';
  const STOP_SELECTOR = 'button[data-testid="stop-button"], button[aria-label^="Stop" i]';
  const CONVERSATION_PATH = /^\/u?c\/[A-Za-z0-9-]+$/;
  const POLL_MS = 500;
  const STABLE_MS = 2000;
  const SEND_ENABLE_WAIT_MS = 3000;
  const PASTE_WAIT_MS = 1000;
  const COMPLETE_TOOL_CALL = /<webmcp_tool_call>[\s\S]*<\/webmcp_tool_call>/;
  const SEND_CONFIRM_WAIT_MS = 5000;

  // Runs in a normal chatgpt.com tab (provider window) or as the ChatGPT frame inside this
  // extension's Side Panel; never inside a frame that some other page embeds.
  const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
  const inPanel = window.top !== window && location.ancestorOrigins?.[0] === EXTENSION_ORIGIN;
  if (location.origin !== ORIGIN || (window.top !== window && !inPanel)) return;

  // The worker keys the panel frame (no tab) by the href it reports; tabs are keyed by tab URL.
  const send = (message) => chrome.runtime.sendMessage({ ...message, href: location.href });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const composer = () => document.querySelector(COMPOSER_SELECTOR)
    ?? [...document.querySelectorAll('form textarea')].find((input) => input.getClientRects().length > 0);
  const sendControl = () => document.querySelector(SEND_SELECTOR);
  const isGenerating = () => document.querySelector(STOP_SELECTOR) !== null;
  const sendDisabled = (control) => control.disabled || control.getAttribute('aria-disabled') === 'true'
    || control.matches(STOP_SELECTOR);

  // The markdown body, not the whole turn: the turn also holds action-button labels.
  function latestAnswer() {
    const turns = document.querySelectorAll(ANSWER_SELECTOR);
    const turn = turns.length > 0 ? turns[turns.length - 1] : null;
    return turn?.querySelector('[data-assistant-markdown], .markdown') ?? turn;
  }

  // ChatGPT shows reasoning as its own collapsed "Thought for …" UI; the panel does not mirror it.
  const latestReasoning = () => null;

  function panelAnswerText() {
    const answer = latestAnswer();
    if (!answer) return '';
    const text = answer.textContent ?? '';
    if (/webmcp_tool_call|｜\s*DSML\s*｜/i.test(text)) return '';
    if (/<webmcp_tool_call>/.test(text)) return '';
    return text;
  }


  // ---- Answer structure for the Side Panel (limits are enforced again in answer-blocks.js) ----
  // The panel never receives the page's HTML, classes or styles: only paragraphs, headings, lists,
  // code, quotes, tables and inline runs, rebuilt there with createElement + textContent.
  const MAX_BLOCK_DEPTH = 3;
  const MAX_WALK_NODES = 20000;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'SVG', 'NOSCRIPT', 'TEMPLATE']);
  const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR', 'DIV', 'SECTION', 'ARTICLE']);
  const tagOf = (node) => String(node.tagName ?? '').toUpperCase();
  const classesOf = (node) => String(node.getAttribute?.('class') ?? '').split(/\s+/);
  const tooMuch = () => { throw new Error('answer too large to structure'); };

  function inlineRuns(node, style, out, walk) {
    if (++walk.nodes > MAX_WALK_NODES) tooMuch();
    if (node.nodeType === 3) {
      if (node.nodeValue) out.push({ text: node.nodeValue, ...style });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = tagOf(node);
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'BR') {
      out.push({ text: '\n', br: true, ...style });
      return;
    }
    if (classesOf(node).includes('katex')) {
      const tex = node.querySelector?.('annotation')?.textContent;
      if (tex) out.push({ text: tex, ...style, code: true });
      return;
    }
    const next = { ...style };
    if (tag === 'STRONG' || tag === 'B') next.bold = true;
    if (tag === 'EM' || tag === 'I') next.italic = true;
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') next.strike = true;
    if (tag === 'CODE') next.code = true;
    if (tag === 'A') {
      const href = node.getAttribute?.('href');
      if (href) next.href = href;
    }
    for (const child of node.childNodes) inlineRuns(child, next, out, walk);
  }

  const sameStyle = (a, b) => a.bold === b.bold && a.italic === b.italic && a.strike === b.strike
    && a.code === b.code && a.href === b.href;

  // Whitespace in the page's markup is layout, not content; only <br> and code keep line breaks.
  function cleanRuns(raw) {
    const runs = [];
    for (const run of raw) {
      const text = run.br || run.code ? run.text : run.text.replace(/\s+/g, ' ');
      if (text === '') continue;
      const last = runs.at(-1);
      if (last && !run.br && !last.br && sameStyle(last, run)) last.text += text;
      else runs.push({ ...run, text });
    }
    if (runs.length > 0) runs[0].text = runs[0].text.replace(/^ +/, '');
    if (runs.length > 0) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/ +$/, '');
    return runs.filter((run) => run.text !== '').map(({ br, ...run }) => run);
  }

  const runsOf = (node, walk) => {
    const out = [];
    for (const child of node.childNodes) inlineRuns(child, {}, out, walk);
    return cleanRuns(out);
  };

  function codeBlock(pre) {
    const code = pre.querySelector?.('code') ?? pre;
    const language = /(?:^|\s)language-([A-Za-z0-9_+.#-]{1,32})(?:\s|$)/.exec(`${pre.getAttribute?.('class') ?? ''} ${code.getAttribute?.('class') ?? ''}`);
    return { type: 'code', lang: language?.[1] ?? '', text: code.textContent ?? '' };
  }

  function tableBlock(table, walk) {
    const rows = [];
    let head = null;
    for (const row of table.querySelectorAll('tr')) {
      const cells = [...row.childNodes].filter((node) => ['TH', 'TD'].includes(tagOf(node)));
      const parsed = cells.map((cell) => runsOf(cell, walk));
      if (rows.length === 0 && head === null && cells.length > 0 && cells.every((cell) => tagOf(cell) === 'TH')) head = parsed;
      else rows.push(parsed);
    }
    return { type: 'table', head, rows };
  }

  function listBlock(list, depth, walk) {
    const items = [];
    for (const child of list.childNodes) {
      if (tagOf(child) !== 'LI') continue;
      // Below the nesting limit an item keeps its text only.
      if (depth + 1 > MAX_BLOCK_DEPTH) {
        items.push({ runs: runsOf(child, walk), blocks: [] });
        continue;
      }
      const inner = blocksFrom(child, depth + 1, walk);
      const runs = inner[0]?.type === 'paragraph' ? inner.shift().runs : [];
      items.push({ runs, blocks: inner });
    }
    const block = { type: 'list', ordered: tagOf(list) === 'OL', items };
    const start = Number.parseInt(list.getAttribute?.('start') ?? '', 10);
    if (block.ordered && Number.isInteger(start)) block.start = start;
    return block;
  }

  function blocksFrom(container, depth, walk) {
    const blocks = [];
    let loose = [];
    const flush = () => {
      const runs = cleanRuns(loose);
      loose = [];
      if (runs.length > 0) blocks.push({ type: 'paragraph', runs });
    };

    for (const child of container.childNodes) {
      if (++walk.nodes > MAX_WALK_NODES) tooMuch();
      const tag = tagOf(child);
      if (child.nodeType !== 1 || !BLOCK_TAGS.has(tag)) {
        inlineRuns(child, {}, loose, walk);
        continue;
      }
      flush();
      if (tag === 'P') {
        const runs = runsOf(child, walk);
        if (runs.length > 0) blocks.push({ type: 'paragraph', runs });
      } else if (/^H[1-6]$/.test(tag)) {
        blocks.push({ type: 'heading', level: Number(tag[1]), runs: runsOf(child, walk) });
      } else if (tag === 'UL' || tag === 'OL') {
        blocks.push(listBlock(child, depth, walk));
      } else if (tag === 'PRE') {
        blocks.push(codeBlock(child));
      } else if (tag === 'HR') {
        blocks.push({ type: 'rule' });
      } else if (tag === 'TABLE') {
        blocks.push(tableBlock(child, walk));
      } else if (tag === 'BLOCKQUOTE') {
        if (depth + 1 > MAX_BLOCK_DEPTH) {
          const runs = runsOf(child, walk);
          if (runs.length > 0) blocks.push({ type: 'paragraph', runs });
        } else {
          blocks.push({ type: 'quote', blocks: blocksFrom(child, depth + 1, walk) });
        }
      } else {
        blocks.push(...blocksFrom(child, depth, walk));
      }
    }
    flush();
    return blocks;
  }

  function buildAnswerBlocks(answer) {
    if (!answer) return [];
    try {
      return blocksFrom(answer, 1, { nodes: 0 });
    } catch {
      return [];
    }
  }

  let route = null;
  let sawGeneration = false;
  // Set when this script itself sent a message and the send was acknowledged: a reply is now awaited even
  // if it starts and ends between two timer ticks (a short tool-call reply), and even though a route
  // change (a new chat getting its address) resets what tick() has observed.
  let ownReplyPending = false;
  let ownReplyBaseline = { count: 0, text: '' };
  let resumeCheck = false;
  let lastText = null;
  let changedAt = 0;
  let busy = false;
  let instructions = null;
  let ownSend = false;
  let lastPanelReasoning = null;
  let lastPanelAnswer = null;
  let lastPanelBlocks = [];
  let lastPanelGenerating = null;

  const readComposer = (input) => (input.value ?? input.innerText ?? '').replace(/ /g, ' ');

  // ChatGPT's ProseMirror composer turns written lines into paragraphs, so the read-back differs from
  // the input only in whitespace.
  const sameText = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

  function selectAll(input) {
    input.focus();
    const selection = getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function writeComposer(input, text) {
    if (input instanceof HTMLTextAreaElement) {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return sameText(readComposer(input), text);
    }
    selectAll(input);
    // ProseMirror pastes at its own selection, which takes up this select-all only later: with the
    // owner's text still in the composer the paste landed after it, the read-back failed and the
    // first Send stopped there (live 2026-09-26). Native delete acts on the DOM selection, so the
    // paste goes into an empty composer, as it does for every tool result.
    if (readComposer(input).trim() !== '') {
      try { document.execCommand('delete'); } catch {}
      const clearDeadline = Date.now() + PASTE_WAIT_MS;
      while (readComposer(input).trim() !== '' && Date.now() < clearDeadline) await sleep(25);
    }
    // One paste is one editor step; insertText makes every line its own step (live 2026-09-25:
    // 8 ms against 2.6 s for a 12 kB tool result, which stayed in the composer meanwhile).
    // ProseMirror applies the paste a task later, so the read-back waits for it; reading at once
    // looked like a failure and wrote the text a second time. insertText only if the paste changed nothing.
    const before = readComposer(input);
    const data = new DataTransfer();
    data.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    const deadline = Date.now() + PASTE_WAIT_MS;
    while (!sameText(readComposer(input), text) && Date.now() < deadline) await sleep(25);
    if (readComposer(input) === before && !sameText(before, text)) {
      selectAll(input);
      try { document.execCommand('insertText', false, text); } catch {}
    }
    return sameText(readComposer(input), text);
  }

  async function sendText(text) {
    const input = composer();
    if (!input) return { ok: false, code: 'COMPOSER_NOT_FOUND' };
    if (!(await writeComposer(input, text))) return { ok: false, code: 'COMPOSER_WRITE_FAILED' };

    const enableDeadline = Date.now() + SEND_ENABLE_WAIT_MS;
    let control = sendControl();
    while (!control || sendDisabled(control)) {
      if (Date.now() > enableDeadline) return { ok: false, code: control ? 'SEND_DISABLED' : 'SEND_BUTTON_NOT_FOUND' };
      await sleep(100);
      control = sendControl();
    }
    const startPath = location.pathname;
    const wasGenerating = isGenerating();
    control.click();

    const confirmDeadline = Date.now() + SEND_CONFIRM_WAIT_MS;
    while (!sendAcknowledged(input, startPath, wasGenerating)) {
      if (Date.now() > confirmDeadline) return { ok: false, code: 'SEND_NOT_CONFIRMED' };
      await sleep(100);
    }
    // Only an answer that differs from what was there at the send can be the awaited reply.
    ownReplyBaseline = { count: document.querySelectorAll(ANSWER_SELECTOR).length, text: latestAnswer()?.textContent ?? '' };
    ownReplyPending = true;
    announceGeneration();
    return { ok: true, code: 'SEND_CLICKED' };
  }

  function announceGeneration() {
    try {
      void send({ type: 'work.generating' }).catch(() => {});
    } catch {
      // Extension context gone; nothing to notify.
    }
  }

  function sendAcknowledged(input, startPath, wasGenerating) {
    if (readComposer(input).trim() === '') return true;
    if (input.isConnected === false) return true;
    if (!wasGenerating && isGenerating()) return true;
    return location.pathname !== startPath && CONVERSATION_PATH.test(location.pathname);
  }


  // Regenerate / Share are DeepSeek adapter extras; the ChatGPT adapter leaves them to the page.
  const pressAnswerControl = () => ({ ok: false, code: 'CONTROL_NOT_FOUND', message: 'Use ChatGPT\'s own controls for this.' });

  // Background only hands out a result for the conversation that produced it; the
  // page re-checks that the same conversation is still displayed before typing.
  async function deliver(reply) {
    if (typeof reply?.continueWith !== 'string' || reply.conversationPath !== location.pathname) return;
    const result = await sendText(reply.continueWith);
    await send({ type: 'work.continuation-result', result, conversationPath: reply.conversationPath }).catch(() => {});
  }

  const INSTRUCTIONS_START = 'You can use owner-approved tools through DeepSeek WebMCP';

  // Live 2026-09-25: ChatGPT read the shared instructions as its own built-in tools, found none in
  // its session and refused. This line says where the tools really run.
  const CHATGPT_FRAMING = 'Note: these are not built-in ChatGPT tools and you do not run them yourself. You only write the call as the text block shown above. My local WebMCP browser extension reads that block from this chat, runs it on my machine, and pastes the real result back as my next message.';

  // `force` is for the assistant's first prompt of a session: the provider may reopen on a
  // conversation that never received the tool contract.
  function userTextWithInstructions(text, { force = false } = {}) {
    const clean = String(text ?? '').trimEnd();
    if (!clean || instructions === null || clean.includes(INSTRUCTIONS_START)) return clean;
    if (!force && !needsInstructions()) return clean;
    return `${clean}\n\n${instructions}\n\n${CHATGPT_FRAMING}`;
  }

  async function sendAssistantPrompt(text, { withInstructions = false, pageNote = '' } = {}) {
    if (isGenerating()) return { ok: false, code: 'GENERATION_IN_PROGRESS', message: 'ChatGPT is still generating.' };
    if (instructions === null) await arrive();
    if (instructions === null) return { ok: false, code: 'WORK_OFF', message: 'Work is not active.' };

    const withNote = pageNote && text.trimEnd() ? `${text.trimEnd()}\n\n${pageNote}` : text;
    const payload = userTextWithInstructions(withNote, { force: withInstructions });
    if (!payload) return { ok: false, code: 'EMPTY_PROMPT', message: 'Enter a prompt.' };

    ownSend = true;
    busy = true;
    try {
      return await sendText(payload);
    } finally {
      ownSend = false;
      busy = false;
    }
  }

  // The panel reopens the last conversation, which may never have received the tool contract
  // (live 2026-09-25: ChatGPT said it could not see the page). The contract is attached to the next
  // message of any conversation whose user messages do not contain it yet.
  function needsInstructions() {
    return ![...document.querySelectorAll(USER_SELECTOR)].some((message) => (message.textContent ?? '').includes(INSTRUCTIONS_START));
  }

  // In a Work tab, the user's first message of a new chat is sent with the tool
  // instructions after it, so the composer stays clean while typing and the question
  // stays visible when the page collapses long messages. Enter during IME composition
  // (e.g. Chinese input) is never treated as Send.
  function interceptSend(event) {
    if (ownSend || instructions === null || !needsInstructions()) return;
    const input = composer();
    if (!input || readComposer(input).trim() === '' || readComposer(input).includes(INSTRUCTIONS_START)) return;
    if (event.type === 'keydown') {
      if (!input.contains(event.target) || event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    } else if (!event.target?.closest?.(SEND_SELECTOR)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const text = userTextWithInstructions(readComposer(input));
    ownSend = true;
    busy = true;
    void sendText(text).finally(() => {
      ownSend = false;
      busy = false;
    });
  }

  async function arrive() {
    busy = true;
    try {
      const reply = await send({ type: 'work.arrive' });
      instructions = reply?.work === true && typeof reply.instructions === 'string' ? reply.instructions : null;
      await deliver(reply);
    } catch {
      // Extension reloaded or worker unavailable; the next route change retries.
    } finally {
      busy = false;
    }
  }

  async function report(text, resume) {
    busy = true;
    try {
      const reply = await send({ type: 'work.completion', text, resume });
      await deliver(reply);
    } catch {
      // Ignore; nothing executes without a reply from the worker.
    } finally {
      busy = false;
    }
  }

  // A new route starts clean: nothing seen in another conversation can be reported
  // here. History is reported only as a one-time resume check, which the worker
  // accepts solely when it is waiting for this conversation's reply.
  function enterRoute() {
    route = location.href;
    sawGeneration = false;
    resumeCheck = true;
    lastText = null;
    lastPanelReasoning = null;
    lastPanelAnswer = null;
    lastPanelBlocks = [];
    lastPanelGenerating = null;
    void arrive();
  }

  function publishAssistantSnapshot() {
    if (!chrome.runtime?.id) return;
    const reasoning = latestReasoning()?.textContent ?? '';
    const answer = panelAnswerText();
    const generating = isGenerating();
    if (reasoning === lastPanelReasoning && answer === lastPanelAnswer && generating === lastPanelGenerating) return;
    // The structure is rebuilt only when the text changed, so streaming ticks that only touch the
    // reasoning or the Stop icon stay cheap. Text that was filtered out never gets a structure.
    if (answer !== lastPanelAnswer) lastPanelBlocks = answer === '' ? [] : buildAnswerBlocks(latestAnswer());
    lastPanelReasoning = reasoning;
    lastPanelAnswer = answer;
    lastPanelGenerating = generating;
    try {
      void send({
        type: 'assistant.snapshot',
        reasoning: reasoning.slice(0, 128 * 1024),
        answer: answer.slice(0, 128 * 1024),
        blocks: lastPanelBlocks,
        generating,
      }).catch(() => {});
    } catch {}
  }

  function tick() {
    scheduleFold();
    publishAssistantSnapshot();
    // After the extension is reloaded, a page script left in an open tab loses its
    // extension context and chrome.runtime.sendMessage throws synchronously.
    if (!chrome.runtime?.id) return;
    if (location.href !== route) enterRoute();
    if (busy) return;
    if (isGenerating()) {
      if (!sawGeneration) announceGeneration();
      sawGeneration = true;
      resumeCheck = false;
      lastText = null;
      return;
    }
    const answer = latestAnswer();
    if (!answer) return;
    const text = answer.textContent ?? '';
    const awaited = ownReplyPending
      && (document.querySelectorAll(ANSWER_SELECTOR).length > ownReplyBaseline.count || text !== ownReplyBaseline.text);
    if (!sawGeneration && !resumeCheck && !awaited) return;
    const now = Date.now();
    // Once ChatGPT stopped generating, a reply holding a complete tool call is final; the quiet
    // period only delayed every tool step by STABLE_MS. Plain answers and resume checks still wait.
    const readyCall = (sawGeneration || awaited) && COMPLETE_TOOL_CALL.test(text);
    if (text !== lastText) {
      lastText = text;
      changedAt = now;
      if (!readyCall) return;
    } else if (now - changedAt < STABLE_MS && !readyCall) {
      return;
    }

    const resume = !sawGeneration && !awaited;
    sawGeneration = false;
    ownReplyPending = false;
    resumeCheck = false;
    lastText = null;
    void report(text, resume);
  }

  // Display only. ChatGPT Web (in this mode) has no hidden instruction channel, so instructions, tool
  // results and tool calls must be real message text; here they are folded into a one-line
  // summary (click to expand). Only data attributes and CSS are used: the text and DOM that
  // ChatGPT's page owns, and the answer text WebMCP reads, stay unchanged.
  const FOLD = 'data-webmcp-fold';
  const OPEN = 'data-webmcp-open';
  const QUESTION = 'data-webmcp-question';
  const COLOR = '--webmcp-fold-color';
  // A turn that is only a WebMCP step (a tool call, or a typed tool result / correction) loses its
  // icon row; the owner's question and the final answer keep Copy / Rate (live DOM 2026-09-25).
  const STEP = 'data-webmcp-step';
  const TURN_SELECTOR = '[data-testid^="conversation-turn"]';
  // Free-plan sponsored cards sit in the reply's block beside the reply itself, with no link or
  // attribute of their own; only the badge text marks them (live DOM 2026-09-26).
  const AD = 'data-webmcp-ad';
  const AD_BADGE = /^(Ad|Ads|Sponsored|广告|赞助)$/;
  const RESULT_START = 'DeepSeek WebMCP tool result.\n';
  const CORRECTION_START = 'DeepSeek WebMCP format correction.\n';
  const INSTRUCTIONS_SEPARATOR = `\n\n---\n${INSTRUCTIONS_START}`;

  // The bubble box itself carries an accent color, so the summary uses the color of the
  // message text it replaces. The user's question keeps full size; the tool line is dimmed.
  const style = document.createElement('style');
  style.textContent = `
    [${FOLD}]:not([${OPEN}]) { font-size: 0 !important; line-height: 0 !important; cursor: pointer; }
    [${FOLD}]:not([${OPEN}]) > * { display: none !important; }
    [${FOLD}]:not([${OPEN}])::before { content: attr(${QUESTION}); display: block; font-size: 16px; line-height: 26px; color: var(${COLOR}, inherit); white-space: pre-wrap; }
    [${FOLD}]:not([${OPEN}])::after { content: attr(${FOLD}); display: block; font-size: 12px; line-height: 20px; color: var(${COLOR}, inherit); opacity: 0.55; white-space: pre-wrap; }
    [${FOLD}][${OPEN}] { cursor: pointer; }
    [${STEP}] [role="group"]:has(button[data-testid="copy-turn-action-button"]) { display: none !important; }
    [${STEP}][data-turn="user"] button { display: none !important; }
    [${AD}] { display: none !important; }
  `;
  (document.head ?? document.documentElement).append(style);

  function toolName(text) {
    return /"name":"([a-z_]{1,32})"/.exec(text)?.[1] ?? 'tool';
  }

  function summaryFor(text) {
    if (text.startsWith(RESULT_START)) return { note: `🔧 ${toolName(text)} ${/"isError":true/.test(text) ? '✗' : '✓'}` };
    if (text.startsWith(CORRECTION_START)) return { note: '🔧 format corrected, retrying' };
    const separator = text.indexOf(INSTRUCTIONS_SEPARATOR);
    if (separator > 0) return { question: text.slice(0, separator), note: '🔧 WebMCP tools attached' };
    return null;
  }

  function setFold(target, { question = '', note }, colorSource) {
    if (target.getAttribute(FOLD) === note && (target.getAttribute(QUESTION) ?? '') === question) return;
    target.style.setProperty(COLOR, getComputedStyle(colorSource).color);
    if (question) target.setAttribute(QUESTION, question);
    target.setAttribute(FOLD, note);
  }

  // USER_SELECTOR is a list, so the descendant part is added to each of its selectors.
  const USER_TEXT_SELECTOR = USER_SELECTOR.split(',')
    .flatMap((user) => ['div', 'span', 'p'].map((tag) => `${user.trim()} ${tag}`))
    .join(', ');

  // Messages the extension typed are plain text in one element. Unlike DeepSeek, ChatGPT renders
  // the fenced examples inside tool instructions and results as <pre> (live DOM 2026-09-25), so
  // the element holds text nodes beside PRE blocks.
  function isTypedText(element) {
    const nodes = [...element.childNodes];
    return nodes.some((node) => node.nodeType === Node.TEXT_NODE)
      && nodes.every((node) => node.nodeType === Node.TEXT_NODE || node.nodeName === 'PRE');
  }

  function markStep(element) {
    const turn = element.closest(TURN_SELECTOR);
    if (turn && !turn.hasAttribute(STEP)) turn.setAttribute(STEP, '');
  }

  function hideAds() {
    for (const turn of document.querySelectorAll(`${TURN_SELECTOR}[data-turn="assistant"]`)) {
      const content = turn.querySelector('[data-conversation-screenshot-content]');
      for (const block of content?.children ?? []) {
        if (block.hasAttribute(AD) || block.matches?.('[data-message-author-role]') || block.querySelector('[data-message-author-role]')) continue;
        const badge = [...block.querySelectorAll('*')].some((element) => element.childElementCount === 0 && AD_BADGE.test((element.textContent ?? '').trim()));
        if (badge) block.setAttribute(AD, '');
      }
    }
  }

  let foldScheduled = false;
  function foldMessages() {
    foldScheduled = false;
    hideAds();
    for (const element of document.querySelectorAll(USER_TEXT_SELECTOR)) {
      if (!isTypedText(element)) continue;
      if (element.closest(ANSWER_SELECTOR)) continue;
      const summary = summaryFor(element.textContent ?? '');
      if (!summary) continue;
      setFold(element, summary, element);
      if (!summary.question) markStep(element);
    }
    for (const answer of document.querySelectorAll(ANSWER_SELECTOR)) {
      const text = answer.textContent ?? '';
      for (const block of answer.querySelectorAll('pre')) {
        const code = block.querySelector('code')?.textContent ?? block.textContent ?? '';
        if (!code.trimStart().startsWith('<webmcp_tool_call>')) continue;
        setFold(block, { note: `🔧 ${toolName(code)}` }, answer);
        markStep(answer);
      }
      if (text.trimStart().startsWith('<webmcp_tool_call>') && !answer.querySelector('pre')) {
        setFold(answer, { note: `🔧 ${toolName(text)}` }, answer);
        markStep(answer);
      }
    }
  }

  function scheduleFold() {
    if (foldScheduled) return;
    foldScheduled = true;
    requestAnimationFrame(foldMessages);
  }

  document.addEventListener('click', (event) => {
    const folded = event.target?.closest?.(`[${FOLD}]`);
    if (!folded || window.getSelection()?.toString()) return;
    folded.toggleAttribute(OPEN);
  }, true);

  document.addEventListener('keydown', interceptSend, true);
  document.addEventListener('click', interceptSend, true);

  // In the panel, Work on/off is relayed by the panel page (the worker cannot message this frame).
  window.addEventListener('message', (event) => {
    if (!inPanel || event.source !== window.parent || event.origin !== EXTENSION_ORIGIN) return;
    if (event.data?.type === 'webmcp:work-changed') void arrive();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'work.changed') {
      void arrive();
      return false;
    }
    if (message?.type === 'assistant.health') {
      sendResponse?.({
        ok: true,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        generating: isGenerating(),
        path: location.pathname,
      });
      return false;
    }
    if (message?.type === 'assistant.action' && ['regenerate', 'share'].includes(message.action)) {
      sendResponse?.(pressAnswerControl(message.action));
      return false;
    }
    if (message?.type === 'assistant.prompt' && typeof message.text === 'string') {
      void sendAssistantPrompt(message.text, {
        withInstructions: message.withInstructions === true,
        pageNote: typeof message.pageNote === 'string' ? message.pageNote.slice(0, 600) : '',
      }).then(
        (result) => sendResponse?.(result),
        () => sendResponse?.({ ok: false, code: 'PROMPT_SEND_FAILED', message: 'ChatGPT prompt failed.' }),
      );
      return true;
    }
    return false;
  });

  // Live DOM 2026-09-15: a short reply showed the Stop icon for only ~680 ms,
  // between throttled timer ticks. Mutations catch that transient state; the
  // interval only advances time for the stable-text check after the DOM goes quiet.
  new MutationObserver(tick).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'd', 'data-testid', 'disabled', 'aria-label'],
  });
  setInterval(tick, POLL_MS);
})();
