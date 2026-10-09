// redact-secrets.ts
// Best-effort redaction of secret-shaped substrings before persisting free text
// (exec-sandbox output, activity-log session entries) to disk under .gsd/, which
// the secret scanner skips. Patterns mirror scripts/secret-scan.mjs.

const PLACEHOLDER = "«redacted»";

// Each secret shape. Global flag so replace() catches every occurrence in a line.
// Order is not significant — matches are replaced independently.
const PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /(api[_-]?key|apikey|api[_-]?secret)[ \t]*[:=][ \t]*['"][0-9a-zA-Z_./-]{20,}['"]/gi,
  /(secret|token|password|passwd|pwd|credential)[ \t]*[:=][ \t]*['"][^\s'"]{8,}['"]/gi,
  /(authorization|bearer)[ \t]*[:=][ \t]*['"][^\s'"]{8,}['"]/gi,
  /Bearer[ \t]+[0-9a-zA-Z._-]{8,}/g, // Authorization: Bearer <token> (unquoted)
  // PEM private key: any algorithm prefix, or none (PKCS#8 "BEGIN PRIVATE KEY"), or ENCRYPTED.
  // A BEGIN block whose END line was truncated is redacted up to the next double quote (the end of
  // a JSON string, which PEM content never contains) or end-of-text, so JSON stays valid.
  /-----BEGIN\s+(?:(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED)\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----[\s\S]*?(?:-----END\s+(?:(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED)\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----|(?=")|$)/g,
  /(mysql|postgres|postgresql|mongodb|redis|amqp|mssql):\/\/[^\s'"]{8,}/gi,
  /gh[pousr]_[0-9a-zA-Z]{36,}/g, // GitHub token
  /glpat-[0-9a-zA-Z-]{20,}/g, // GitLab token
  /xox[baprs]-[0-9a-zA-Z-]{10,}/g, // Slack token
  /hooks\.slack\.com\/services\/T[0-9A-Z]{8,}\/B[0-9A-Z]{8,}\/[0-9a-zA-Z]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g, // Google API key
  /[sr]k_(live|test)_[0-9a-zA-Z]{20,}/g, // Stripe key
  /sk-(ant-)?[0-9a-zA-Z_-]{20,}/g, // OpenAI / Anthropic style key
  /npm_[0-9a-zA-Z]{36,}/g, // npm token
  /(secret|key|token|password)[ \t]*[:=][ \t]*['"]?[0-9a-f]{32,}['"]?/gi, // hex secret
];

/**
 * Replace secret-shaped substrings in `text` with a placeholder, preserving the
 * surrounding content. Pure and safe to call per log line. The placeholder
 * contains no quote/brace/backslash, so redacting a JSON string keeps it valid.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, PLACEHOLDER);
  }
  return out;
}
