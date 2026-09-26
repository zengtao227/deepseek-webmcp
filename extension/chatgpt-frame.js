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
