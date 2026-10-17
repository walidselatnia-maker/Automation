import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Instagram's own copy of a post picture.
 *
 * Flow makes the Instagram picture 3:4, its closest size, but an Instagram
 * feed post may be no taller than 4:5 and Instagram refuses anything taller
 * when Buffer hands it over. So the picture is cut to 4:5 from its middle
 * (a strip off the top and bottom) and saved as a JPEG beside the original,
 * once; the original stays as it was.
 */

/** The copy's file name, beside the picture. */
export const instagramFileOf = (file: string): string => `${file.replace(/\.[A-Za-z0-9]+$/, '')}.ig.jpg`;

/** Make the 4:5 JPEG from the picture at `src` into `out`, unless it is already there. */
export function makeInstagramPicture(src: string, out: string, ffmpeg = 'ffmpeg'): Promise<void> {
  if (existsSync(out)) return Promise.resolve();
  const args = ['-y', '-loglevel', 'error', '-i', src, '-vf', 'crop=iw:min(ih\\,trunc(iw*5/8)*2)', '-frames:v', '1', '-q:v', '2', out];
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on('error', (err) => reject(new Error(`ffmpeg could not be started (${err.message})`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`))));
  });
}
