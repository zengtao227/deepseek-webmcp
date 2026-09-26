// Shared frame policy copied from chatgpt-embedded-panel; DeepSeek-only helpers are appended below.
export const FRAME_POLICY_RULE_ID = 42001;
export const SANDBOX_FRAME_POLICY_RULE_ID = 42002;

// The Content-Security-Policy OpenAI serves for ChatGPT HTML previews (captured from the live
// response on 2026-09-26). Its frame-ancestors check covers every ancestor, and in the Side Panel
// the outermost one is this extension's page. The rewrite applies only while OpenAI serves exactly
// this policy; any change fails closed (no preview) instead of guessing.
export const OPENAI_SANDBOX_CSP = "frame-ancestors 'self' https://chatgpt.com https://app.chatgpt.com https://app.chatgpt-staging.com https://tt.chatgpt.com https://feather.openai.com https://web-search-evals-feather-render.gateway.unified-0.api.openai.com https://preview-web-renderer.feathertasks.com http://localhost:* app://- https://*.openai.org https://featherstorageprod-dveschgjgvehgbh3.z01.azurefd.net https://featherstorageqa-ehffhzdzgqgqevdy.z01.azurefd.net https://skybridge.oaistatic.com chrome-extension://lfkehkpjohcoelkpembgemeipeppanef; frame-src 'self' https: data: blob:; sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms";

// The same policy with this extension added to frame-ancestors; every other directive, frame-src
// and sandbox included, stays exactly as OpenAI sent it.
export function withExtensionAncestor(csp, runtimeId) {
  return csp.split('; ').map((directive) => (directive.startsWith('frame-ancestors ')
    ? `${directive} chrome-extension://${runtimeId}`
    : directive)).join('; ');
}

function requireRuntimeId(runtimeId) {
  if (typeof runtimeId !== 'string' || !runtimeId) {
    throw new TypeError('Extension runtime id is required.');
  }
}

export function buildFramePolicyRule(runtimeId) {
  requireRuntimeId(runtimeId);
  return {
    id: FRAME_POLICY_RULE_ID,
    priority: 100,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    condition: {
      requestDomains: ['chatgpt.com'],
      initiatorDomains: [runtimeId],
      resourceTypes: ['sub_frame'],
    },
  };
}

export function buildSandboxFramePolicyRule(runtimeId) {
  requireRuntimeId(runtimeId);
  return {
    id: SANDBOX_FRAME_POLICY_RULE_ID,
    priority: 110,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [{
        header: 'content-security-policy',
        operation: 'set',
        value: withExtensionAncestor(OPENAI_SANDBOX_CSP, runtimeId),
      }],
    },
    condition: {
      regexFilter: '^https://codex-inline-visualization-[a-f0-9]+\\.web-sandbox\\.oaiusercontent\\.com/',
      requestDomains: ['web-sandbox.oaiusercontent.com'],
      initiatorDomains: ['chatgpt.com', 'web-sandbox.oaiusercontent.com'],
      resourceTypes: ['sub_frame'],
      responseHeaders: [{
        header: 'content-security-policy',
        values: [OPENAI_SANDBOX_CSP],
      }],
    },
  };
}

export async function enableFramePolicy() {
  const rule = buildFramePolicyRule(chrome.runtime.id);
  const sandboxRule = buildSandboxFramePolicyRule(chrome.runtime.id);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [FRAME_POLICY_RULE_ID, SANDBOX_FRAME_POLICY_RULE_ID],
    addRules: [rule, sandboxRule],
  });
  return { enabled: true, rule, sandboxRule };
}

export async function disableFramePolicy() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [FRAME_POLICY_RULE_ID, SANDBOX_FRAME_POLICY_RULE_ID],
  });
  return { enabled: false, rule: null, sandboxRule: null };
}

export async function framePolicyStatus() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const rule = rules.find((candidate) => candidate.id === FRAME_POLICY_RULE_ID) ?? null;
  const sandboxRule = rules.find((candidate) => candidate.id === SANDBOX_FRAME_POLICY_RULE_ID) ?? null;
  return { enabled: Boolean(rule && sandboxRule), rule, sandboxRule };
}

// DeepSeek Web Provider local addition: the embedded ChatGPT frame has no tab, so it is keyed by
// this pseudo tab id. One id serves the current POC; two panel windows would share it.
export const PANEL_ID = -2;

// A message from the panel frame: no sender.tab, sent by the content script in a chatgpt.com
// frame. `href` is the frame's own location.href (sender.url goes stale after SPA route changes);
// it must be on the sender's origin.
export function panelFrameHref(sender, href) {
  if (!sender || sender.tab || sender.origin !== 'https://chatgpt.com' || typeof href !== 'string') return null;
  try {
    const url = new URL(href);
    return url.origin === sender.origin ? url.href : null;
  } catch {
    return null;
  }
}
