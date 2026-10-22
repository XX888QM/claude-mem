/**
 * Build entry for the OpenCode plugin bundle.
 *
 * OpenCode's loader walks `Object.values(module)` and throws
 * `TypeError("Plugin export is not a function")` if ANY export is not callable,
 * as the installed OpenCode 1.18.35 does. Ship only the V1 hook factory here;
 * index.ts retains the modern id/server/setup definition for definition loaders.
 */
export { createV1Hooks as default } from './v1.js';
