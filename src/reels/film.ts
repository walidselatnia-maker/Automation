import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageClient } from '../integrations/images.js';
import {
  getSite,
  listScenes,
  presenterForPage,
  updateScene,
  type ReelSceneRow,
  type ReelView,
} from '../db/repos.js';
import { resolveProjectId } from '../core/project-id.js';
import type { Settings } from '../settings.js';
import { clipPrompt, type ReelSeed } from './compose.js';
import type { SourceRole } from './plan.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('reel-film');

const TERMINAL_FAILURES = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED']);

export interface FilmDeps {
  images: Pick<ImageClient, 'submitVideo' | 'poll'>;
  download(url: string): Promise<Buffer>;
  /** Where clips land: one folder per reel under it. */
  clipsDir: string;
}

/**
 * Film every scene that is not filmed yet, one clip each, and say whether
 * the reel is still working or done.
 *
 * Called once per tick. Scenes are submitted in order, then polled; a scene
 * that comes back finished is downloaded next to the reel. A scene that
 * fails is marked with why and the stage stops -- Retry on the reel page
 * clears it and the next tick picks it up again. Scenes already done are
 * never touched, which is what makes a retry cost one clip, not the reel.
 */
export async function filmPending(
  reel: ReelView,
  deps: FilmDeps,
  settings: Settings,
): Promise<'working' | 'done'> {
  const seed = JSON.parse(reel.plan_json || '{}') as Partial<ReelSeed>;
  const sources = seed.sources ?? {};
  const presenter = reel.fb_page_id ? presenterForPage(reel.fb_page_id) : undefined;
  const site = reel.site_id ? getSite(reel.site_id) : undefined;
  const project = resolveProjectId(
    site?.project_id ?? '',
    settings.get('flow_project_id'),
    site?.domain ?? '',
  );

  for (const scene of listScenes(reel.id)) {
    if (scene.status === 'done') continue;
    if (scene.status === 'failed') {
      throw new Error(`Scene ${scene.position} failed: ${scene.error ?? 'no detail'}`);
    }

    if (scene.status === 'pending') {
      // A fresh image made for this scene outranks the article's; either
      // way the clip is filmed from what the scene names.
      const urls = scene.image_url
        ? [scene.image_url]
        : (JSON.parse(scene.sources_json) as SourceRole[])
            .map((role) => sources[role])
            .filter((u): u is string => Boolean(u));
      if (urls.length === 0) {
        fail(scene, 'none of the images this scene was planned from exist');
      }

      // The character is an ingredient only when the scene puts them on
      // screen. The voice rides along with every spoken line, on screen or
      // not: a line without the voice asset is read by whoever Flow picks,
      // and that is a different voice in every clip.
      const onScreen = scene.presenter === 1 && Boolean(presenter);
      const speaks = Boolean(presenter) && scene.line.trim() !== '';
      const jobId = await deps.images.submitVideo({
        prompt: clipPrompt(
          { motion: scene.motion_prompt, line: scene.line, onScreen },
          presenter && (onScreen || speaks)
            ? { name: presenter.name, voice: presenter.voice_description }
            : null,
          seed.article?.title ?? '',
        ),
        referenceUrls: urls,
        characterMediaId: onScreen ? presenter!.flow_character_id || undefined : undefined,
        voiceMediaId: speaks ? presenter!.flow_voice_id || undefined : undefined,
        projectId: project.projectId,
      });
      updateScene(scene.id, { status: 'working', clipJobId: jobId, error: null });
      log.info(`reel ${reel.id}: scene ${scene.position} queued as ${jobId}`);
      continue;
    }

    // working: see whether it finished.
    const job = await deps.images.poll(scene.clip_job_id!);
    const status = (job.status ?? '').toUpperCase();
    if (status === 'COMPLETED' && job.image_url) {
      const dir = join(deps.clipsDir, String(reel.id));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `scene-${scene.position}.mp4`);
      writeFileSync(path, await deps.download(job.image_url));
      updateScene(scene.id, { status: 'done', clipPath: path, error: null });
      log.info(`reel ${reel.id}: scene ${scene.position} filmed`);
    } else if (TERMINAL_FAILURES.has(status)) {
      fail(scene, job.error ?? `the clip job ended ${status}`);
    }
  }

  return listScenes(reel.id).every((s) => s.status === 'done') ? 'done' : 'working';
}

function fail(scene: ReelSceneRow, why: string): never {
  updateScene(scene.id, { status: 'failed', error: why });
  throw new Error(`Scene ${scene.position} failed: ${why}`);
}
