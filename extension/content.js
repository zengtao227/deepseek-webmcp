(() => {
  'use strict';

  const ORIGIN = 'https://chat.deepseek.com';
  // Live DOM 2026-09-15: the final answer carries `ds-assistant-message-main-content`;
  // the reasoning block's own `.ds-markdown` inside `.ds-think-content` does not.
  const ANSWER_SELECTOR = '.ds-markdown.ds-assistant-message-main-content';
  const REASONING_SELECTOR = '.ds-think-content';
  const COMPOSER_SELECTOR = 'textarea[placeholder]';
  // Single send/stop control; disabled state is a class, not the `disabled` attribute.
  const SEND_SELECTOR = 'div[role="button"].ds-button--primary.ds-button--circle';
  const DISABLED_CLASS = 'ds-button--disabled';
  const CONVERSATION_PATH = /^\/a\/chat\/s\/[^/]+$/;
  const POLL_MS = 500;
  // Reasoning models can pause mid-turn; require the answer text to stay unchanged.
  const STABLE_MS = 2000;
  const SEND_ENABLE_WAIT_MS = 3000;
  const SEND_CONFIRM_WAIT_MS = 5000;

  if (location.origin !== ORIGIN) return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const composer = () => document.querySelector(COMPOSER_SELECTOR);
  const sendControl = () => document.querySelector(SEND_SELECTOR);

  // DeepSeek reuses one circle control for Send and Stop. Enabled state alone is
  // ambiguous, so generation is keyed to the Stop icon path inside that control:
  // present in Better DeepSeek v0.1.13 (`path[d*="M2 4.88"]`) and confirmed live
  // 2026-09-15 (Finding 11). No `ds-icon-stop*` class exists on the live page.
  function isGenerating() {
    const control = sendControl();
    if (!control) return false;
    return control.querySelector('path[d^="M2 4.88"]') !== null;
  }

  function latestAnswer() {
    const answers = document.querySelectorAll(ANSWER_SELECTOR);
    return answers.length > 0 ? answers[answers.length - 1] : null;
  }

  function latestReasoning() {
    const blocks = document.querySelectorAll(REASONING_SELECTOR);
    return blocks.length > 0 ? blocks[blocks.length - 1] : null;
  }

  function panelAnswerText() {
    const answer = latestAnswer();
    if (!answer) return '';
    const text = answer.textContent ?? '';
    if (/webmcp_tool_call|｜\s*DSML\s*｜/i.test(text)) return '';
    for (const block of answer.querySelectorAll?.('.md-code-block') ?? []) {
      if ((block.querySelector?.('pre')?.textContent ?? '').includes('<webmcp_tool_call>')) return '';
    }
    return text;
  }


  // ---- Answer structure for the Side Panel (limits are enforced again in answer-blocks.js) ----
  // The panel never receives DeepSeek's HTML, classes or styles: only paragraphs, headings, lists,
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
    return { type: 'code', lang: language?.[1] ?? '', text: pre.textContent ?? '' };
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
      } else if (classesOf(child).includes('md-code-block')) {
        // The banner around DeepSeek's code block holds its Copy/Download labels, not answer text.
        const pre = child.querySelector?.('pre');
        if (pre) blocks.push(codeBlock(pre));
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

  function writeComposer(input, text) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, text);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return input.value === text;
  }

  async function sendText(text) {
    const input = composer();
    if (!input) return { ok: false, code: 'COMPOSER_NOT_FOUND' };
    if (!writeComposer(input, text)) return { ok: false, code: 'COMPOSER_WRITE_FAILED' };

    const enableDeadline = Date.now() + SEND_ENABLE_WAIT_MS;
    let control = sendControl();
    while (!control || control.classList.contains(DISABLED_CLASS)) {
      if (Date.now() > enableDeadline) return { ok: false, code: control ? 'SEND_DISABLED' : 'SEND_BUTTON_NOT_FOUND' };
      await sleep(100);
      control = sendControl();
    }
    const startPath = location.pathname;
    const wasGenerating = isGenerating();
    control.click();

    // Live 2026-09-20: DeepSeek accepted and answered a prompt while this textarea kept its
    // value, so an empty composer alone cannot be the only acknowledgement.
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
      void chrome.runtime.sendMessage({ type: 'work.generating' }).catch(() => {});
    } catch {
      // Extension context gone; nothing to notify.
    }
  }

  function sendAcknowledged(input, startPath, wasGenerating) {
    if (input.value === '') return true;
    if (input.isConnected === false) return true;
    if (!wasGenerating && isGenerating()) return true;
    return location.pathname !== startPath && CONVERSATION_PATH.test(location.pathname);
  }


  // ---- Regenerate / Share: press DeepSeek's own control under the latest answer ----
  // UNVERIFIED against the live DOM: DeepSeek's action bar is icon-only, so controls are matched
  // by aria-label/title/text. When nothing matches, the reply lists what was found (structure only,
  // no page text) so the real selector can be taken from a live run.
  // Live 2026-09-21: the action bar's icon buttons are `div.ds-button.ds-button--iconLabelTertiary`,
  // which need not carry role="button", so `.ds-button` is a candidate on its own.
  const ACTION_CONTROL_SELECTOR = 'button, div[role="button"], .ds-icon-button, .ds-button';
  const ACTION_LABELS = {
    regenerate: /regenerate|retry|重新生成|重试|重新回答/i,
    share: /share|分享/i,
  };
  // Live 2026-09-21 (diagnostic from a real DeepSeek run): the action bar is six icon-only buttons
  // (copy, regenerate, like, dislike, read aloud, share), one of them named only by aria-label.
  // Regenerate and Share are recognised by their exact icon: viewBox plus the single full path
  // (582 and 894 characters, both captured untruncated). Position is never used.
  const ACTION_ICONS = {
    regenerate: {
      viewBox: '0 0 16 16',
      path: 'M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z',
    },
    share: {
      viewBox: '0 0 16 16',
      path: 'M7.95889 1.52285C7.95888 0.826234 8.76055 0.467983 9.27669 0.875208L9.37524 0.967191L15.1317 7.18358C15.5582 7.64419 15.5582 8.35614 15.1317 8.81676L9.37524 15.0331C8.87034 15.578 7.95888 15.2205 7.95889 14.4775V10.8207C7.10614 10.8432 6.31361 10.9316 5.45468 11.2515C4.39484 11.6463 3.18248 12.413 1.64676 13.9425C1.4533 14.135 1.18329 14.1696 0.969086 14.0908C0.74748 14.0091 0.547307 13.7879 0.54859 13.4844L0.55516 13.1315C0.618924 11.3494 1.11153 9.29838 2.27656 7.63787C3.45289 5.96147 5.29554 4.71635 7.95889 4.54797V1.52285ZM9.20911 5.13366C9.20899 5.50567 8.9031 5.77687 8.56523 5.77755C5.99383 5.78282 4.33736 6.8762 3.29964 8.35496C2.54519 9.43014 2.10739 10.7283 1.9152 11.9939C3.04749 11.0323 4.0569 10.4385 5.01917 10.0801C6.29638 9.60449 7.4406 9.56343 8.56429 9.56295C8.9178 9.5628 9.20894 9.84909 9.20911 10.2068L9.20817 13.3737L14.1837 8.00017L9.20817 2.62571L9.20911 5.13366Z',
    },
  };
  const controlLabel = (control) => `${control.getAttribute?.('aria-label') ?? ''} ${control.getAttribute?.('title') ?? ''} ${control.textContent ?? ''}`.trim();

  // `scope` and `level` only feed the failure diagnostic; which controls are candidates is unchanged.
  function answerControls() {
    const answer = latestAnswer();
    if (!answer) return { controls: [], scope: null, level: 0, answer: null };
    const send = sendControl();
    let scope = answer.parentElement ?? null;
    for (let level = 0; scope && level < 8; level += 1, scope = scope.parentElement) {
      const found = [...scope.querySelectorAll(ACTION_CONTROL_SELECTOR)]
        .filter((control) => !answer.contains(control) && control !== send && !send?.contains?.(control));
      if (found.length > 0) return { controls: found, scope, level, answer };
    }
    return { controls: [], scope: null, level: 0, answer };
  }

  function describeControl(control) {
    const classes = classesOf(control).filter(Boolean).slice(0, 2).join('.');
    const label = controlLabel(control).slice(0, 24);
    const path = control.querySelector?.('path')?.getAttribute?.('d')?.slice(0, 12) ?? '';
    return `${tagOf(control).toLowerCase()}.${classes}[${label}|${path}]`;
  }

  // ---- Failure diagnostic: enough structure to tell DeepSeek's icon-only buttons apart ----
  // Only the controls of the latest answer's action bar are described, and only attributes of the
  // controls themselves: never the answer, the prompt, URLs, or long identifier-like values.
  const DIAG_FIELD_MAX = 120;
  const DIAG_TEXT_MAX = 40;
  const DIAG_PATH_MAX = 1200;
  const DIAG_EXTRA_PATH_MAX = 400;
  const DIAG_EXTRA_PATHS = 3;
  const DIAG_LEVELS = 8;
  const DIAG_MAX_CONTROLS = 16;
  const DIAG_MAX_DATA_ATTRIBUTES = 6;
  const DIAG_MAX_CHARS = 16000;
  const boundedField = (value, max = DIAG_FIELD_MAX) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  // Conversation ids, message ids, tokens and URLs can hide in data-* values.
  const opaqueValue = (value) => (/:\/\/|\/|[0-9a-f]{8}-[0-9a-f]{4}|[A-Za-z0-9_-]{24,}/.test(value) ? '[redacted]' : value);
  const classSummary = (node) => boundedField(node?.getAttribute?.('class'), 200);
  const tagClass = (node) => (node ? `${tagOf(node).toLowerCase()}.${classSummary(node)}` : '');

  function controlDiagnostic(control, index) {
    const svg = control.querySelector?.('svg') ?? null;
    const paths = svg?.querySelectorAll?.('path') ?? [];
    const data = {};
    for (const attribute of [...(control.attributes ?? [])]) {
      if (!attribute.name.startsWith('data-') || Object.keys(data).length >= DIAG_MAX_DATA_ATTRIBUTES) continue;
      data[boundedField(attribute.name, 40)] = opaqueValue(boundedField(attribute.value, 60));
    }
    return {
      index,
      tag: tagOf(control).toLowerCase(),
      class: classSummary(control),
      role: boundedField(control.getAttribute?.('role'), 40),
      ariaLabel: boundedField(control.getAttribute?.('aria-label')),
      title: boundedField(control.getAttribute?.('title')),
      text: boundedField(control.textContent, DIAG_TEXT_MAX),
      ariaDescribedby: boundedField(control.getAttribute?.('aria-describedby'), 80),
      ariaLabelledby: boundedField(control.getAttribute?.('aria-labelledby'), 80),
      data,
      parent: tagClass(control.parentElement),
      svg: svg ? {
        viewBox: boundedField(svg.getAttribute?.('viewBox'), 40),
        pathCount: paths.length,
        path: boundedField(paths[0]?.getAttribute?.('d'), DIAG_PATH_MAX),
        // A cut path is flagged, so a prefix is never mistaken for the whole icon.
        pathLength: String(paths[0]?.getAttribute?.('d') ?? '').length,
        pathTruncated: String(paths[0]?.getAttribute?.('d') ?? '').length > DIAG_PATH_MAX,
        extraPaths: [...paths].slice(1, 1 + DIAG_EXTRA_PATHS).map((path) => boundedField(path.getAttribute?.('d'), DIAG_EXTRA_PATH_MAX)),
      } : null,
    };
  }

  // The ancestors above the answer, with how many controls and answers each holds: this shows where
  // the action bar really sits, and whether the chosen scope is wide enough to include older answers.
  function ancestryDiagnostic(answer) {
    const levels = [];
    let node = answer?.parentElement ?? null;
    for (let level = 0; node && level < DIAG_LEVELS; level += 1, node = node.parentElement) {
      levels.push({
        level,
        element: tagClass(node),
        controls: node.querySelectorAll(ACTION_CONTROL_SELECTOR).length,
        answers: node.querySelectorAll(ANSWER_SELECTOR).length,
      });
    }
    return levels;
  }

  function actionDiagnostic(action, { controls, scope, level, answer }) {
    const diagnostic = {
      action,
      scope: scope ? { element: tagClass(scope), level } : null,
      ancestry: ancestryDiagnostic(answer),
      count: controls.length,
      controls: controls.slice(0, DIAG_MAX_CONTROLS).map(controlDiagnostic),
      truncated: controls.length > DIAG_MAX_CONTROLS,
    };
    // Drop trailing controls rather than emit an unbounded message from a malformed page.
    while (JSON.stringify(diagnostic).length > DIAG_MAX_CHARS && diagnostic.controls.length > 1) {
      diagnostic.controls.pop();
      diagnostic.truncated = true;
    }
    return diagnostic;
  }

  function hasActionIcon(control, action) {
    const icon = ACTION_ICONS[action];
    const svg = control.querySelector?.('svg');
    const paths = svg?.querySelectorAll?.('path') ?? [];
    return Boolean(icon && svg)
      && svg.getAttribute?.('viewBox') === icon.viewBox
      && paths.length === 1
      && paths[0].getAttribute?.('d') === icon.path;
  }

  // Exactly one control may match, by its name if it has one, otherwise by its icon. Zero or several
  // matches, or a scope that also holds an older answer, fail with the diagnostic and click nothing.
  function pressAnswerControl(action) {
    if (isGenerating()) return { ok: false, code: 'GENERATION_IN_PROGRESS', message: 'DeepSeek is still generating.' };
    const found = answerControls();
    const { controls } = found;
    const named = controls.filter((candidate) => ACTION_LABELS[action]?.test(controlLabel(candidate)));
    const hits = named.length > 0 ? named : controls.filter((candidate) => hasActionIcon(candidate, action));
    const ambiguousScope = found.scope !== null && found.scope.querySelectorAll(ANSWER_SELECTOR).length > 1;
    const control = hits.length === 1 && !ambiguousScope ? hits[0] : null;
    if (!control) {
      // The side panel notice holds ~500 characters; the full detail is returned here and also
      // logged once in this tab's console so it can be copied from DevTools.
      const diagnostics = actionDiagnostic(action, found);
      if (typeof console !== 'undefined') console.info('[WebMCP] action control diagnostic', JSON.stringify(diagnostics));
      return {
        ok: false,
        code: 'CONTROL_NOT_FOUND',
        message: `DeepSeek ${action} control not found. Controls seen: ${controls.slice(0, 8).map(describeControl).join(' ') || 'none'}`.slice(0, 480),
        diagnostics,
      };
    }
    if (classesOf(control).some((name) => name.endsWith('--disabled'))) {
      return { ok: false, code: 'CONTROL_DISABLED', message: `DeepSeek ${action} is not available for this answer.` };
    }
    control.click();
    return { ok: true, code: 'ACTION_CLICKED' };
  }

  // Background only hands out a result for the conversation that produced it; the
  // page re-checks that the same conversation is still displayed before typing.
  async function deliver(reply) {
    if (typeof reply?.continueWith !== 'string' || reply.conversationPath !== location.pathname) return;
    const result = await sendText(reply.continueWith);
    await chrome.runtime.sendMessage({ type: 'work.continuation-result', result, conversationPath: reply.conversationPath }).catch(() => {});
  }

  const INSTRUCTIONS_START = 'You can use owner-approved tools through WebMCP';

  // `force` is for the assistant's first prompt of a session: the provider may reopen on a
  // conversation that never received the tool contract, where isNewChat() is false.
  function userTextWithInstructions(text, { force = false } = {}) {
    const clean = String(text ?? '').trimEnd();
    if (!clean || instructions === null || clean.includes(INSTRUCTIONS_START)) return clean;
    if (!force && !isNewChat()) return clean;
    return `${clean}\n\n${instructions}`;
  }

  async function sendAssistantPrompt(text, { withInstructions = false, pageNote = '' } = {}) {
    if (isGenerating()) return { ok: false, code: 'GENERATION_IN_PROGRESS', message: 'DeepSeek is still generating.' };
    if (instructions === null) await arrive();
    if (instructions === null) return { ok: false, code: 'WORK_OFF', message: 'DeepSeek Work is not active.' };

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

  function isNewChat() {
    return !CONVERSATION_PATH.test(location.pathname) && latestAnswer() === null;
  }

  // In a Work tab, the user's first message of a new chat is sent with the tool
  // instructions after it, so the composer stays clean while typing and the question
  // stays visible when DeepSeek collapses long messages. Enter during IME composition
  // (e.g. Chinese input) is never treated as Send.
  function interceptSend(event) {
    if (ownSend || instructions === null || !isNewChat()) return;
    const input = composer();
    if (!input || input.value.trim() === '' || input.value.includes(INSTRUCTIONS_START)) return;
    if (event.type === 'keydown') {
      if (event.target !== input || event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    } else if (!event.target?.closest?.(SEND_SELECTOR)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const text = userTextWithInstructions(input.value);
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
      const reply = await chrome.runtime.sendMessage({ type: 'work.arrive' });
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
      const reply = await chrome.runtime.sendMessage({ type: 'work.completion', text, resume });
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
      void chrome.runtime.sendMessage({
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
    if (text !== lastText) {
      lastText = text;
      changedAt = now;
      return;
    }
    if (now - changedAt < STABLE_MS) return;

    const resume = !sawGeneration && !awaited;
    sawGeneration = false;
    ownReplyPending = false;
    resumeCheck = false;
    lastText = null;
    void report(text, resume);
  }

  // Display only. DeepSeek Web has no hidden instruction channel, so instructions, tool
  // results and tool calls must be real message text; here they are folded into a one-line
  // summary (click to expand). Only data attributes and CSS are used: the text and DOM that
  // DeepSeek's page owns, and the answer text WebMCP reads, stay unchanged.
  const FOLD = 'data-webmcp-fold';
  const OPEN = 'data-webmcp-open';
  const QUESTION = 'data-webmcp-question';
  const COLOR = '--webmcp-fold-color';
  const RESULT_START = 'WebMCP tool result.\n';
  const CORRECTION_START = 'WebMCP format correction.\n';
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

  let foldScheduled = false;
  function foldMessages() {
    foldScheduled = false;
    // Messages the extension typed: a single text node inside one element (live DOM:
    // a visible <span> plus a hidden <div> copy of each user message).
    for (const element of document.querySelectorAll('div, span')) {
      if (element.childNodes.length !== 1 || element.firstChild.nodeType !== Node.TEXT_NODE) continue;
      if (element.closest(ANSWER_SELECTOR)) continue;
      const summary = summaryFor(element.firstChild.nodeValue ?? '');
      // Fold the whole bubble: DeepSeek's own collapsible box inside it keeps a fixed height.
      if (summary) setFold(element.closest('.ds-message') ?? element, summary, element);
    }
    for (const answer of document.querySelectorAll(ANSWER_SELECTOR)) {
      const text = answer.textContent ?? '';
      if (/｜\s*DSML\s*｜/.test(text)) {
        setFold(answer, { note: '🔧 DeepSeek used its own tool format (not run)' }, answer);
        continue;
      }
      for (const block of answer.querySelectorAll('.md-code-block')) {
        const code = block.querySelector('pre')?.textContent ?? '';
        if (code.trimStart().startsWith('<webmcp_tool_call>')) setFold(block, { note: `🔧 ${toolName(code)}` }, answer);
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
        () => sendResponse?.({ ok: false, code: 'PROMPT_SEND_FAILED', message: 'DeepSeek prompt failed.' }),
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
    attributeFilter: ['class', 'd'],
  });
  setInterval(tick, POLL_MS);
})();
