export const REDACTED = '[REDACTED]';

/**
 * Strips registered secret strings (the API token, resolved secret values, bypass
 * secrets) from any text before it is logged or put in an error message.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  /** Register a value to redact. Values shorter than 4 characters are ignored to avoid mangling text. */
  add(secret: string | undefined | null): void {
    if (secret && secret.length >= 4) this.secrets.add(secret);
  }

  redact(text: string): string {
    let out = text;
    // Longest first so a secret that contains another is fully removed.
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(s).join(REDACTED);
    }
    return out;
  }

  /** JSON-serialize then redact. */
  redactJson(value: unknown): string {
    return this.redact(JSON.stringify(value));
  }
}
