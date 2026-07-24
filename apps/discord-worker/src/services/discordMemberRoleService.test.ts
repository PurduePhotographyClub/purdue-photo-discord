import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';
import { dispatchInternalEvent } from '../internal-events/dispatcher';
import { parseInternalEvent } from '../internal-events/parser';
import type { Env } from '../discord/types';
import {
  removeDiscordManagedRoles,
  syncDiscordMemberRoles,
} from './discordMemberRoleService';

const DEFAULT_MEMBER_ROLE_ID = '1519105703736770600';
const DEFAULT_FACILITIES_ROLE_ID = '1519105558127575141';
const HISTORICAL_ROLE_ID = '1510000000000000001';
const LEGACY_PLACEHOLDER_ROLE_ID = '1512510317740036216';
const WEBSITE_VERIFIED_ROLE_ID = '1503180707550199920';
const DISCORD_ID = '123456789012345678';
const originalFetch = globalThis.fetch;

interface GuildRoleFixture {
  id: string;
  permissions: string;
  position?: number;
}

const roleConfiguration = {
  facilitiesRoleId: DEFAULT_FACILITIES_ROLE_ID,
  managedRoleIds: [
    DEFAULT_MEMBER_ROLE_ID,
    DEFAULT_FACILITIES_ROLE_ID,
    HISTORICAL_ROLE_ID,
  ],
  memberRoleId: DEFAULT_MEMBER_ROLE_ID,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('membership role defaults use the configured member and facilities roles', () => {
  assert.deepEqual(DISCORD_ROLE_IDS.membershipTiers.member, [
    DEFAULT_MEMBER_ROLE_ID,
  ]);
  assert.deepEqual(DISCORD_ROLE_IDS.membershipTiers.facilities, [
    DEFAULT_MEMBER_ROLE_ID,
    DEFAULT_FACILITIES_ROLE_ID,
  ]);
});

test('member-role events preserve a strict dashboard role configuration', () => {
  const sync = parseInternalEvent({
    discordId: DISCORD_ID,
    roleConfiguration,
    tier: 'facilities',
    type: 'website.discord.member_roles.sync',
  });
  const remove = parseInternalEvent({
    discordId: DISCORD_ID,
    roleConfiguration,
    type: 'website.discord.member_roles.remove',
  });

  assert.equal(sync.kind, 'memberRoles');
  assert.deepEqual(sync.event, {
    discordId: DISCORD_ID,
    membershipExpired: false,
    roleConfiguration,
    tier: 'facilities',
    type: 'website.discord.member_roles.sync',
  });
  assert.equal(remove.kind, 'memberRoles');
  assert.deepEqual(remove.event, {
    discordId: DISCORD_ID,
    roleConfiguration,
    type: 'website.discord.member_roles.remove',
  });
});

test('member-role events reject malformed, ambiguous, and incomplete role configurations', () => {
  const baseEvent = {
    discordId: DISCORD_ID,
    tier: 'member',
    type: 'website.discord.member_roles.sync',
  };
  const invalidRoleConfigurations = [
    {
      ...roleConfiguration,
      memberRoleId: 'not-a-snowflake',
    },
    {
      ...roleConfiguration,
      facilitiesRoleId: DEFAULT_MEMBER_ROLE_ID,
    },
    {
      ...roleConfiguration,
      managedRoleIds: [DEFAULT_MEMBER_ROLE_ID, 'invalid-role'],
    },
    {
      facilitiesRoleId: DEFAULT_FACILITIES_ROLE_ID,
      managedRoleIds: [DEFAULT_MEMBER_ROLE_ID, DEFAULT_FACILITIES_ROLE_ID],
    },
    {
      facilitiesRoleId: DEFAULT_FACILITIES_ROLE_ID,
      managedRoleIds: [DEFAULT_MEMBER_ROLE_ID],
      memberRoleId: DEFAULT_MEMBER_ROLE_ID,
    },
  ];

  for (const invalidRoleConfiguration of invalidRoleConfigurations) {
    assert.throws(
      () =>
        parseInternalEvent({
          ...baseEvent,
          roleConfiguration: invalidRoleConfiguration,
        }),
      /role|snowflake|Discord/i,
    );
  }
});

test('member-role sync and remove events reject a missing role configuration', () => {
  for (const type of [
    'website.discord.member_roles.sync',
    'website.discord.member_roles.remove',
  ] as const) {
    assert.throws(
      () =>
        parseInternalEvent({
          discordId: DISCORD_ID,
          type,
        }),
      /role configuration is required/i,
    );
  }
});

test('member-role services reject missing role configuration before Discord requests', async () => {
  globalThis.fetch = async () => {
    throw new Error('Discord should not be called for an invalid event.');
  };

  await assert.rejects(
    () =>
      syncDiscordMemberRoles(createEnv(), {
        discordId: DISCORD_ID,
        tier: 'member',
      } as never),
    /role configuration is required/i,
  );
  await assert.rejects(
    () =>
      removeDiscordManagedRoles(createEnv(), DISCORD_ID, undefined as never),
    /role configuration is required/i,
  );
});

test('facilities sync adds member plus facilities and cleans historical managed roles', async () => {
  const requests = installDiscordFetchMock([
    WEBSITE_VERIFIED_ROLE_ID,
    HISTORICAL_ROLE_ID,
  ]);

  const result = await syncDiscordMemberRoles(createEnv(), {
    discordId: DISCORD_ID,
    roleConfiguration,
    tier: 'facilities',
  });

  assert.deepEqual(result.addedRoleIds, [
    DEFAULT_MEMBER_ROLE_ID,
    DEFAULT_FACILITIES_ROLE_ID,
  ]);
  assert.deepEqual(result.removedRoleIds, [HISTORICAL_ROLE_ID]);
  assert.deepEqual(requests, [
    `GET /api/v10/guilds/guild-123/members/${DISCORD_ID}`,
    'GET /api/v10/guilds/guild-123/roles',
    `PUT /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${DEFAULT_MEMBER_ROLE_ID}`,
    `PUT /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${DEFAULT_FACILITIES_ROLE_ID}`,
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${HISTORICAL_ROLE_ID}`,
  ]);
});

test('member sync removes facilities and historical roles while keeping the member role', async () => {
  const requests = installDiscordFetchMock([
    WEBSITE_VERIFIED_ROLE_ID,
    DEFAULT_MEMBER_ROLE_ID,
    DEFAULT_FACILITIES_ROLE_ID,
    LEGACY_PLACEHOLDER_ROLE_ID,
    HISTORICAL_ROLE_ID,
  ]);

  const result = await syncDiscordMemberRoles(createEnv(), {
    discordId: DISCORD_ID,
    roleConfiguration,
    tier: 'member',
  });

  assert.deepEqual(result.addedRoleIds, []);
  assert.deepEqual(result.removedRoleIds, [
    LEGACY_PLACEHOLDER_ROLE_ID,
    DEFAULT_FACILITIES_ROLE_ID,
    HISTORICAL_ROLE_ID,
  ]);
  assert.deepEqual(requests, [
    `GET /api/v10/guilds/guild-123/members/${DISCORD_ID}`,
    'GET /api/v10/guilds/guild-123/roles',
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${LEGACY_PLACEHOLDER_ROLE_ID}`,
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${DEFAULT_FACILITIES_ROLE_ID}`,
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${HISTORICAL_ROLE_ID}`,
  ]);
});

test('remove events clear current, historical, and legacy managed roles', async () => {
  const requests = installDiscordFetchMock([
    WEBSITE_VERIFIED_ROLE_ID,
    DEFAULT_MEMBER_ROLE_ID,
    DEFAULT_FACILITIES_ROLE_ID,
    LEGACY_PLACEHOLDER_ROLE_ID,
    HISTORICAL_ROLE_ID,
  ]);
  const event = parseInternalEvent({
    discordId: DISCORD_ID,
    roleConfiguration,
    type: 'website.discord.member_roles.remove',
  });

  const result = await dispatchInternalEvent(event, createEnv());

  assert.deepEqual(result.removedRoleIds, [
    WEBSITE_VERIFIED_ROLE_ID,
    LEGACY_PLACEHOLDER_ROLE_ID,
    DEFAULT_MEMBER_ROLE_ID,
    DEFAULT_FACILITIES_ROLE_ID,
    HISTORICAL_ROLE_ID,
  ]);
  assert.deepEqual(requests, [
    `GET /api/v10/guilds/guild-123/members/${DISCORD_ID}`,
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${WEBSITE_VERIFIED_ROLE_ID}`,
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${LEGACY_PLACEHOLDER_ROLE_ID}`,
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${DEFAULT_MEMBER_ROLE_ID}`,
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${DEFAULT_FACILITIES_ROLE_ID}`,
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${HISTORICAL_ROLE_ID}`,
  ]);
});

test('receipt role sync rejects missing configured roles before any mutation', async () => {
  const requests = installDiscordFetchMock(
    [WEBSITE_VERIFIED_ROLE_ID],
    defaultGuildRoles().filter(({ id }) => id !== DEFAULT_FACILITIES_ROLE_ID),
  );

  await assert.rejects(
    () =>
      syncDiscordMemberRoles(createEnv(), {
        discordId: DISCORD_ID,
        roleConfiguration,
        tier: 'facilities',
      }),
    /configured Discord membership role does not exist/i,
  );

  assert.equal(
    requests.some((request) => /^(?:PUT|DELETE) /.test(request)),
    false,
  );
});

test('receipt role sync rejects known staff roles before any mutation', async () => {
  for (const protectedRoleId of [
    DISCORD_ROLE_IDS.admin,
    DISCORD_ROLE_IDS.executive,
  ]) {
    const protectedConfiguration = {
      ...roleConfiguration,
      managedRoleIds: [
        protectedRoleId,
        DEFAULT_FACILITIES_ROLE_ID,
        HISTORICAL_ROLE_ID,
      ],
      memberRoleId: protectedRoleId,
    };
    const requests = installDiscordFetchMock(
      [WEBSITE_VERIFIED_ROLE_ID],
      [
        ...defaultGuildRoles(),
        {
          id: protectedRoleId,
          permissions: '0',
        },
      ],
    );

    await assert.rejects(
      () =>
        syncDiscordMemberRoles(createEnv(), {
          discordId: DISCORD_ID,
          roleConfiguration: protectedConfiguration,
          tier: 'member',
        }),
      /protected Discord staff role/i,
    );

    assert.equal(
      requests.some((request) => /^(?:PUT|DELETE) /.test(request)),
      false,
    );
  }
});

test('receipt role sync rejects moderation and management permissions before any mutation', async () => {
  const dangerousPermissionBits = [
    1n << 1n, // Kick Members
    1n << 2n, // Ban Members
    1n << 3n, // Administrator
    1n << 4n, // Manage Channels
    1n << 5n, // Manage Guild
    1n << 13n, // Manage Messages
    1n << 27n, // Manage Nicknames
    1n << 28n, // Manage Roles
    1n << 29n, // Manage Webhooks
    1n << 33n, // Manage Events
    1n << 34n, // Manage Threads
    1n << 40n, // Moderate Members
  ];

  for (const permissions of dangerousPermissionBits) {
    const requests = installDiscordFetchMock(
      [WEBSITE_VERIFIED_ROLE_ID],
      defaultGuildRoles().map((role) =>
        role.id === DEFAULT_MEMBER_ROLE_ID
          ? { ...role, permissions: permissions.toString() }
          : role,
      ),
    );

    await assert.rejects(
      () =>
        syncDiscordMemberRoles(createEnv(), {
          discordId: DISCORD_ID,
          roleConfiguration,
          tier: 'member',
        }),
      /dangerous Discord permissions/i,
    );

    assert.equal(
      requests.some((request) => /^(?:PUT|DELETE) /.test(request)),
      false,
    );
  }
});

test('receipt role sync removes a dangerous historical managed role', async () => {
  const dangerousHistoricalRoleId = '1510000000000000002';
  const dangerousConfiguration = {
    ...roleConfiguration,
    managedRoleIds: [
      DEFAULT_MEMBER_ROLE_ID,
      DEFAULT_FACILITIES_ROLE_ID,
      dangerousHistoricalRoleId,
    ],
  };
  const requests = installDiscordFetchMock(
    [
      WEBSITE_VERIFIED_ROLE_ID,
      DEFAULT_MEMBER_ROLE_ID,
      dangerousHistoricalRoleId,
    ],
    [
      ...defaultGuildRoles(),
      {
        id: dangerousHistoricalRoleId,
        permissions: (1n << 28n).toString(),
      },
    ],
  );

  const result = await syncDiscordMemberRoles(createEnv(), {
    discordId: DISCORD_ID,
    roleConfiguration: dangerousConfiguration,
    tier: 'member',
  });

  assert.deepEqual(result.addedRoleIds, []);
  assert.deepEqual(result.removedRoleIds, [dangerousHistoricalRoleId]);
  assert.deepEqual(requests, [
    `GET /api/v10/guilds/guild-123/members/${DISCORD_ID}`,
    'GET /api/v10/guilds/guild-123/roles',
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${dangerousHistoricalRoleId}`,
  ]);
});

test('receipt role removal cleans dangerous roles without deleting protected staff roles', async () => {
  const dangerousHistoricalRoleId = '1510000000000000002';
  const cleanupConfiguration = {
    ...roleConfiguration,
    managedRoleIds: [
      DEFAULT_MEMBER_ROLE_ID,
      DEFAULT_FACILITIES_ROLE_ID,
      dangerousHistoricalRoleId,
      DISCORD_ROLE_IDS.admin,
      DISCORD_ROLE_IDS.executive,
    ],
  };
  const requests = installDiscordFetchMock([
    DEFAULT_MEMBER_ROLE_ID,
    dangerousHistoricalRoleId,
    DISCORD_ROLE_IDS.admin,
    DISCORD_ROLE_IDS.executive,
  ]);

  const result = await removeDiscordManagedRoles(
    createEnv(),
    DISCORD_ID,
    cleanupConfiguration,
  );

  assert.deepEqual(result.removedRoleIds, [
    DEFAULT_MEMBER_ROLE_ID,
    dangerousHistoricalRoleId,
  ]);
  assert.deepEqual(requests, [
    `GET /api/v10/guilds/guild-123/members/${DISCORD_ID}`,
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${DEFAULT_MEMBER_ROLE_ID}`,
    `DELETE /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${dangerousHistoricalRoleId}`,
  ]);
});

test('receipt role sync leaves unrelated privileged roles untouched', async () => {
  const requests = installDiscordFetchMock(
    [WEBSITE_VERIFIED_ROLE_ID, DISCORD_ROLE_IDS.admin],
    [
      ...defaultGuildRoles(),
      {
        id: DISCORD_ROLE_IDS.admin,
        permissions: (1n << 3n).toString(),
      },
    ],
  );

  const result = await syncDiscordMemberRoles(createEnv(), {
    discordId: DISCORD_ID,
    roleConfiguration,
    tier: 'member',
  });

  assert.deepEqual(result.addedRoleIds, [DEFAULT_MEMBER_ROLE_ID]);
  assert.deepEqual(result.removedRoleIds, []);
  assert.deepEqual(requests, [
    `GET /api/v10/guilds/guild-123/members/${DISCORD_ID}`,
    'GET /api/v10/guilds/guild-123/roles',
    `PUT /api/v10/guilds/guild-123/members/${DISCORD_ID}/roles/${DEFAULT_MEMBER_ROLE_ID}`,
  ]);
});

function installDiscordFetchMock(
  existingRoleIds: string[],
  guildRoles: GuildRoleFixture[] = defaultGuildRoles(),
) {
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url.pathname}`);

    if (method === 'GET' && url.pathname.endsWith('/roles')) {
      return Response.json(guildRoles);
    }
    if (method === 'GET') {
      return Response.json({
        roles: existingRoleIds,
        user: { id: DISCORD_ID },
      });
    }
    return new Response(null, { status: 204 });
  };
  return requests;
}

function defaultGuildRoles(): GuildRoleFixture[] {
  return [
    WEBSITE_VERIFIED_ROLE_ID,
    LEGACY_PLACEHOLDER_ROLE_ID,
    DEFAULT_MEMBER_ROLE_ID,
    DEFAULT_FACILITIES_ROLE_ID,
    HISTORICAL_ROLE_ID,
  ].map((id, position) => ({
    id,
    permissions: '0',
    position,
  }));
}

function createEnv(): Env {
  return {
    DISCORD_GUILD_ID: 'guild-123',
    DISCORD_TOKEN: 'test-discord-token',
  };
}
