import { discordApiRequest } from '../discord/api';
import type { Env } from '../discord/types';
import { BadRequestError, DiscordApiError } from '../utils/errors';
import { getRequiredEnv } from '../utils/env';

export const DISCORD_PRIVATE_THREAD_TYPE = 12;
export const PRIVATE_THREAD_AUTO_ARCHIVE_DURATION = 10_080;

export interface DiscordManagedChannel {
  guild_id?: string;
  id: string;
  name?: string;
  owner_id?: string;
  parent_id?: string | null;
  position?: number;
  thread_metadata?: {
    archive_timestamp?: string;
    archived?: boolean;
  };
  topic?: string | null;
  type?: number;
}

export interface ManagedPrivateThreadSpec {
  legacyMarkers?: readonly string[];
  marker: string;
  parentChannelId: string;
  syncRevision?: number;
}

interface DiscordThreadCollection {
  has_more?: boolean;
  threads?: DiscordManagedChannel[];
}

export function buildManagedPrivateThreadName(
  displayName: string,
  spec: ManagedPrivateThreadSpec,
) {
  const marker = buildManagedPrivateThreadMarker(spec);
  if (marker.length >= 100) {
    throw new BadRequestError('Discord private thread marker is too long.');
  }

  const prefix = displayName.slice(0, 100 - marker.length).replace(/-+$/g, '');
  return `${prefix}${marker}`;
}

export async function createManagedPrivateThread(
  env: Env,
  displayName: string,
  spec: ManagedPrivateThreadSpec,
) {
  const thread = await discordApiRequest<DiscordManagedChannel>(
    env,
    `/channels/${spec.parentChannelId}/threads`,
    {
      body: JSON.stringify({
        auto_archive_duration: PRIVATE_THREAD_AUTO_ARCHIVE_DURATION,
        invitable: false,
        name: buildManagedPrivateThreadName(displayName, spec),
        type: DISCORD_PRIVATE_THREAD_TYPE,
      }),
      method: 'POST',
    },
  );

  if (!thread.id) {
    throw new BadRequestError('Discord did not return a private thread ID.');
  }

  return thread;
}

export async function findManagedPrivateThread(
  env: Env,
  spec: ManagedPrivateThreadSpec,
) {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const active = await discordApiRequest<DiscordThreadCollection>(
    env,
    `/guilds/${guildId}/threads/active`,
  );
  const activeMatch = selectManagedPrivateThread(active.threads, spec);
  if (activeMatch) {
    assertManagedPrivateThread(env, activeMatch, spec);
    return activeMatch;
  }

  return findArchivedManagedPrivateThread(env, spec);
}

export async function getDiscordManagedChannel(env: Env, channelId: string) {
  try {
    return await discordApiRequest<DiscordManagedChannel>(
      env,
      `/channels/${channelId}`,
    );
  } catch (error) {
    if (isDiscordNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export function assertManagedPrivateThread(
  env: Env,
  channel: DiscordManagedChannel,
  spec: ManagedPrivateThreadSpec,
  options: { allowMissingOwner?: boolean } = {},
) {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const applicationId = getRequiredEnv(env, 'DISCORD_APPLICATION_ID');
  const ownerMatches =
    channel.owner_id === applicationId ||
    (options.allowMissingOwner === true && channel.owner_id === undefined);
  if (
    channel.guild_id !== guildId ||
    !ownerMatches ||
    channel.parent_id !== spec.parentChannelId ||
    channel.type !== DISCORD_PRIVATE_THREAD_TYPE
  ) {
    throw new BadRequestError('Discord private thread ownership mismatch.');
  }

  const storedRevision = readManagedPrivateThreadRevision(channel.name, spec);
  if (storedRevision === null) {
    throw new BadRequestError('Discord private thread marker mismatch.');
  }
  if (spec.syncRevision !== undefined && storedRevision > spec.syncRevision) {
    throw new BadRequestError('Discord private thread event is stale.');
  }
}

export async function prepareManagedPrivateThread(
  env: Env,
  thread: DiscordManagedChannel,
  displayName: string,
  spec: ManagedPrivateThreadSpec,
  options: { allowMissingOwner?: boolean } = {},
) {
  assertManagedPrivateThread(env, thread, spec, options);
  const name = buildManagedPrivateThreadName(displayName, spec);
  await discordApiRequest(env, `/channels/${thread.id}`, {
    body: JSON.stringify({
      archived: false,
      auto_archive_duration: PRIVATE_THREAD_AUTO_ARCHIVE_DURATION,
      invitable: false,
      name,
    }),
    method: 'PATCH',
  });

  return {
    ...thread,
    name,
    thread_metadata: {
      ...thread.thread_metadata,
      archived: false,
    },
  };
}

export async function addManagedPrivateThreadMember(
  env: Env,
  threadId: string,
  discordId: string,
) {
  await discordApiRequest(
    env,
    `/channels/${threadId}/thread-members/${discordId}`,
    { method: 'PUT' },
  );
}

export async function removeManagedPrivateThreadMember(
  env: Env,
  threadId: string,
  discordId: string,
) {
  try {
    await discordApiRequest(
      env,
      `/channels/${threadId}/thread-members/${discordId}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (!isDiscordNotFoundError(error)) {
      throw error;
    }
  }
}

export async function deleteDiscordManagedChannel(env: Env, channelId: string) {
  try {
    await discordApiRequest(env, `/channels/${channelId}`, {
      method: 'DELETE',
    });
  } catch (error) {
    if (!isDiscordNotFoundError(error)) {
      throw error;
    }
  }
}

export function isDiscordPrivateThread(channel: DiscordManagedChannel) {
  return channel.type === DISCORD_PRIVATE_THREAD_TYPE;
}

function selectManagedPrivateThread(
  threads: DiscordManagedChannel[] | undefined,
  spec: ManagedPrivateThreadSpec,
) {
  const matches = (threads ?? []).filter(
    (thread) => readManagedPrivateThreadRevision(thread.name, spec) !== null,
  );
  if (matches.length > 1) {
    throw new BadRequestError(
      'Multiple managed Discord private threads found.',
    );
  }
  return matches[0] ?? null;
}

async function findArchivedManagedPrivateThread(
  env: Env,
  spec: ManagedPrivateThreadSpec,
) {
  let before: string | undefined;

  while (true) {
    const query = before
      ? `?limit=100&before=${encodeURIComponent(before)}`
      : '?limit=100';
    const archived = await discordApiRequest<DiscordThreadCollection>(
      env,
      `/channels/${spec.parentChannelId}/threads/archived/private${query}`,
    );
    const archivedMatch = selectManagedPrivateThread(archived.threads, spec);
    if (archivedMatch) {
      assertManagedPrivateThread(env, archivedMatch, spec);
      return archivedMatch;
    }
    if (archived.has_more !== true) {
      return null;
    }

    const nextBefore =
      archived.threads?.at(-1)?.thread_metadata?.archive_timestamp;
    if (!nextBefore || nextBefore === before) {
      throw new BadRequestError(
        'Discord archived private thread pagination is invalid.',
      );
    }
    before = nextBefore;
  }
}

function readManagedPrivateThreadRevision(
  name: string | undefined,
  spec: ManagedPrivateThreadSpec,
) {
  if (!name) {
    return null;
  }

  for (const marker of [spec.marker, ...(spec.legacyMarkers ?? [])]) {
    if (spec.syncRevision === undefined) {
      if (name.endsWith(marker)) return 0;
      continue;
    }

    const markerPrefix = `${marker}-r`;
    const markerIndex = name.lastIndexOf(markerPrefix);
    if (markerIndex < 0) continue;
    const revisionText = name.slice(markerIndex + markerPrefix.length);
    const revision = Number(revisionText);
    if (Number.isInteger(revision) && revision >= 0) return revision;
  }
  return null;
}

function buildManagedPrivateThreadMarker(spec: ManagedPrivateThreadSpec) {
  return spec.syncRevision === undefined
    ? spec.marker
    : `${spec.marker}-r${spec.syncRevision}`;
}

function isDiscordNotFoundError(error: unknown) {
  return error instanceof DiscordApiError && error.status === 404;
}
