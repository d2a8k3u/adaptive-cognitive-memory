"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORE_TOOL = exports.MEMORY_SERVER_NAME = void 0;
exports.hostToolName = hostToolName;
const version_1 = require("./version");
exports.MEMORY_SERVER_NAME = "memory";
function hostToolName(tool) {
    return `mcp__plugin_${version_1.PLUGIN_NAME}_${exports.MEMORY_SERVER_NAME}__${tool}`;
}
exports.STORE_TOOL = hostToolName("memory_store");
