import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The edit of a long reel: its scene clips in order, short crossfades between
 * them, a music track under the clips' own sound, subtitles written from each
 * scene's script, and the closing line large at the end. All of it ffmpeg, no
 * AI: the words on screen are exactly the words of the scripts.
 */

export const WIDTH = 1080;
export const HEIGHT = 1920;
const FPS = 30;
/** The crossfade between two scenes, in seconds. */
export const FADE = 0.3;
/** The music under the voices: quiet enough to hear every word. */
const MUSIC_VOLUME = 0.12;
/** How long the closing line stays on screen at the end. */
const CTA_SECONDS = 2.5;
/** The most words one subtitle shows at a time. */
const WORDS_PER_CUE = 5;

export interface EditScene {
  file: string;
  seconds: number;
  /** The words spoken in it, shown as subtitles. */
  script: string;
}

export interface EditInput {
  scenes: EditScene[];
  /** A music file, or none. */
  music?: string;
  /** Shown large over the last seconds. */
  closing?: string;
  out: string;
  /** Where the subtitle file is written. */
  workDir: string;
  ffmpeg?: string;
  ffprobe?: string;
}

function runTool(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`${cmd} could not be started (${e.message})`)));
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (exit ${code}): ${err.trim().split('\n').slice(-3).join(' ')}`)),
    );
  });
}

/** Whether a file has a sound track: a clip Flow made without one gets silence. */
async function hasAudio(file: string, ffprobe: string): Promise<boolean> {
  const out = await runTool(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
  return out.trim().length > 0;
}

/** When each scene starts in the finished video: every crossfade overlaps two scenes. */
export function sceneStarts(seconds: number[], fade = FADE): number[] {
  const starts: number[] = [];
  let at = 0;
  seconds.forEach((s, i) => {
    starts.push(at);
    at += s - (i < seconds.length - 1 ? fade : 0);
  });
  return starts;
}

export const totalSeconds = (seconds: number[], fade = FADE): number =>
  seconds.reduce((a, b) => a + b, 0) - fade * Math.max(0, seconds.length - 1);

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/**
 * The subtitles: each scene's script in pieces of a few words, spread over
 * the scene by their share of its words, the way the voice says them.
 */
export function subtitleCues(scenes: { seconds: number; script: string }[], fade = FADE): Cue[] {
  const starts = sceneStarts(scenes.map((s) => s.seconds), fade);
  const cues: Cue[] = [];
  scenes.forEach((scene, i) => {
    const words = scene.script.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) return;
    const pieces: string[][] = [];
    for (let w = 0; w < words.length; w += WORDS_PER_CUE) pieces.push(words.slice(w, w + WORDS_PER_CUE));
    // The voice starts a beat in and stops a beat before the cut.
    const from = starts[i]! + 0.2;
    const span = Math.max(0.5, scene.seconds - (i < scenes.length - 1 ? fade : 0) - 0.4);
    let at = from;
    for (const piece of pieces) {
      const length = (span * piece.length) / words.length;
      cues.push({ start: at, end: at + length, text: piece.join(' ') });
      at += length;
    }
  });
  return cues;
}

const assTime = (t: number): string => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assText = (t: string): string => t.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ');

/** The subtitle file: words low in the frame, the closing line large in the middle. */
export function subtitleFile(cues: Cue[], closing: string, total: number): string {
  // The closing line has the screen to itself: words under it would say it twice.
  const ctaStart = closing.trim() ? Math.max(0, total - CTA_SECONDS) : Infinity;
  const shown = cues.filter((c) => c.start < ctaStart - 0.2).map((c) => ({ ...c, end: Math.min(c.end, ctaStart) }));
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${WIDTH}`,
    `PlayResY: ${HEIGHT}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Words,DejaVu Sans,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,2,80,80,420,1',
    'Style: Closing,DejaVu Sans,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,3,24,0,5,90,90,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...shown.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Words,,0,0,0,,${assText(c.text)}`),
  ];
  if (closing.trim()) {
    lines.push(`Dialogue: 1,${assTime(ctaStart)},${assTime(total)},Closing,,0,0,0,,${assText(closing.trim())}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Make the finished reel. */
export async function editReel(input: EditInput): Promise<void> {
  const ffmpeg = input.ffmpeg ?? 'ffmpeg';
  const ffprobe = input.ffprobe ?? 'ffprobe';
  const { scenes } = input;
  if (!scenes.length) throw new Error('No scene clips to edit.');
  const seconds = scenes.map((s) => s.seconds);
  const total = totalSeconds(seconds);

  const assPath = join(input.workDir, 'subtitles.ass');
  writeFileSync(assPath, subtitleFile(subtitleCues(scenes), input.closing ?? '', total));

  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
  scenes.forEach((s) => args.push('-i', s.file));
  const silent: number[] = [];
  for (let i = 0; i < scenes.length; i++) if (!(await hasAudio(scenes[i]!.file, ffprobe))) silent.push(i);
  // One silent track per clip without sound, so every scene has audio to fade.
  const silenceIndex = new Map<number, number>();
  for (const i of silent) {
    silenceIndex.set(i, scenes.length + silenceIndex.size);
    args.push('-f', 'lavfi', '-t', String(seconds[i]), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }
  const musicIndex = input.music ? scenes.length + silenceIndex.size : -1;
  if (input.music) args.push('-stream_loop', '-1', '-i', input.music);

  const graph: string[] = [];
  scenes.forEach((s, i) => {
    graph.push(
      `[${i}:v]tpad=stop_mode=clone:stop_duration=${s.seconds},trim=0:${s.seconds},setpts=PTS-STARTPTS,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FPS},setsar=1,format=yuv420p[v${i}]`,
    );
    const src = silenceIndex.has(i) ? `${silenceIndex.get(i)}:a` : `${i}:a`;
    graph.push(`[${src}]atrim=0:${s.seconds},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,apad=whole_dur=${s.seconds}[a${i}]`);
  });

  // Each scene fades into the next; the offsets are where the next one starts.
  const starts = sceneStarts(seconds);
  let video = 'v0';
  let audio = 'a0';
  for (let i = 1; i < scenes.length; i++) {
    const v = `vx${i}`;
    const a = `ax${i}`;
    graph.push(`[${video}][v${i}]xfade=transition=fade:duration=${FADE}:offset=${starts[i]!.toFixed(3)}[${v}]`);
    graph.push(`[${audio}][a${i}]acrossfade=d=${FADE}[${a}]`);
    video = v;
    audio = a;
  }
  const escaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  graph.push(`[${video}]subtitles='${escaped}'[vout]`);
  if (musicIndex >= 0) {
    graph.push(`[${musicIndex}:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume=${MUSIC_VOLUME},afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5[music]`);
    graph.push(`[${audio}][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
  } else {
    graph.push(`[${audio}]anull[aout]`);
  }

  args.push(
    '-filter_complex', graph.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    input.out,
  );
  await runTool(ffmpeg, args);
}
