// The panel's ChatGPT frame first holds about:blank, which has the extension's own origin, until
// chatgpt.com loads; a message addressed to chatgpt.com then only logs an error. A document this page
// can read is therefore not ChatGPT's and gets nothing; ChatGPT asks for its state once it loads.
export function postToChatGptFrame(target, message) {
  if (!target) return false;
  try {
    void target.location.href;
    return false;
  } catch {
    // Cross-origin: the browser still delivers only if the document really is chatgpt.com.
  }
  target.postMessage(message, 'https://chatgpt.com');
  return true;
}

// The page the panel reopens is saved on every chatgpt.com navigation (embedded-chatgpt.js, a copy
// kept unchanged), auth pages included. Reopening /auth/logout logs the shared session out and
// /auth/login leaves for auth.openai.com, which the panel may not show; only ordinary pages return.
export function restorableChatGptUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password) return null;
    if (/^\/(api|backend-api|cdn|auth)(\/|$)/.test(url.pathname)) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
