/**
 * Public health command for Discord.
 *
 * This command reads Worker-side config and performs lightweight external
 * checks, then renders a short Discord embed that is safe to show to the caller.
 */
import type {
  DiscordCommand,
  DiscordInteractionResponse,
  DiscordMessagePayload,
} from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import {
  getSystemHealth,
  type ServiceHealthCheck,
  type SystemHealthReport,
} from '../../services/healthService';

export const healthCommand: DiscordCommand = {
  definition: {
    description: "Check the PPC bot's status and website health.",
    name: 'health',
  },
  execute: async (_interaction, env) => {
    // Health checks can perform network requests, so keep the command async and
    // delegate the actual probing to the service layer.
    const report = await getSystemHealth(env);
    return createHealthResponse(report);
  },
};

function createHealthResponse(
  report: SystemHealthReport,
): DiscordInteractionResponse {
  // Discord relative timestamps render in each user's local timezone.
  const checkedAt = new Date(report.checkedAt);
  // Discord renders relative timestamps client-side from Unix seconds, which is
  // easier to read across time zones than a server-formatted string.
  const checkedAtUnixSeconds = Math.floor(checkedAt.getTime() / 1_000);
  const summary = getHealthSummary(report);
  const fields = [
    { inline: true, name: 'Bot', value: '**Status:** 🟢 Online' },
    {
      inline: true,
      name: 'Gateway',
      value: formatServiceCheck(report.checks.gateway),
    },
    {
      inline: true,
      name: 'Website',
      value: formatServiceCheck(report.checks.website),
    },
    { inline: true, name: 'API', value: formatServiceCheck(report.checks.api) },
    {
      inline: true,
      name: 'Dashboard',
      value: formatServiceCheck(report.checks.dashboard),
    },
    {
      inline: true,
      name: 'Wiki',
      value: formatServiceCheck(report.checks.wiki),
    },
  ];

  const payload: DiscordMessagePayload = {
    embeds: [
      {
        color: getHealthColor(report),
        description: `${summary.icon} **${summary.text}**\nChecked <t:${checkedAtUnixSeconds}:R>`,
        fields,
        footer: {
          text: 'Purdue Photography Club',
        },
        timestamp: report.checkedAt,
        title: 'PPC System Status',
      },
    ],
  };

  return ephemeralResponse(payload);
}

function formatServiceCheck(check: ServiceHealthCheck): string {
  // Keep each field compact; Discord embeds have tight per-field limits.
  switch (check.status) {
    case 'not_configured':
      return '**Status:** ⚫ Not configured';

    case 'invalid_config':
      return formatLines([
        '**Status:** 🟡 Config issue',
        check.error ? `**Note:** ${check.error}` : undefined,
      ]);

    case 'offline':
      return formatLines([
        `**Status:** 🔴 Unreachable${formatStatusCode(check.statusCode)}`,
      ]);

    case 'online':
      return formatLines([
        `**Status:** 🟢 Online${formatStatusCode(check.statusCode)}`,
        formatLatency(check.latencyMs),
      ]);
  }
}

function getHealthSummary(report: SystemHealthReport): {
  icon: string;
  text: string;
} {
  // Failures win over config warnings because they need action first.
  if (report.hasFailures) {
    return {
      icon: '🔴',
      text: 'Some services need attention.',
    };
  }

  if (report.hasInvalidConfig) {
    return {
      icon: '🟡',
      text: 'One or more checks need configuration.',
    };
  }

  if (!hasConfiguredExternalChecks(report)) {
    return {
      icon: '🟢',
      text: 'Bot is online. External checks are not configured yet.',
    };
  }

  return {
    icon: '🟢',
    text: 'All configured systems look healthy.',
  };
}

function getHealthColor(report: SystemHealthReport): number {
  // Match Discord's common green/yellow/red status palette.
  if (report.hasFailures) {
    return 0xed4245;
  }

  if (report.hasInvalidConfig) {
    return 0xfee75c;
  }

  return 0x57f287;
}

function formatStatusCode(statusCode: number | undefined): string {
  // Show HTTP status only when a request actually reached the service.
  return statusCode === undefined ? '' : ` (${statusCode})`;
}

function formatLatency(latencyMs: number | undefined): string | undefined {
  // Leave latency off for config errors and failed network attempts.
  return latencyMs === undefined ? undefined : `**Latency:** ${latencyMs}ms`;
}

function formatLines(lines: Array<string | undefined>): string {
  // Drop optional rows before joining so embeds do not get blank lines.
  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

function hasConfiguredExternalChecks(report: SystemHealthReport): boolean {
  // "not_configured" should not make the command look degraded; it only means
  // the Worker is running without external site checks wired up.
  return Object.values(report.checks).some(
    (check) =>
      check.status === 'online' ||
      check.status === 'offline' ||
      check.status === 'invalid_config',
  );
}
