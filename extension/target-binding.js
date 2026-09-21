export const TASK_KEY = 'webmcp.pageTask';
export const MAX_PARENT_TARGETS = 12;

export function attachablePageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.origin === 'https://chat.deepseek.com') return null;
    return url;
  } catch {
    return null;
  }
}

export function buildAttachedPage(tab) {
  const url = attachablePageUrl(tab?.url);
  if (!Number.isInteger(tab?.id) || !url) return null;
  return Object.freeze({
    tabId: tab.id,
    origin: url.origin,
    title: String(tab.title || url.hostname).replace(/\s+/g, ' ').trim().slice(0, 200),
  });
}

function validTarget(target) {
  return Boolean(
    target
    && Number.isInteger(target.tabId)
    && typeof target.origin === 'string'
    && typeof target.title === 'string',
  );
}

function normalizeParents(parents) {
  if (!Array.isArray(parents)) return [];
  return parents
    .filter(validTarget)
    .slice(-MAX_PARENT_TARGETS)
    .map((target) => Object.freeze({
      tabId: target.tabId,
      origin: target.origin,
      title: target.title,
    }));
}

function normalizeHandoff(handoff, target) {
  if (!handoff || typeof handoff !== 'object') return null;
  if (!Number.isInteger(handoff.sourceTabId) || handoff.sourceTabId !== target.tabId) return null;
  if (!Number.isFinite(handoff.issuedAt) || handoff.issuedAt <= 0) return null;

  const destinationTabId = Number.isInteger(handoff.destinationTabId)
    ? handoff.destinationTabId
    : null;
  const destinationUrl = typeof handoff.destinationUrl === 'string'
    ? handoff.destinationUrl.slice(0, 4096)
    : null;

  return Object.freeze({
    sourceTabId: handoff.sourceTabId,
    issuedAt: handoff.issuedAt,
    destinationTabId,
    destinationUrl,
  });
}

export function createHandoff(target, issuedAt = Date.now()) {
  if (!validTarget(target) || !Number.isFinite(issuedAt) || issuedAt <= 0) {
    throw new TypeError('A valid handoff source and timestamp are required.');
  }
  return Object.freeze({
    sourceTabId: target.tabId,
    issuedAt,
    destinationTabId: null,
    destinationUrl: null,
  });
}

export function claimHandoff(handoff, destinationTabId, destinationUrl = null) {
  if (!handoff || !Number.isInteger(handoff.sourceTabId) || !Number.isFinite(handoff.issuedAt)) {
    throw new TypeError('A valid handoff lease is required.');
  }
  if (!Number.isInteger(destinationTabId)) throw new TypeError('A destination tab id is required.');
  return Object.freeze({
    sourceTabId: handoff.sourceTabId,
    issuedAt: handoff.issuedAt,
    destinationTabId,
    destinationUrl: typeof destinationUrl === 'string' ? destinationUrl.slice(0, 4096) : null,
  });
}

export function idleTask() {
  return Object.freeze({ mode: 'idle', target: null, reason: null });
}

export function lockedTask(target, { parents = [], handoff = null } = {}) {
  if (!validTarget(target)) throw new TypeError('A valid attached page is required.');
  return Object.freeze({
    mode: 'locked',
    target,
    reason: null,
    parents: Object.freeze(normalizeParents(parents)),
    handoff: normalizeHandoff(handoff, target),
  });
}

export function blockedTask(target, reason, { parents = [] } = {}) {
  if (!validTarget(target)) throw new TypeError('A valid attached page is required.');
  return Object.freeze({
    mode: 'blocked',
    target,
    reason: typeof reason === 'string' && reason ? reason : 'PAGE_UNAVAILABLE',
    parents: Object.freeze(normalizeParents(parents)),
    handoff: null,
  });
}

export function normalizeTask(value) {
  if (!value || typeof value !== 'object') return idleTask();
  if (value.mode === 'idle') return idleTask();
  if ((value.mode === 'locked' || value.mode === 'blocked') && validTarget(value.target)) {
    return value.mode === 'locked'
      ? lockedTask(value.target, { parents: value.parents, handoff: value.handoff })
      : blockedTask(value.target, value.reason, { parents: value.parents });
  }
  return idleTask();
}
