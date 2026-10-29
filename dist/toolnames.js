"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEMORY_SERVER_KEY = void 0;
exports.hostToolName = hostToolName;
const version_1 = require("./version");
exports.MEMORY_SERVER_KEY = "memory";
const QUALIFIED_TOOL_PREFIX = {
    claude: `mcp__plugin_${version_1.PLUGIN_NAME}_${exports.MEMORY_SERVER_KEY}__`,
    codex: `mcp__${exports.MEMORY_SERVER_KEY}__`,
    opencode: `${exports.MEMORY_SERVER_KEY}_`,
};
function hostToolName(host, tool) {
    return `${QUALIFIED_TOOL_PREFIX[host]}${tool}`;
}
