import { errorMessage } from '../lib/logger.js';

/**
 * Buffer GraphQL client for Pinterest scheduling.
 * Queries are reproduced from the captured n8n execution.
 */

const ENDPOINT = 'https://api.buffer.com';

export interface BufferBoard {
  serviceId: string;
  name: string;
}

export interface BufferChannel {
  id: string;
  name: string;
  /** 'facebook', 'pinterest', 'instagram' ... — what Buffer posts it through. */
  service: string;
  boards: BufferBoard[];
}

export class BufferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BufferError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export class BufferClient {
  constructor(private readonly token: string) {}

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BufferError(`Buffer HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const json = (await response.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      throw new BufferError(`Buffer GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data) throw new BufferError('Buffer returned no data');

    return json.data;
  }

  async getOrganizationId(): Promise<string> {
    const data = await this.graphql<{
      account: { organizations: { id: string; name: string }[] };
    }>(`query GetOrganizations {
  account {
    organizations {
      id
      name
    }
  }
}`);

    const org = data.account?.organizations?.[0];
    if (!org) throw new BufferError('No Buffer organization found for this token');
    return org.id;
  }

  async getChannels(organizationId: string): Promise<BufferChannel[]> {
    const data = await this.graphql<{
      channels: {
        id: string;
        name: string;
        service?: string;
        metadata?: { boards?: BufferBoard[] };
      }[];
    }>(
      'query GetChannelsWithBoards($orgId: OrganizationId!) { channels(input: { organizationId: $orgId }) { id name service metadata { ... on PinterestMetadata { boards {  serviceId name  } } } } }',
      { orgId: organizationId },
    );

    return (data.channels ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      service: c.service ?? '',
      boards: c.metadata?.boards ?? [],
    }));
  }

  /**
   * Schedule a Pinterest pin.
   *
   * Values are injected into the mutation as GraphQL string literals, matching
   * the original implementation, so they must be escaped rather than
   * concatenated raw.
   */
  async createPost(input: {
    text: string;
    channelId: string;
    imageUrl: string;
    altText: string;
    title: string;
    linkUrl: string;
    boardServiceId: string;
  }): Promise<string> {
    const q = (value: string): string => JSON.stringify(value ?? '');

    const mutation = `mutation CreatePost {
  createPost(
    input: {
      text: ${q(input.text)}
      channelId: ${q(input.channelId)}
      schedulingType: automatic
      mode: addToQueue
      assets: [
        {
          image: {
            url: ${q(input.imageUrl)}
            metadata: {
              altText: ${q(input.altText)}
              animatedThumbnail: "string"
            }
          }
        }
      ]
      metadata: {
        pinterest: {
          title: ${q(input.title)}
          url: ${q(input.linkUrl)}
          boardServiceId: ${q(input.boardServiceId)}
        }
      }
    }
  ) {
    ... on PostActionSuccess {
      post {
        id
      }
    }
    ... on MutationError {
      message
    }
  }
}`;

    const data = await this.graphql<{
      createPost: { post?: { id: string }; message?: string };
    }>(mutation);

    if (data.createPost?.message) {
      throw new BufferError(`Buffer rejected the post: ${data.createPost.message}`);
    }

    const id = data.createPost?.post?.id;
    if (!id) throw new BufferError('Buffer did not return a post id');

    return id;
  }

  /**
   * Queue an image post on any Buffer channel and return what Buffer said:
   * the post's id and when it is due to go out. `metadata` is the
   * service-specific part, already written as GraphQL (for example
   * `pinterest: { title: "…", url: "…", boardServiceId: "…" }`), or empty.
   *
   * Only a reply carrying a post id counts as accepted: an error, or any
   * answer without an id, throws, so nothing is ever recorded as sent that
   * Buffer did not take.
   */
  async createImagePost(input: {
    text: string;
    channelId: string;
    imageUrl: string;
    altText: string;
    metadata: string;
  }): Promise<{ id: string; dueAt: string }> {
    const q = (value: string): string => JSON.stringify(value ?? '');
    const metadata = input.metadata.trim() ? `
      metadata: {
        ${input.metadata.trim()}
      }` : '';
    const mutation = `mutation CreateImagePost {
  createPost(
    input: {
      text: ${q(input.text)}
      channelId: ${q(input.channelId)}
      schedulingType: automatic
      mode: addToQueue
      assets: [
        {
          image: {
            url: ${q(input.imageUrl)}
            metadata: {
              altText: ${q(input.altText)}
            }
          }
        }
      ]${metadata}
    }
  ) {
    ... on PostActionSuccess {
      post {
        id
        dueAt
      }
    }
    ... on MutationError {
      message
    }
  }
}`;

    const data = await this.graphql<{
      createPost: { post?: { id: string; dueAt?: string | null }; message?: string };
    }>(mutation);

    if (data.createPost?.message) {
      throw new BufferError(`Buffer rejected the post: ${data.createPost.message}`);
    }
    const id = data.createPost?.post?.id;
    if (!id) throw new BufferError('Buffer did not confirm the post (no post id in its answer), so it was not recorded as sent.');
    return { id, dueAt: String(data.createPost.post?.dueAt ?? '') };
  }

  /** GraphQL text for a string value, escaped. */
  static literal(value: string): string {
    return JSON.stringify(value ?? '');
  }

  /**
   * Queue a video post -- a reel, on a channel that takes one.
   *
   * Buffer fetches the video from `videoUrl` itself rather than taking bytes,
   * which is why the reel is uploaded to its own site first: Flow's urls are
   * signed and expire, and a queued post may not go out for hours.
   *
   * Built as a string literal the way createPost is, because it is the same
   * endpoint and the same escaping rule, not because a variables map would not
   * be nicer.
   */
  async createVideoPost(input: {
    text: string;
    channelId: string;
    videoUrl: string;
    thumbnailUrl?: string;
    /** The service-specific part, as for createImagePost (a pin's board and link, a Facebook reel). */
    metadata?: string;
  }): Promise<string> {
    const q = (value: string): string => JSON.stringify(value ?? '');
    const thumbnail = input.thumbnailUrl
      ? `\n              thumbnail: ${q(input.thumbnailUrl)}`
      : '';
    const metadata = input.metadata?.trim() ? `
      metadata: {
        ${input.metadata.trim()}
      }` : '';

    const mutation = `mutation CreateVideoPost {
  createPost(
    input: {
      text: ${q(input.text)}
      channelId: ${q(input.channelId)}
      schedulingType: automatic
      mode: addToQueue
      assets: [
        {
          video: {
            url: ${q(input.videoUrl)}${thumbnail}
          }
        }
      ]${metadata}
    }
  ) {
    ... on PostActionSuccess {
      post {
        id
      }
    }
    ... on MutationError {
      message
    }
  }
}`;

    const data = await this.graphql<{
      createPost: { post?: { id: string }; message?: string };
    }>(mutation);

    if (data.createPost?.message) {
      throw new BufferError(`Buffer rejected the reel: ${data.createPost.message}`);
    }

    const id = data.createPost?.post?.id;
    if (!id) throw new BufferError('Buffer did not return a post id for the reel');

    return id;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.getOrganizationId();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}
