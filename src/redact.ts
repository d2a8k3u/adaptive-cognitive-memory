export interface Redaction {
  pattern: string;
  count: number;
}

export interface RedactResult {
  text: string;
  found: Redaction[];
}

interface SecretPattern {
  name: string;
  regex: RegExp;
  replacement: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/gi, replacement: "[REDACTED]" },
  {
    name: "anthropic_key",
    regex: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/gi,
    replacement: "[REDACTED]",
  },
  { name: "api_key", regex: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/gi, replacement: "[REDACTED]" },
  { name: "github_token", regex: /gh[pousr]_[A-Za-z0-9]{20,}/gi, replacement: "[REDACTED]" },
  { name: "github_pat", regex: /github_pat_[A-Za-z0-9_]{20,}/gi, replacement: "[REDACTED]" },
  {
    name: "bearer_token",
    regex: /(Bearer) ["']?[A-Za-z0-9._-]{16,}["']?/gi,
    replacement: "$1 [REDACTED]",
  },
  {
    name: "private_key",
    regex: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/gi,
    replacement: "[REDACTED]",
  },
  {
    name: "url_credentials",
    regex: /([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]*:[^\s:@/]+@/gi,
    replacement: "$1[REDACTED]@",
  },
  {
    name: "jwt",
    regex: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/gi,
    replacement: "[REDACTED]",
  },
  {
    name: "labeled_secret",
    regex:
      /((?:password|passwd|secret|api[_-]?key|token)[A-Za-z0-9_-]*)(\s*[:=]\s*)(?!\[REDACTED\])\S{8,}/gi,
    replacement: "$1$2[REDACTED]",
  },
  {
    name: "aws_secret_key",
    regex:
      /(aws_?secret_?access_?key)((?:\s*[:=]\s*|\s+)["']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/gi,
    replacement: "$1$2[REDACTED]",
  },
  {
    name: "stripe_key",
    regex: /(?<![A-Za-z0-9])sk_(?:live|test)_[A-Za-z0-9]{16,}/gi,
    replacement: "[REDACTED]",
  },
  {
    name: "slack_token",
    regex: /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/gi,
    replacement: "[REDACTED]",
  },
  {
    name: "google_api_key",
    regex: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
    replacement: "[REDACTED]",
  },
  { name: "npm_token", regex: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36,}/g, replacement: "[REDACTED]" },
  {
    name: "huggingface_token",
    regex: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/g,
    replacement: "[REDACTED]",
  },
];

export function redactWithin(text: string, maxChars: number): string {
  const redacted = redact(text).text;
  if (redacted.length <= maxChars) {
    return redacted;
  }
  let kept = "";
  for (const char of redacted) {
    if (kept.length + char.length > maxChars) {
      break;
    }
    kept += char;
  }
  return kept;
}

export function redact(text: string): RedactResult {
  let output = text;
  const found: Redaction[] = [];
  for (const { name, regex, replacement } of SECRET_PATTERNS) {
    const matches = output.match(regex);
    if (matches !== null) {
      found.push({ pattern: name, count: matches.length });
      output = output.replace(regex, replacement);
    }
  }
  return { text: output, found };
}
