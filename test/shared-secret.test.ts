import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';


/**
 * The platform and the image service have to agree on an API key. Asking
 * someone to invent one and paste it into two places is the sort of step that
 * gets skipped, so imagegen generates it into a volume both mount and the
 * platform reads it from there.
 *
 * The module reads the path at import time, so each case imports a fresh copy.
 */
describe('the shared image API key', () => {
  let dir: string;
  let close: (() => void) | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shared-secret-'));
  });

  afterEach(() => {
    close?.();
    close = null;
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SHARED_SECRET_PATH;
    delete process.env.IMAGE_API_KEY;
  });

  async function settingsFor(path: string) {
    process.env.SHARED_SECRET_PATH = path;

    // The module reads the path once at import, so each case needs a fresh
    // copy rather than the one an earlier case already loaded. That resets the
    // database module too, so the connection has to be opened inside the same
    // fresh graph the Settings instance will read through.
    vi.resetModules();
    const db = await import('../src/db/index.js');
    db.openDatabase(':memory:');
    close = db.closeDatabase;

    const { Settings } = await import('../src/settings.js');
    return new Settings(randomBytes(32));
  }

  it('reads the key the image service generated', async () => {
    const keyPath = join(dir, 'image-api-key');
    writeFileSync(keyPath, 'a'.repeat(64));

    const settings = await settingsFor(keyPath);

    expect(settings.get('image_api_key')).toBe('a'.repeat(64));
  });

  it('strips the trailing newline openssl leaves behind', async () => {
    const keyPath = join(dir, 'image-api-key');
    writeFileSync(keyPath, `${'b'.repeat(64)}\n`);

    const settings = await settingsFor(keyPath);

    // A key with a newline on the end fails as a header value, and the error
    // it produces says nothing about whitespace.
    expect(settings.get('image_api_key')).toBe('b'.repeat(64));
  });

  it('reports a problem when the file is not there yet', async () => {
    const settings = await settingsFor(join(dir, 'not-written-yet'));

    expect(settings.get('image_api_key')).toBe('');
    expect(settings.validate().some((p: string) => p.includes('Image service API key'))).toBe(true);
  });

  it('picks the file up later without a restart', async () => {
    // The containers start together, so the platform may well look before
    // imagegen has written. Re-reading means it starts working a moment later
    // rather than needing a restart.
    const keyPath = join(dir, 'image-api-key');
    const settings = await settingsFor(keyPath);
    expect(settings.get('image_api_key')).toBe('');

    writeFileSync(keyPath, 'c'.repeat(64));

    expect(settings.get('image_api_key')).toBe('c'.repeat(64));
  });

  it('lets an explicit environment variable win', async () => {
    const keyPath = join(dir, 'image-api-key');
    writeFileSync(keyPath, 'from-the-volume');
    process.env.IMAGE_API_KEY = 'from-the-environment';

    const settings = await settingsFor(keyPath);

    // Deploying the two halves separately means no shared volume; the
    // environment has to remain the override.
    expect(settings.get('image_api_key')).toBe('from-the-environment');
  });
});
