import { BROWSER_TOOL_ARGUMENTS, BROWSER_TOOL_NAMES } from './browser-client.js';
import { TOOL_ARGUMENTS as NATIVE_TOOL_ARGUMENTS, TOOL_NAMES as NATIVE_TOOL_NAMES } from './native-client.js';

export const TOOL_NAMES = Object.freeze([...BROWSER_TOOL_NAMES, ...NATIVE_TOOL_NAMES]);
export const TOOL_ARGUMENTS = Object.freeze({
  ...BROWSER_TOOL_ARGUMENTS,
  ...NATIVE_TOOL_ARGUMENTS,
});
