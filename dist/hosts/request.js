"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stringField = stringField;
exports.fieldOf = fieldOf;
function stringField(value) {
    return typeof value === "string" ? value : undefined;
}
function fieldOf(value, field) {
    return typeof value === "object" && value !== null && field in value
        ? value[field]
        : undefined;
}
