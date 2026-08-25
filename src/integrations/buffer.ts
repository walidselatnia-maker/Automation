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
        metadata?: { boards?: BufferBoard[] };
      }[];
    }>(
      'query GetChannelsWithBoards($orgId: OrganizationId!) { channels(input: { organizationId: $orgId }) { id name metadata { ... on PinterestMetadata { boards {  serviceId name  } } } } }',
      { orgId: organizationId },
    );

    return (data.channels ?? []).map((c) => ({
      id: c.id,
      name: c.name,
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

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.getOrganizationId();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}
