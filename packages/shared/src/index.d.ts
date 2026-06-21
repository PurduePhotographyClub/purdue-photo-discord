/**
 * Shared type exports used by the Worker and the VPS Gateway.
 *
 * The package is type-only today; runtime imports should not depend on it doing
 * work at module load time.
 */
export type {
  DiscordEmbed,
  DiscordEmbedField,
  GatewayEventType,
  GatewayInternalEvent,
  InternalEvent,
  WebsiteDiscordNotificationEvent,
} from './internalEvents.js';
