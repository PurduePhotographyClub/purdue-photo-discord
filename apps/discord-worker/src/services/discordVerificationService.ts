import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import { getServerVerifiedRoleId } from './discordMemberRoleService';
import { sendDiscordMessage } from './discordMessageService';
import { requestWebsiteApi } from './websiteApiService';
import type {
  ComponentInteraction,
  DiscordMessagePayload,
  Env,
} from '../discord/types';
import { ephemeralResponse } from '../discord/responses';
import type { DiscordInteractionResponse } from '../discord/types';
import { getErrorMessage } from '../utils/errors';
import { getDiscordAccountAgeDecision } from './discordVerificationPolicy';

const ACTION_ROW = 1;
const BUTTON = 2;
const PRIMARY_BUTTON = 1;

export const DISCORD_VERIFY_BUTTON_CUSTOM_ID = 'discord_verify:start';

interface VerificationChallengeResponse {
  code?: string;
  expiresAt?: string;
  retryAfterSeconds?: number;
  verificationUrl?: string;
}

export async function postDiscordVerificationMessage(env: Env) {
  const channelId = getVerificationChannelId(env);
  const result = await sendDiscordMessage(env, {
    channelId,
    ...createVerificationMessagePayload(),
  });

  return {
    channelId,
    messageId: readMessageId(result),
  };
}

export async function sendDiscordVerificationWelcomeMessage(
  env: Env,
  input: {
    applicationId?: string | undefined;
    discordId: string;
    interactionToken?: string | undefined;
  },
) {
  const applicationId = input.applicationId || env.DISCORD_APPLICATION_ID;
  if (!applicationId || !input.interactionToken) {
    return;
  }

  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(input.interactionToken)}`,
    {
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        content:
          "You're verified. Welcome to the Purdue Photography Club Discord.",
        flags: 64,
      }),
      headers: {
        'content-type': 'application/json;charset=UTF-8',
      },
      method: 'POST',
    },
  );

  if (!response.ok) {
    throw new Error(`Discord follow-up failed with ${response.status}.`);
  }
}

export async function handleDiscordVerifyButton(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const discordId = getInteractionUserId(interaction);
  if (!discordId) {
    return ephemeralResponse('Could not identify your Discord user.');
  }

  const verifiedRoleId = getServerVerifiedRoleId(env);
  if (interaction.member?.roles?.includes(verifiedRoleId)) {
    return ephemeralResponse('You are already verified.');
  }

  const accountAge = getDiscordAccountAgeDecision(
    discordId,
    env.DISCORD_MIN_ACCOUNT_AGE_DAYS,
  );
  if (!accountAge.createdAt) {
    return ephemeralResponse(
      'Could not read your Discord account age. Please try again later.',
    );
  }

  if (!accountAge.allowed && accountAge.retryAt) {
    return ephemeralResponse(
      `Your Discord account must be at least ${formatDays(accountAge.minimumAgeDays)} old to verify. Try again after ${accountAge.retryAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC.`,
    );
  }

  try {
    const challenge = await requestWebsiteApi(
      env,
      '/discord-verification/start',
      {
        body: {
          applicationId: interaction.application_id,
          discordId,
          interactionToken: interaction.token,
        },
        method: 'POST',
      },
    );
    const data = readChallengeResponse(challenge);

    if (!data?.code || !data.verificationUrl) {
      return ephemeralResponse(
        'The website did not return a verification code. Please try again.',
      );
    }

    return ephemeralResponse(
      createChallengeResponse({
        code: data.code,
        verificationUrl: data.verificationUrl,
      }),
    );
  } catch (error) {
    return ephemeralResponse(
      `Could not start verification: ${getErrorMessage(error)}`,
    );
  }
}

function createVerificationMessagePayload(): DiscordMessagePayload {
  return {
    embeds: [
      {
        color: 0x58a6ff,
        description:
          'Verification is required before the rest of the server opens up. Click the button below and follow the private instructions.',
        footer: {
          text: 'Purdue Photography Club',
        },
        title: 'Verify to enter',
      },
    ],
    components: [
      {
        components: [
          {
            custom_id: DISCORD_VERIFY_BUTTON_CUSTOM_ID,
            emoji: { name: '📷' },
            label: 'Verify',
            style: PRIMARY_BUTTON,
            type: BUTTON,
          },
        ],
        type: ACTION_ROW,
      },
    ],
  };
}

function createChallengeResponse(
  data: Required<
    Pick<VerificationChallengeResponse, 'code' | 'verificationUrl'>
  >,
) {
  return {
    embeds: [
      {
        color: 0x57d68d,
        description: [
          `Open this link and enter code \`${data.code}\`.`,
          '',
          data.verificationUrl,
          '',
          'The code expires in 10 minutes and can only be used once.',
        ].join('\n'),
        title: 'Discord verification',
      },
    ],
  };
}

function getVerificationChannelId(env: Env) {
  return (
    env.DISCORD_VERIFICATION_CHANNEL_ID?.trim() ||
    DISCORD_CHANNEL_IDS.verification
  );
}

function getInteractionUserId(interaction: ComponentInteraction) {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function formatDays(days: number) {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

function readChallengeResponse(
  value: unknown,
): VerificationChallengeResponse | null {
  if (!isRecord(value)) {
    return null;
  }

  const response: VerificationChallengeResponse = {};
  if (typeof value.code === 'string') {
    response.code = value.code;
  }
  if (typeof value.expiresAt === 'string') {
    response.expiresAt = value.expiresAt;
  }
  if (typeof value.retryAfterSeconds === 'number') {
    response.retryAfterSeconds = value.retryAfterSeconds;
  }
  if (typeof value.verificationUrl === 'string') {
    response.verificationUrl = value.verificationUrl;
  }

  return response;
}

function readMessageId(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }

  return typeof value.id === 'string' ? value.id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
