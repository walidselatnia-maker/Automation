import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editReel, sceneStarts, subtitleCues, subtitleFile, totalSeconds } from '../src/newsite/reel-edit.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('long reel edit: timing and subtitles', () => {
  it('starts each scene where the crossfade before it begins', () => {
    expect(sceneStarts([4, 6, 8], 0.3)).toEqual([0, 3.7, 9.4]);
    expect(totalSeconds([4, 6, 8], 0.3)).toBeCloseTo(17.4);
  });

  it('spreads each script over its own scene, a few words at a time', () => {
    const cues = subtitleCues([
      { seconds: 4, script: 'This cake needs no oven at all' },
      { seconds: 6, script: 'Mix the cream and the berries' },
    ]);
    expect(cues.map((c) => c.text)).toEqual(['This cake needs no oven', 'at all', 'Mix the cream and the', 'berries']);
    // The second scene's words start inside the second scene.
    expect(cues[2]!.start).toBeGreaterThanOrEqual(3.7);
    // Nothing runs past the end.
    expect(cues.at(-1)!.end).toBeLessThanOrEqual(totalSeconds([4, 6]));
    for (const c of cues) expect(c.end).toBeGreaterThan(c.start);
  });

  it('writes the words exactly, and the closing line over the last seconds', () => {
    const file = subtitleFile([{ start: 0.2, end: 1.5, text: 'No {oven} here' }], 'Full recipe on longlivo.com', 10);
    expect(file).toContain('Dialogue: 0,0:00:00.20,0:00:01.50,Words,,0,0,0,,No oven here');
    expect(file).toContain('Dialogue: 1,0:00:07.50,0:00:10.00,Closing,,0,0,0,,Full recipe on longlivo.com');
  });
});

describe.skipIf(!hasFfmpeg)('long reel edit: the real ffmpeg', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'reel-edit-'));
    const clip = (name: string, seconds: number, size: string, sound: boolean) =>
      execFileSync('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=24:duration=${seconds}`,
        ...(sound ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`] : []),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(sound ? ['-c:a', 'aac'] : []),
        join(dir, name),
      ]);
    clip('a.mp4', 4, '720x1280', true);
    clip('b.mp4', 6, '1080x1920', false);
    clip('c.mp4', 8, '720x1280', true);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=5', join(dir, 'music.mp3')]);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('joins the clips at 1080x1920 with sound, music and subtitles, as long as the scenes', async () => {
    const out = join(dir, 'reel.mp4');
    await editReel({
      scenes: [
        { file: join(dir, 'a.mp4'), seconds: 4, script: 'This cake needs no oven' },
        { file: join(dir, 'b.mp4'), seconds: 6, script: 'Whip the cream until it holds' },
        { file: join(dir, 'c.mp4'), seconds: 8, script: 'Full recipe on longlivo.com' },
      ],
      music: join(dir, 'music.mp3'),
      closing: 'Full recipe on longlivo.com',
      out,
      workDir: dir,
    });
    expect(statSync(out).size).toBeGreaterThan(10_000);
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', out]).toString(),
    ) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
    const video = probe.streams.find((s) => s.codec_type === 'video')!;
    expect([video.width, video.height]).toEqual([1080, 1920]);
    expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true);
    expect(Number(probe.format.duration)).toBeCloseTo(totalSeconds([4, 6, 8]), 0);
  }, 120_000);
});
