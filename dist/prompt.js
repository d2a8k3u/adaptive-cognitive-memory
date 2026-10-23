"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wordsOf = wordsOf;
exports.distinctWords = distinctWords;
exports.admitPrompt = admitPrompt;
const MIN_TOKEN_CHARS = 2;
const SLASH_COMMAND_PREFIX = "/";
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
let wordSegmenter;
function segmenter() {
    wordSegmenter ??= new Intl.Segmenter("und", { granularity: "word" });
    return wordSegmenter;
}
function segmentedWords(run) {
    if (!UNSPACED_SCRIPT.test(run)) {
        return [run];
    }
    return [...segmenter().segment(run)]
        .filter((segment) => segment.isWordLike)
        .map((segment) => segment.segment);
}
function wordsOf(text) {
    return (text.toLowerCase().match(WORD_PATTERN) ?? [])
        .flatMap(segmentedWords)
        .filter((word) => word.length >= MIN_TOKEN_CHARS);
}
function distinctWords(text) {
    return [...new Set(wordsOf(text))];
}
function admitPrompt(prompt, minWords) {
    const text = prompt.trim();
    if (text.startsWith(SLASH_COMMAND_PREFIX)) {
        return { admitted: false, reason: "slash_command" };
    }
    const tokens = distinctWords(text);
    if (tokens.length < minWords) {
        return { admitted: false, reason: "too_few_words" };
    }
    return { admitted: true, tokens };
}
