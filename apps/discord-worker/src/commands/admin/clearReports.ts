import { ephemeralResponse } from '../../discord/responses';
import type {
  DiscordApplicationCommandOption,
  DiscordCommand,
} from '../../discord/types';
import { requestWebsiteApi } from '../../services/websiteApiService';
import { createLogger } from '../../utils/logger';
import { getExecutiveRoleError } from './permissions';

const STRING_OPTION = 3;
const REQUIRED_CONFIRMATION = 'CLEAR REPORTS';
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

const logger = createLogger('clear-member-reports');

interface DeletedReportCounts {
  aliases: number;
  audits: number;
  reports: number;
  subjects: number;
}

export const clearReportsCommand: DiscordCommand = {
  definition: {
    description: 'Permanently clear all member reports.',
    name: 'clear-reports',
    options: [
      {
        description: 'Type CLEAR REPORTS to confirm permanent deletion.',
        name: 'confirm',
        required: true,
        type: STRING_OPTION,
      },
    ],
  },
  execute: async (interaction, env) => {
    const permissionError = getExecutiveRoleError(interaction, env);
    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    const confirmation = readStringOption(
      interaction.data.options ?? [],
      'confirm',
    )?.trim();
    if (confirmation !== REQUIRED_CONFIRMATION) {
      return ephemeralResponse(
        'Type CLEAR REPORTS exactly to confirm permanent deletion.',
      );
    }

    const discordId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!discordId || !DISCORD_SNOWFLAKE_PATTERN.test(discordId)) {
      return ephemeralResponse('I could not identify your Discord account.');
    }

    try {
      const response = await requestWebsiteApi(
        env,
        '/admin/member-reports/clear-by-discord',
        {
          body: {
            confirmation: REQUIRED_CONFIRMATION,
            discordId,
          },
          method: 'DELETE',
        },
      );
      const deleted = readDeletedReportCounts(response);
      if (!deleted) {
        throw new Error(
          'Clear member reports response did not include valid counts.',
        );
      }

      return ephemeralResponse(
        `Cleared ${formatCount(deleted.reports, 'report')}, ${formatCount(deleted.subjects, 'subject')}, ${formatCount(deleted.aliases, 'alias', 'aliases')}, and ${formatCount(deleted.audits, 'audit record')}.`,
      );
    } catch (error) {
      logger.warn('Could not clear member reports.', { error });
      return ephemeralResponse(
        'I could not clear the member reports. Try again later.',
      );
    }
  },
};

function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function readStringOption(
  options: DiscordApplicationCommandOption[],
  name: string,
): string | undefined {
  const value = options.find((option) => option.name === name)?.value;
  return typeof value === 'string' ? value : undefined;
}

function readDeletedReportCounts(value: unknown): DeletedReportCounts | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.deleted)) {
    return null;
  }

  const counts = {
    aliases: value.deleted.aliases,
    audits: value.deleted.audits,
    reports: value.deleted.reports,
    subjects: value.deleted.subjects,
  };
  if (
    Object.values(counts).some(
      (count) =>
        typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0,
    )
  ) {
    return null;
  }

  return counts as DeletedReportCounts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
