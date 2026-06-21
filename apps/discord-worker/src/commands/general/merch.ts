/**
 * Public command for listing currently available club merch in Discord.
 */
import type {
  DiscordEmbed,
  DiscordEmbedField,
  DiscordCommand,
  DiscordMessagePayload,
  Env,
} from '../../discord/types';
import { ephemeralResponse, messageResponse } from '../../discord/responses';
import { requestWebsiteApi } from '../../services/websiteApiService';
import { getOptionalEnv } from '../../utils/env';
import { getErrorMessage } from '../../utils/errors';

interface MerchProduct {
  buyUrl: string;
  categoryName: string;
  description: string;
  inventoryLabel: string;
  name: string;
  price: string;
  status: 'available' | 'limited' | 'sold_out';
}

interface MerchResponse {
  products?: unknown;
}

const MAX_EMBED_FIELDS = 25;
const MAX_EMBEDS = 10;

export const merchCommand: DiscordCommand = {
  definition: {
    description: 'Show currently available PPC merch.',
    name: 'merch',
  },
  execute: async (_interaction, env) => {
    try {
      const response = await requestWebsiteApi(env, '/merch', {
        method: 'GET',
      });
      const products = readMerchProducts(response).filter(
        (product) => product.status !== 'sold_out',
      );

      if (products.length === 0) {
        return ephemeralResponse('No merch is available right now.');
      }

      return messageResponse(createMerchPayload(products, env));
    } catch (error) {
      return ephemeralResponse(
        `Could not load merch: ${getErrorMessage(error)}`,
      );
    }
  },
};

function createMerchPayload(
  products: MerchProduct[],
  env: Env,
): DiscordMessagePayload {
  const fields = products.map((product) => productToField(product, env));
  const chunks = chunkFields(fields, MAX_EMBED_FIELDS).slice(0, MAX_EMBEDS);
  const hiddenCount =
    fields.length - chunks.reduce((count, chunk) => count + chunk.length, 0);
  const embeds = chunks.map((chunk, index): DiscordEmbed => {
    const embed: DiscordEmbed = {
      color: 0xf2c94c,
      fields: chunk,
      footer: {
        text: 'Purdue Photography Club merch',
      },
      title: index === 0 ? 'Available Merch' : 'Available Merch Continued',
    };

    if (index === 0) {
      embed.description = formatDescription(products.length, hiddenCount, env);
    }

    return embed;
  });

  return { embeds };
}

function productToField(product: MerchProduct, env: Env): DiscordEmbedField {
  const lines = [
    `**Price:** ${product.price || 'Ask at meeting'}`,
    `**Status:** ${formatStatus(product)}`,
    product.description ? truncate(product.description, 220) : undefined,
    formatBuyLine(product.buyUrl, env),
  ];

  return {
    inline: false,
    name: truncate(`${product.name} · ${product.categoryName}`, 256),
    value: lines.filter((line): line is string => Boolean(line)).join('\n'),
  };
}

function readMerchProducts(value: unknown): MerchProduct[] {
  if (!isRecord(value) || !Array.isArray((value as MerchResponse).products)) {
    return [];
  }

  return (value as { products: unknown[] }).products
    .map(readMerchProduct)
    .filter((product): product is MerchProduct => Boolean(product));
}

function readMerchProduct(value: unknown): MerchProduct | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = readString(value.status);
  if (status !== 'available' && status !== 'limited' && status !== 'sold_out') {
    return undefined;
  }

  const name = readString(value.name);
  if (!name) {
    return undefined;
  }

  return {
    buyUrl: readString(value.buyUrl) ?? '',
    categoryName: readString(value.categoryName) ?? 'Merch',
    description: readString(value.description) ?? '',
    inventoryLabel: readString(value.inventoryLabel) ?? '',
    name,
    price: readString(value.price) ?? '',
    status,
  };
}

function formatDescription(
  visibleCount: number,
  hiddenCount: number,
  env: Env,
) {
  const lines = [
    `Here is what is currently available from PPC merch.`,
    hiddenCount > 0
      ? `Showing ${visibleCount - hiddenCount} of ${visibleCount} items.`
      : undefined,
    `[Browse the merch page](${getWebsiteUrl(env)}/merch)`,
  ];

  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

function formatStatus(product: MerchProduct) {
  if (product.inventoryLabel) {
    return product.inventoryLabel;
  }

  return product.status === 'limited' ? 'Limited' : 'Available';
}

function formatBuyLine(buyUrl: string, env: Env) {
  const url = normalizeMerchUrl(buyUrl, env);
  return url ? `**Buy:** [Open link](${url})` : '**Buy:** Ask at meeting';
}

function normalizeMerchUrl(value: string, env: Env) {
  if (!value) {
    return '';
  }

  if (value.startsWith('/') && !value.startsWith('//')) {
    return `${getWebsiteUrl(env)}${value}`;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function getWebsiteUrl(env: Env) {
  return (
    getOptionalEnv(env, 'WEBSITE_URL') ?? 'https://purduephotoclub.org'
  ).replace(/\/+$/, '');
}

function chunkFields(
  fields: DiscordEmbedField[],
  chunkSize: number,
): DiscordEmbedField[][] {
  const chunks: DiscordEmbedField[][] = [];
  for (let index = 0; index < fields.length; index += chunkSize) {
    chunks.push(fields.slice(index, index + chunkSize));
  }

  return chunks;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
