/**
 * Public command for registering an email address with the PPC newsletter.
 */
import type {
  DiscordApplicationCommandOption,
  DiscordCommand,
} from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { requestWebsiteApi } from '../../services/websiteApiService';
import { getOptionalEnv } from '../../utils/env';
import { getErrorMessage } from '../../utils/errors';

const STRING_OPTION = 3;
const MANAGE_URL =
  'https://lists.purdue.edu/scripts/wa.exe?SUBED1=PURDUEPHOTOCLUB&A=1';

interface NewsletterApiResponse {
  listserv?: {
    manageUrl?: unknown;
    message?: unknown;
    submitted?: unknown;
  };
  success?: unknown;
}

export const newsletterCommand: DiscordCommand = {
  definition: {
    description: 'Register for the PPC newsletter.',
    name: 'newsletter',
    options: [
      {
        description: 'Your full name for the LISTSERV subscription.',
        name: 'name',
        required: true,
        type: STRING_OPTION,
      },
      {
        description: 'Email address to subscribe.',
        name: 'email',
        required: true,
        type: STRING_OPTION,
      },
    ],
  },
  execute: async (interaction, env) => {
    const options = interaction.data.options ?? [];
    const name = getStringOption(options, 'name')?.trim() ?? '';
    const email = getStringOption(options, 'email')?.trim().toLowerCase() ?? '';

    if (!name) {
      return ephemeralResponse('Please include your full name.');
    }

    if (!isValidEmail(email)) {
      return ephemeralResponse('Please use a valid email address.');
    }

    try {
      const response = await requestWebsiteApi(env, '/newsletter/subscribe', {
        body: {
          email,
          name,
          source: 'discord',
        },
        method: 'POST',
      });
      const parsed = readNewsletterApiResponse(response);
      const manageUrl = parsed.listserv?.manageUrl ?? getManageUrl(env);

      if (!parsed.success) {
        return ephemeralResponse(
          `The newsletter API did not confirm the signup. Finish or manage it here: ${manageUrl}`,
        );
      }

      if (parsed.listserv?.submitted) {
        return ephemeralResponse(
          `You're registered for the PPC newsletter. Check ${email} for any Purdue LISTSERV confirmation email.`,
        );
      }

      return ephemeralResponse(
        `I saved the signup, but Purdue LISTSERV may need browser confirmation. Finish or manage it here: ${manageUrl}`,
      );
    } catch (error) {
      return ephemeralResponse(
        `Could not register for the newsletter: ${getErrorMessage(error)}`,
      );
    }
  },
};

function getStringOption(
  options: DiscordApplicationCommandOption[],
  name: string,
): string | undefined {
  const value = options.find((option) => option.name === name)?.value;
  return typeof value === 'string' ? value : undefined;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function readNewsletterApiResponse(value: unknown): {
  listserv?: {
    manageUrl?: string;
    message?: string;
    submitted?: boolean;
  };
  success: boolean;
} {
  if (!isRecord(value)) {
    return { success: false };
  }

  const listserv = isRecord((value as NewsletterApiResponse).listserv)
    ? (value as NewsletterApiResponse).listserv
    : undefined;
  const normalizedListserv:
    | {
        manageUrl?: string;
        message?: string;
        submitted?: boolean;
      }
    | undefined = listserv
    ? {
        submitted:
          typeof listserv.submitted === 'boolean' ? listserv.submitted : false,
      }
    : undefined;

  if (normalizedListserv && typeof listserv?.manageUrl === 'string') {
    normalizedListserv.manageUrl = listserv.manageUrl;
  }

  if (normalizedListserv && typeof listserv?.message === 'string') {
    normalizedListserv.message = listserv.message;
  }

  const result: {
    listserv?: {
      manageUrl?: string;
      message?: string;
      submitted?: boolean;
    };
    success: boolean;
  } = {
    success: value.success === true,
  };

  if (normalizedListserv) {
    result.listserv = normalizedListserv;
  }

  return result;
}

function getManageUrl(env: { WEBSITE_URL?: string | undefined }) {
  const websiteUrl = getOptionalEnv(env, 'WEBSITE_URL')?.replace(/\/+$/, '');
  return websiteUrl ? `${websiteUrl}/#newsletter` : MANAGE_URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
