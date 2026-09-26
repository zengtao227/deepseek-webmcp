// The page a browser task works on, and how it follows a click to another page.
//
// Part of the shared Browser Execution Plane (docs/browser-webmcp-platform-roadmap.md):
//   task target / handoff state -> runBrowserTool() -> browser-client.js -> target-executor.js
// The logic is the same as the ChatGPT Embedded Panel's service worker, kept apart from any model
// provider. The only input that differs per provider is which tab is "the page in front of the
// owner" (`activeTab`), so a later shared package needs no change here.
//
// The first browser tool call locks that page; the task then stays on it until the owner presses
// Stop. A click may hand the task over to the page it opens (same tab, new tab, popup), but only
// causally: Chrome must report the clicked page as the opener within a short lease.

import { callBrowserTool } from './browser-client.js';
import {
  TASK_KEY,
  attachablePageUrl,
  blockedTask,
  buildAttachedPage,
  claimHandoff,
  createHandoff,
  idleTask,
  lockedTask,
  normalizeTask,
} from './target-binding.js';

const HANDOFF_LEASE_MS = 1500;
const HANDOFF_DETECT_MS = 600;
const HANDOFF_SETTLE_MS = 5000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBrowserTask({ activeTab }) {
  if (typeof activeTab !== 'function') throw new TypeError('activeTab is required.');

  // The first browser tool call locks the page that is active in the assistant's window; the task
  // then stays on that page until the owner presses Stop. A click may hand the task over to the page
  // it opens (same tab, new tab, popup) but only causally, within a short lease.
  function handoffFresh(handoff) {
    return Boolean(handoff && Number.isFinite(handoff.issuedAt) && Date.now() - handoff.issuedAt <= HANDOFF_LEASE_MS);
  }

  const handoffClaimed = (handoff) => Number.isInteger(handoff?.destinationTabId);

  async function readTask() {
    const stored = await chrome.storage.session.get(TASK_KEY);
    return normalizeTask(stored[TASK_KEY]);
  }

  async function writeTask(task) {
    await chrome.storage.session.set({ [TASK_KEY]: task });
    return task;
  }

  const releaseTask = () => writeTask(idleTask());

  async function beginClickHandoff(target) {
    const task = await readTask();
    if (task.mode !== 'locked' || task.target.tabId !== target.tabId) return task;
    return writeTask(lockedTask(task.target, { parents: task.parents, handoff: createHandoff(task.target) }));
  }

  async function clearUnclaimedHandoff(tabId) {
    const task = await readTask();
    if (task.mode === 'locked' && task.target.tabId === tabId && task.handoff && !handoffClaimed(task.handoff)) {
      return writeTask(lockedTask(task.target, { parents: task.parents }));
    }
    return task;
  }

  async function waitForHandoffSettlement(task) {
    if (task.mode !== 'locked' || !handoffClaimed(task.handoff)) return task;
    const deadline = Date.now() + HANDOFF_SETTLE_MS;
    let current = task;
    while (Date.now() < deadline) {
      await delay(100);
      current = await readTask();
      if (current.mode !== 'locked' || !current.handoff) return current;
    }
    return current;
  }

  async function waitForPossibleHandoff(task) {
    if (task.mode !== 'locked' || !task.handoff || handoffClaimed(task.handoff) || !handoffFresh(task.handoff)) return task;

    const deadline = Math.min(task.handoff.issuedAt + HANDOFF_LEASE_MS, Date.now() + HANDOFF_DETECT_MS);
    let current = task;
    while (Date.now() < deadline) {
      await delay(50);
      current = await readTask();
      if (current.mode !== 'locked' || !current.handoff || handoffClaimed(current.handoff)) return current;
    }

    current = await readTask();
    if (current.mode === 'locked' && current.handoff && !handoffClaimed(current.handoff)) {
      return writeTask(lockedTask(current.target, { parents: current.parents }));
    }
    return current;
  }

  async function activePage() {
    const tab = await activeTab();
    return { tab: tab ?? null, target: buildAttachedPage(tab) };
  }

  async function ensureTargetExecutor(tabId) {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['target-executor.js'],
    });
    const frameIds = [...new Set((injected ?? [])
      .map((entry) => entry?.frameId)
      .filter((frameId) => Number.isInteger(frameId) && frameId >= 0))];
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'webmcp.browser.ping' }, { frameId: 0 });
    if (ping?.ok !== true || ping?.result?.ready !== true) throw new Error('Attached page executor did not answer.');
    if (!frameIds.includes(0)) frameIds.unshift(0);
    return frameIds;
  }

  async function targetStatus() {
    const [task, current] = await Promise.all([readTask(), activePage()]);
    return { ok: true, task, candidate: task.mode === 'idle' ? current.target : null };
  }

  async function blockCurrentTask(reason) {
    const task = await readTask();
    if (task.mode !== 'locked') return task;
    return writeTask(blockedTask(task.target, reason, { parents: task.parents }));
  }

  const targetError = (code, message) => ({ ok: false, error: { code, message } });
  const PAGE_UNAVAILABLE = () => targetError('PAGE_UNAVAILABLE', 'The current page cannot be used by Browser WebMCP.');

  async function targetForBrowserTool() {
    let task = await readTask();
    if (task.mode === 'blocked') {
      return targetError('TASK_BLOCKED', 'The page locked to this task is no longer available. Press Stop, then try again.');
    }

    if (task.mode === 'locked') {
      if (task.handoff && !handoffClaimed(task.handoff) && handoffFresh(task.handoff)) task = await waitForPossibleHandoff(task);

      if (handoffClaimed(task.handoff)) {
        task = await waitForHandoffSettlement(task);
        if (task.mode === 'blocked') return targetError('TASK_BLOCKED', 'Browser WebMCP could not complete the page handoff.');
        if (task.mode === 'locked' && handoffClaimed(task.handoff)) {
          return targetError('TASK_NAVIGATING', 'The page opened by the previous action is still loading.');
        }
      } else if (task.handoff && !handoffFresh(task.handoff)) {
        task = await writeTask(lockedTask(task.target, { parents: task.parents }));
      }
      if (task.mode === 'locked') return { ok: true, target: task.target };
    }

    const { target } = await activePage();
    if (!target) return PAGE_UNAVAILABLE();
    try {
      await ensureTargetExecutor(target.tabId);
    } catch {
      return PAGE_UNAVAILABLE();
    }
    await writeTask(lockedTask(target));
    return { ok: true, target };
  }

  async function runBrowserTool(call) {
    const selected = await targetForBrowserTool();
    if (!selected.ok) return { version: 1, id: call.id, ok: false, error: selected.error };

    if (call.name === 'click') await beginClickHandoff(selected.target);
    else await clearUnclaimedHandoff(selected.target.tabId);

    try {
      const frameIds = await ensureTargetExecutor(selected.target.tabId);
      const response = await callBrowserTool(selected.target.tabId, call, { frameIds });
      if (call.name === 'click' && response.ok !== true) await clearUnclaimedHandoff(selected.target.tabId);
      return response;
    } catch {
      if (call.name === 'click') {
        // The click may itself have navigated or opened the page the task now follows.
        await delay(100);
        const task = await readTask();
        const navigationObserved = task.mode === 'locked'
          && (task.target.tabId !== selected.target.tabId || handoffClaimed(task.handoff));
        if (navigationObserved) {
          return { version: 1, id: call.id, ok: true, result: { ref: call.arguments.ref, navigation: true } };
        }
      }
      await blockCurrentTask('PAGE_UNAVAILABLE');
      return {
        version: 1,
        id: call.id,
        ok: false,
        error: { code: 'TASK_BLOCKED', message: 'The page locked to this task became unavailable.' },
      };
    }
  }

  async function adoptTab(task, tab, { pushCurrent = false } = {}) {
    const target = buildAttachedPage(tab);
    if (!target) return null;
    try {
      await ensureTargetExecutor(target.tabId);
    } catch {
      return null;
    }
    const parents = pushCurrent ? [...(task.parents ?? []), task.target].slice(-12) : (task.parents ?? []);
    return writeTask(lockedTask(target, { parents }));
  }

  async function considerChildHandoff(tab) {
    if (!Number.isInteger(tab?.id)) return false;
    let task = await readTask();
    if (task.mode !== 'locked' || !task.handoff) return false;

    const alreadyClaimed = task.handoff.destinationTabId === tab.id;
    const causallyOpened = !handoffClaimed(task.handoff)
      && handoffFresh(task.handoff)
      && tab.openerTabId === task.handoff.sourceTabId;
    if (!alreadyClaimed && !causallyOpened) return false;

    if (!alreadyClaimed) {
      const claimed = claimHandoff(task.handoff, tab.id, tab.url ?? null);
      task = await writeTask(lockedTask(task.target, { parents: task.parents, handoff: claimed }));
    }
    if (tab.status !== 'complete') return true;

    if (await adoptTab(task, tab, { pushCurrent: true })) return true;
    const rawUrl = typeof tab.url === 'string' ? tab.url : '';
    if (rawUrl && rawUrl !== 'about:blank') {
      await writeTask(blockedTask(task.target, 'HANDOFF_UNSUPPORTED', { parents: task.parents }));
    }
    return true;
  }

  async function handleTargetTabUpdate(tabId, changeInfo, tab) {
    let task = await readTask();
    if (task.mode !== 'locked' || task.target.tabId !== tabId) return;

    if (typeof changeInfo.url === 'string') {
      const next = attachablePageUrl(changeInfo.url);
      if (!next) {
        const causal = task.handoff
          && task.handoff.sourceTabId === tabId
          && (handoffFresh(task.handoff) || task.handoff.destinationTabId === tabId);
        await writeTask(blockedTask(task.target, causal ? 'HANDOFF_UNSUPPORTED' : 'ORIGIN_CHANGED', { parents: task.parents }));
        return;
      }

      if (next.origin !== task.target.origin) {
        const canHandoff = task.handoff
          && task.handoff.sourceTabId === tabId
          && (task.handoff.destinationTabId === tabId || (!handoffClaimed(task.handoff) && handoffFresh(task.handoff)));
        if (!canHandoff) {
          await writeTask(blockedTask(task.target, 'ORIGIN_CHANGED', { parents: task.parents }));
          return;
        }
        if (task.handoff.destinationTabId !== tabId) {
          task = await writeTask(lockedTask(task.target, {
            parents: task.parents,
            handoff: claimHandoff(task.handoff, tabId, changeInfo.url),
          }));
        }
      }
    }

    if (changeInfo.status !== 'complete') return;
    task = await readTask();
    if (task.mode !== 'locked' || task.target.tabId !== tabId) return;

    if (task.handoff?.destinationTabId === tabId) {
      if (!(await adoptTab(task, tab))) {
        await writeTask(blockedTask(task.target, 'HANDOFF_UNSUPPORTED', { parents: task.parents }));
      }
      return;
    }

    try {
      await ensureTargetExecutor(tabId);
      const refreshed = buildAttachedPage(tab);
      if (refreshed) await writeTask(lockedTask(refreshed, { parents: task.parents }));
    } catch {
      await writeTask(blockedTask(task.target, 'PAGE_UNAVAILABLE', { parents: task.parents }));
    }
  }

  async function restoreParentAfterClose(task) {
    const parents = [...(task.parents ?? [])];
    while (parents.length > 0) {
      const parent = parents.pop();
      try {
        const restored = buildAttachedPage(await chrome.tabs.get(parent.tabId));
        if (!restored) continue;
        await ensureTargetExecutor(restored.tabId);
        return writeTask(lockedTask(restored, { parents }));
      } catch {
        // Try the next surviving ancestor.
      }
    }
    return writeTask(blockedTask(task.target, 'TAB_CLOSED', { parents: [] }));
  }

  async function handleTaskTabRemoved(tabId) {
    const task = await readTask();
    if (!['locked', 'blocked'].includes(task.mode)) return;

    if (task.target.tabId === tabId) {
      if ((task.parents ?? []).length > 0) await restoreParentAfterClose(task);
      else await writeTask(blockedTask(task.target, 'TAB_CLOSED', { parents: [] }));
      return;
    }
    if (task.mode === 'locked' && task.handoff?.destinationTabId === tabId) {
      await writeTask(lockedTask(task.target, { parents: task.parents }));
      return;
    }
    if ((task.parents ?? []).some((parent) => parent.tabId === tabId)) {
      const parents = task.parents.filter((parent) => parent.tabId !== tabId);
      if (task.mode === 'locked') await writeTask(lockedTask(task.target, { parents, handoff: task.handoff }));
      else await writeTask(blockedTask(task.target, task.reason, { parents }));
    }
  }

  return Object.freeze({
    readTask,
    releaseTask,
    targetStatus,
    runBrowserTool,
    considerChildHandoff,
    handleTargetTabUpdate,
    handleTaskTabRemoved,
  });
}
