/**
 * Local Discord and Worker binding types.
 *
 * These are intentionally narrow: they model the fields this Worker actually
 * uses, not every property Discord can send.
 */
import type {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
} from 'discord-interactions';
import type { DiscordEmbed } from '@pccbot/shared';

export type { DiscordEmbed, DiscordEmbedField } from '@pccbot/shared';

export interface GatewayServiceBinding {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface Env {
  DISCORD_APPLICATION_ID?: string | undefined;
  DISCORD_GUILD_ID?: string | undefined;
  DISCORD_PUBLIC_KEY?: string | undefined;
  DISCORD_TOKEN?: string | undefined;
  WEBSITE_URL?: string | undefined;
  WIKI_URL?: string | undefined;
  ENVIRONMENT?: string | undefined;
  GATEWAY_SERVICE?: GatewayServiceBinding | undefined;
  INTERNAL_TOKEN?: string | undefined;
  WORKER_SECRET?: string | undefined;
  DISCORD_DEFAULT_CHANNEL_ID?: string | undefined;
  DISCORD_MIN_ACCOUNT_AGE_DAYS?: string | undefined;
  DISCORD_UNVERIFIED_ROLE_ID?: string | undefined;
  DISCORD_VERIFICATION_CHANNEL_ID?: string | undefined;
  DISCORD_VERIFIED_ROLE_ID?: string | undefined;
  DISCORD_WIKI_CHANNEL_ID?: string | undefined;
  API_WORKER?: Fetcher | undefined;
  REQUEST_NONCES?: KVNamespace | undefined;
}

export type Snowflake = string;

export interface DiscordApplicationCommandDefinition {
  name: string;
  description: string;
  type?: number;
  options?: unknown[];
}

export interface DiscordApplicationCommandData {
  name: string;
  options?: DiscordApplicationCommandOption[];
}

export interface DiscordApplicationCommandOption {
  name: string;
  type?: number;
  value?: unknown;
  options?: DiscordApplicationCommandOption[];
}

export interface DiscordComponentData {
  custom_id: string;
  component_type?: number;
  values?: string[];
}

export interface DiscordModalSubmitData {
  custom_id: string;
  components?: unknown[];
}

export type DiscordInteractionData =
  | DiscordApplicationCommandData
  | DiscordComponentData
  | DiscordModalSubmitData;

export interface DiscordInteraction {
  id?: Snowflake;
  application_id?: Snowflake;
  channel_id?: Snowflake;
  guild_id?: Snowflake;
  member?: {
    roles?: Snowflake[];
    user?: {
      created_at?: string;
      id?: Snowflake;
    };
  };
  token?: string;
  type: InteractionType;
  message?: {
    id?: Snowflake;
  };
  user?: {
    created_at?: string;
    id?: Snowflake;
  };
  data?: DiscordInteractionData;
}

export interface ApplicationCommandInteraction extends DiscordInteraction {
  data: DiscordApplicationCommandData;
}

export interface ComponentInteraction extends DiscordInteraction {
  data: DiscordComponentData;
}

export interface ModalSubmitInteraction extends DiscordInteraction {
  data: DiscordModalSubmitData;
}

export interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: unknown[];
  flags?: InteractionResponseFlags | number;
  custom_id?: string;
  title?: string;
  allowed_mentions?: {
    parse: string[];
  };
}

export interface DiscordInteractionResponse {
  type: InteractionResponseType;
  data?: DiscordMessagePayload;
}

export interface DiscordCommand {
  definition: DiscordApplicationCommandDefinition;
  execute: (
    interaction: ApplicationCommandInteraction,
    env: Env,
  ) => DiscordInteractionResponse | Promise<DiscordInteractionResponse>;
}
