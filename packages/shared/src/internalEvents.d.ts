/**
 * Contracts for events that cross process boundaries.
 *
 * Keep this file conservative: anything added here becomes part of the Worker,
 * Gateway, and website integration surface.
 */
export type GatewayEventType =
  | 'GUILD_MEMBER_ADD'
  | 'GUILD_MEMBER_REMOVE'
  | 'GUILD_MEMBER_UPDATE'
  | 'MESSAGE_CREATE'
  | 'MESSAGE_DELETE'
  | 'MESSAGE_REACTION_ADD'
  | 'MESSAGE_REACTION_REMOVE'
  | 'MESSAGE_REACTION_REMOVE_ALL'
  | 'MESSAGE_REACTION_REMOVE_EMOJI'
  | 'MESSAGE_UPDATE';

export interface DiscordEmbedField {
  /** Label shown by Discord for one embed field. */
  name: string;
  /** Field body, already formatted for Discord markdown. */
  value: string;
  /** Whether Discord may place this field beside other inline fields. */
  inline?: boolean;
}

export interface DiscordEmbed {
  /** Optional embed title shown above the description. */
  title?: string;
  /** Main embed body, already formatted for Discord markdown. */
  description?: string;
  /** Discord decimal color value for the embed accent. */
  color?: number;
  /** Small structured rows under the description. */
  fields?: DiscordEmbedField[];
  /** Footer text shown at the bottom of the embed. */
  footer?: {
    text: string;
  };
  /** ISO timestamp Discord can render in the embed footer. */
  timestamp?: string;
}

export interface WebsiteDiscordNotificationEvent {
  /** Internal website-to-Worker notification type, chosen by the producer. */
  type: string;
  channelId?: string;
  content?: string;
  embeds?: DiscordEmbed[];
  /** When present, the Worker edits this existing Discord message. */
  messageId?: string;
}

export interface GatewayInternalEvent {
  /** Contract used by the VPS Gateway forwarder when relaying Discord events. */
  type: 'discord.gateway.event';
  eventType: GatewayEventType;
  /** ISO timestamp from the gateway process, not necessarily Discord's event time. */
  receivedAt: string;
  /** Normalized IDs promoted from payload for routing and structured logs. */
  guildId?: string;
  channelId?: string;
  messageId?: string;
  userId?: string;
  /** Gateway egress IP from config, carried inside the signed event body. */
  gatewayIp?: string;
  /** Sanitized Discord payload; shape depends on eventType. */
  payload: Record<string, unknown>;
}

export type InternalEvent =
  | GatewayInternalEvent
  | WebsiteDiscordNotificationEvent;
