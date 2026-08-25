import { loadConfig } from './config.js';
import { openDatabase, closeDatabase } from './db/index.js';
import { insertEvent } from './db/repos.js';
import { configurePrompts } from './pipeline/prompts.js';
import { Scheduler } from './scheduler/index.js';
import { Settings } from './settings.js';
import { buildServer } from './web/server.js';
import { createLogger, errorMessage, setLogLevel, setLogSink } from './lib/logger.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  openDatabase(config.dbPath);
  configurePrompts(config.promptsDir);

  // Mirror warnings and errors into the database so the Events page is useful
  // without shell access to the container.
  setLogSink((level, source, message, detail) => {
    if (level === 'warn' || level === 'error') {
      insertEvent(level, source, message, detail === undefined ? undefined : String(detail));
    }
  });

  const settings = new Settings(config.encryptionKey);

  const server = buildServer(settings, config.encryptionKey);
  await server.listen({ port: config.port, host: '0.0.0.0' });
  log.info(`Web UI listening on http://localhost:${config.port}`);

  const problems = settings.validate();
  if (problems.length > 0) {
    log.warn('Configuration is incomplete; open Settings to finish setup', problems);
  }

  const scheduler = new Scheduler(settings, config.encryptionKey);
  scheduler.start();

  const shutdown = (signal: string): void => {
    log.info(`${signal} received, shutting down`);
    scheduler.stop();
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
