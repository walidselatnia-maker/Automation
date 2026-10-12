import { describe, expect, it } from 'vitest';
import { normalizeDomain, validate } from '../src/newsite/validate.js';

const KEY = 'sk_test_FAKE0000000000000000000000';

describe('new website validation', () => {
  describe('address', () => {
    it.each([
      ['f.longlivo.com', 'f.longlivo.com'],
      ['https://WWW.Example.com/recipes/', 'www.example.com'],
      ['  http://blog.example.co.uk/?x=1 ', 'blog.example.co.uk'],
    ])('accepts %s', (input, host) => {
      expect(normalizeDomain(input)).toBe(host);
    });

    it.each([
      'hello',
      'just some words',
      'localhost',
      '192.168.1.1',
      'exa mple.com',
      '-bad.example.com',
      'example..com',
      'example.c',
      'user@example.com',
      'example.com:8080',
      '',
    ])('rejects %j', (input) => {
      expect(normalizeDomain(input)).toBeNull();
    });
  });

  it('accepts a normal name and rejects junk', () => {
    expect(validate({ name: '  Long   Livo ' }, ['name']).clean.name).toBe('Long Livo');
    for (const bad of ['', 'x', '1234', '<script>', 'a'.repeat(61)]) {
      expect(validate({ name: bad }, ['name']).errors.name, bad).toBeTruthy();
    }
  });

  it('only accepts something shaped like an API key', () => {
    expect(validate({ apiKey: KEY }, ['apiKey']).errors.apiKey).toBeUndefined();
    for (const bad of ['', 'hello', 'sk_short', `${KEY} extra`, 'Bearer ' + KEY, 'pk_' + KEY.slice(3)]) {
      expect(validate({ apiKey: bad }, ['apiKey']).errors.apiKey, bad).toBeTruthy();
    }
  });

  it('needs a niche and keeps the detail short and plain', () => {
    expect(validate({ niche: 'Recipes', nicheContext: '' }, ['niche', 'nicheContext']).errors).toEqual({});
    expect(validate({ niche: '' }, ['niche']).errors.niche).toBeTruthy();
    expect(validate({ niche: '!!!' }, ['niche']).errors.niche).toBeTruthy();
    expect(validate({ nicheContext: 'x'.repeat(501) }, ['nicheContext']).errors.nicheContext).toBeTruthy();
  });

  it('takes a preset persona or a custom one, not neither or an unknown preset', () => {
    const f = ['persona', 'customPersona'] as const;
    expect(validate({ persona: 'Storyteller' }, [...f]).clean.persona).toBe('Storyteller');
    expect(validate({ persona: '', customPersona: 'A retired chef' }, [...f]).clean.persona).toBe('A retired chef');
    expect(validate({ persona: '', customPersona: '' }, [...f]).errors.customPersona).toBeTruthy();
    expect(validate({ persona: 'Wizard' }, [...f]).errors.persona).toBeTruthy();
    expect(validate({ persona: '', customPersona: 'ab' }, [...f]).errors.customPersona).toBeTruthy();
  });

  it('turns the gap into minutes and refuses nonsense', () => {
    const f = ['gapAmount', 'gapUnit'] as const;
    expect(validate({ gapAmount: '8', gapUnit: 'hours' }, [...f]).clean.intervalMinutes).toBe(480);
    expect(validate({ gapAmount: '1.5', gapUnit: 'hours' }, [...f]).clean.intervalMinutes).toBe(90);
    expect(validate({ gapAmount: '2', gapUnit: 'days' }, [...f]).clean.intervalMinutes).toBe(2880);
    expect(validate({ gapAmount: '-1', gapUnit: 'hours' }, [...f]).errors.gapAmount).toBeTruthy();
    expect(validate({ gapAmount: 'abc', gapUnit: 'hours' }, [...f]).errors.gapAmount).toBeTruthy();
    expect(validate({ gapAmount: '8', gapUnit: 'weeks' }, [...f]).errors.gapUnit).toBeTruthy();
    expect(validate({ gapAmount: '31', gapUnit: 'days' }, [...f]).errors.gapAmount).toBeTruthy();
  });

  it('needs whole posts per day from 0 to 100', () => {
    expect(validate({ dailyTarget: '3' }, ['dailyTarget']).clean.dailyTarget).toBe(3);
    for (const bad of ['', '-1', '1.5', 'x', '101']) {
      expect(validate({ dailyTarget: bad }, ['dailyTarget']).errors.dailyTarget, bad).toBeTruthy();
    }
  });

  it('only allows the two statuses and the two publishing modes', () => {
    expect(validate({ status: 'active', autoPublish: '0' }, ['status', 'autoPublish']).errors).toEqual({});
    expect(validate({ status: 'maybe', autoPublish: '2' }, ['status', 'autoPublish']).errors).toEqual({
      status: expect.any(String),
      autoPublish: expect.any(String),
    });
  });

  it('keeps the optional fields optional but checks them when filled', () => {
    const f = ['bufferToken', 'pinUsername', 'projectId'] as const;
    expect(validate({}, [...f]).errors).toEqual({});
    expect(validate({ pinUsername: '@my.board' }, [...f]).clean.pinUsername).toBe('my.board');
    const bad = validate({ bufferToken: 'a b', pinUsername: 'no spaces!', projectId: 'x' }, [...f]);
    expect(Object.keys(bad.errors).sort()).toEqual(['bufferToken', 'pinUsername', 'projectId']);
  });
});
