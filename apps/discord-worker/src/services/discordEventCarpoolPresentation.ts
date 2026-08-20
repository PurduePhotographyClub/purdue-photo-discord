import type { DiscordEmbed, DiscordMessagePayload } from '../discord/types';

const ACTION_ROW = 1;
const BUTTON = 2;
const PRIMARY_BUTTON = 1;
const SECONDARY_BUTTON = 2;
const SUCCESS_BUTTON = 3;
const DANGER_BUTTON = 4;

export const EVENT_CARPOOL_FORUM_NAME = 'event-carpools';
export const EVENT_CARPOOL_CUSTOM_ID_PREFIX = 'event_carpool:v1:';
export const EVENT_CARPOOL_DISCLAIMER =
  'Community-organized carpool. This is not an official PPC activity. Drivers and riders are responsible for confirming plans, safety, costs, and changes directly.';
export const EVENT_CARPOOL_TAG_NAMES = [
  'Open',
  'Needs drivers',
  'Assigned',
  'Cancelled',
  'Past',
] as const;

interface EventCarpoolParticipant {
  discordId: string;
  joinedAt: string;
  note: string | null;
  offeredSeats: number | null;
  role: 'driver' | 'rider';
}

interface EventCarpoolAssignment {
  driverDiscordId: string;
  riderDiscordId: string;
}

export interface EventCarpoolProjection {
  assignments: EventCarpoolAssignment[];
  departsAt: string;
  destination: string;
  driverCount: number;
  forumChannelId: string | null;
  id: string;
  meetingPoint: string;
  missingSeats: number;
  offeredSeats: number;
  organizerDiscordId: string;
  participants: EventCarpoolParticipant[];
  returnsAt: string;
  riderCount: number;
  rootMessageId: string | null;
  status: 'assigned' | 'cancelled' | 'open' | 'provisioning';
  syncRevision: number;
  threadId: string | null;
  title: string;
}

interface DiscordForumTag {
  id: string;
  name: string;
}

export interface DiscordForumChannel {
  available_tags?: DiscordForumTag[];
  id: string;
  name?: string;
  type: number;
}

export function createEventCarpoolMessagePayload(
  event: EventCarpoolProjection,
): DiscordMessagePayload {
  const capacity =
    event.missingSeats > 0
      ? `${event.missingSeats} more passenger seat(s) needed`
      : `${event.offeredSeats - event.riderCount} passenger seat(s) available`;
  const drivers =
    event.participants
      .flatMap((participant) =>
        participant.role === 'driver'
          ? [
              `<@${participant.discordId}> — ${participant.offeredSeats} seat(s)`,
            ]
          : [],
      )
      .join('\n') || 'No drivers yet';
  const riders =
    event.participants
      .flatMap((participant) =>
        participant.role === 'rider' ? [`<@${participant.discordId}>`] : [],
      )
      .join(', ') || 'No riders yet';
  const embed: DiscordEmbed = {
    color:
      event.status === 'cancelled'
        ? 0xc0392b
        : event.missingSeats > 0
          ? 0xf2c94c
          : 0x2ecc71,
    description: `Organized by <@${event.organizerDiscordId}>`,
    fields: [
      { inline: false, name: 'Destination', value: event.destination },
      { inline: false, name: 'Meeting point', value: event.meetingPoint },
      {
        inline: true,
        name: 'Departs',
        value: discordTimestamp(event.departsAt),
      },
      {
        inline: true,
        name: 'Expected return',
        value: discordTimestamp(event.returnsAt),
      },
      { inline: false, name: 'Capacity', value: capacity },
      {
        inline: false,
        name: `Drivers (${event.driverCount})`,
        value: truncateField(drivers),
      },
      {
        inline: false,
        name: `Riders (${event.riderCount})`,
        value: truncateField(riders),
      },
      ...assignmentFields(event),
    ],
    title: event.title,
  };
  return {
    allowed_mentions: { parse: [] },
    components: createEventCarpoolButtons(event),
    content: EVENT_CARPOOL_DISCLAIMER,
    embeds: [embed],
  };
}

export function statusTagName(event: EventCarpoolProjection) {
  if (event.status === 'assigned') return 'Assigned';
  if (event.status === 'cancelled') return 'Cancelled';
  return event.missingSeats > 0 ? 'Needs drivers' : 'Open';
}

export function findStatusTag(forum: DiscordForumChannel, name: string) {
  return forum.available_tags?.find((tag) => tag.name === name)?.id;
}

function assignmentFields(
  event: EventCarpoolProjection,
): NonNullable<DiscordEmbed['fields']> {
  if (event.status !== 'assigned') return [];
  const groups = new Map<string, string[]>();
  for (const assignment of event.assignments) {
    groups.set(assignment.driverDiscordId, [
      ...(groups.get(assignment.driverDiscordId) ?? []),
      assignment.riderDiscordId,
    ]);
  }
  const value =
    [...groups.entries()]
      .map(
        ([driver, riders]) =>
          `<@${driver}> → ${riders.map((rider) => `<@${rider}>`).join(', ')}`,
      )
      .join('\n') || 'No riders needed assignment.';
  return [{ inline: false, name: 'Assignments', value: truncateField(value) }];
}

function createEventCarpoolButtons(event: EventCarpoolProjection) {
  if (event.status === 'cancelled' || event.status === 'provisioning') {
    return [];
  }
  const buttons =
    event.status === 'open'
      ? [
          button('drive', event.id, 'Offer seats', SUCCESS_BUTTON),
          button('ride', event.id, 'Need a ride', PRIMARY_BUTTON),
          button('withdraw', event.id, 'Withdraw', SECONDARY_BUTTON),
          button('assign', event.id, 'Assign riders', PRIMARY_BUTTON),
          button('cancel', event.id, 'Cancel', DANGER_BUTTON),
        ]
      : [
          button('reopen', event.id, 'Reopen signups', PRIMARY_BUTTON),
          button('cancel', event.id, 'Cancel', DANGER_BUTTON),
        ];
  return [{ components: buttons, type: ACTION_ROW }];
}

function button(action: string, eventId: string, label: string, style: number) {
  return {
    custom_id: `${EVENT_CARPOOL_CUSTOM_ID_PREFIX}${action}:${eventId}`,
    label,
    style,
    type: BUTTON,
  };
}

function discordTimestamp(value: string) {
  const unix = Math.floor(Date.parse(value) / 1_000);
  return Number.isFinite(unix) ? `<t:${unix}:F>` : value;
}

function truncateField(value: string) {
  return value.length <= 1_024 ? value : `${value.slice(0, 1_021)}…`;
}
