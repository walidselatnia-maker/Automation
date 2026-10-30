import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run } from '../db/index.js';
import { resolveDataDir } from '../config.js';

/**
 * The music library long reels take their music from: tracks uploaded on the
 * Reels page, each picked for reels or not. A reel takes one picked track at
 * random and plays it quietly under the clips' own voices and sound.
 */

export interface MusicRow {
  id: number;
  name: string;
  file: string;
  used: number;
  created_at: string;
}

export const MUSIC_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

export const musicDir = (dataDir = resolveDataDir()): string => join(dataDir, 'newsite-music');
export const listMusic = (): MusicRow[] => all<MusicRow>('SELECT * FROM newsite_music ORDER BY name COLLATE NOCASE, id');
export const getMusic = (id: number): MusicRow | undefined => get<MusicRow>('SELECT * FROM newsite_music WHERE id = ?', id);

/** The extension of an upload's name when it is a kind of music we take, else ''. */
export function musicExt(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  return ext !== name.toLowerCase() && MUSIC_TYPES[ext] ? ext : '';
}

/** Keep one uploaded track. Its file name is the platform's own, never the upload's. */
export function addMusic(name: string, data: Buffer, dataDir?: string): MusicRow {
  const ext = musicExt(name);
  if (!ext) throw new Error(`“${name}” is not a music file (${Object.keys(MUSIC_TYPES).join(', ')}).`);
  const title = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 120) || 'Track';
  const id = Number(run(`INSERT INTO newsite_music (name, file) VALUES (?, '')`, title).lastInsertRowid);
  const file = `track-${id}.${ext}`;
  const dir = musicDir(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), data);
  run('UPDATE newsite_music SET file = ? WHERE id = ?', file, id);
  return getMusic(id)!;
}

export function setMusicUsed(ids: number[], used: boolean): number {
  let n = 0;
  for (const id of ids) n += Number(run('UPDATE newsite_music SET used = ? WHERE id = ?', used ? 1 : 0, id).changes ?? 0);
  return n;
}

export function deleteMusic(ids: number[], dataDir?: string): number {
  let n = 0;
  for (const id of ids) {
    const row = getMusic(id);
    if (!row) continue;
    if (row.file && !/[\\/]/.test(row.file)) rmSync(join(musicDir(dataDir), row.file), { force: true });
    n += Number(run('DELETE FROM newsite_music WHERE id = ?', id).changes ?? 0);
  }
  return n;
}

/** One picked track's file, at random, or undefined when none is picked. */
export function pickMusic(dataDir?: string, random: () => number = Math.random): string | undefined {
  const picked = listMusic().filter((m) => m.used && m.file && existsSync(join(musicDir(dataDir), m.file)));
  if (!picked.length) return undefined;
  return join(musicDir(dataDir), picked[Math.floor(random() * picked.length)]!.file);
}
