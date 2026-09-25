// Copied unchanged from chatgpt-embedded-panel frame-policy.js (the proven ChatGPT Side Panel).
export const FRAME_POLICY_RULE_ID = 42001;

export function buildFramePolicyRule(runtimeId) {
  if (typeof runtimeId !== 'string' || !runtimeId) {
    throw new TypeError('Extension runtime id is required.');
  }

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

export async function enableFramePolicy() {
  const rule = buildFramePolicyRule(chrome.runtime.id);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [FRAME_POLICY_RULE_ID],
    addRules: [rule],
  });
  return { enabled: true, rule };
}

export async function disableFramePolicy() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [FRAME_POLICY_RULE_ID],
  });
  return { enabled: false, rule: null };
}

export async function framePolicyStatus() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const rule = rules.find((candidate) => candidate.id === FRAME_POLICY_RULE_ID) ?? null;
  return { enabled: Boolean(rule), rule };
}

// The embedded ChatGPT frame has no tab, so it is keyed by this pseudo tab id. One id serves the
// POC: two windows with ChatGPT panels open at once would share it.
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
