/**
 * Public command for listing PPC and member-listed equipment.
 */
import type {
  DiscordCommand,
  DiscordEmbed,
  DiscordEmbedField,
  DiscordMessagePayload,
  Env,
} from '../../discord/types';
import { ephemeralResponse, messageResponse } from '../../discord/responses';
import { requestWebsiteApi } from '../../services/websiteApiService';
import { getOptionalEnv } from '../../utils/env';
import { getErrorMessage } from '../../utils/errors';

interface EquipmentItem {
  assetTag: string | null;
  category: string;
  condition: string | null;
  isAvailable: boolean;
  lenderTerms: string | null;
  model: string | null;
  name: string;
  ownerId: string | null;
}

interface EquipmentResponse {
  equipment?: unknown;
}

const MAX_EMBED_FIELDS = 25;
const STRING_OPTION = 3;

export const equipmentCommand: DiscordCommand = {
  definition: {
    description:
      'List PPC equipment or personal gear available through the club.',
    name: 'equipment',
    options: [
      {
        choices: [
          { name: 'PPC equipment', value: 'ppc' },
          { name: 'Personal gear', value: 'personal' },
        ],
        description: 'Choose which equipment list to show.',
        name: 'type',
        required: false,
        type: STRING_OPTION,
      },
    ],
  },
  execute: async (interaction, env) => {
    const type = readEquipmentTypeOption(interaction.data.options);

    try {
      const response = await requestWebsiteApi(env, `/equipment?type=${type}`, {
        method: 'GET',
      });
      const items = readEquipmentItems(response);

      if (items.length === 0) {
        return ephemeralResponse(
          type === 'personal'
            ? 'No personal gear is listed right now.'
            : 'No PPC equipment is listed right now.',
        );
      }

      return messageResponse(createEquipmentPayload(items, type, env));
    } catch (error) {
      return ephemeralResponse(
        `Could not load equipment: ${getErrorMessage(error)}`,
      );
    }
  },
};

function createEquipmentPayload(
  items: EquipmentItem[],
  type: 'personal' | 'ppc',
  env: Env,
): DiscordMessagePayload {
  const visibleItems = items.slice(0, MAX_EMBED_FIELDS);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);
  const title = type === 'personal' ? 'Personal Gear' : 'PPC Equipment';
  const embed: DiscordEmbed = {
    color: type === 'personal' ? 0x22c55e : 0xf2c94c,
    description: [
      `${items.length} item${items.length === 1 ? '' : 's'} listed.`,
      hiddenCount > 0
        ? `Showing ${visibleItems.length}; open the dashboard for the rest.`
        : null,
      `[Open equipment dashboard](${getWebsiteUrl(env)}/dashboard/equipment)`,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n'),
    fields: visibleItems.map((item) => equipmentToField(item, type)),
    footer: {
      text: 'Purdue Photography Club equipment',
    },
    title,
  };

  return { embeds: [embed] };
}

function equipmentToField(
  item: EquipmentItem,
  type: 'personal' | 'ppc',
): DiscordEmbedField {
  const lines = [
    `**Status:** ${item.isAvailable ? 'Available' : 'On loan'}`,
    item.model ? `**Model:** ${item.model}` : null,
    item.assetTag ? `**Asset tag:** ${item.assetTag}` : null,
    item.condition ? `**Condition:** ${capitalize(item.condition)}` : null,
    type === 'personal' && item.lenderTerms
      ? `**Terms:** ${truncate(item.lenderTerms, 180)}`
      : null,
  ];

  return {
    inline: false,
    name: truncate(`${item.name} · ${capitalize(item.category)}`, 256),
    value: lines.filter((line): line is string => Boolean(line)).join('\n'),
  };
}

function readEquipmentItems(value: unknown): EquipmentItem[] {
  if (
    !isRecord(value) ||
    !Array.isArray((value as EquipmentResponse).equipment)
  ) {
    return [];
  }

  return (value as { equipment: unknown[] }).equipment
    .map(readEquipmentItem)
    .filter((item): item is EquipmentItem => Boolean(item));
}

function readEquipmentItem(value: unknown): EquipmentItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = readString(value.name);
  const category = readString(value.category);
  if (!name || !category) {
    return undefined;
  }

  return {
    assetTag: readNullableString(value.assetTag),
    category,
    condition: readNullableString(value.condition),
    isAvailable: value.isAvailable === true,
    lenderTerms: readNullableString(value.lenderTerms),
    model: readNullableString(value.model),
    name,
    ownerId: readNullableString(value.ownerId),
  };
}

function readEquipmentTypeOption(options: unknown) {
  if (!Array.isArray(options)) {
    return 'ppc' as const;
  }

  const selected = options.find(
    (option) =>
      isRecord(option) &&
      option.name === 'type' &&
      (option.value === 'personal' || option.value === 'ppc'),
  );

  return isRecord(selected) && selected.value === 'personal'
    ? 'personal'
    : 'ppc';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readNullableString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function getWebsiteUrl(env: Env) {
  return (
    getOptionalEnv(env, 'WEBSITE_URL') ?? 'https://purduephotoclub.org'
  ).replace(/\/+$/, '');
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, ' ');
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
