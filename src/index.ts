import { loadConfig } from './config.js';
import { openDatabase, closeDatabase } from './db/index.js';
import { configurePromptFiles } from './pipeline/prompt-files.js';
import { configurePrompts } from './pipeline/prompts.js';
import { Settings } from './settings.js';
import { buildServer } from './web/server.js';
import { createLogger, errorMessage, setLogLevel } from './lib/logger.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  openDatabase(config.dbPath);
  configurePrompts(config.promptsDir);
  configurePromptFiles(config.promptsDir);

  const settings = new Settings(config.encryptionKey);

  const server = buildServer(settings, config.encryptionKey, {
    password: config.authPassword,
    secret: config.encryptionKey,
    generated: config.authPasswordGenerated,
    encryptionKey: config.encryptionKey,
  });
  await server.listen({ port: config.port, host: config.host });
  log.info(`Web UI listening on port ${config.port}`);

  if (config.authPasswordGenerated) {
    // Printed on every start: on a hosted Docker platform the logs are the
    // only way in, and there is no shell to cat the file from.
    console.log(
      [
        '',
        '  ┌─────────────────────────────────────────────────────────┐',
        '  │  ADMIN PASSWORD (generated on first start)              │',
        '  ├─────────────────────────────────────────────────────────┤',
        `  │  ${config.authPassword.padEnd(55)}│`,
        '  ├─────────────────────────────────────────────────────────┤',
        '  │  Set AUTH_PASSWORD in your environment to choose your   │',
        '  │  own. This one is stored in the data volume.            │',
        '  └─────────────────────────────────────────────────────────┘',
        '',
      ].join(String.fromCharCode(10)),
    );
  }

  const shutdown = (signal: string): void => {
    log.info(`${signal} received, shutting down`);
    void server.close().then(() => {
      closeDatabase();
      process.exit(0);
    });
    // Do not let a hung request block shutdown forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', errorMessage(reason));
  });
}

main().catch((err: unknown) => {
  console.error('\nFailed to start:\n');
  console.error(errorMessage(err));
  process.exit(1);
});
