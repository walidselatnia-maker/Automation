import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Join the scene clips into the reel.
 *
 * One ffmpeg run: every clip scaled and padded to 1080x1920 at 30 fps with
 * its own sound kept, concatenated in order, and the call to action drawn
 * over the last two seconds. ffmpeg is a command, not a service -- it runs
 * for the seconds this takes and exits, so there is nothing to keep up or
 * shut down between reels.
 */
export async function assembleReel(
  clipPaths: string[],
  outPath: string,
  options: { ctaText: string; ffmpeg?: string },
): Promise<void> {
  if (clipPaths.length === 0) throw new Error('There are no clips to assemble.');
  mkdirSync(dirname(outPath), { recursive: true });

  const inputs = clipPaths.flatMap((p) => ['-i', p]);
  const norm = clipPaths
    .map(
      (_, i) =>
        `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
        `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}];` +
        `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`,
    )
    .join(';');
  const concat =
    clipPaths.map((_, i) => `[v${i}][a${i}]`).join('') +
    `concat=n=${clipPaths.length}:v=1:a=1[vc][ac]`;

  const cta = options.ctaText.trim();
  const from = Math.max(0, clipPaths.length * 10 - 2);
  const text = cta
    ? `;[vc]drawtext=text='${escapeDrawtext(cta)}':fontcolor=white:fontsize=64:` +
      `box=1:boxcolor=black@0.5:boxborderw=24:x=(w-text_w)/2:y=h-260:enable='gte(t,${from})'[vout]`
    : ';[vc]copy[vout]';

  const args = [
    '-y', ...inputs,
    '-filter_complex', `${norm};${concat}${text}`,
    '-map', '[vout]', '-map', '[ac]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    outPath,
  ];

  await run(options.ffmpeg ?? 'ffmpeg', args);
}

/** drawtext reads : and ' and \ as syntax; a caption may contain any of them. */
function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '%%');
}

function run(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (err) =>
      reject(
        new Error(
          `ffmpeg could not be started (${err.message}). It ships in the platform image; ` +
            'on a local checkout, install ffmpeg.',
        ),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      reject(new Error(`ffmpeg failed (exit ${code}):\n${tail}`));
    });
  });
}
