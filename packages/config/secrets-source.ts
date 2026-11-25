import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Port representing an abstract source for application secrets (Issue 391 / #503).
 *
 * In production, secrets are sourced dynamically via environment injection
 * from external secret management solutions (e.g. AWS Secrets Manager,
 * HashiCorp Vault, Doppler, Google Cloud Secret Manager) rather than committed
 * files.
 *
 * Verixa models secrets access as an abstract port so that application and
 * tooling code can resolve secrets uniformly across local development (.env files),
 * automated test suites (in-memory fixtures), and production clusters (cloud secret managers).
 */
export interface SecretsSource {
  /**
   * Identifies the secrets source adapter (e.g., 'dotenv', 'in-memory', 'aws-secrets-manager').
   */
  readonly name: string;

  /**
   * Retrieves a secret value by its case-sensitive key.
   *
   * @param key - The secret key / variable name (e.g., 'SESSION_ACCESS_TOKEN_SECRET').
   * @returns The secret value string, or undefined if not set.
   */
  getSecret(key: string): Promise<string | undefined>;

  /**
   * Retrieves multiple secrets at once as a key-value record.
   *
   * @param keys - Optional subset of keys to fetch. If omitted, returns all secrets available to this source.
   * @returns A record containing the resolved key-value pairs (missing keys are omitted).
   */
  getSecrets(keys?: readonly string[]): Promise<Record<string, string>>;

  /**
   * Checks whether a secret exists and has a non-undefined value in this source.
   *
   * @param key - The secret key to inspect.
   * @returns True if the key exists, false otherwise.
   */
  hasSecret(key: string): Promise<boolean>;
}

/**
 * Parses raw .env file content into key-value pairs.
 *
 * Conforms to standard dotenv formatting rules:
 * - Ignores empty lines and comment lines starting with `#`
 * - Strips optional leading `export ` keyword
 * - Trims unquoted values and keys
 * - Unquotes single (`'`) and double (`"`) quoted values, expanding escaped newlines in double-quoted strings
 * - Preserves inline comments only when separated by whitespace after unquoted values
 */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Ignore empty lines and comment lines
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    // Strip optional leading 'export '
    const normalized = line.startsWith("export ") ? line.slice(7).trimStart() : line;

    const equalsIdx = normalized.indexOf("=");
    if (equalsIdx === -1) {
      continue;
    }

    const key = normalized.slice(0, equalsIdx).trim();
    if (!key) {
      continue;
    }

    let rawVal = normalized.slice(equalsIdx + 1).trim();

    // Handle double-quoted string
    if (rawVal.startsWith('"')) {
      const match = rawVal.match(/^"((?:[^"\\]|\\.)*)"/);
      if (match && match[1] !== undefined) {
        rawVal = match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      } else if (rawVal.endsWith('"') && rawVal.length >= 2) {
        rawVal = rawVal.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
      } else {
        rawVal = rawVal.slice(1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
      }
    } else if (rawVal.startsWith("'")) {
      // Handle single-quoted string (no escape processing)
      const match = rawVal.match(/^'([^']*)'/);
      if (match && match[1] !== undefined) {
        rawVal = match[1];
      } else if (rawVal.endsWith("'") && rawVal.length >= 2) {
        rawVal = rawVal.slice(1, -1);
      } else {
        rawVal = rawVal.slice(1);
      }
    } else {
      // Unquoted: strip trailing comments if separated by space
      const commentIdx = rawVal.search(/\s+#/);
      if (commentIdx !== -1) {
        rawVal = rawVal.slice(0, commentIdx).trimEnd();
      }
    }

    result[key] = rawVal;
  }

  return result;
}

/**
 * Options for configuring the DotenvSecretsSource development adapter.
 */
export interface DotenvSecretsSourceOptions {
  /**
   * Absolute or relative path to the .env file.
   * If omitted, defaults to ".env" in the current working directory.
   */
  readonly filePath?: string;

  /**
   * Explicit key-value dictionary to overlay or use as fallback when no file exists.
   * If omitted, process.env is consulted as fallback.
   */
  readonly env?: Record<string, string | undefined>;

  /**
   * If true, secrets loaded from the .env file are also written to process.env.
   * Default: false (pure reading without mutating global state).
   */
  readonly injectIntoProcessEnv?: boolean;
}

/**
 * Development adapter reading secrets from local .env files and process.env.
 *
 * For local development, engineers maintain a private `.env` file (copied from `.env.example`).
 * This adapter reads that file without requiring external network connections or cloud provider credentials.
 * If the file does not exist, it falls back gracefully to environment variables or empty defaults.
 */
export class DotenvSecretsSource implements SecretsSource {
  public readonly name = "dotenv";
  private readonly secrets: Record<string, string>;

  public constructor(options: DotenvSecretsSourceOptions = {}) {
    const filePath = options.filePath ? resolve(options.filePath) : resolve(process.cwd(), ".env");
    const parsedFile: Record<string, string> = {};

    // Safe development file read; path is operator-supplied config or local .env
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (existsSync(filePath)) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const content = readFileSync(filePath, "utf-8");
        Object.assign(parsedFile, parseDotenv(content));
      } catch (err) {
        // Read errors (e.g. EACCES) warn but do not crash development boot
        console.warn(`[DotenvSecretsSource] Warning: Unable to read file at ${filePath}:`, err);
      }
    }

    // Merge fallback environment (options.env or process.env)
    const fallbackSource = options.env ?? process.env;
    const merged: Record<string, string> = {};

    for (const [key, value] of Object.entries(fallbackSource)) {
      if (typeof value === "string") {
        merged[key] = value;
      }
    }

    // File values take precedence over ambient environment in local development
    for (const [key, value] of Object.entries(parsedFile)) {
      merged[key] = value;
    }

    this.secrets = Object.freeze(merged);

    if (options.injectIntoProcessEnv) {
      for (const [key, value] of Object.entries(this.secrets)) {
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    }
  }

  public getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets[key]);
  }

  public getSecrets(keys?: readonly string[]): Promise<Record<string, string>> {
    if (!keys) {
      return Promise.resolve({ ...this.secrets });
    }

    const filtered: Record<string, string> = {};
    for (const key of keys) {
      const val = this.secrets[key];
      if (val !== undefined) {
        filtered[key] = val;
      }
    }
    return Promise.resolve(filtered);
  }

  public hasSecret(key: string): Promise<boolean> {
    return Promise.resolve(this.secrets[key] !== undefined);
  }
}

/** Alias for DotenvSecretsSource representing the development adapter. */
export const DevSecretsSource = DotenvSecretsSource;

/**
 * In-memory secrets source adapter designed for testing and contract verification.
 */
export class InMemorySecretsSource implements SecretsSource {
  public readonly name = "in-memory";
  private readonly store: Map<string, string>;

  public constructor(initialSecrets: Record<string, string> = {}) {
    this.store = new Map(Object.entries(initialSecrets));
  }

  public setSecret(key: string, value: string): void {
    this.store.set(key, value);
  }

  public removeSecret(key: string): void {
    this.store.delete(key);
  }

  public getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.store.get(key));
  }

  public getSecrets(keys?: readonly string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    if (!keys) {
      for (const [k, v] of this.store.entries()) {
        result[k] = v;
      }
      return Promise.resolve(result);
    }

    for (const k of keys) {
      const val = this.store.get(k);
      if (val !== undefined) {
        result[k] = val;
      }
    }
    return Promise.resolve(result);
  }

  public hasSecret(key: string): Promise<boolean> {
    return Promise.resolve(this.store.has(key));
  }
}
