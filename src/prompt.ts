const MIN_TOKEN_CHARS = 2;
const SLASH_COMMAND_PREFIX = "/";
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
let wordSegmenter: Intl.Segmenter | undefined;

function segmenter(): Intl.Segmenter {
  wordSegmenter ??= new Intl.Segmenter("und", { granularity: "word" });
  return wordSegmenter;
}

export type AdmissionRejection = "slash_command" | "too_few_words";

export type Admission =
  | { readonly admitted: true; readonly tokens: readonly string[] }
  | { readonly admitted: false; readonly reason: AdmissionRejection };

function segmentedWords(run: string): string[] {
  if (!UNSPACED_SCRIPT.test(run)) {
    return [run];
  }
  return [...segmenter().segment(run)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(WORD_PATTERN) ?? [])
    .flatMap(segmentedWords)
    .filter((word) => word.length >= MIN_TOKEN_CHARS);
}

export function distinctWords(text: string): string[] {
  return [...new Set(wordsOf(text))];
}

export function admitPrompt(prompt: string, minWords: number): Admission {
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
