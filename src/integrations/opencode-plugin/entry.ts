/**
 * Build entry for the OpenCode plugin bundle.
 *
 * OpenCode's loader walks `Object.values(module)` and throws
 * `TypeError("Plugin export is not a function")` if ANY export is not callable,
 * which silently disabled the whole plugin because index.ts also exports the
 * REGISTERED_OPENCODE_HOOKS / REAL_OPENCODE_EVENT_TYPES const arrays the
 * contract test asserts on. Ship only the plugin function from this entry and
 * keep index.ts as the testable module.
 */
export { ClaudeMemPlugin as default } from './index.js';
