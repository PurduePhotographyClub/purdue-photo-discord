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
  'Before accepting a job, make sure that you know exactly what you are getting into. The first thing to keep in mind is delivery: what is the client expecting from you? Make sure that both you and the client agree upon the type of images, the number of images, and by what time the client will receive the images. While it is generally unadvisable to deliver raw pictures, this can vary based on the type of job and client requests. Second, ensure that both you and the client are on the same page regarding payment. Do you prefer to charge hourly, or by number of final images? When are you to receive the payment–before delivering the images, or after? If you are being hired by another student organization, keep in mind that BOSO takes at least two weeks to do anything. This will impact the timing of your payment. Lastly, understand how the photos will be used in the future. As the photographer, you own the copyright to every image you take unless explicitly transferred in writing. Paying for a photoshoot does not automatically give the client ownership of the copyright or unlimited usage rights. Most, if not all, of the jobs that you might accept through PPC will be for personal use, so explicitly outlining usage rights to the pictures is typically not needed. However, if you intend to use any images for your portfolio or social media, you must obtain permission from the client to do so. In the event that the images you are taking will be for commercial use, then you might want to be more specific for how long and for what purpose your client can use your images.',
  '',
  '## 💬 COMMUNICATION',
  '',
  "The number one rule of doing business is to satisfy the client. This is cheesy, but unfortunately that’s how it goes, so you need to make sure you are communicating as frequently as possible. Double check plans 24 hours before, let them know when you’re there, send a thank you when it's over, etc. Clients are not going to be pissed if you’re taking more time than expected to edit photos as long as you’re frequently updating them with an ETA. If you leave them sitting in their own thoughts,  they’re just going to get anxious and think you’re scamming them, which leads to a bad review for you.",
  '',
  '## 📅 COVERING EVENTS',
  '',
  "Showing up early and leaving late (when possible) is generally good advice, but is even more important when shooting events. It's more likely to get you recommendations, repeat business, and sometimes even a bonus. While you should establish as much as possible before the event, showing up early gives you more time to chat with the organizer of the event. Learn the schedule, people of importance, and where the photos will be used (if for social media, shoot vertically, default to horizontal otherwise). Learn to time people talking and eating, and take bursts when they do–you don't want a photo of someone with food in their mouth. Always make sure everyone is flattering in a photo, and try to minimize empty space (empty seats and undercrowded rooms make it seem like an event had low turn out, cover that up with careful composition and the use of longer focal lengths). An event organizer is stressing about a million things–if you show up early, ask questions, are confident, and stay out of people's way, the organizer will not need to worry about you. That is worth more to them than a pretty picture, and will win you a lot of leeway with final output; sometimes lighting and venue is shit, the photos will be bad and you can't fix that. Always dress appropriately (if unsure, lean on the side of overdressing). Avoid bright colors or white especially if it's during a performance; stage lighting will bounce off and be super annoying to guests. Again–can’t stress this enough–your client liking and trusting you is more important than the quality of your photos.",
  '',
  '## 📄 CONTRACTS AND LATE ARRIVALS',
  '',
  "The number one rule of writing contracts is to CYA (cover your ass). Read every single line, and if you or the other party decide to change anything, always request to have it in writing. Never feel bad for asking the client to revise the contract so it matches what they promised you. Clients are paying you for your time, so it’s recommended having a late/cancellation policy in place in your contract. Personally, I charge 50% of my hourly rate for every hour that they’re late, but it's up to you. It’s also good to set up a deposit clause in your contract if people end up cancelling. Again, CYA and don’t let people take advantage of your time.",
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
