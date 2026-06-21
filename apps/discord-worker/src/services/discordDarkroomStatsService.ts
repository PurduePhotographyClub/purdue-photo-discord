import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import { discordApiRequest } from '../discord/api';
import type { Env } from '../discord/types';
import { getDiscordGuildStats } from './discordGuildStatsService';
import type {
  DarkroomStatsRank,
  DarkroomStatsRecentLog,
  DarkroomStatsSyncInternalEvent,
} from '../internal-events/types';

const EMBED_COLOR_DARKROOM = 0x9f7aea;
const MAX_FIELD_VALUE_LENGTH = 1_024;
const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

interface DiscordMessageResponse {
  id?: string;
}

interface DiscordChannelResponse {
  name?: string;
}

export interface DarkroomStatsSyncResult {
  channelId: string;
  discordMemberCount: number;
  messageId: string | null;
  userCount: number;
  voiceChannelId: string;
  voiceChannelName: string;
}

export async function syncDarkroomStatsMessage(
  env: Env,
  event: DarkroomStatsSyncInternalEvent,
): Promise<DarkroomStatsSyncResult> {
  const payload = createDarkroomStatsMessagePayload(event);
  const message = event.messageId
    ? await discordApiRequest<DiscordMessageResponse>(
        env,
        `/channels/${DISCORD_CHANNEL_IDS.darkroomStats}/messages/${event.messageId}`,
        {
          body: JSON.stringify(payload),
          method: 'PATCH',
        },
      )
    : await discordApiRequest<DiscordMessageResponse>(
        env,
        `/channels/${DISCORD_CHANNEL_IDS.darkroomStats}/messages`,
        {
          body: JSON.stringify(payload),
          method: 'POST',
        },
      );
  const guildStats = await getDiscordGuildStats(env);
  const voiceChannelName = formatDiscordUserCountChannelName(
    guildStats.memberCount,
  );
  const voiceChannel = await discordApiRequest<DiscordChannelResponse>(
    env,
    `/channels/${DISCORD_CHANNEL_IDS.darkroomUserCountVoice}`,
    {
      body: JSON.stringify({ name: voiceChannelName }),
      method: 'PATCH',
    },
  );

  return {
    channelId: DISCORD_CHANNEL_IDS.darkroomStats,
    discordMemberCount: guildStats.memberCount,
    messageId: message.id ?? event.messageId ?? null,
    userCount: event.userCount,
    voiceChannelId: DISCORD_CHANNEL_IDS.darkroomUserCountVoice,
    voiceChannelName: voiceChannel.name ?? voiceChannelName,
  };
}

function createDarkroomStatsMessagePayload(
  event: DarkroomStatsSyncInternalEvent,
) {
  return {
    content: '',
    embeds: [
      {
        color: EMBED_COLOR_DARKROOM,
        description: [
          `**${formatNumber(event.totalRolls)} rolls developed** across ${formatNumber(event.logCount)} logged session${event.logCount === 1 ? '' : 's'}.`,
          `${formatNumber(event.userCount)} darkroom user${event.userCount === 1 ? '' : 's'} have logged development, with ${formatNumber(event.rollsThisMonth)} roll${event.rollsThisMonth === 1 ? '' : 's'} this month.`,
        ].join('\n'),
        fields: [
          {
            inline: false,
            name: 'Process Mix',
            value: formatBreakdown([
              ['C-41', event.c41, event.totalRolls],
              ['B&W', event.bw, event.totalRolls],
              ['E-6', event.slide, event.totalRolls],
            ]),
          },
          {
            inline: true,
            name: 'Formats',
            value: formatBreakdown([
              ['35mm', event.format35mm, event.totalRolls],
              ['120', event.format120, event.totalRolls],
            ]),
          },
          {
            inline: true,
            name: 'Pulse',
            value: [
              `This month: **${formatNumber(event.rollsThisMonth)}**`,
              `Users: **${formatNumber(event.userCount)}**`,
              `Logs: **${formatNumber(event.logCount)}**`,
            ].join('\n'),
          },
          {
            inline: false,
            name: 'Top Film Stocks',
            value: formatRankList(event.topStocks),
          },
          {
            inline: false,
            name: 'Top Developers',
            value: formatRankList(event.topDevelopers),
          },
          {
            inline: false,
            name: 'Latest Logs',
            value: formatRecentLogs(event.recentLogs),
          },
        ],
        footer: {
          text: 'Purdue Photography Club darkroom stats',
        },
        timestamp: event.updatedAt,
        title: 'Darkroom Stats',
      },
    ],
  };
}

function formatBreakdown(items: Array<[string, number, number]>) {
  return truncate(
    items
      .map(([label, value, total]) => {
        const percent = total > 0 ? Math.round((value / total) * 100) : 0;
        return `**${label}** ${formatNumber(value)} (${percent}%) ${formatBar(percent)}`;
      })
      .join('\n'),
    MAX_FIELD_VALUE_LENGTH,
  );
}

function formatRankList(items: DarkroomStatsRank[]) {
  if (items.length === 0) {
    return 'No rolls logged yet.';
  }

  return truncate(
    items
      .slice(0, 5)
      .map(
        (item, index) =>
          `${index + 1}. **${truncate(item.name, 80)}** - ${formatNumber(item.rolls)} roll${item.rolls === 1 ? '' : 's'}`,
      )
      .join('\n'),
    MAX_FIELD_VALUE_LENGTH,
  );
}

function formatRecentLogs(logs: DarkroomStatsRecentLog[]) {
  if (logs.length === 0) {
    return 'No recent darkroom logs yet.';
  }

  return truncate(
    logs
      .slice(0, 5)
      .map((log) => {
        const countLabel = `${formatNumber(log.rollCount)} roll${log.rollCount === 1 ? '' : 's'}`;
        return `**${truncate(log.userName, 64)}** developed ${countLabel} of ${truncate(log.filmStockName, 80)} (${log.format}, ${log.process}) on ${formatPlainDate(log.createdAt)}`;
      })
      .join('\n'),
    MAX_FIELD_VALUE_LENGTH,
  );
}

function formatBar(percent: number) {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `[${'#'.repeat(filled)}${'-'.repeat(10 - filled)}]`;
}

function formatDiscordUserCountChannelName(memberCount: number) {
  return `Discord Users: ${formatNumber(memberCount)}`;
}

function formatPlainDate(value: string) {
  return new Date(value).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatNumber(value: number) {
  return NUMBER_FORMATTER.format(value);
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
