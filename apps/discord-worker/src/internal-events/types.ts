/**
 * Parsed contracts for signed internal events.
 *
 * The shared package owns the cross-process wire shape. These local types are
 * the Worker's validated, dispatch-ready view of that input.
 */
import type { DiscordEmbed, GatewayInternalEvent } from '@pccbot/shared';

export interface MessageInternalEvent {
  channelId?: string;
  content?: string;
  embeds?: DiscordEmbed[];
  messageId?: string;
  type: string;
}

export interface ScheduledEventInternalEvent {
  description?: string | null;
  discordEventId?: string;
  endsAt?: string | null;
  location?: string | null;
  startsAt?: string;
  title?: string;
  type:
    | 'website.event.create'
    | 'website.event.delete'
    | 'website.event.update';
}

export interface DiscordGuildStatsInternalEvent {
  type: 'website.discord.guild_stats';
}

export interface DarkroomStatsRank {
  name: string;
  rolls: number;
}

export interface DarkroomStatsRecentLog {
  createdAt: string;
  filmStockName: string;
  format: '120' | '35mm';
  process: 'B&W' | 'C-41' | 'E-6 Slide';
  rollCount: number;
  userName: string;
}

export interface DarkroomStatsSyncInternalEvent {
  bw: number;
  c41: number;
  format120: number;
  format35mm: number;
  logCount: number;
  messageId?: string | null;
  recentLogs: DarkroomStatsRecentLog[];
  rollsThisMonth: number;
  slide: number;
  topDevelopers: DarkroomStatsRank[];
  topStocks: DarkroomStatsRank[];
  totalRolls: number;
  type: 'website.darkroom.stats.sync';
  updatedAt: string;
  userCount: number;
}

export interface DarkroomScheduleRegistrant {
  discordId: string;
  name: string;
  registeredAt: string;
  userId: string;
}

export interface DarkroomScheduleSyncInternalEvent {
  capacity: number;
  channelId?: string | null;
  deleteChannel?: boolean;
  endsAt: string;
  messageId?: string | null;
  notificationAction?: 'cancel' | 'end';
  registeredCount: number;
  registrants: DarkroomScheduleRegistrant[];
  removeDiscordIds?: string[];
  slotId: string;
  startsAt: string;
  status: 'cancelled' | 'open';
  title: string;
  type: 'website.darkroom.schedule.sync';
  updateChannel?: boolean;
}

export interface DarkroomScheduleWeeklyJoinSlot {
  availableCapacity: number;
  capacity: number;
  endsAt: string;
  registeredCount: number;
  slotId: string;
  startsAt: string;
  title: string;
}

export interface DarkroomScheduleWeeklyJoinMessageInternalEvent {
  allowCreate?: boolean;
  channelId?: string | null;
  messageId?: string | null;
  slots: DarkroomScheduleWeeklyJoinSlot[];
  truncated?: boolean;
  type: 'website.darkroom.schedule.weekly_join_message';
  windowEnd: string;
  windowStart: string;
}

export interface StudioScheduleRequester {
  discordId: string;
  name: string;
  userId: string;
}

export interface StudioScheduleSyncInternalEvent {
  adminNote?: string | null;
  channelId?: string | null;
  deleteChannel?: boolean;
  endsAt: string;
  messageId?: string | null;
  removeDiscordId?: string | null;
  requestId: string;
  requester: StudioScheduleRequester;
  startsAt: string;
  status: 'approved' | 'cancelled';
  type: 'website.studio.schedule.sync';
  updateChannel?: boolean;
}

export interface StudioScheduleMessageInternalEvent {
  channelId?: string | null;
  messageId?: string | null;
  type: 'website.studio.schedule.message';
}

export interface StudioPendingReviewInternalEvent {
  adminNote?: string | null;
  channelId?: string | null;
  endsAt: string;
  memberNote?: string | null;
  messageId?: string | null;
  needsStudioManager: boolean;
  requestId: string;
  requester: {
    discordId?: string | null;
    name: string;
    userId: string;
  };
  startsAt: string;
  status: 'approved' | 'cancelled' | 'pending' | 'rejected';
  type: 'website.studio.request.review';
}

export interface EquipmentLoanParty {
  discordId: string;
  name: string;
  userId: string;
}

export interface EquipmentLoanSyncInternalEvent {
  approvedAt?: string | null;
  borrower: EquipmentLoanParty;
  channelId?: string | null;
  dueDate?: string | null;
  equipment: {
    assetTag?: string | null;
    category: string;
    id: string;
    model?: string | null;
    name: string;
  };
  isPpcOwned: boolean;
  lender?: EquipmentLoanParty | null;
  loanId: string;
  messageId?: string | null;
  notes?: string | null;
  reminderKind?: 'due_soon' | 'overdue';
  requestedAt: string;
  returnedAt?: string | null;
  status: 'active' | 'pending' | 'pending_return' | 'rejected' | 'returned';
  termsSnapshot?: string | null;
  type: 'website.equipment.loan.sync';
  updateChannel?: boolean;
}

export interface FilmRequestReviewInternalEvent {
  adminNote?: string | null;
  channelId?: string | null;
  createdAt: string;
  messageId?: string | null;
  reason?: string | null;
  requestId: string;
  requester: {
    discordId?: string | null;
    name: string;
    userId: string;
  };
  rollsRequested: number;
  status: 'denied' | 'fulfilled' | 'pending';
  type: 'website.film.request.review';
}

export interface DiscordMemberRolesSyncInternalEvent {
  discordId: string;
  membershipExpired?: boolean;
  tier?: 'facilities' | 'member' | null;
  type: 'website.discord.member_roles.sync';
}

export interface DiscordMemberRolesRemoveInternalEvent {
  discordId: string;
  type: 'website.discord.member_roles.remove';
}

export interface DiscordServerVerificationCompleteInternalEvent {
  applicationId?: string;
  discordId: string;
  interactionToken?: string;
  type: 'website.discord.server_verification.complete';
}

export interface DiscordWebsiteStaffRoleResolveInternalEvent {
  discordId: string;
  type: 'website.discord.staff_role.resolve';
}

export type MemberRolesInternalEvent =
  | DiscordMemberRolesRemoveInternalEvent
  | DiscordMemberRolesSyncInternalEvent
  | DiscordServerVerificationCompleteInternalEvent
  | DiscordWebsiteStaffRoleResolveInternalEvent;

export type ParsedInternalEvent =
  | {
      event: GatewayInternalEvent;
      kind: 'gateway';
    }
  | {
      event: MessageInternalEvent;
      kind: 'message';
    }
  | {
      event: ScheduledEventInternalEvent;
      kind: 'scheduledEvent';
    }
  | {
      event: DiscordGuildStatsInternalEvent;
      kind: 'guildStats';
    }
  | {
      event: DarkroomStatsSyncInternalEvent;
      kind: 'darkroomStats';
    }
  | {
      event: DarkroomScheduleSyncInternalEvent;
      kind: 'darkroomSchedule';
    }
  | {
      event: DarkroomScheduleWeeklyJoinMessageInternalEvent;
      kind: 'darkroomWeeklyJoinMessage';
    }
  | {
      event: StudioScheduleSyncInternalEvent;
      kind: 'studioSchedule';
    }
  | {
      event: StudioScheduleMessageInternalEvent;
      kind: 'studioScheduleMessage';
    }
  | {
      event: StudioPendingReviewInternalEvent;
      kind: 'studioPendingReview';
    }
  | {
      event: EquipmentLoanSyncInternalEvent;
      kind: 'equipmentLoan';
    }
  | {
      event: FilmRequestReviewInternalEvent;
      kind: 'filmRequestReview';
    }
  | {
      event: MemberRolesInternalEvent;
      kind: 'memberRoles';
    };
