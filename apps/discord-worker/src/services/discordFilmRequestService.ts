import { InteractionResponseType } from 'discord-interactions';
import { ephemeralResponse } from '../discord/responses';
import type {
  ComponentInteraction,
  DiscordEmbed,
  DiscordInteractionResponse,
  Env,
  ModalSubmitInteraction,
} from '../discord/types';
import type { FilmRequestReviewInternalEvent } from '../internal-events/types';
import { DiscordApiError } from '../utils/errors';
import { createLogger } from '../utils/logger';
import {
  editDiscordMessage,
  sendDiscordDirectMessage,
  sendDiscordMessage,
} from './discordMessageService';
import { requestWebsiteApi } from './websiteApiService';

const FILM_REQUEST_REVIEW_CHANNEL_ID = '1515283197850812499';
const ACTION_ROW = 1;
const BUTTON = 2;
const INPUT_TEXT = 4;
const LABEL = 18;
const PARAGRAPH_TEXT = 2;
const SUCCESS_BUTTON = 3;
const DANGER_BUTTON = 4;

const logger = createLogger('film-request-review');

export const FILM_REQUEST_REVIEW_CUSTOM_ID_PREFIX = 'film_request_review:';
export const FILM_REQUEST_REVIEW_MODAL_CUSTOM_ID_PREFIX =
  'film_request_review_modal:';
const FILM_REQUEST_REVIEW_NOTE_CUSTOM_ID = 'film_request_review_note';

type FilmRequestReviewAction = 'deny' | 'fulfill';
type ModalValue = boolean | string | string[];

interface DiscordMessageResult {
  id?: string;
}

interface WebsiteFilmRequestActionResponse {
  message?: string;
  ok?: boolean;
}

export function isFilmRequestReviewButtonCustomId(customId: string) {
  return parseFilmRequestReviewCustomId(customId) !== null;
}

export function isFilmRequestReviewModalCustomId(customId: string) {
  return parseFilmRequestReviewModalCustomId(customId) !== null;
}

export function handleFilmRequestReviewButton(
  interaction: ComponentInteraction,
): DiscordInteractionResponse {
  const review = parseFilmRequestReviewCustomId(interaction.data.custom_id);
  if (!review) {
    return ephemeralResponse('I could not identify that film request.');
  }

  return {
    data: createFilmRequestReviewModalPayload(review.action, review.requestId),
    type: InteractionResponseType.MODAL,
  };
}

export async function handleFilmRequestReviewModalSubmit(
  interaction: ModalSubmitInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const review = parseFilmRequestReviewModalCustomId(
    interaction.data.custom_id,
  );
  if (!review) {
    return ephemeralResponse('I could not identify that film request.');
  }

  const discordId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!discordId) {
    return ephemeralResponse('I could not identify your Discord account.');
  }

  const values = readModalValues(interaction);
  let result: unknown;
  try {
    result = await requestWebsiteApi(
      env,
      `/admin/darkroom/film-requests/${encodeURIComponent(
        review.requestId,
      )}/review-by-discord`,
      {
        body: {
          action: review.action,
          adminNote: readModalString(
            values.get(FILM_REQUEST_REVIEW_NOTE_CUSTOM_ID),
          ),
          discordId,
        },
        method: 'POST',
      },
    );
  } catch (error) {
    logger.warn('Film request review modal API request failed.', { error });
    return ephemeralResponse(
      'I could not update that film request. Try again from the admin dashboard.',
    );
  }

  const response = readWebsiteFilmRequestActionResponse(result);

  return ephemeralResponse(
    response.message ??
      (response.ok
        ? review.action === 'fulfill'
          ? 'Film request accepted.'
          : 'Film request denied.'
        : 'I could not update that film request.'),
  );
}

export async function postFilmRequestReviewMessage(
  env: Env,
  event: FilmRequestReviewInternalEvent,
) {
  const channelId = event.channelId ?? FILM_REQUEST_REVIEW_CHANNEL_ID;
  const payload = createFilmRequestReviewPayload(event);
  const { result, replacedStaleMessage } = await editOrSendStoredMessage(env, {
    channelId,
    messageId: event.messageId,
    ...payload,
  });

  if (event.status !== 'pending') {
    await notifyRequesterOfFilmRequestUpdate(env, event);
  }

  return {
    channelId,
    messageId:
      readMessageId(result) ??
      (replacedStaleMessage ? null : (event.messageId ?? null)),
  };
}

async function editOrSendStoredMessage(
  env: Env,
  input: {
    channelId: string;
    components?: unknown[];
    content?: string;
    embeds?: DiscordEmbed[];
    messageId?: string | null | undefined;
  },
) {
  if (!input.messageId) {
    return {
      replacedStaleMessage: false,
      result: await sendDiscordMessage(env, {
        channelId: input.channelId,
        components: input.components,
        content: input.content,
        embeds: input.embeds,
      }),
    };
  }

  try {
    return {
      replacedStaleMessage: false,
      result: await editDiscordMessage(env, {
        channelId: input.channelId,
        components: input.components,
        content: input.content,
        embeds: input.embeds,
        messageId: input.messageId,
      }),
    };
  } catch (error) {
    if (isDiscordNotFoundError(error)) {
      logger.warn(
        'Stored film request Discord message was missing; posting a replacement.',
        {
          channelId: input.channelId,
          messageId: input.messageId,
        },
      );

      return {
        replacedStaleMessage: true,
        result: await sendDiscordMessage(env, {
          channelId: input.channelId,
          components: input.components,
          content: input.content,
          embeds: input.embeds,
        }),
      };
    }

    throw error;
  }
}

function createFilmRequestReviewPayload(event: FilmRequestReviewInternalEvent) {
  return {
    components:
      event.status === 'pending'
        ? [
            {
              components: [
                {
                  custom_id: `${FILM_REQUEST_REVIEW_CUSTOM_ID_PREFIX}fulfill:${event.requestId}`,
                  label: 'Accept with note',
                  style: SUCCESS_BUTTON,
                  type: BUTTON,
                },
                {
                  custom_id: `${FILM_REQUEST_REVIEW_CUSTOM_ID_PREFIX}deny:${event.requestId}`,
                  label: 'Deny with note',
                  style: DANGER_BUTTON,
                  type: BUTTON,
                },
              ],
              type: ACTION_ROW,
            },
          ]
        : [],
    embeds: [
      {
        color: getFilmRequestReviewColor(event.status),
        description: event.reason || 'No member reason provided.',
        fields: [
          {
            inline: true,
            name: 'Rolls',
            value: `${event.rollsRequested} roll${
              event.rollsRequested === 1 ? '' : 's'
            }`,
          },
          {
            inline: true,
            name: 'Submitted',
            value: formatDiscordTimestamp(new Date(event.createdAt)),
          },
          {
            inline: false,
            name: 'Member',
            value: formatRequester(event.requester),
          },
          ...(event.adminNote
            ? [
                {
                  inline: false,
                  name: 'Admin note',
                  value: event.adminNote,
                },
              ]
            : []),
        ],
        footer: {
          text: `Film request ${event.requestId}`,
        },
        timestamp: new Date().toISOString(),
        title: `${getFilmRequestDisplayStatus(event.status)} Film Request`,
      },
    ],
  };
}

function createFilmRequestReviewModalPayload(
  action: FilmRequestReviewAction,
  requestId: string,
) {
  return {
    components: [
      createTextInputLabel({
        customId: FILM_REQUEST_REVIEW_NOTE_CUSTOM_ID,
        label: action === 'fulfill' ? 'Acceptance note' : 'Denial note',
        placeholder:
          action === 'fulfill'
            ? 'Pickup details, limits, or reminders'
            : 'Tell the member what needs to change',
        required: false,
        style: PARAGRAPH_TEXT,
      }),
    ],
    custom_id: `${FILM_REQUEST_REVIEW_MODAL_CUSTOM_ID_PREFIX}${action}:${requestId}`,
    title: action === 'fulfill' ? 'Accept film request' : 'Deny film request',
  };
}

function createTextInputLabel(options: {
  customId: string;
  label: string;
  placeholder: string;
  required: boolean;
  style: number;
}) {
  return {
    component: {
      custom_id: options.customId,
      max_length: 500,
      placeholder: options.placeholder,
      required: options.required,
      style: options.style,
      type: INPUT_TEXT,
    },
    label: options.label,
    type: LABEL,
  };
}

async function notifyRequesterOfFilmRequestUpdate(
  env: Env,
  event: FilmRequestReviewInternalEvent,
) {
  const requesterDiscordId = event.requester.discordId?.trim();
  if (!requesterDiscordId) {
    return;
  }

  try {
    await sendDiscordDirectMessage(env, {
      content: buildFilmRequestUpdateDmContent(event),
      recipientId: requesterDiscordId,
    });
  } catch (error) {
    logger.warn('Failed to send film request update DM.', {
      error,
      requestId: event.requestId,
      requesterDiscordId,
      status: event.status,
    });
  }
}

function buildFilmRequestUpdateDmContent(
  event: FilmRequestReviewInternalEvent,
) {
  const action = event.status === 'fulfilled' ? 'accepted' : 'denied';
  const note = event.adminNote?.trim();

  return [
    `Your film request for ${event.rollsRequested} roll${
      event.rollsRequested === 1 ? '' : 's'
    } was ${action}.`,
    '',
    note
      ? `Admin note: ${truncate(note, 1_500)}`
      : 'No admin note was included.',
    '',
    event.status === 'fulfilled'
      ? 'Your roll credits have been updated in the darkroom dashboard.'
      : 'Open the darkroom dashboard if you need to submit another request.',
  ].join('\n');
}

function parseFilmRequestReviewCustomId(customId: string) {
  if (!customId.startsWith(FILM_REQUEST_REVIEW_CUSTOM_ID_PREFIX)) {
    return null;
  }

  return readFilmRequestReviewParts(
    customId.slice(FILM_REQUEST_REVIEW_CUSTOM_ID_PREFIX.length),
  );
}

function parseFilmRequestReviewModalCustomId(customId: string) {
  if (!customId.startsWith(FILM_REQUEST_REVIEW_MODAL_CUSTOM_ID_PREFIX)) {
    return null;
  }

  return readFilmRequestReviewParts(
    customId.slice(FILM_REQUEST_REVIEW_MODAL_CUSTOM_ID_PREFIX.length),
  );
}

function readFilmRequestReviewParts(value: string): {
  action: FilmRequestReviewAction;
  requestId: string;
} | null {
  const [action, requestId] = value.split(':');
  if ((action !== 'fulfill' && action !== 'deny') || !requestId) {
    return null;
  }

  return { action, requestId };
}

function readModalValues(interaction: ModalSubmitInteraction) {
  const values = new Map<string, ModalValue>();

  for (const row of interaction.data.components ?? []) {
    if (!isRecord(row)) {
      continue;
    }

    if (isRecord(row.component)) {
      addModalComponentValue(values, row.component);
    }

    if (!Array.isArray(row.components)) {
      continue;
    }

    for (const component of row.components) {
      addModalComponentValue(values, component);
    }
  }

  return values;
}

function addModalComponentValue(
  values: Map<string, ModalValue>,
  component: unknown,
) {
  if (!isRecord(component) || typeof component.custom_id !== 'string') {
    return;
  }

  if (typeof component.value === 'boolean') {
    values.set(component.custom_id, component.value);
    return;
  }

  if (typeof component.value === 'string') {
    values.set(component.custom_id, component.value);
    return;
  }

  if (
    Array.isArray(component.values) &&
    component.values.every((value) => typeof value === 'string')
  ) {
    values.set(component.custom_id, component.values);
  }
}

function readModalString(value: ModalValue | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readWebsiteFilmRequestActionResponse(
  value: unknown,
): WebsiteFilmRequestActionResponse {
  return isRecord(value) ? (value as WebsiteFilmRequestActionResponse) : {};
}

function readMessageId(result: unknown) {
  if (!isRecord(result)) {
    return null;
  }

  const message = result as DiscordMessageResult;
  return typeof message.id === 'string' ? message.id : null;
}

function getFilmRequestReviewColor(
  status: FilmRequestReviewInternalEvent['status'],
) {
  switch (status) {
    case 'fulfilled':
      return 0x22c55e;
    case 'denied':
      return 0xf85149;
    default:
      return 0xf59e0b;
  }
}

function getFilmRequestDisplayStatus(
  status: FilmRequestReviewInternalEvent['status'],
) {
  switch (status) {
    case 'fulfilled':
      return 'Accepted';
    case 'denied':
      return 'Denied';
    default:
      return 'Pending';
  }
}

function formatDiscordTimestamp(date: Date) {
  return `<t:${Math.floor(date.getTime() / 1_000)}:f>`;
}

function formatRequester(
  requester: FilmRequestReviewInternalEvent['requester'],
) {
  return requester.discordId
    ? `${requester.name} (<@${requester.discordId}>)`
    : requester.name;
}

function truncate(input: string, maxLength: number) {
  return input.length > maxLength
    ? `${input.slice(0, maxLength - 1)}...`
    : input;
}

function isDiscordNotFoundError(error: unknown) {
  return error instanceof DiscordApiError && error.status === 404;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
