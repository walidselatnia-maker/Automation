import { loadConfig } from './config.js';
import { openDatabase, closeDatabase } from './db/index.js';
import { insertEvent } from './db/repos.js';
import { configurePromptFiles } from './pipeline/prompt-files.js';
import { normaliseStoredDomains } from './db/repos.js';
import { normaliseDomain } from './lib/domain.js';
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
  // Sites stored with a scheme cannot be matched by a bare CSV column heading,
  // which silently produced keywords linked to nothing.
  try {
    const domains = normaliseStoredDomains(normaliseDomain);
    if (domains.changed.length) {
      log.info(`normalised ${domains.changed.length} site domain(s): ${domains.changed.join(', ')}`);
    }
    for (const clash of domains.conflicted) {
      log.warn(`site domain left as-is, another site already uses the normalised form: ${clash}`);
    }
  } catch (err) {
    // A tidy-up must never be the reason the platform will not start.
    log.warn(`could not normalise stored domains: ${errorMessage(err)}`);
  }

  configurePrompts(config.promptsDir);
  configurePromptFiles(config.promptsDir);

  // Mirror warnings and errors into the database so the Events page is useful
  // without shell access to the container.
  setLogSink((level, source, message, detail) => {
    if (level === 'warn' || level === 'error') {
      insertEvent(level, source, message, detail === undefined ? undefined : String(detail));
    }
  });

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
