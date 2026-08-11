import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import {
  DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION,
  DISCORD_ROLE_IDS,
} from '../config/discord-role-ids';
import { discordApiRequest } from '../discord/api';
import { ephemeralResponse } from '../discord/responses';
import type {
  ComponentInteraction,
  DiscordInteractionResponse,
  Env,
} from '../discord/types';
import { getRequiredEnv } from '../utils/env';
import { createLogger } from '../utils/logger';
import { sendDiscordMessage } from './discordMessageService';

const ACTION_ROW = 1;
const BUTTON = 2;
const SUCCESS_BUTTON = 3;
const DISCORD_MESSAGE_LIMIT = 2_000;
const DISCORD_JOBS_ACCESS_ALLOWED_ROLE_PERMISSIONS = 0n;
const logger = createLogger('jobs-access');

export const JOBS_101_MESSAGE_CHANNEL_ID = DISCORD_CHANNEL_IDS.jobs101;
export const JOBS_ACCESS_ROLE_ID = DISCORD_ROLE_IDS.jobsAccess;
export const JOBS_ACCESS_ACCEPT_CUSTOM_ID = 'jobs_101:v1:accept';

export const JOBS_101_GUIDE_CONTENT = [
  '# 📸 JOBS 101',
  '',
  '## ✅ GENERAL TIPS',
  '',
  '- Agree on the deliverables before you accept: image type, final count, and deadline.',
  '- Decide how and when you will be paid. For Purdue student organizations, allow at least two weeks for BOSO payments.',
  '- Do not promise RAW files unless the job calls for them.',
  '- You keep the copyright unless you transfer it in writing. Get permission before using client photos in your portfolio or on social media, and set clear usage rights for commercial work.',
  '',
  '## 💬 COMMUNICATION',
  '',
  '- Confirm the plan 24 hours before the shoot.',
  '- Tell the client when you arrive, thank them afterward, and share editing updates with a realistic ETA.',
  '- If something changes or takes longer than expected, say so early. Silence makes clients worry.',
  '',
  '## 📅 COVERING EVENTS',
  '',
  '- Arrive early when possible so you can learn the schedule, key people, and where the photos will be used.',
  '- Shoot vertically for social media and horizontally by default elsewhere.',
  '- Watch your timing around talking and eating. Use bursts, flattering angles, and tighter framing to avoid awkward moments or empty-looking rooms.',
  '- Dress for the event. Avoid bright colors and white during performances.',
  "- Be confident, ask useful questions, stay out of the way, and make the organizer's job easier.",
  '',
  '## 📄 CONTRACTS AND LATE ARRIVALS',
  '',
  '- Read every line and put every change or promise in writing.',
  '- Ask for revisions when the contract does not match what you agreed to.',
  '- Set late, cancellation, and deposit terms before the job.',
  '- Protect your time and do not agree to terms you cannot enforce.',
  '',
  'Read the full Jobs 101 guide: https://wiki.purduephotoclub.org/jobs/',
].join('\n');

const JOBS_101_ACKNOWLEDGEMENT_CONTENT = [
  '## ✅ JOBS 101 TERMS AND CONDITIONS',
  '',
  'By selecting **I have read and accept**, you confirm that you have read the Jobs 101 guidance above. The Jobs role will be added to your account, giving you access to the job posting channels.',
].join('\n');

interface DiscordMessageResult {
  id?: string;
}

interface DiscordRoleResult {
  id?: string;
  permissions?: string;
}

export function isJobsAccessButtonCustomId(customId: string) {
  return customId === JOBS_ACCESS_ACCEPT_CUSTOM_ID;
}

export async function postJobs101Messages(env: Env) {
  const messageIds: string[] = [];

  for (const content of splitDiscordContent(JOBS_101_GUIDE_CONTENT)) {
    const result = (await sendDiscordMessage(env, {
      channelId: JOBS_101_MESSAGE_CHANNEL_ID,
      content,
    })) as DiscordMessageResult;

    if (typeof result.id === 'string') {
      messageIds.push(result.id);
    }
  }

  const acknowledgement = (await sendDiscordMessage(env, {
    channelId: JOBS_101_MESSAGE_CHANNEL_ID,
    components: [
      {
        components: [
          {
            custom_id: JOBS_ACCESS_ACCEPT_CUSTOM_ID,
            label: 'I have read and accept',
            style: SUCCESS_BUTTON,
            type: BUTTON,
          },
        ],
        type: ACTION_ROW,
      },
    ],
    content: JOBS_101_ACKNOWLEDGEMENT_CONTENT,
  })) as DiscordMessageResult;

  if (typeof acknowledgement.id === 'string') {
    messageIds.push(acknowledgement.id);
  }

  return {
    channelId: JOBS_101_MESSAGE_CHANNEL_ID,
    messageIds,
  };
}

export async function handleJobsAccessButton(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const discordId = interaction.member?.user?.id;
  if (!discordId) {
    return ephemeralResponse('I could not identify your Discord account.');
  }

  try {
    const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
    if (
      interaction.guild_id !== guildId ||
      interaction.channel_id !== JOBS_101_MESSAGE_CHANNEL_ID
    ) {
      return ephemeralResponse('This Jobs 101 button is not valid here.');
    }

    const memberRoleIds = interaction.member?.roles ?? [];
    if (
      !memberRoleIds.includes(
        DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION.memberRoleId,
      )
    ) {
      return ephemeralResponse(
        'You need the PPC Member role before you can access the job posting channels.',
      );
    }

    if (memberRoleIds.includes(JOBS_ACCESS_ROLE_ID)) {
      return ephemeralResponse(
        'You already have access to the job posting channels.',
      );
    }

    await assertJobsAccessRoleSafe(env, guildId);
    await discordApiRequest(
      env,
      `/guilds/${guildId}/members/${discordId}/roles/${JOBS_ACCESS_ROLE_ID}`,
      { method: 'PUT' },
    );

    return ephemeralResponse(
      'You have confirmed that you read Jobs 101. You now have access to the job posting channels.',
    );
  } catch (error) {
    logger.warn('Could not grant the Jobs access role.', { error });
    return ephemeralResponse(
      'I could not give you access to the job posting channels. Please contact an Executive.',
    );
  }
}

async function assertJobsAccessRoleSafe(env: Env, guildId: string) {
  const roles = await discordApiRequest<DiscordRoleResult[]>(
    env,
    `/guilds/${guildId}/roles`,
  );
  const jobsRole = roles.find((role) => role.id === JOBS_ACCESS_ROLE_ID);
  const permissions = parseDiscordPermissionBits(jobsRole?.permissions);

  if (
    !jobsRole ||
    permissions === null ||
    permissions !== DISCORD_JOBS_ACCESS_ALLOWED_ROLE_PERMISSIONS
  ) {
    throw new Error(
      'The Jobs access role is missing or unsafe to self-assign.',
    );
  }
}

function parseDiscordPermissionBits(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function splitDiscordContent(
  content: string,
  limit = DISCORD_MESSAGE_LIMIT,
): string[] {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > limit) {
    const splitAt = findReadableSplit(remaining, limit);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function findReadableSplit(content: string, limit: number) {
  const paragraphBreak = content.lastIndexOf('\n\n', limit - 2);
  if (paragraphBreak > 0) {
    if (!endsWithMarkdownHeading(content.slice(0, paragraphBreak))) {
      return paragraphBreak + 2;
    }

    const previousParagraphBreak = content.lastIndexOf(
      '\n\n',
      paragraphBreak - 1,
    );
    if (previousParagraphBreak > 0) {
      return previousParagraphBreak + 2;
    }
  }

  for (const boundary of ['. ', '? ', '! ', '; ', '\n', ' ']) {
    const index = content.lastIndexOf(boundary, limit - boundary.length);
    if (index > 0) {
      return index + boundary.length;
    }
  }

  return limit;
}

function endsWithMarkdownHeading(content: string) {
  const finalLine = content.trimEnd().split('\n').at(-1);
  return typeof finalLine === 'string' && /^#{1,6} .+$/u.test(finalLine);
}
