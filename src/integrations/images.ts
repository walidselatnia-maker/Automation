import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('images');

/**
 * Image generation service client.
 *
 * The previous implementation polled /v1/jobs/{id} in an n8n loop that tested
 * only `status === "COMPLETED"`. Any other value — including "FAILED" — took
 * the false branch, waited 15 seconds and polled again, forever. A failed
 * image job hung the execution permanently.
 *
 * This client bounds the loop and treats a reported failure as a failure.
 */

export interface ImageJob {
  job_id: string;
  status: string;
  image_url: string | null;
  image_expires_at: string | null;
  error: string | null;
  prompt?: string;
}

export interface ImageClientOptions {
  baseUrl: string;
  apiKey: string;
  pollIntervalMs: number;
  maxAttempts: number;
  /**
   * The Flow project to generate into, resolved per site.
   *
   * Sent with the request rather than configured on the image service, because
   * the service is shared by every site and each site has its own project. It
   * was previously an environment variable on that container, which meant the
   * value in Settings never reached it at all.
   */
  projectId?: string;
  /**
   * Which image model, as chosen in Settings: a model key, or 'auto'.
   *
   * Sent with every request so the choice on the page is the choice the
   * service makes. Omitted when it is 'auto' or unset, which the service
   * treats the same way.
   */
  imageModel?: string;
}

export class ImageGenerationError extends Error {
  constructor(message: string, readonly jobId?: string) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

const TERMINAL_FAILURES = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED']);

export class ImageClient {
  constructor(private readonly options: ImageClientOptions) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.options.apiKey,
    };
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  /** Submit a generation request and return the job id. */
  async submit(prompt: string, orientation = 'VERTICAL'): Promise<string> {
    const response = await fetch(this.url('/v1/generate'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        prompt,
        orientation,
        // Omitted rather than sent empty, so the service falls back to its own
        // configured project instead of being told to use nothing.
        ...(this.options.projectId ? { project_id: this.options.projectId } : {}),
        ...(this.options.imageModel && this.options.imageModel !== 'auto'
          ? { image_model: this.options.imageModel }
          : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ImageGenerationError(
        `Image generation request failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }

    const json = (await response.json()) as { job_id?: string };
    if (!json.job_id) {
      throw new ImageGenerationError('Image service did not return a job_id');
    }
    return json.job_id;
  }

  async poll(jobId: string): Promise<ImageJob> {
    const response = await fetch(this.url(`/v1/jobs/${jobId}`), {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new ImageGenerationError(
        `Polling job ${jobId} failed: HTTP ${response.status}`,
        jobId,
      );
    }
    return (await response.json()) as ImageJob;
  }

  /**
   * Wait for a job to complete. Bounded by maxAttempts, and a reported
   * failure ends the wait immediately instead of retrying it forever.
   */
  async waitForCompletion(jobId: string): Promise<string> {
    const { maxAttempts, pollIntervalMs } = this.options;
    let lastNote: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const job = await this.poll(jobId);
      const status = (job.status ?? '').toUpperCase();

      if (status === 'COMPLETED') {
        if (!job.image_url) {
          throw new ImageGenerationError(
            `Job ${jobId} reported COMPLETED but returned no image_url`,
            jobId,
          );
        }
        log.debug(`Job ${jobId} completed after ${attempt} poll(s)`);
        return job.image_url;
      }

      if (TERMINAL_FAILURES.has(status)) {
        throw new ImageGenerationError(
          `Image job ${jobId} failed with status ${status}: ${job.error ?? 'no detail given'}`,
          jobId,
        );
      }

      // A job that is still queued or running with an error written on it is
      // a job the service is retrying: it went back to PENDING with the last
      // failure noted. That used to end the wait here, which cancelled the
      // retry from the outside -- the job went on to succeed in a queue nobody
      // was watching, and the run failed on the note. The note is worth a log
      // line and a mention if the wait runs out; the status decides.
      if (job.error && job.error !== lastNote) {
        lastNote = job.error;
        log.warn(`Job ${jobId} is being retried by the image service after: ${job.error}`);
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }

    const waited = Math.round((maxAttempts * pollIntervalMs) / 1000);
    throw new ImageGenerationError(
      `Image job ${jobId} did not complete within ${waited}s (${maxAttempts} attempts). ` +
        'Raise the limit in Settings → Images if generation is legitimately slow.' +
        (lastNote ? ` The last attempt the service made hit: ${lastNote}` : ''),
      jobId,
    );
  }

  /** Download a generated image into memory. */
  async download(imageUrl: string): Promise<{ data: Buffer; contentType: string }> {
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new ImageGenerationError(`Downloading image failed: HTTP ${response.status}`);
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'image/webp',
    };
  }

  /** Submit, wait, and download in one call. */
  async generate(prompt: string, orientation = 'VERTICAL'): Promise<{
    jobId: string;
    imageUrl: string;
    data: Buffer;
    contentType: string;
  }> {
    const jobId = await this.submit(prompt, orientation);
    const imageUrl = await this.waitForCompletion(jobId);
    const { data, contentType } = await this.download(imageUrl);
    return { jobId, imageUrl, data, contentType };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch(this.url('/v1/jobs/health-probe'), {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      // 404 for an unknown job still proves the service and key are working.
      return { ok: response.status < 500 };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}
