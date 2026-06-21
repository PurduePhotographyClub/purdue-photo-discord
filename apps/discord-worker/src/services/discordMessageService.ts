/**
 * Sends outbound Discord messages through the REST API.
 *
 * Internal routes and Gateway event handlers use this instead of calling
 * Discord directly, so channel fallback and mention safety stay consistent.
 */
import { discordApiRequest } from '../discord/api';
import type { DiscordEmbed, Env } from '../discord/types';
import { getOptionalEnv } from '../utils/env';
import { BadRequestError } from '../utils/errors';

export interface SendDiscordMessageInput {
  channelId?: string | undefined;
  components?: unknown[] | undefined;
  content?: string | undefined;
  embeds?: DiscordEmbed[] | undefined;
}

export interface EditDiscordMessageInput {
  channelId: string;
  components?: unknown[] | undefined;
  content?: string | undefined;
  embeds?: DiscordEmbed[] | undefined;
  messageId: string;
}

export interface SendDiscordDirectMessageInput {
  components?: unknown[] | undefined;
  content?: string | undefined;
  embeds?: DiscordEmbed[] | undefined;
  recipientId: string;
}

interface DiscordChannelResponse {
  id?: string;
}

interface DiscordMessageResponse {
  id?: string;
}

export interface SendDiscordDirectMessageResult {
  channelId: string;
  messageId: string | null;
}

export async function sendDiscordMessage(
  env: Env,
  input: SendDiscordMessageInput,
): Promise<unknown> {
  // Internal producers can target a channel explicitly, while simple automation
  // can fall back to the Worker-level default channel.
  const channelId =
    input.channelId ?? getOptionalEnv(env, 'DISCORD_DEFAULT_CHANNEL_ID');

  if (!channelId) {
    // Surface producer mistakes as 400-style app errors instead of Discord API
    // failures that are harder to understand.
    throw new BadRequestError(
      'A Discord channel ID is required for outbound messages.',
    );
  }

  if (!input.content && (!input.embeds || input.embeds.length === 0)) {
    // Discord rejects empty message bodies, so validate before making the API
    // call and spending the rate-limit budget.
    throw new BadRequestError(
      'Outbound Discord messages need content or at least one embed.',
    );
  }

  return discordApiRequest(env, `/channels/${channelId}/messages`, {
    body: JSON.stringify({
      // Prevent forwarded website or gateway text from unexpectedly pinging
      // members, roles, or everyone in the server.
      allowed_mentions: { parse: [] },
      components: input.components,
      content: input.content,
      embeds: input.embeds,
    }),
    method: 'POST',
  });
}

export async function sendDiscordDirectMessage(
  env: Env,
  input: SendDiscordDirectMessageInput,
): Promise<SendDiscordDirectMessageResult> {
  const recipientId = input.recipientId.trim();
  if (!recipientId) {
    throw new BadRequestError('A Discord recipient ID is required for DMs.');
  }

  if (!input.content && (!input.embeds || input.embeds.length === 0)) {
    throw new BadRequestError(
      'Discord DMs need content or at least one embed.',
    );
  }

  const channel = await discordApiRequest<DiscordChannelResponse>(
    env,
    '/users/@me/channels',
    {
      body: JSON.stringify({ recipient_id: recipientId }),
      method: 'POST',
    },
  );

  if (!channel.id) {
    throw new BadRequestError('Discord did not return a DM channel ID.');
  }

  const message = (await sendDiscordMessage(env, {
    channelId: channel.id,
    components: input.components,
    content: input.content,
    embeds: input.embeds,
  })) as DiscordMessageResponse;

  return {
    channelId: channel.id,
    messageId: typeof message.id === 'string' ? message.id : null,
  };
}

export async function editDiscordMessage(
  env: Env,
  input: EditDiscordMessageInput,
): Promise<unknown> {
  if (!input.channelId || !input.messageId) {
    throw new BadRequestError(
      'A Discord channel ID and message ID are required to edit messages.',
    );
  }

  if (!input.content && (!input.embeds || input.embeds.length === 0)) {
    throw new BadRequestError(
      'Edited Discord messages need content or at least one embed.',
    );
  }

  return discordApiRequest(
    env,
    `/channels/${input.channelId}/messages/${input.messageId}`,
    {
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        components: input.components,
        content: input.content,
        embeds: input.embeds,
      }),
      method: 'PATCH',
    },
  );
}
