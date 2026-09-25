// Runs in the page's MAIN world (no chrome.* here) so it can wrap the page's own fetch.
// It only reads model-name fields from the assistant response stream. Answer text is never
// parsed into a value, stored or forwarded; the relay in embedded-chatgpt.js forwards the result.
(() => {
  'use strict';

  const NAMESPACE = 'chatgpt-embedded-panel:model';
  const CONVERSATION_PATH = /^\/backend-api(\/f)?\/conversation$/;
  const SLUG = /^[A-Za-z0-9._:-]{1,64}$/;
  const MAX_LINE_CHARS = 1_000_000;
  // A server_ste_metadata frame outranks the per-message fallback: it is the one top-level
  // frame the server emits about the turn itself.
  const RANK = { 'message.metadata.resolved_model_slug': 1, 'server_ste_metadata.model_slug': 2 };

  if (window.top === window || !String(location.ancestorOrigins?.[0] ?? '').startsWith('chrome-extension://')) return;

  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;

  function slugOrNull(value) {
    return typeof value === 'string' && SLUG.test(value) ? value : null;
  }

  function emit(payload) {
    window.postMessage({ source: NAMESPACE, ...payload }, location.origin);
  }

  function isConversationPost(input, init) {
    try {
      const method = String(init?.method ?? (typeof input === 'object' ? input?.method : '') ?? 'GET').toUpperCase();
      if (method !== 'POST') return false;
      const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input), location.href);
      return url.origin === location.origin && CONVERSATION_PATH.test(url.pathname);
    } catch {
      return false;
    }
  }

  // Only these two request fields are read; the rest of the body (the prompt) is never looked at.
  function requestedOf(init) {
    if (typeof init?.body !== 'string') return { model: null, effort: null };
    try {
      const body = JSON.parse(init.body);
      return { model: slugOrNull(body?.model), effort: slugOrNull(body?.thinking_effort) };
    } catch {
      return { model: null, effort: null };
    }
  }

  // Returns { model, sourceField, effort } for a frame; each part is null when the frame lacks it.
  function extractFrame(frame) {
    if (frame?.type === 'server_ste_metadata') {
      const model = slugOrNull(frame.metadata?.model_slug);
      return { model, sourceField: model && 'server_ste_metadata.model_slug', effort: null };
    }
    const message = frame?.v?.message;
    if (message?.author?.role !== 'assistant') return { model: null, sourceField: null, effort: null };
    const model = slugOrNull(message.metadata?.resolved_model_slug);
    return {
      model,
      sourceField: model && 'message.metadata.resolved_model_slug',
      effort: slugOrNull(message.metadata?.thinking_effort),
    };
  }

  async function watchStream(response, turnId) {
    let best = null;
    let effort = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    function onLine(line) {
      // The substring checks keep every other frame, answer text included, unparsed.
      if (!line.startsWith('data:')) return;
      if (!/server_ste_metadata|resolved_model_slug|thinking_effort/.test(line)) return;
      let frame;
      try { frame = JSON.parse(line.slice(5)); } catch { return; }
      const found = extractFrame(frame);
      if (found.model && !(best && RANK[found.sourceField] <= best.rank)) {
        best = { rank: RANK[found.sourceField] };
        emit({ type: 'model', turnId, actualModel: found.model, sourceField: found.sourceField });
      }
      if (found.effort && found.effort !== effort) {
        effort = found.effort;
        emit({ type: 'effort', turnId, actualEffort: effort, sourceField: 'message.metadata.thinking_effort' });
      }
    }

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, newline).trimEnd());
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > MAX_LINE_CHARS) buffer = '';
    }
    onLine(buffer.trim());
  }

  window.fetch = async function patchedFetch(input, init) {
    if (!isConversationPost(input, init)) return nativeFetch.apply(this, arguments);

    const turnId = crypto.randomUUID();
    const requested = requestedOf(init);
    emit({ type: 'turn_start', turnId, requestedModel: requested.model, requestedEffort: requested.effort });
    let response;
    try {
      response = await nativeFetch.apply(this, arguments);
    } catch (error) {
      emit({ type: 'turn_end', turnId });
      throw error;
    }

    const isStream = response.ok && /text\/event-stream/i.test(response.headers.get('content-type') ?? '') && response.body;
    if (!isStream) {
      emit({ type: 'turn_end', turnId });
      return response;
    }
    // Side-channel read on a clone; the page keeps the untouched original response.
    watchStream(response.clone(), turnId)
      .catch(() => {})
      .finally(() => emit({ type: 'turn_end', turnId }));
    return response;
  };
})();
