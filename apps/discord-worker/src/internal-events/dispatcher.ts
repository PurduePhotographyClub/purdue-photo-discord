/**
 * Dispatches validated internal events to Worker services.
 *
 * Routes should not know whether a Discord event creates a message, syncs a
 * role, or proxies to the website API. This module keeps those workflows in one
 * service-facing switch.
 */
import {
  editDiscordMessage,
  sendDiscordMessage,
} from '../services/discordMessageService';
import { getDiscordGuildStats } from '../services/discordGuildStatsService';
import {
  completeDiscordServerVerification,
  removeDiscordManagedRoles,
  resolveWebsiteStaffRoleForDiscordMember,
  syncDiscordMemberRoles,
} from '../services/discordMemberRoleService';
import {
  createDiscordScheduledEvent,
  deleteDiscordScheduledEvent,
  updateDiscordScheduledEvent,
} from '../services/discordScheduledEventService';
import {
  postDarkroomWeeklyJoinMessage,
  syncDarkroomScheduleChannel,
} from '../services/discordDarkroomScheduleService';
import { syncDarkroomStatsMessage } from '../services/discordDarkroomStatsService';
import { syncEquipmentLoanChannel } from '../services/discordEquipmentLoanService';
import { postFilmRequestReviewMessage } from '../services/discordFilmRequestService';
import {
  postStudioPendingReviewMessage,
  postStudioScheduleMessage,
  syncStudioScheduleChannel,
} from '../services/discordStudioScheduleService';
import { sendDiscordVerificationWelcomeMessage } from '../services/discordVerificationService';
import { handleGatewayEvent } from '../services/gatewayEventService';
import { sweepExpiredPhotographerRequests } from '../services/photographerRequestStatusService';
import type { Env } from '../discord/types';
import { createLogger } from '../utils/logger';
import type {
  DiscordMemberRolesSyncInternalEvent,
  DiscordServerVerificationCompleteInternalEvent,
  MemberRolesInternalEvent,
  MessageInternalEvent,
  ParsedInternalEvent,
  ScheduledEventInternalEvent,
} from './types';

const logger = createLogger('internal-events');

export async function dispatchInternalEvent(
  parsedEvent: ParsedInternalEvent,
  env: Env,
  context?: ExecutionContext,
): Promise<Record<string, unknown>> {
  switch (parsedEvent.kind) {
    case 'gateway':
      return handleGatewayInternalEvent(parsedEvent.event, env);
    case 'guildStats':
      return handleGuildStatsEvent(env, parsedEvent.event.type);
    case 'darkroomStats':
      return handleDarkroomStatsEvent(parsedEvent.event, env);
    case 'darkroomSchedule':
      return handleDarkroomScheduleEvent(parsedEvent.event, env);
    case 'darkroomWeeklyJoinMessage':
      return handleDarkroomWeeklyJoinMessageEvent(parsedEvent.event, env);
    case 'studioSchedule':
      return handleStudioScheduleEvent(parsedEvent.event, env);
    case 'studioScheduleMessage':
      return handleStudioScheduleMessageEvent(parsedEvent.event, env);
    case 'studioPendingReview':
      return handleStudioPendingReviewEvent(parsedEvent.event, env);
    case 'equipmentLoan':
      return handleEquipmentLoanEvent(parsedEvent.event, env);
    case 'filmRequestReview':
      return handleFilmRequestReviewEvent(parsedEvent.event, env);
    case 'photographerRequestExpirySweep':
      return handlePhotographerRequestExpirySweepEvent(parsedEvent.event, env);
    case 'memberRoles':
      return handleMemberRolesEvent(parsedEvent.event, env, context);
    case 'scheduledEvent':
      return handleScheduledEvent(parsedEvent.event, env);
    case 'message':
      return handleMessageEvent(parsedEvent.event, env);
  }
}

async function handleDarkroomStatsEvent(
  event: Extract<ParsedInternalEvent, { kind: 'darkroomStats' }>['event'],
  env: Env,
): Promise<Record<string, unknown>> {
  const result = await syncDarkroomStatsMessage(env, event);

  return {
    channelId: result.channelId,
    discordMemberCount: result.discordMemberCount,
    messageId: result.messageId,
    ok: true,
    type: event.type,
    userCount: result.userCount,
    voiceChannelId: result.voiceChannelId,
    voiceChannelName: result.voiceChannelName,
  };
}

async function handleDarkroomWeeklyJoinMessageEvent(
  event: Extract<
    ParsedInternalEvent,
    { kind: 'darkroomWeeklyJoinMessage' }
  >['event'],
  env: Env,
): Promise<Record<string, unknown>> {
  const result = await postDarkroomWeeklyJoinMessage(env, event, {
    allowCreate: event.allowCreate === true,
  });

  return {
    channelId: result.channelId,
    messageId: result.messageId,
    ok: true,
    slotCount: event.slots.length,
    type: event.type,
  };
}

async function handleDarkroomScheduleEvent(
  event: Extract<ParsedInternalEvent, { kind: 'darkroomSchedule' }>['event'],
  env: Env,
): Promise<Record<string, unknown>> {
  const result = await syncDarkroomScheduleChannel(env, event);

  return {
    channelId: result.channelId,
    messageId: result.messageId,
    ok: true,
    type: event.type,
  };
}

async function handleStudioScheduleMessageEvent(
  event: Extract<
    ParsedInternalEvent,
    { kind: 'studioScheduleMessage' }
  >['event'],
  env: Env,
): Promise<Record<string, unknown>> {
  const result = await postStudioScheduleMessage(env, event);

  return {
    channelId: result.channelId,
    messageId: result.messageId,
    ok: true,
    type: event.type,
  };
}

async function handleStudioScheduleEvent(
  event: Extract<ParsedInternalEvent, { kind: 'studioSchedule' }>['event'],
  env: Env,
): Promise<Record<string, unknown>> {
  const result = await syncStudioScheduleChannel(env, event);

  return {
    channelId: result.channelId,
    messageId: result.messageId,
    ok: true,
    type: event.type,
  };
}

async function handleStudioPendingReviewEvent(
  event: Extract<ParsedInternalEvent, { kind: 'studioPendingReview' }>['event'],
  env: Env,
): Promise<Record<string, unknown>> {
  const result = await postStudioPendingReviewMessage(env, event);

  return {
    channelId: result.channelId,
    messageId: result.messageId,
    ok: true,
    type: event.type,
  };
}

async function handleFilmRequestReviewEvent(
  event: Extract<ParsedInternalEvent, { kind: 'filmRequestReview' }>['event'],
  env: Env,
): Promise<Record<string, unknown>> {
  const result = await postFilmRequestReviewMessage(env, event);

  return {
    channelId: result.channelId,
    messageId: result.messageId,
    ok: true,
    type: event.type,
  };
}

async function handlePhotographerRequestExpirySweepEvent(
  event: Extract<
    ParsedInternalEvent,
    { kind: 'photographerRequestExpirySweep' }
  >['event'],
  env: Env,
): Promise<Record<string, unknown>> {
  const result = await sweepExpiredPhotographerRequests(env);

  return {
    ...result,
    ok: true,
    type: event.type,
  };
}

async function handleEquipmentLoanEvent(
  event: Extract<ParsedInternalEvent, { kind: 'equipmentLoan' }>['event'],
  env: Env,
): Promise<Record<string, unknown>> {
  const result = await syncEquipmentLoanChannel(env, event);

  return {
    channelId: result.channelId,
    messageId: result.messageId,
    ok: true,
    type: event.type,
  };
}

async function handleGatewayInternalEvent(
  event: Extract<ParsedInternalEvent, { kind: 'gateway' }>['event'],
  env: Env,
): Promise<Record<string, unknown>> {
  const result = await handleGatewayEvent(event, env);

  return {
    eventType: event.eventType,
    handled: result.handled,
    ok: true,
    type: event.type,
  };
}

async function handleGuildStatsEvent(
  env: Env,
  type: string,
): Promise<Record<string, unknown>> {
  const stats = await getDiscordGuildStats(env);

  return {
    discordMemberCount: stats.memberCount,
    discordPresenceCount: stats.presenceCount,
    ok: true,
    type,
  };
}

async function handleMemberRolesEvent(
  event: MemberRolesInternalEvent,
  env: Env,
  context: ExecutionContext | undefined,
): Promise<Record<string, unknown>> {
  const result = await runMemberRoleEvent(event, env);

  if (
    event.type === 'website.discord.server_verification.complete' &&
    result.inGuild
  ) {
    queueVerificationWelcomeMessage(env, event, context);
  }

  return {
    ...result,
    ok: true,
    type: event.type,
  };
}

async function runMemberRoleEvent(event: MemberRolesInternalEvent, env: Env) {
  if (event.type === 'website.discord.member_roles.remove') {
    return removeDiscordManagedRoles(env, event.discordId);
  }

  if (event.type === 'website.discord.staff_role.resolve') {
    return resolveWebsiteStaffRoleForDiscordMember(env, event.discordId);
  }

  if (event.type === 'website.discord.server_verification.complete') {
    return completeDiscordServerVerification(env, event.discordId, {
      nickname: event.nickname,
    });
  }

  return syncDiscordMemberRoles(env, buildMemberRolesSyncInput(event));
}

function queueVerificationWelcomeMessage(
  env: Env,
  event: DiscordServerVerificationCompleteInternalEvent,
  context: ExecutionContext | undefined,
): void {
  const welcomeMessagePromise = sendDiscordVerificationWelcomeMessage(env, {
    applicationId: event.applicationId,
    discordId: event.discordId,
    interactionToken: event.interactionToken,
  }).catch((error) => {
    logger.error('Failed to send Discord verification welcome message.', error);
  });

  if (context) {
    context.waitUntil(welcomeMessagePromise);
    return;
  }

  void welcomeMessagePromise;
}

function buildMemberRolesSyncInput(event: DiscordMemberRolesSyncInternalEvent) {
  return {
    discordId: event.discordId,
    ...(event.membershipExpired !== undefined
      ? { membershipExpired: event.membershipExpired }
      : {}),
    ...(event.nickname ? { nickname: event.nickname } : {}),
    ...(event.tier !== undefined ? { tier: event.tier } : {}),
  };
}

async function handleScheduledEvent(
  event: ScheduledEventInternalEvent,
  env: Env,
): Promise<Record<string, unknown>> {
  if (event.type === 'website.event.delete') {
    await deleteDiscordScheduledEvent(env, {
      discordEventId: event.discordEventId ?? '',
    });

    return {
      ok: true,
      type: event.type,
    };
  }

  const scheduledEventInput = buildScheduledEventInput(event);
  const result =
    event.type === 'website.event.update'
      ? await updateDiscordScheduledEvent(env, {
          ...scheduledEventInput,
          discordEventId: event.discordEventId ?? '',
        })
      : await createDiscordScheduledEvent(env, scheduledEventInput);

  return {
    discordEventId: result.id,
    ok: true,
    type: event.type,
  };
}

function buildScheduledEventInput(event: ScheduledEventInternalEvent) {
  return {
    startsAt: event.startsAt ?? '',
    title: event.title ?? '',
    ...(event.description !== undefined
      ? { description: event.description }
      : {}),
    ...(event.endsAt !== undefined ? { endsAt: event.endsAt } : {}),
    ...(event.location !== undefined ? { location: event.location } : {}),
  };
}

async function handleMessageEvent(
  event: MessageInternalEvent,
  env: Env,
): Promise<Record<string, unknown>> {
  const result = event.messageId
    ? await editDiscordMessage(env, {
        channelId: event.channelId ?? '',
        content: event.content,
        embeds: event.embeds,
        messageId: event.messageId,
      })
    : await sendDiscordMessage(env, {
        channelId: event.channelId,
        content: event.content,
        embeds: event.embeds,
        nonce: event.nonce,
      });

  return {
    messageId: readDiscordMessageId(result),
    ok: true,
    type: event.type,
  };
}

function readDiscordMessageId(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const id = result.id;
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
