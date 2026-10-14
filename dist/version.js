"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLUGIN_ROOT = exports.PLUGIN_VERSION = exports.PLUGIN_INSTALL_ID = exports.PLUGIN_NAME = void 0;
const node_path_1 = require("node:path");
exports.PLUGIN_NAME = "adaptive-cognitive-memory";
exports.PLUGIN_INSTALL_ID = `${exports.PLUGIN_NAME}@${exports.PLUGIN_NAME}`;
exports.PLUGIN_VERSION = "0.1.1";
exports.PLUGIN_ROOT = (0, node_path_1.join)(__dirname, "..");
