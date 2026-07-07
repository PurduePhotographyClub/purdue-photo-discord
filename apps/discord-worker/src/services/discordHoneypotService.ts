import type { GatewayInternalEvent } from '@pccbot/shared';
import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';
import { discordApiRequest } from '../discord/api';
import type { Env } from '../discord/types';
import { getRequiredEnv } from '../utils/env';
import { sendDiscordMessage } from './discordMessageService';

export const HONEYPOT_WARNING_MESSAGE = [
  '# ⚠️ DO NOT TYPE HERE',
  '',
  '> This channel is a honeypot for spam bots.  ',
  '> If you are a real person, please do not post here.',
  '',
  '━━━━━━━━━━━━━━━━━━━━',
  '',
  '## 🚫 What happens if you type here?',
  '',
  '* Your message will be deleted automatically and all channels will be hidden for you. You will be able to talk to us if something happens.',
  '',
  '━━━━━━━━━━━━━━━━━━━━',
  '',
  'If you are new, go over **Get Started** and follow the normal server steps.',
  '',
  'Do not test this channel "just to see what happens" 😭',
].join('\n');

interface DiscordMessageResponse {
  id?: string;
}

export interface DiscordHoneypotWarningResult {
  channelId: string;
  messageId: string | null;
}

export interface DiscordHoneypotMessageResult {
  handled: boolean;
}

export async function postDiscordHoneypotWarningMessage(
  env: Env,
): Promise<DiscordHoneypotWarningResult> {
  const channelId = DISCORD_CHANNEL_IDS.honeypot;
  const message = (await sendDiscordMessage(env, {
    channelId,
    content: HONEYPOT_WARNING_MESSAGE,
  })) as DiscordMessageResponse;

  return {
    channelId,
    messageId: typeof message.id === 'string' ? message.id : null,
  };
}

export async function handleDiscordHoneypotMessage(
  event: GatewayInternalEvent,
  env: Env,
): Promise<DiscordHoneypotMessageResult> {
  if (!isHoneypotMessageCreate(event)) {
    return { handled: false };
  }

  const messageId = event.messageId?.trim();
  const userId = event.userId?.trim();
  if (!messageId || !userId) {
    return { handled: false };
  }

  const guildId =
    event.guildId?.trim() || getRequiredEnv(env, 'DISCORD_GUILD_ID');

  await deleteDiscordMessage(env, DISCORD_CHANNEL_IDS.honeypot, messageId);
  await addHoneypotRole(env, guildId, userId);

  return { handled: true };
}

function isHoneypotMessageCreate(event: GatewayInternalEvent) {
  return (
    event.eventType === 'MESSAGE_CREATE' &&
    event.channelId === DISCORD_CHANNEL_IDS.honeypot &&
    !isAuthorBot(event.payload)
  );
}

async function deleteDiscordMessage(
  env: Env,
  channelId: string,
  messageId: string,
) {
  await discordApiRequest(env, `/channels/${channelId}/messages/${messageId}`, {
    method: 'DELETE',
  });
}

async function addHoneypotRole(env: Env, guildId: string, userId: string) {
  await discordApiRequest(
    env,
    `/guilds/${guildId}/members/${userId}/roles/${DISCORD_ROLE_IDS.honeypotRestricted}`,
    { method: 'PUT' },
  );
}

function isAuthorBot(payload: Record<string, unknown>) {
  const author = payload.author;

  if (!isRecord(author)) {
    return false;
  }

  return author.bot === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
