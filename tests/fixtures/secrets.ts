function fragments(...parts: readonly string[]): string {
  return parts.join("");
}

export const FAKE_SECRETS = {
  awsAccessKeyId: fragments("AKIA", "IOSFODNN7EXAMPLE"),
  awsAccessKeyIdNeighbour: fragments("AKIA", "IOSFODNN7EXAMPLF"),
  anthropicKey: fragments("sk-", "ant-api03-Cq1abcDEF-ghi456JKL-mno789"),
  openaiProjectKey: fragments("sk-", "proj-abcdefghij1234567890"),
  githubClassicShort: fragments("ghp_", "16charLiterals123456AB"),
  githubClassicLowercase: fragments("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"),
  githubClassicExample: fragments("ghp_", "EXAMPLEfakeGitHubToken000000000000000"),
  githubFineGrained: fragments(
    "github_",
    "pat_11ABCDEFGH01234567890123456789012345678901234567890123456789012",
  ),
  stripeLive: fragments("sk_", "live_51AbCdEfGhIjKlMnOpQrStUv1a2b3c4d5e6f7g8h9"),
  slackBot: fragments("xox", "b-000000000000-0000000000000-EXAMPLEfakeSLACKtoken0"),
  huggingFace: fragments("hf_", "EXAMPLEfakeHFtokenDoNotUse0000000"),
  npm: fragments("npm_", "EXAMPLEfakeNPMtoken000000000000000000"),
  rsaPrivateKeyBlock: fragments(
    "-----BEGIN RSA ",
    "PRIVATE KEY-----\nMIIBOgIBAAJBAKdGcH\n-----END RSA ",
    "PRIVATE KEY-----",
  ),
} as const;
