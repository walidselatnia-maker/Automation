import { randomBytes } from 'node:crypto';

/**
 * Process-level configuration. Deliberately tiny.
 *
 * Everything an operator would plausibly want to change — credentials,
 * endpoints, schedules, site settings — lives in the database behind the
 * Settings UI. This file covers only what must exist before the database
 * can be opened.
 */
export interface AppConfig {
  port: number;
  dbPath: string;
  encryptionKey: Buffer;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  promptsDir: string;
}

function readEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY?.trim();

  if (!raw) {
    const suggestion = randomBytes(32).toString('hex');
    throw new Error(
      'ENCRYPTION_KEY is not set.\n\n' +
        'This key encrypts stored credentials. Add it to your .env file:\n\n' +
        `  ENCRYPTION_KEY=${suggestion}\n\n` +
        'Keep it safe — losing it means re-entering every credential.',
    );
  }

  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).\n' +
        'Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  return Buffer.from(raw, 'hex');
}

export function loadConfig(): AppConfig {
  const level = (process.env.LOG_LEVEL ?? 'info') as AppConfig['logLevel'];

  return {
    port: Number(process.env.PORT ?? 8080),
    dbPath: process.env.DB_PATH ?? './data/platform.db',
    encryptionKey: readEncryptionKey(),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    promptsDir: process.env.PROMPTS_DIR ?? './prompts',
  };
}
