/**
 * Modern OpenCode plugin definition. V1 definition loaders call `server`;
 * V2 calls `setup`. The installed legacy loader uses entry.ts instead.
 */
import { createV1Hooks, type OpenCodePluginContextV1 } from "./v1.js";
import { CLAUDE_MEM_PLUGIN_ID, setupV2, type OpenCodePluginContextV2 } from "./v2.js";

async function server(ctx: OpenCodePluginContextV1) {
  return createV1Hooks(ctx);
}

async function setup(ctx: OpenCodePluginContextV2) {
  return setupV2(ctx);
}

export default { id: CLAUDE_MEM_PLUGIN_ID, server, setup };
