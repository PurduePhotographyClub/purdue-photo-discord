/**
 * Validation for signed internal event payloads.
 *
 * Keep parsing separate from route dispatch so each internal event contract has
 * one narrow boundary before it reaches service code.
 */
import type {
  DiscordEmbed,
  GatewayEventType,
  GatewayInternalEvent,
} from '@pccbot/shared';
import { BadRequestError } from '../utils/errors';
import type {
  DarkroomStatsRank,
  DarkroomStatsRecentLog,
  DarkroomStatsSyncInternalEvent,
  DarkroomScheduleRegistrant,
  DarkroomScheduleSyncInternalEvent,
  DarkroomScheduleWeeklyJoinMessageInternalEvent,
  DarkroomScheduleWeeklyJoinSlot,
  DiscordMemberRolesRemoveInternalEvent,
  DiscordMemberRolesSyncInternalEvent,
  DiscordServerVerificationCompleteInternalEvent,
  DiscordWebsiteStaffRoleResolveInternalEvent,
  EquipmentLoanParty,
  EquipmentLoanSyncInternalEvent,
  FilmRequestReviewInternalEvent,
  MemberRolesInternalEvent,
  MessageInternalEvent,
  ParsedInternalEvent,
  PhotographerRequestExpirySweepInternalEvent,
  ScheduledEventInternalEvent,
  StudioPendingReviewInternalEvent,
  StudioScheduleMessageInternalEvent,
  StudioScheduleRequester,
  StudioScheduleSyncInternalEvent,
} from './types';

const GATEWAY_EVENT_TYPES = new Set<GatewayEventType>([
  'GUILD_MEMBER_ADD',
  'GUILD_MEMBER_REMOVE',
  'GUILD_MEMBER_UPDATE',
  'MESSAGE_CREATE',
  'MESSAGE_DELETE',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL',
  'MESSAGE_REACTION_REMOVE_EMOJI',
  'MESSAGE_UPDATE',
]);

export function parseInternalEvent(payload: unknown): ParsedInternalEvent {
  if (!isRecord(payload)) {
    throw new BadRequestError('Internal event payload must be an object.');
  }

  const type = readString(payload, 'type');

  if (!type) {
    throw new BadRequestError('Internal event payload requires a type.');
  }

  if (type === 'discord.gateway.event') {
    return {
      event: parseGatewayEvent(payload),
      kind: 'gateway',
    };
  }

  if (
    type === 'website.event.create' ||
    type === 'website.event.delete' ||
    type === 'website.event.update'
  ) {
    return {
      event: parseScheduledEvent(payload, type),
      kind: 'scheduledEvent',
    };
  }

  if (type === 'website.discord.guild_stats') {
    return {
      event: { type },
      kind: 'guildStats',
    };
  }

  if (type === 'website.darkroom.stats.sync') {
    return {
      event: parseDarkroomStatsEvent(payload),
      kind: 'darkroomStats',
    };
  }

  if (type === 'website.darkroom.schedule.sync') {
    return {
      event: parseDarkroomScheduleEvent(payload),
      kind: 'darkroomSchedule',
    };
  }

  if (type === 'website.darkroom.schedule.weekly_join_message') {
    return {
      event: parseDarkroomWeeklyJoinMessageEvent(payload),
      kind: 'darkroomWeeklyJoinMessage',
    };
  }

  if (type === 'website.studio.schedule.sync') {
    return {
      event: parseStudioScheduleEvent(payload),
      kind: 'studioSchedule',
    };
  }

  if (type === 'website.studio.schedule.message') {
    return {
      event: parseStudioScheduleMessageEvent(payload),
      kind: 'studioScheduleMessage',
    };
  }

  if (type === 'website.studio.request.review') {
    return {
      event: parseStudioPendingReviewEvent(payload),
      kind: 'studioPendingReview',
    };
  }

  if (type === 'website.equipment.loan.sync') {
    return {
      event: parseEquipmentLoanSyncEvent(payload),
      kind: 'equipmentLoan',
    };
  }

  if (type === 'website.film.request.review') {
    return {
      event: parseFilmRequestReviewEvent(payload),
      kind: 'filmRequestReview',
    };
  }

  if (type === 'website.photographer_request.expired_sweep') {
    return {
      event: parsePhotographerRequestExpirySweepEvent(type),
      kind: 'photographerRequestExpirySweep',
    };
  }

  if (
    type === 'website.discord.member_roles.remove' ||
    type === 'website.discord.member_roles.sync' ||
    type === 'website.discord.server_verification.complete' ||
    type === 'website.discord.staff_role.resolve'
  ) {
    return {
      event: parseMemberRolesEvent(payload, type),
      kind: 'memberRoles',
    };
  }

  return {
    event: parseMessageEvent(payload, type),
    kind: 'message',
  };
}

function parsePhotographerRequestExpirySweepEvent(
  type: PhotographerRequestExpirySweepInternalEvent['type'],
): PhotographerRequestExpirySweepInternalEvent {
  return { type };
}

function parseDarkroomStatsEvent(
  payload: Record<string, unknown>,
): DarkroomStatsSyncInternalEvent {
  const totalRolls = readNonNegativeInteger(payload, 'totalRolls');
  const rollsThisMonth = readNonNegativeInteger(payload, 'rollsThisMonth');
  const userCount = readNonNegativeInteger(payload, 'userCount');
  const logCount = readNonNegativeInteger(payload, 'logCount');
  const c41 = readNonNegativeInteger(payload, 'c41');
  const bw = readNonNegativeInteger(payload, 'bw');
  const slide = readNonNegativeInteger(payload, 'slide');
  const format35mm = readNonNegativeInteger(payload, 'format35mm');
  const format120 = readNonNegativeInteger(payload, 'format120');
  const updatedAt = readString(payload, 'updatedAt');
  const messageId = readNullableString(payload, 'messageId');

  if (
    totalRolls === null ||
    rollsThisMonth === null ||
    userCount === null ||
    logCount === null ||
    c41 === null ||
    bw === null ||
    slide === null ||
    format35mm === null ||
    format120 === null
  ) {
    throw new BadRequestError(
      'Darkroom stats counts must be non-negative integers.',
    );
  }

  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) {
    throw new BadRequestError('Darkroom stats updatedAt must be an ISO date.');
  }

  return {
    bw,
    c41,
    format120,
    format35mm,
    logCount,
    recentLogs: readDarkroomStatsRecentLogs(payload),
    rollsThisMonth,
    slide,
    topDevelopers: readDarkroomStatsRanks(payload, 'topDevelopers'),
    topStocks: readDarkroomStatsRanks(payload, 'topStocks'),
    totalRolls,
    type: 'website.darkroom.stats.sync',
    updatedAt,
    userCount,
    ...(messageId !== undefined ? { messageId } : {}),
  };
}

function parseDarkroomScheduleEvent(
  payload: Record<string, unknown>,
): DarkroomScheduleSyncInternalEvent {
  const slotId = readString(payload, 'slotId');
  const title = readString(payload, 'title');
  const startsAt = readString(payload, 'startsAt');
  const endsAt = readString(payload, 'endsAt');
  const status = readString(payload, 'status');
  const capacity = readInteger(payload, 'capacity');
  const registeredCount = readInteger(payload, 'registeredCount');
  const syncRevision = readInteger(payload, 'syncRevision');
  const registrants = readDarkroomScheduleRegistrants(payload);
  const managerDiscordIds = readManagerDiscordIds(
    payload,
    'Darkroom schedule managerDiscordIds',
    2,
  );
  const removeDiscordIds = readStringArray(payload, 'removeDiscordIds');
  const removeManagerDiscordIds = readRemovedManagerDiscordIds(
    payload,
    'Darkroom schedule removeManagerDiscordIds',
  );
  const channelId = readNullableString(payload, 'channelId');
  const messageId = readNullableString(payload, 'messageId');
  const notificationAction = readString(payload, 'notificationAction');
  const deleteChannel = readBoolean(payload, 'deleteChannel');
  const updateChannel = readBoolean(payload, 'updateChannel');

  if (!slotId || !isUuid(slotId)) {
    throw new BadRequestError('Darkroom schedule slotId must be a UUID.');
  }

  if (!title) {
    throw new BadRequestError('Darkroom schedule title is required.');
  }

  if (!startsAt || Number.isNaN(Date.parse(startsAt))) {
    throw new BadRequestError(
      'Darkroom schedule startsAt must be an ISO date.',
    );
  }

  if (!endsAt || Number.isNaN(Date.parse(endsAt))) {
    throw new BadRequestError('Darkroom schedule endsAt must be an ISO date.');
  }

  if (new Date(endsAt) <= new Date(startsAt)) {
    throw new BadRequestError(
      'Darkroom schedule endsAt must be after startsAt.',
    );
  }

  if (status !== 'open' && status !== 'cancelled') {
    throw new BadRequestError(
      'Darkroom schedule status must be open or cancelled.',
    );
  }

  if (capacity === null || capacity < 1 || capacity > 24) {
    throw new BadRequestError('Darkroom schedule capacity must be 1-24.');
  }

  if (
    registeredCount === null ||
    registeredCount < 0 ||
    registeredCount > capacity
  ) {
    throw new BadRequestError('Darkroom schedule registeredCount is invalid.');
  }
  if (syncRevision === null || syncRevision < 0) {
    throw new BadRequestError(
      'Darkroom schedule syncRevision must be a non-negative integer.',
    );
  }

  assertOptionalDiscordSnowflake(channelId, 'Darkroom schedule channelId');
  assertOptionalDiscordSnowflake(messageId, 'Darkroom schedule messageId');
  for (const discordId of removeDiscordIds ?? []) {
    assertDiscordSnowflake(discordId, 'Darkroom schedule removeDiscordIds');
  }

  if (
    notificationAction !== undefined &&
    notificationAction !== 'cancel' &&
    notificationAction !== 'end'
  ) {
    throw new BadRequestError(
      'Darkroom schedule notificationAction must be cancel or end.',
    );
  }

  return {
    capacity,
    endsAt,
    ...(notificationAction ? { notificationAction } : {}),
    registeredCount,
    registrants,
    slotId,
    startsAt,
    status,
    syncRevision,
    title,
    type: 'website.darkroom.schedule.sync',
    ...(channelId !== undefined ? { channelId } : {}),
    ...(deleteChannel !== undefined ? { deleteChannel } : {}),
    ...(managerDiscordIds ? { managerDiscordIds } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(removeDiscordIds ? { removeDiscordIds } : {}),
    ...(removeManagerDiscordIds ? { removeManagerDiscordIds } : {}),
    ...(updateChannel !== undefined ? { updateChannel } : {}),
  };
}

function parseDarkroomWeeklyJoinMessageEvent(
  payload: Record<string, unknown>,
): DarkroomScheduleWeeklyJoinMessageInternalEvent {
  const windowStart = readString(payload, 'windowStart');
  const windowEnd = readString(payload, 'windowEnd');
  const slots = readDarkroomWeeklyJoinSlots(payload);
  const truncated = readBoolean(payload, 'truncated');
  const channelId = readNullableString(payload, 'channelId');
  const messageId = readNullableString(payload, 'messageId');
  const allowCreate = readBoolean(payload, 'allowCreate');
  const projectionHash = readString(payload, 'projectionHash');
  const projectionRevision =
    payload.projectionRevision === undefined
      ? undefined
      : readNonNegativeInteger(payload, 'projectionRevision');
  const weeklyMessageId = readString(payload, 'weeklyMessageId');

  if (!windowStart || Number.isNaN(Date.parse(windowStart))) {
    throw new BadRequestError(
      'Darkroom weekly join windowStart must be an ISO date.',
    );
  }

  if (!windowEnd || Number.isNaN(Date.parse(windowEnd))) {
    throw new BadRequestError(
      'Darkroom weekly join windowEnd must be an ISO date.',
    );
  }

  if (new Date(windowEnd) <= new Date(windowStart)) {
    throw new BadRequestError(
      'Darkroom weekly join windowEnd must be after windowStart.',
    );
  }
  assertOptionalDiscordSnowflake(channelId, 'Darkroom weekly channelId');
  assertOptionalDiscordSnowflake(messageId, 'Darkroom weekly messageId');
  if (projectionHash !== undefined && !/^[a-f0-9]{64}$/.test(projectionHash)) {
    throw new BadRequestError(
      'Darkroom weekly projectionHash must be a SHA-256 hex digest.',
    );
  }
  if (payload.projectionRevision !== undefined && projectionRevision === null) {
    throw new BadRequestError(
      'Darkroom weekly projectionRevision must be a non-negative integer.',
    );
  }
  if (weeklyMessageId !== undefined && !isUuid(weeklyMessageId)) {
    throw new BadRequestError(
      'Darkroom weekly weeklyMessageId must be a UUID.',
    );
  }
  if (
    weeklyMessageId !== undefined &&
    (projectionHash === undefined || projectionRevision === undefined)
  ) {
    throw new BadRequestError(
      'Tracked darkroom weekly messages require a projection hash and revision.',
    );
  }

  return {
    slots,
    type: 'website.darkroom.schedule.weekly_join_message',
    windowEnd,
    windowStart,
    ...(allowCreate !== undefined ? { allowCreate } : {}),
    ...(channelId !== undefined ? { channelId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(projectionHash !== undefined ? { projectionHash } : {}),
    ...(typeof projectionRevision === 'number' ? { projectionRevision } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
    ...(weeklyMessageId !== undefined ? { weeklyMessageId } : {}),
  };
}

function parseStudioScheduleEvent(
  payload: Record<string, unknown>,
): StudioScheduleSyncInternalEvent {
  const requestId = readString(payload, 'requestId');
  const startsAt = readString(payload, 'startsAt');
  const endsAt = readString(payload, 'endsAt');
  const status = readString(payload, 'status');
  const syncRevision = readInteger(payload, 'syncRevision');
  const requester = readStudioScheduleRequester(payload);
  const managerDiscordIds = readManagerDiscordIds(
    payload,
    'Studio schedule managerDiscordIds',
    1,
  );
  const channelId = readNullableString(payload, 'channelId');
  const messageId = readNullableString(payload, 'messageId');
  const adminNote = readNullableString(payload, 'adminNote');
  const removeDiscordId = readNullableString(payload, 'removeDiscordId');
  const removeManagerDiscordIds = readRemovedManagerDiscordIds(
    payload,
    'Studio schedule removeManagerDiscordIds',
  );
  const deleteChannel = readBoolean(payload, 'deleteChannel');
  const updateChannel = readBoolean(payload, 'updateChannel');

  if (!requestId || !isUuid(requestId)) {
    throw new BadRequestError('Studio schedule requestId must be a UUID.');
  }

  if (!startsAt || Number.isNaN(Date.parse(startsAt))) {
    throw new BadRequestError('Studio schedule startsAt must be an ISO date.');
  }

  if (!endsAt || Number.isNaN(Date.parse(endsAt))) {
    throw new BadRequestError('Studio schedule endsAt must be an ISO date.');
  }

  if (new Date(endsAt) <= new Date(startsAt)) {
    throw new BadRequestError('Studio schedule endsAt must be after startsAt.');
  }

  if (status !== 'approved' && status !== 'cancelled') {
    throw new BadRequestError(
      'Studio schedule status must be approved or cancelled.',
    );
  }
  if (syncRevision === null || syncRevision < 0) {
    throw new BadRequestError(
      'Studio schedule syncRevision must be a non-negative integer.',
    );
  }

  assertOptionalDiscordSnowflake(channelId, 'Studio schedule channelId');
  assertOptionalDiscordSnowflake(messageId, 'Studio schedule messageId');
  assertOptionalDiscordSnowflake(
    removeDiscordId,
    'Studio schedule removeDiscordId',
  );

  return {
    endsAt,
    requestId,
    requester,
    startsAt,
    status,
    syncRevision,
    type: 'website.studio.schedule.sync',
    ...(adminNote !== undefined ? { adminNote } : {}),
    ...(channelId !== undefined ? { channelId } : {}),
    ...(deleteChannel !== undefined ? { deleteChannel } : {}),
    ...(managerDiscordIds ? { managerDiscordIds } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(removeDiscordId !== undefined ? { removeDiscordId } : {}),
    ...(removeManagerDiscordIds ? { removeManagerDiscordIds } : {}),
    ...(updateChannel !== undefined ? { updateChannel } : {}),
  };
}

function parseStudioScheduleMessageEvent(
  payload: Record<string, unknown>,
): StudioScheduleMessageInternalEvent {
  const channelId = readNullableString(payload, 'channelId');
  const messageId = readNullableString(payload, 'messageId');
  assertOptionalDiscordSnowflake(
    channelId,
    'Studio schedule message channelId',
  );
  assertOptionalDiscordSnowflake(
    messageId,
    'Studio schedule message messageId',
  );

  return {
    type: 'website.studio.schedule.message',
    ...(channelId !== undefined ? { channelId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
  };
}

function parseStudioPendingReviewEvent(
  payload: Record<string, unknown>,
): StudioPendingReviewInternalEvent {
  const requestId = readString(payload, 'requestId');
  const startsAt = readString(payload, 'startsAt');
  const endsAt = readString(payload, 'endsAt');
  const status = readString(payload, 'status');
  const channelId = readNullableString(payload, 'channelId');
  const messageId = readNullableString(payload, 'messageId');
  const memberNote = readNullableString(payload, 'memberNote');
  const adminNote = readNullableString(payload, 'adminNote');
  const needsStudioManager = readBoolean(payload, 'needsStudioManager');
  const requester = readStudioPendingReviewRequester(payload);

  if (!requestId || !isUuid(requestId)) {
    throw new BadRequestError('Studio review requestId must be a UUID.');
  }

  if (!startsAt || Number.isNaN(Date.parse(startsAt))) {
    throw new BadRequestError('Studio review startsAt must be an ISO date.');
  }

  if (!endsAt || Number.isNaN(Date.parse(endsAt))) {
    throw new BadRequestError('Studio review endsAt must be an ISO date.');
  }

  if (new Date(endsAt) <= new Date(startsAt)) {
    throw new BadRequestError('Studio review endsAt must be after startsAt.');
  }

  if (
    status !== 'approved' &&
    status !== 'cancelled' &&
    status !== 'pending' &&
    status !== 'rejected'
  ) {
    throw new BadRequestError('Studio review status is invalid.');
  }

  if (needsStudioManager === undefined) {
    throw new BadRequestError('Studio review needsStudioManager is required.');
  }
  assertOptionalDiscordSnowflake(channelId, 'Studio review channelId');
  assertOptionalDiscordSnowflake(messageId, 'Studio review messageId');

  return {
    endsAt,
    needsStudioManager,
    requestId,
    requester,
    startsAt,
    status,
    type: 'website.studio.request.review',
    ...(adminNote !== undefined ? { adminNote } : {}),
    ...(channelId !== undefined ? { channelId } : {}),
    ...(memberNote !== undefined ? { memberNote } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
  };
}

function parseFilmRequestReviewEvent(
  payload: Record<string, unknown>,
): FilmRequestReviewInternalEvent {
  const requestId = readString(payload, 'requestId');
  const createdAt = readString(payload, 'createdAt');
  const status = readString(payload, 'status');
  const rollsRequested = readInteger(payload, 'rollsRequested');
  const channelId = readNullableString(payload, 'channelId');
  const messageId = readNullableString(payload, 'messageId');
  const reason = readNullableString(payload, 'reason');
  const adminNote = readNullableString(payload, 'adminNote');
  const requester = readFilmRequestRequester(payload);

  if (!requestId) {
    throw new BadRequestError('Film request requestId is required.');
  }

  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    throw new BadRequestError('Film request createdAt must be an ISO date.');
  }

  if (status !== 'denied' && status !== 'fulfilled' && status !== 'pending') {
    throw new BadRequestError('Film request status is invalid.');
  }

  if (rollsRequested === null || rollsRequested < 1 || rollsRequested > 50) {
    throw new BadRequestError('Film request rollsRequested must be 1-50.');
  }

  return {
    createdAt,
    requestId,
    requester,
    rollsRequested,
    status,
    type: 'website.film.request.review',
    ...(adminNote !== undefined ? { adminNote } : {}),
    ...(channelId !== undefined ? { channelId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

function parseEquipmentLoanSyncEvent(
  payload: Record<string, unknown>,
): EquipmentLoanSyncInternalEvent {
  const loanId = readString(payload, 'loanId');
  const requestedAt = readString(payload, 'requestedAt');
  const dueDate = readNullableString(payload, 'dueDate');
  const approvedAt = readNullableString(payload, 'approvedAt');
  const returnedAt = readNullableString(payload, 'returnedAt');
  const status = readString(payload, 'status');
  const syncRevision = readInteger(payload, 'syncRevision');
  const isPpcOwned = readBoolean(payload, 'isPpcOwned');
  const channelId = readNullableString(payload, 'channelId');
  const messageId = readNullableString(payload, 'messageId');
  const notes = readNullableString(payload, 'notes');
  const reminderKind = readNullableString(payload, 'reminderKind');
  const termsSnapshot = readNullableString(payload, 'termsSnapshot');
  const updateChannel = readBoolean(payload, 'updateChannel');
  const borrower = readEquipmentLoanParty(payload, 'borrower');
  const lender = readNullableEquipmentLoanParty(payload, 'lender');
  const equipment = readEquipmentLoanEquipment(payload);
  const managerDiscordIds = readManagerDiscordIds(
    payload,
    'Equipment loan managerDiscordIds',
    1,
  );
  const removeManagerDiscordIds = readRemovedManagerDiscordIds(
    payload,
    'Equipment loan removeManagerDiscordIds',
  );

  if (!loanId) {
    throw new BadRequestError('Equipment loan loanId is required.');
  }

  if (!requestedAt || Number.isNaN(Date.parse(requestedAt))) {
    throw new BadRequestError(
      'Equipment loan requestedAt must be an ISO date.',
    );
  }

  for (const [field, value] of [
    ['dueDate', dueDate],
    ['approvedAt', approvedAt],
    ['returnedAt', returnedAt],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      Number.isNaN(Date.parse(value))
    ) {
      throw new BadRequestError(`Equipment loan ${field} must be an ISO date.`);
    }
  }

  if (
    status !== 'active' &&
    status !== 'pending' &&
    status !== 'pending_return' &&
    status !== 'rejected' &&
    status !== 'returned'
  ) {
    throw new BadRequestError('Equipment loan status is invalid.');
  }

  if (isPpcOwned === undefined) {
    throw new BadRequestError('Equipment loan isPpcOwned is required.');
  }

  if (syncRevision === null || syncRevision < 0) {
    throw new BadRequestError(
      'Equipment loan syncRevision must be a non-negative integer.',
    );
  }

  assertOptionalDiscordSnowflake(channelId, 'Equipment loan channelId');
  assertOptionalDiscordSnowflake(messageId, 'Equipment loan messageId');

  if (
    reminderKind !== undefined &&
    reminderKind !== null &&
    reminderKind !== 'due_soon' &&
    reminderKind !== 'overdue'
  ) {
    throw new BadRequestError('Equipment loan reminderKind is invalid.');
  }

  return {
    borrower,
    equipment,
    isPpcOwned,
    loanId,
    requestedAt,
    status,
    syncRevision,
    type: 'website.equipment.loan.sync',
    ...(approvedAt !== undefined ? { approvedAt } : {}),
    ...(channelId !== undefined ? { channelId } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(lender !== undefined ? { lender } : {}),
    ...(managerDiscordIds ? { managerDiscordIds } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(reminderKind ? { reminderKind } : {}),
    ...(removeManagerDiscordIds ? { removeManagerDiscordIds } : {}),
    ...(returnedAt !== undefined ? { returnedAt } : {}),
    ...(termsSnapshot !== undefined ? { termsSnapshot } : {}),
    ...(updateChannel !== undefined ? { updateChannel } : {}),
  };
}

function readDarkroomWeeklyJoinSlots(
  payload: Record<string, unknown>,
): DarkroomScheduleWeeklyJoinSlot[] {
  const slots = payload.slots;
  if (!Array.isArray(slots)) {
    throw new BadRequestError('Darkroom weekly join slots must be an array.');
  }

  if (slots.length > 25) {
    throw new BadRequestError('Darkroom weekly join slots cannot exceed 25.');
  }

  return slots.map((slot) => {
    if (!isRecord(slot)) {
      throw new BadRequestError('Darkroom weekly join slot must be an object.');
    }

    const slotId = readString(slot, 'slotId');
    const title = readString(slot, 'title');
    const startsAt = readString(slot, 'startsAt');
    const endsAt = readString(slot, 'endsAt');
    const capacity = readInteger(slot, 'capacity');
    const registeredCount = readInteger(slot, 'registeredCount');
    const availableCapacity = readInteger(slot, 'availableCapacity');

    if (!slotId || !isUuid(slotId) || !title) {
      throw new BadRequestError(
        'Darkroom weekly join slots need a UUID slotId and title.',
      );
    }

    if (!startsAt || Number.isNaN(Date.parse(startsAt))) {
      throw new BadRequestError(
        'Darkroom weekly join slot startsAt must be an ISO date.',
      );
    }

    if (!endsAt || Number.isNaN(Date.parse(endsAt))) {
      throw new BadRequestError(
        'Darkroom weekly join slot endsAt must be an ISO date.',
      );
    }

    if (new Date(endsAt) <= new Date(startsAt)) {
      throw new BadRequestError(
        'Darkroom weekly join slot endsAt must be after startsAt.',
      );
    }

    if (capacity === null || capacity < 1 || capacity > 24) {
      throw new BadRequestError(
        'Darkroom weekly join slot capacity must be 1-24.',
      );
    }

    if (
      registeredCount === null ||
      registeredCount < 0 ||
      registeredCount > capacity
    ) {
      throw new BadRequestError(
        'Darkroom weekly join slot registeredCount is invalid.',
      );
    }

    if (
      availableCapacity === null ||
      availableCapacity < 0 ||
      availableCapacity > capacity
    ) {
      throw new BadRequestError(
        'Darkroom weekly join slot availableCapacity is invalid.',
      );
    }

    return {
      availableCapacity,
      capacity,
      endsAt,
      registeredCount,
      slotId,
      startsAt,
      title,
    };
  });
}

function parseMemberRolesEvent(
  payload: Record<string, unknown>,
  type:
    | DiscordMemberRolesRemoveInternalEvent['type']
    | DiscordMemberRolesSyncInternalEvent['type']
    | DiscordServerVerificationCompleteInternalEvent['type']
    | DiscordWebsiteStaffRoleResolveInternalEvent['type'],
): MemberRolesInternalEvent {
  const discordId = readString(payload, 'discordId');
  if (!discordId) {
    throw new BadRequestError('Discord user ID is required.');
  }

  if (type === 'website.discord.member_roles.remove') {
    return { discordId, type };
  }

  if (type === 'website.discord.staff_role.resolve') {
    return { discordId, type };
  }

  if (type === 'website.discord.server_verification.complete') {
    const applicationId = readString(payload, 'applicationId');
    const interactionToken = readString(payload, 'interactionToken');
    const nickname = readString(payload, 'nickname');

    return {
      discordId,
      ...(applicationId ? { applicationId } : {}),
      ...(interactionToken ? { interactionToken } : {}),
      ...(nickname ? { nickname } : {}),
      type,
    };
  }

  const tier = readNullableString(payload, 'tier');
  const nickname = readString(payload, 'nickname');
  if (
    tier !== undefined &&
    tier !== null &&
    tier !== 'member' &&
    tier !== 'facilities'
  ) {
    throw new BadRequestError('Membership tier must be member or facilities.');
  }

  return {
    discordId,
    membershipExpired: readBoolean(payload, 'membershipExpired') ?? false,
    ...(nickname ? { nickname } : {}),
    ...(tier !== undefined ? { tier } : {}),
    type,
  };
}

function readDarkroomScheduleRegistrants(
  payload: Record<string, unknown>,
): DarkroomScheduleRegistrant[] {
  const registrants = payload.registrants;
  if (!Array.isArray(registrants)) {
    throw new BadRequestError(
      'Darkroom schedule registrants must be an array.',
    );
  }

  if (registrants.length > 24) {
    throw new BadRequestError(
      'Darkroom schedule registrants cannot exceed capacity bounds.',
    );
  }

  return registrants.map((registrant) => {
    if (!isRecord(registrant)) {
      throw new BadRequestError(
        'Darkroom schedule registrant must be an object.',
      );
    }

    const discordId = readString(registrant, 'discordId');
    const name = readString(registrant, 'name');
    const registeredAt = readString(registrant, 'registeredAt');
    const userId = readString(registrant, 'userId');

    if (!discordId || !name || !registeredAt || !userId) {
      throw new BadRequestError(
        'Darkroom schedule registrants need discordId, name, registeredAt, and userId.',
      );
    }
    assertDiscordSnowflake(discordId, 'Darkroom schedule registrant discordId');

    if (Number.isNaN(Date.parse(registeredAt))) {
      throw new BadRequestError(
        'Darkroom schedule registrant registeredAt must be an ISO date.',
      );
    }

    return {
      discordId,
      name,
      registeredAt,
      userId,
    };
  });
}

function readStudioScheduleRequester(
  payload: Record<string, unknown>,
): StudioScheduleRequester {
  const requester = payload.requester;
  if (!isRecord(requester)) {
    throw new BadRequestError('Studio schedule requester must be an object.');
  }

  const discordId = readString(requester, 'discordId');
  const name = readString(requester, 'name');
  const userId = readString(requester, 'userId');

  if (!discordId || !name || !userId) {
    throw new BadRequestError(
      'Studio schedule requester needs discordId, name, and userId.',
    );
  }
  assertDiscordSnowflake(discordId, 'Studio schedule requester discordId');

  return {
    discordId,
    name,
    userId,
  };
}

function readStudioPendingReviewRequester(
  payload: Record<string, unknown>,
): StudioPendingReviewInternalEvent['requester'] {
  const requester = payload.requester;
  if (!isRecord(requester)) {
    throw new BadRequestError('Studio review requester must be an object.');
  }

  const discordId = readNullableString(requester, 'discordId');
  const name = readString(requester, 'name');
  const userId = readString(requester, 'userId');

  if (!name || !userId) {
    throw new BadRequestError('Studio review requester needs name and userId.');
  }
  assertOptionalDiscordSnowflake(
    discordId,
    'Studio review requester discordId',
  );

  return {
    name,
    userId,
    ...(discordId !== undefined ? { discordId } : {}),
  };
}

function readEquipmentLoanParty(
  payload: Record<string, unknown>,
  field: 'borrower' | 'lender',
): EquipmentLoanParty {
  const party = payload[field];
  if (!isRecord(party)) {
    throw new BadRequestError(`Equipment loan ${field} must be an object.`);
  }

  const discordId = readString(party, 'discordId');
  const name = readString(party, 'name');
  const userId = readString(party, 'userId');

  if (!discordId || !name || !userId) {
    throw new BadRequestError(
      `Equipment loan ${field} needs discordId, name, and userId.`,
    );
  }
  assertDiscordSnowflake(discordId, `Equipment loan ${field} discordId`);

  return {
    discordId,
    name,
    userId,
  };
}

function readNullableEquipmentLoanParty(
  payload: Record<string, unknown>,
  field: 'lender',
) {
  if (payload[field] === null || payload[field] === undefined) {
    return payload[field] === null ? null : undefined;
  }

  return readEquipmentLoanParty(payload, field);
}

function readEquipmentLoanEquipment(
  payload: Record<string, unknown>,
): EquipmentLoanSyncInternalEvent['equipment'] {
  const equipment = payload.equipment;
  if (!isRecord(equipment)) {
    throw new BadRequestError('Equipment loan equipment must be an object.');
  }

  const id = readString(equipment, 'id');
  const name = readString(equipment, 'name');
  const category = readString(equipment, 'category');
  const assetTag = readNullableString(equipment, 'assetTag');
  const model = readNullableString(equipment, 'model');

  if (!id || !name || !category) {
    throw new BadRequestError(
      'Equipment loan equipment needs id, name, and category.',
    );
  }

  return {
    category,
    id,
    name,
    ...(assetTag !== undefined ? { assetTag } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

function readFilmRequestRequester(
  payload: Record<string, unknown>,
): FilmRequestReviewInternalEvent['requester'] {
  const requester = payload.requester;
  if (!isRecord(requester)) {
    throw new BadRequestError('Film request requester must be an object.');
  }

  const discordId = readNullableString(requester, 'discordId');
  const name = readString(requester, 'name');
  const userId = readString(requester, 'userId');

  if (!name || !userId) {
    throw new BadRequestError('Film request requester needs name and userId.');
  }

  return {
    name,
    userId,
    ...(discordId !== undefined ? { discordId } : {}),
  };
}

function readDarkroomStatsRanks(
  payload: Record<string, unknown>,
  key: 'topDevelopers' | 'topStocks',
): DarkroomStatsRank[] {
  const ranks = payload[key];
  if (!Array.isArray(ranks)) {
    throw new BadRequestError(`Darkroom stats ${key} must be an array.`);
  }

  if (ranks.length > 10) {
    throw new BadRequestError(`Darkroom stats ${key} cannot exceed 10 items.`);
  }

  return ranks.map((rank) => {
    if (!isRecord(rank)) {
      throw new BadRequestError(
        `Darkroom stats ${key} item must be an object.`,
      );
    }

    const name = readString(rank, 'name');
    const rolls = readNonNegativeInteger(rank, 'rolls');

    if (!name || rolls === null) {
      throw new BadRequestError(
        `Darkroom stats ${key} items need name and rolls.`,
      );
    }

    return {
      name,
      rolls,
    };
  });
}

function readDarkroomStatsRecentLogs(
  payload: Record<string, unknown>,
): DarkroomStatsRecentLog[] {
  const logs = payload.recentLogs;
  if (!Array.isArray(logs)) {
    throw new BadRequestError('Darkroom stats recentLogs must be an array.');
  }

  if (logs.length > 10) {
    throw new BadRequestError(
      'Darkroom stats recentLogs cannot exceed 10 items.',
    );
  }

  return logs.map((log) => {
    if (!isRecord(log)) {
      throw new BadRequestError('Darkroom stats recent log must be an object.');
    }

    const userName = readString(log, 'userName');
    const filmStockName = readString(log, 'filmStockName');
    const process = readString(log, 'process');
    const format = readString(log, 'format');
    const rollCount = readNonNegativeInteger(log, 'rollCount');
    const createdAt = readString(log, 'createdAt');

    if (!userName || !filmStockName || rollCount === null || !createdAt) {
      throw new BadRequestError(
        'Darkroom stats recent logs need userName, filmStockName, rollCount, and createdAt.',
      );
    }

    if (process !== 'B&W' && process !== 'C-41' && process !== 'E-6 Slide') {
      throw new BadRequestError(
        'Darkroom stats recent log process is invalid.',
      );
    }

    if (format !== '35mm' && format !== '120') {
      throw new BadRequestError('Darkroom stats recent log format is invalid.');
    }

    if (rollCount < 1) {
      throw new BadRequestError(
        'Darkroom stats recent log rollCount must be at least 1.',
      );
    }

    if (Number.isNaN(Date.parse(createdAt))) {
      throw new BadRequestError(
        'Darkroom stats recent log createdAt must be an ISO date.',
      );
    }

    return {
      createdAt,
      filmStockName,
      format,
      process,
      rollCount,
      userName,
    };
  });
}

function parseScheduledEvent(
  payload: Record<string, unknown>,
  type: ScheduledEventInternalEvent['type'],
): ScheduledEventInternalEvent {
  const discordEventId = readString(payload, 'discordEventId');
  if (type !== 'website.event.create' && !discordEventId) {
    throw new BadRequestError('Discord scheduled event ID is required.');
  }

  if (discordEventId) {
    assertDiscordSnowflake(discordEventId, 'Discord scheduled event ID');
  }

  if (type === 'website.event.delete') {
    return {
      discordEventId: discordEventId as string,
      type,
    };
  }

  const title = readString(payload, 'title');
  const startsAt = readString(payload, 'startsAt');

  if (!title) {
    throw new BadRequestError('Scheduled event title is required.');
  }

  if (!startsAt) {
    throw new BadRequestError('Scheduled event startsAt is required.');
  }

  if (Number.isNaN(Date.parse(startsAt))) {
    throw new BadRequestError('Scheduled event startsAt must be an ISO date.');
  }

  const endsAt = readNullableString(payload, 'endsAt');
  if (endsAt && Number.isNaN(Date.parse(endsAt))) {
    throw new BadRequestError('Scheduled event endsAt must be an ISO date.');
  }

  const description = readNullableString(payload, 'description');
  const location = readNullableString(payload, 'location');

  return {
    startsAt,
    title,
    type,
    ...(description !== undefined ? { description } : {}),
    ...(discordEventId ? { discordEventId } : {}),
    ...(endsAt !== undefined ? { endsAt } : {}),
    ...(location !== undefined ? { location } : {}),
  };
}

function parseMessageEvent(
  payload: Record<string, unknown>,
  type: string,
): MessageInternalEvent {
  const content =
    readString(payload, 'content') ?? readString(payload, 'message');
  const channelId = readString(payload, 'channelId');
  const embeds = readEmbeds(payload);
  const messageId = readString(payload, 'messageId');
  const nonce = readString(payload, 'nonce');

  if (!content && (!embeds || embeds.length === 0)) {
    throw new BadRequestError('Internal event requires content or embeds.');
  }

  if (content && content.length > 2_000) {
    throw new BadRequestError('Discord message content is too long.');
  }

  if (messageId && !channelId) {
    throw new BadRequestError('channelId is required when editing a message.');
  }

  if (nonce && nonce.length > 25) {
    throw new BadRequestError('Discord message nonce is too long.');
  }

  return {
    type,
    ...(channelId ? { channelId } : {}),
    ...(content ? { content } : {}),
    ...(embeds ? { embeds } : {}),
    ...(messageId ? { messageId } : {}),
    ...(nonce ? { nonce } : {}),
  };
}

function parseGatewayEvent(
  payload: Record<string, unknown>,
): GatewayInternalEvent {
  const eventType = readString(payload, 'eventType');
  const receivedAt =
    readString(payload, 'receivedAt') ?? new Date().toISOString();
  const gatewayPayload = payload.payload;

  if (!isGatewayEventType(eventType)) {
    throw new BadRequestError(
      'Gateway event payload has an invalid eventType.',
    );
  }

  if (Number.isNaN(Date.parse(receivedAt))) {
    throw new BadRequestError('Gateway event receivedAt must be an ISO date.');
  }

  if (!isRecord(gatewayPayload)) {
    throw new BadRequestError('Gateway event payload must include payload.');
  }

  const guildId = readString(payload, 'guildId');
  const channelId = readString(payload, 'channelId');
  const messageId = readString(payload, 'messageId');
  const userId = readString(payload, 'userId');
  const gatewayIp = readString(payload, 'gatewayIp');

  return {
    eventType,
    payload: gatewayPayload,
    receivedAt,
    type: 'discord.gateway.event',
    ...(channelId ? { channelId } : {}),
    ...(gatewayIp ? { gatewayIp } : {}),
    ...(guildId ? { guildId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(userId ? { userId } : {}),
  };
}

function readEmbeds(
  payload: Record<string, unknown>,
): DiscordEmbed[] | undefined {
  const embeds = payload.embeds;

  if (embeds === undefined) {
    return undefined;
  }

  if (!Array.isArray(embeds) || embeds.some((embed) => !isRecord(embed))) {
    throw new BadRequestError('embeds must be an array of embed objects.');
  }

  if (embeds.length > 10) {
    throw new BadRequestError('Discord accepts at most 10 embeds per message.');
  }

  return embeds as DiscordEmbed[];
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new BadRequestError(`${key} must be a string.`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNullableString(
  payload: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = payload[key];

  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new BadRequestError(`${key} must be a string.`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readInteger(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null;
  }

  return value;
}

function readNonNegativeInteger(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = readInteger(payload, key);
  return value !== null && value >= 0 ? value : null;
}

function readStringArray(
  payload: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = payload[key];

  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    value.length > 25 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new BadRequestError(`${key} must be an array of strings.`);
  }

  return value.flatMap((item) => {
    const trimmedItem = item.trim();
    return trimmedItem.length > 0 ? [trimmedItem] : [];
  });
}

function readManagerDiscordIds(
  payload: Record<string, unknown>,
  label: string,
  maxIds: number,
) {
  const discordIds = readStringArray(payload, 'managerDiscordIds');
  if (!discordIds) {
    return undefined;
  }

  if (new Set(discordIds).size !== discordIds.length) {
    throw new BadRequestError(`${label} must contain unique IDs.`);
  }
  if (discordIds.length > maxIds) {
    throw new BadRequestError(
      `${label} must contain at most ${maxIds} ID${maxIds === 1 ? '' : 's'}.`,
    );
  }
  for (const discordId of discordIds) {
    assertDiscordSnowflake(discordId, label);
  }

  return discordIds;
}

function readRemovedManagerDiscordIds(
  payload: Record<string, unknown>,
  label: string,
) {
  const discordIds = readStringArray(payload, 'removeManagerDiscordIds');
  if (!discordIds) {
    return undefined;
  }

  for (const discordId of discordIds) {
    assertDiscordSnowflake(discordId, label);
  }

  return [...new Set(discordIds)];
}

function readBoolean(
  payload: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = payload[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new BadRequestError(`${key} must be a boolean.`);
  }

  return value;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function assertDiscordSnowflake(value: string, label: string) {
  if (!/^\d{17,20}$/.test(value)) {
    throw new BadRequestError(`${label} must be a Discord snowflake.`);
  }
}

function assertOptionalDiscordSnowflake(
  value: string | null | undefined,
  label: string,
) {
  if (typeof value === 'string') assertDiscordSnowflake(value, label);
}

function isGatewayEventType(
  value: string | undefined,
): value is GatewayEventType {
  return Boolean(value && GATEWAY_EVENT_TYPES.has(value as GatewayEventType));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
