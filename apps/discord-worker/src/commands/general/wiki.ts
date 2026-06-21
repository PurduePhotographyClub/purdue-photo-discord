/**
 * Public command for pointing members to the PPC photography wiki.
 */
import type {
  ComponentInteraction,
  DiscordApplicationCommandOption,
  DiscordCommand,
  DiscordEmbedField,
  DiscordInteractionResponse,
  DiscordMessagePayload,
  Env,
} from '../../discord/types';
import { ephemeralResponse, messageResponse } from '../../discord/responses';
import { sendDiscordMessage } from '../../services/discordMessageService';
import { getOptionalEnv } from '../../utils/env';
import { DISCORD_CHANNEL_IDS } from '../../config/discord-channel-ids';

const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_OPTION = 3;
const PRIMARY_BUTTON = 1;
const SECONDARY_BUTTON = 2;
const DEFAULT_WIKI_URL = 'https://wiki.purduephotoclub.org';
const GUIDE_MAP_VALUE = 'map';
const WIKI_GUIDE_BUTTON_CUSTOM_ID_PREFIX = 'wiki_guide:';

export interface WikiGuide {
  bestFor: string;
  id: string;
  nextGuideIds: readonly string[];
  path: string;
  summary: string;
  title: string;
}

export const WIKI_GUIDES = [
  {
    bestFor:
      'You are new to photography, using a phone, or looking for a place to begin.',
    id: 'start',
    nextGuideIds: ['basics', 'composition', 'gear'],
    path: '/photography/',
    summary:
      'Start with the camera you already have, practice noticing light, and learn what to try next.',
    title: 'Getting Started',
  },
  {
    bestFor:
      'You want aperture, shutter speed, ISO, Raw files, and camera modes to make sense.',
    id: 'basics',
    nextGuideIds: ['camera', 'composition', 'editing'],
    path: '/photography/basics/',
    summary:
      'Exposure, stops of light, camera modes, dynamic range, and the settings that control brightness.',
    title: 'Basics',
  },
  {
    bestFor:
      'You want to understand the body, lens, sensor, viewfinder, and controls before borrowing or buying gear.',
    id: 'camera',
    nextGuideIds: ['basics', 'gear', 'technical'],
    path: '/photography/anatomy-of-a-camera/',
    summary:
      'A practical map of camera parts and what each control actually does.',
    title: 'Anatomy of a Camera',
  },
  {
    bestFor:
      'You want stronger frames and clearer choices about what belongs in the photo.',
    id: 'composition',
    nextGuideIds: ['basics', 'editing', 'start'],
    path: '/photography/composition/',
    summary:
      'Framing, light, color, movement, and making photos feel intentional.',
    title: 'Composition',
  },
  {
    bestFor:
      'You have a photo or set that needs work on crop, color, tone, or consistency.',
    id: 'editing',
    nextGuideIds: ['composition', 'basics', 'resources'],
    path: '/photography/editing/',
    summary:
      'Culling, color, tone, and finishing a photo without over-editing it.',
    title: 'Editing',
  },
  {
    bestFor:
      'You want to try film and understand the basic costs, habits, and workflow first.',
    id: 'film',
    nextGuideIds: ['camera', 'technical', 'resources'],
    path: '/photography/film/',
    summary:
      'Stocks, cameras, metering, development, scanning, and the habits that save rolls.',
    title: 'Film',
  },
  {
    bestFor:
      'You are buying or upgrading gear and want to think through budget, subject, size, and lenses.',
    id: 'gear',
    nextGuideIds: ['camera', 'basics', 'resources'],
    path: '/photography/buying-guide-gear/',
    summary:
      'Choose gear around the photos you want to make, not the spec sheet alone.',
    title: 'Buying Guide / Gear',
  },
  {
    bestFor:
      'You know the basics and want a deeper look at how cameras and files behave.',
    id: 'technical',
    nextGuideIds: ['basics', 'camera', 'resources'],
    path: '/photography/technical/',
    summary:
      'Sharpness, sensors, metering, file formats, and technical details that matter in practice.',
    title: 'Technical',
  },
  {
    bestFor:
      'You want to photograph the night sky and need the planning and camera setup.',
    id: 'astrophotography',
    nextGuideIds: ['basics', 'technical', 'resources'],
    path: '/photography/astrophotography/',
    summary:
      'Planning, stability, exposure choices, and editing basics for night-sky photos.',
    title: 'Astrophotography',
  },
  {
    bestFor:
      'You are comparing gear, techniques, or advice and want better sources to check.',
    id: 'resources',
    nextGuideIds: ['gear', 'technical', 'editing'],
    path: '/photography/helpful-resources/',
    summary:
      'Reviews, size checks, sample images, sensor charts, and places worth cross-checking.',
    title: 'Helpful Resources',
  },
] as const satisfies readonly WikiGuide[];

export const GUIDE_CHOICES = [
  { name: 'Guide Map', value: GUIDE_MAP_VALUE },
  ...WIKI_GUIDES.map((guide) => ({
    name: guide.title,
    value: guide.id,
  })),
];

const WIKI_MESSAGE_BUTTON_ROWS = [
  [GUIDE_MAP_VALUE, 'start', 'basics', 'gear', 'editing'],
  ['camera', 'composition', 'film', 'technical', 'resources'],
  ['astrophotography'],
] as const;

const WIKI_MESSAGE_BUTTON_LABELS: Record<string, string> = {
  astrophotography: 'Astro',
  camera: 'Camera Anatomy',
  map: 'Guide Map',
};

export const wikiCommand: DiscordCommand = {
  definition: {
    description: 'Open PPC photography wiki guides.',
    name: 'wiki',
    options: [
      {
        choices: GUIDE_CHOICES,
        description: 'Pick a guide, or leave blank for the full wiki map.',
        name: 'guide',
        required: false,
        type: STRING_OPTION,
      },
    ],
  },
  execute: (interaction, env) => {
    const guideId = getStringOption(
      interaction.data.options ?? [],
      'guide',
    )?.toLowerCase();

    if (!guideId || guideId === GUIDE_MAP_VALUE) {
      return messageResponse(createGuideMapPayload(env));
    }

    const guide = findGuide(guideId);

    if (!guide) {
      return ephemeralResponse(
        `Unknown wiki guide: ${guideId}. Try /wiki for the guide map.`,
      );
    }

    return messageResponse(createGuidePayload(guide, env));
  },
};

export async function postWikiGuideMessage(env: Env) {
  const channelId = getWikiChannelId(env);
  const result = await sendDiscordMessage(env, {
    channelId,
    ...createWikiGuideMessagePayload(env),
  });

  return {
    channelId: channelId ?? getOptionalEnv(env, 'DISCORD_DEFAULT_CHANNEL_ID'),
    messageId: readMessageId(result),
  };
}

export function handleWikiGuideButton(
  interaction: ComponentInteraction,
  env: Env,
): DiscordInteractionResponse {
  const guideId = interaction.data.custom_id
    .slice(WIKI_GUIDE_BUTTON_CUSTOM_ID_PREFIX.length)
    .trim()
    .toLowerCase();

  if (guideId === GUIDE_MAP_VALUE) {
    return ephemeralResponse(createGuideMapPayload(env));
  }

  const guide = findGuide(guideId);

  if (!guide) {
    return ephemeralResponse('Unknown wiki guide button. Try /wiki instead.');
  }

  return ephemeralResponse(createGuidePayload(guide, env));
}

export function isWikiGuideButtonCustomId(customId: string): boolean {
  return customId.startsWith(WIKI_GUIDE_BUTTON_CUSTOM_ID_PREFIX);
}

export function createGuideMapPayload(env: Env): DiscordMessagePayload {
  return {
    embeds: [
      {
        color: 0x38bdf8,
        description: [
          'A quick map for finding the right PPC photography guide.',
          `[Open the wiki home](${formatWikiUrl('/', env)})`,
        ].join('\n'),
        fields: [
          createGuideGroupField(
            'Start Here',
            ['start', 'basics', 'camera'],
            env,
          ),
          createGuideGroupField(
            'Practice and Workflow',
            ['composition', 'editing', 'film'],
            env,
          ),
          createGuideGroupField(
            'Gear and Technical',
            ['gear', 'technical', 'astrophotography', 'resources'],
            env,
          ),
        ],
        footer: {
          text: 'Use /wiki guide: <topic> to share a focused guide.',
        },
        title: 'PPC Photography Wiki',
      },
    ],
  };
}

export function createGuidePayload(
  guide: WikiGuide,
  env: Env,
): DiscordMessagePayload {
  return {
    embeds: [
      {
        color: 0xf2c94c,
        description: guide.summary,
        fields: [
          {
            inline: false,
            name: 'Open guide',
            value: `[Read ${guide.title}](${formatWikiUrl(guide.path, env)})`,
          },
          {
            inline: false,
            name: 'Good for',
            value: guide.bestFor,
          },
          {
            inline: false,
            name: 'Next stops',
            value: formatNextGuides(guide, env),
          },
        ],
        footer: {
          text: 'Purdue Photography Club wiki',
        },
        title: guide.title,
      },
    ],
  };
}

function createWikiGuideMessagePayload(env: Env): DiscordMessagePayload {
  return {
    embeds: [
      {
        color: 0x38bdf8,
        description: [
          'Use this message to open the PPC photography wiki.',
          'Press a button and the bot will send you the guide privately.',
          `[Open the full wiki](${formatWikiUrl('/', env)})`,
        ].join('\n'),
        fields: [
          {
            inline: false,
            name: 'Best first click',
            value:
              'Start with Getting Started if you are new, Basics for camera settings, or Gear before buying or upgrading.',
          },
        ],
        footer: {
          text: 'Purdue Photography Club wiki',
        },
        title: 'PPC Photography Wiki',
      },
    ],
    components: createWikiGuideButtonRows(),
  };
}

function createGuideGroupField(
  name: string,
  guideIds: readonly string[],
  env: Env,
): DiscordEmbedField {
  return {
    inline: false,
    name,
    value: guideIds.map((guideId) => formatGuideLine(guideId, env)).join('\n'),
  };
}

function formatGuideLine(guideId: string, env: Env): string {
  const guide = findGuide(guideId);
  return guide
    ? `**[${guide.title}](${formatWikiUrl(guide.path, env)})** - ${guide.summary}`
    : guideId;
}

function createWikiGuideButtonRows() {
  return WIKI_MESSAGE_BUTTON_ROWS.map((guideIds) => ({
    components: guideIds.map(createWikiGuideButton),
    type: ACTION_ROW,
  }));
}

function createWikiGuideButton(guideId: string) {
  const guide = guideId === GUIDE_MAP_VALUE ? undefined : findGuide(guideId);
  const label =
    WIKI_MESSAGE_BUTTON_LABELS[guideId] ??
    guide?.title.replace('Buying Guide / Gear', 'Gear') ??
    guideId;

  return {
    custom_id: `${WIKI_GUIDE_BUTTON_CUSTOM_ID_PREFIX}${guideId}`,
    label,
    style: guideId === GUIDE_MAP_VALUE ? PRIMARY_BUTTON : SECONDARY_BUTTON,
    type: BUTTON,
  };
}

function formatNextGuides(guide: WikiGuide, env: Env): string {
  return guide.nextGuideIds
    .map((guideId) => {
      const nextGuide = findGuide(guideId);
      return nextGuide
        ? `[${nextGuide.title}](${formatWikiUrl(nextGuide.path, env)})`
        : undefined;
    })
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

export function findGuide(guideId: string): WikiGuide | undefined {
  const normalizedGuideId = guideId.trim().toLowerCase();
  return WIKI_GUIDES.find((guide) => guide.id === normalizedGuideId);
}

function formatWikiUrl(path: string, env: Env): string {
  return new URL(
    path.replace(/^\/+/, ''),
    `${getWikiBaseUrl(env)}/`,
  ).toString();
}

function getWikiBaseUrl(env: Env): string {
  const configuredUrl = getOptionalEnv(env, 'WIKI_URL') ?? DEFAULT_WIKI_URL;

  try {
    const url = new URL(configuredUrl);

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    // Fall back to the production wiki if local config is malformed.
  }

  return DEFAULT_WIKI_URL;
}

function getWikiChannelId(env: Env): string | undefined {
  return (
    getOptionalEnv(env, 'DISCORD_WIKI_CHANNEL_ID') ?? DISCORD_CHANNEL_IDS.wiki
  );
}

function readMessageId(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }

  return typeof value.id === 'string' ? value.id : undefined;
}

function getStringOption(
  options: DiscordApplicationCommandOption[],
  name: string,
): string | undefined {
  const value = options.find((option) => option.name === name)?.value;
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
