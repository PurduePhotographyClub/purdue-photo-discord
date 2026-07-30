import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
} from 'discord-interactions';
import { reportCommand } from '../commands/general/report';
import { handleButtonInteraction } from '../components/buttons';
import {
  DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION,
  DISCORD_ROLE_IDS,
} from '../config/discord-role-ids';
import { getCommand } from '../../config/commands';
import type {
  ApplicationCommandInteraction,
  ComponentInteraction,
  Env,
  ModalSubmitInteraction,
} from '../discord/types';
import { dispatchInternalEvent } from '../internal-events/dispatcher';
import {
  parseInternalEvent,
  parseMemberReportProjection,
} from '../internal-events/parser';
import {
  deferDiscordInteraction,
  shouldDeferDiscordInteraction,
} from '../routes/discordInteractions';
import {
  MEMBER_REPORT_CHANNEL_ID,
  MEMBER_REPORT_CORRECT_CUSTOM_ID_PREFIX,
  MEMBER_REPORT_CORRECT_MODAL_CUSTOM_ID_PREFIX,
  MEMBER_REPORT_MODAL_CUSTOM_ID,
  handleMemberReportCorrectionModalSubmit,
  handleMemberReportModalSubmit,
  postMemberReportMessage,
} from './discordMemberReportService';

const originalFetch = globalThis.fetch;
const TEST_INTERACTION_TOKEN = ['interaction', 'token'].join('-');
const REPORT_ID = '213f0818-b135-4a1f-9708-46eb5220b979';
const RELATED_REPORT_ID = '5ea27a99-8492-4efe-9f62-561c31523298';
const MEMBER_ROLE_ID =
  DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION.memberRoleId;
const REPORT_OPEN_CUSTOM_ID = 'member_report:v1:open';
const ACTOR_DISCORD_ID = '123456789012345678';
const INTERACTION_ID = '823456789012345678';
const REPORTED_DISCORD_ID = '223456789012345678';
const REPORT_PANEL_CHANNEL_ID = '923456789012345678';
const STORED_MESSAGE_ID = '323456789012345678';
const RELATED_MESSAGE_ID = '423456789012345678';

interface TargetFixtureOptions {
  bot?: boolean;
  globalName?: null | string;
  includeMember?: boolean;
  includeUser?: boolean;
  memberRoles?: string[];
  nick?: null | string;
  selectedIds?: string[];
  username?: string;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('/report opens the anonymous report modal for PPC members', async () => {
  assert.equal(getCommand('REPORT'), reportCommand);
  const response = await reportCommand.execute(
    commandInteraction([MEMBER_ROLE_ID]),
    createEnv(),
  );

  assert.equal(response.type, InteractionResponseType.MODAL);
  assert.equal(response.data?.custom_id, MEMBER_REPORT_MODAL_CUSTOM_ID);
  assert.equal(response.data?.title, 'Report member behaviour');
  assert.deepEqual(response.data?.components, [
    {
      component: {
        custom_id: 'member_report_target',
        max_values: 1,
        min_values: 1,
        placeholder: 'Select the member',
        required: true,
        type: MessageComponentTypes.USER_SELECT,
      },
      description: 'Choose the PPC member you are reporting.',
      label: 'Member',
      type: 18,
    },
    {
      component: {
        custom_id: 'member_report_behavior',
        max_length: 2_000,
        min_length: 20,
        placeholder: 'Describe what happened and include useful context',
        required: true,
        style: 2,
        type: 4,
      },
      description: 'Your identity is not included with the report.',
      label: 'What happened?',
      type: 18,
    },
    {
      component: {
        custom_id: 'member_report_reason',
        max_length: 500,
        placeholder: 'Explain why you are reporting this',
        required: false,
        style: 2,
        type: 4,
      },
      description: 'Add anything that would help the Executive team review it.',
      label: 'Reason (optional)',
      type: 18,
    },
  ]);
  assert.equal(shouldDeferDiscordInteraction(commandInteraction()), false);
});

test('/report stays unavailable without the current PPC Member role', async () => {
  const response = await reportCommand.execute(
    commandInteraction(),
    createEnv(),
  );

  assert.equal(
    response.data?.content,
    'You need the PPC Member role before you can submit a report.',
  );
  assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
});

test('/post-report-message is registered, Executive-only, and listed in /admin', async () => {
  const command = getCommand('POST-REPORT-MESSAGE');
  assert.ok(command);
  assert.deepEqual(command.definition, {
    description: 'Post the anonymous member report panel.',
    name: 'post-report-message',
  });

  const rejected = await command.execute(
    commandInteraction([], 'post-report-message', REPORT_PANEL_CHANNEL_ID),
    createEnv(),
  );
  assert.equal(
    rejected.data?.content,
    'Only the Executive role can use this command.',
  );

  const admin = getCommand('admin');
  assert.ok(admin);
  const adminResponse = await admin.execute(
    commandInteraction([DISCORD_ROLE_IDS.executive], 'admin'),
    createEnv(),
  );
  assert.equal(
    JSON.stringify(adminResponse.data).includes('`/post-report-message`'),
    true,
  );
});

test('/post-report-message posts a mention-safe report panel in the current channel', async () => {
  const discordRequests: Array<{
    body: Record<string, unknown>;
    method: string;
    path: string;
  }> = [];
  globalThis.fetch = createDiscordFetch(discordRequests);
  const command = getCommand('post-report-message');
  assert.ok(command);

  const response = await command.execute(
    commandInteraction(
      [DISCORD_ROLE_IDS.executive],
      'post-report-message',
      REPORT_PANEL_CHANNEL_ID,
    ),
    createEnv(),
  );

  assert.equal(discordRequests.length, 1);
  assert.equal(
    discordRequests[0]!.path,
    `/api/v10/channels/${REPORT_PANEL_CHANNEL_ID}/messages`,
  );
  assert.deepEqual(discordRequests[0]!.body.allowed_mentions, { parse: [] });
  assert.deepEqual(discordRequests[0]!.body.embeds, [
    {
      color: 0xf2c94c,
      description:
        'Report a member’s behaviour anonymously to the Executive team. Use the button below to open the form.',
      footer: { text: 'Purdue Photography Club' },
      title: 'Report a concern',
    },
  ]);
  assert.deepEqual(discordRequests[0]!.body.components, [
    {
      components: [
        {
          custom_id: REPORT_OPEN_CUSTOM_ID,
          label: 'Open report form',
          style: 1,
          type: 2,
        },
      ],
      type: 1,
    },
  ]);
  assert.equal(
    response.data?.content,
    `Report message posted in <#${REPORT_PANEL_CHANNEL_ID}> as 523456789012345678.`,
  );
  assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
  assert.equal(
    shouldDeferDiscordInteraction(
      commandInteraction(
        [DISCORD_ROLE_IDS.executive],
        'post-report-message',
        REPORT_PANEL_CHANNEL_ID,
      ),
    ),
    true,
  );
});

test('/post-report-message rejects a missing or malformed current channel', async () => {
  const command = getCommand('post-report-message');
  assert.ok(command);

  for (const channelId of [undefined, 'not-a-channel']) {
    const discordRequests: Array<{
      body: Record<string, unknown>;
      method: string;
      path: string;
    }> = [];
    globalThis.fetch = createDiscordFetch(discordRequests);
    const response = await command.execute(
      commandInteraction(
        [DISCORD_ROLE_IDS.executive],
        'post-report-message',
        channelId,
      ),
      createEnv(),
    );

    assert.equal(discordRequests.length, 0);
    assert.equal(
      response.data?.content,
      'Could not post report message: A valid Discord channel is required.',
    );
  }
});

test('the public report button rechecks membership and opens the same modal as /report', async () => {
  const expectedModal = await reportCommand.execute(
    commandInteraction([MEMBER_ROLE_ID]),
    createEnv(),
  );
  const accepted = await handleButtonInteraction(
    componentInteraction(REPORT_OPEN_CUSTOM_ID, [MEMBER_ROLE_ID]),
    createEnv(),
  );
  assert.deepEqual(accepted, expectedModal);
  assert.equal(accepted.type, InteractionResponseType.MODAL);

  const rejected = await handleButtonInteraction(
    componentInteraction(REPORT_OPEN_CUSTOM_ID),
    createEnv(),
  );
  assert.equal(
    rejected.data?.content,
    'You need the PPC Member role before you can submit a report.',
  );
  assert.equal(rejected.data?.flags, InteractionResponseFlags.EPHEMERAL);
  assert.equal(
    shouldDeferDiscordInteraction(
      componentInteraction(REPORT_OPEN_CUSTOM_ID, [MEMBER_ROLE_ID]),
    ),
    false,
  );
});

test('/clear-reports is registered with the required confirmation option and listed in /admin', async () => {
  const command = getCommand('CLEAR-REPORTS');
  assert.ok(command);
  assert.deepEqual(command.definition, {
    description: 'Permanently clear all member reports.',
    name: 'clear-reports',
    options: [
      {
        description: 'Type CLEAR REPORTS to confirm permanent deletion.',
        name: 'confirm',
        required: true,
        type: 3,
      },
    ],
  });

  const admin = getCommand('admin');
  assert.ok(admin);
  const adminResponse = await admin.execute(
    commandInteraction([DISCORD_ROLE_IDS.executive], 'admin'),
    createEnv(),
  );
  assert.equal(
    JSON.stringify(adminResponse.data).includes('`/clear-reports`'),
    true,
  );
});

test('/clear-reports requires the Executive role before calling the API', async () => {
  const apiRequests: Request[] = [];
  const command = getCommand('clear-reports');
  assert.ok(command);

  const response = await command.execute(
    clearReportsInteraction([], 'CLEAR REPORTS'),
    createApiEnv(apiRequests, () => Response.json({ ok: true })),
  );

  assert.equal(apiRequests.length, 0);
  assert.equal(
    response.data?.content,
    'Only the Executive role can use this command.',
  );
  assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
});

test('/clear-reports requires the exact trimmed confirmation and a valid actor', async () => {
  const command = getCommand('clear-reports');
  assert.ok(command);

  for (const confirmation of [
    undefined,
    'clear reports',
    'CLEAR REPORTS!',
    'CLEAR  REPORTS',
  ]) {
    const apiRequests: Request[] = [];
    const response = await command.execute(
      clearReportsInteraction([DISCORD_ROLE_IDS.executive], confirmation),
      createApiEnv(apiRequests, () => Response.json({ ok: true })),
    );

    assert.equal(apiRequests.length, 0);
    assert.equal(
      response.data?.content,
      'Type CLEAR REPORTS exactly to confirm permanent deletion.',
    );
  }

  for (const actorId of [null, 'not-a-discord-id']) {
    const apiRequests: Request[] = [];
    const response = await command.execute(
      clearReportsInteraction(
        [DISCORD_ROLE_IDS.executive],
        'CLEAR REPORTS',
        actorId,
      ),
      createApiEnv(apiRequests, () => Response.json({ ok: true })),
    );

    assert.equal(apiRequests.length, 0);
    assert.equal(
      response.data?.content,
      'I could not identify your Discord account.',
    );
  }
});

test('/clear-reports deletes through the internal API and reports every count', async () => {
  const apiRequests: Request[] = [];
  const command = getCommand('clear-reports');
  assert.ok(command);

  const response = await command.execute(
    clearReportsInteraction([DISCORD_ROLE_IDS.executive], '  CLEAR REPORTS  '),
    createApiEnv(apiRequests, () =>
      Response.json({
        deleted: {
          aliases: 3,
          audits: 1,
          reports: 1,
          subjects: 2,
        },
        ok: true,
      }),
    ),
  );

  assert.equal(apiRequests.length, 1);
  assert.equal(apiRequests[0]!.method, 'DELETE');
  assert.equal(
    new URL(apiRequests[0]!.url).pathname,
    '/api/v1/admin/member-reports/clear-by-discord',
  );
  assert.deepEqual(await apiRequests[0]!.clone().json(), {
    confirmation: 'CLEAR REPORTS',
    discordId: ACTOR_DISCORD_ID,
  });
  assert.equal(
    response.data?.content,
    'Cleared 1 report, 2 subjects, 3 aliases, and 1 audit record.',
  );
  assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
  assert.equal(
    shouldDeferDiscordInteraction(
      clearReportsInteraction([DISCORD_ROLE_IDS.executive], 'CLEAR REPORTS'),
    ),
    true,
  );
});

test('/clear-reports fails safely for API errors and malformed count responses', async () => {
  const command = getCommand('clear-reports');
  assert.ok(command);

  for (const respond of [
    () => Response.json({ ok: false }, { status: 500 }),
    () =>
      Response.json({
        deleted: {
          aliases: 0,
          audits: 0,
          reports: -1,
          subjects: 0,
        },
        ok: true,
      }),
  ]) {
    const apiRequests: Request[] = [];
    const response = await command.execute(
      clearReportsInteraction([DISCORD_ROLE_IDS.executive], 'CLEAR REPORTS'),
      createApiEnv(apiRequests, respond),
    );

    assert.equal(apiRequests.length, 1);
    assert.equal(
      response.data?.content,
      'I could not clear the member reports. Try again later.',
    );
    assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
  }
});

test('report submission remains anonymous while refreshing all matched messages', async () => {
  const apiRequests: Request[] = [];
  const discordRequests: Array<{
    body: Record<string, unknown>;
    method: string;
    path: string;
  }> = [];
  globalThis.fetch = createDiscordFetch(discordRequests);
  const created = projection({
    messageId: null,
    relatedReportCount: 2,
  });
  const related = projection({
    messageId: STORED_MESSAGE_ID,
    relatedReportCount: 2,
    reportId: RELATED_REPORT_ID,
    submittedName: 'Alex S.',
  });
  const response = await handleMemberReportModalSubmit(
    reportModalInteraction([MEMBER_ROLE_ID]),
    createApiEnv(apiRequests, (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api/v1/member-reports/by-discord') {
        return Response.json({
          ok: true,
          report: created,
          reports: [created, related],
        });
      }
      return Response.json({ ok: true });
    }),
  );

  assert.equal(apiRequests.length, 2);
  assert.equal(
    new URL(apiRequests[0]!.url).pathname,
    '/api/v1/member-reports/by-discord',
  );
  assert.deepEqual(await apiRequests[0]!.clone().json(), {
    behavior:
      'They repeatedly insulted another member during the club meeting.',
    discordId: ACTOR_DISCORD_ID,
    interactionId: INTERACTION_ID,
    reason: 'This has happened at several club meetings.',
    reportedDiscordId: REPORTED_DISCORD_ID,
    reportedName: 'Alex Club Nickname',
  });
  assert.equal(
    new URL(apiRequests[1]!.url).pathname,
    `/api/v1/member-reports/${REPORT_ID}/sync-result-by-discord`,
  );
  assert.deepEqual(await apiRequests[1]!.clone().json(), {
    channelId: MEMBER_REPORT_CHANNEL_ID,
    messageId: '523456789012345678',
  });

  assert.deepEqual(
    discordRequests.map(({ method, path }) => ({ method, path })),
    [
      {
        method: 'POST',
        path: `/api/v10/channels/${MEMBER_REPORT_CHANNEL_ID}/messages`,
      },
      {
        method: 'PATCH',
        path: `/api/v10/channels/${MEMBER_REPORT_CHANNEL_ID}/messages/${STORED_MESSAGE_ID}`,
      },
    ],
  );
  for (const request of discordRequests) {
    assert.equal(
      JSON.stringify(request.body).includes(ACTOR_DISCORD_ID),
      false,
    );
    assert.equal(
      JSON.stringify(request.body).includes(REPORTED_DISCORD_ID),
      false,
    );
    assert.equal(JSON.stringify(request.body).includes('Anonymous'), true);
  }
  assert.equal(
    response.data?.content,
    'Your report was submitted anonymously. The Executive team can review it now.',
  );
});

test('report submission sends an omitted optional reason as null', async () => {
  const apiRequests: Request[] = [];
  globalThis.fetch = createDiscordFetch([]);
  const report = projection({ messageId: null, reason: null });

  await handleMemberReportModalSubmit(
    reportModalInteraction([MEMBER_ROLE_ID], null),
    createApiEnv(apiRequests, (request) => {
      const pathname = new URL(request.url).pathname;
      return pathname === '/api/v1/member-reports/by-discord'
        ? Response.json({ ok: true, report, reports: [report] })
        : Response.json({ ok: true });
    }),
  );

  assert.deepEqual(await apiRequests[0]!.clone().json(), {
    behavior:
      'They repeatedly insulted another member during the club meeting.',
    discordId: ACTOR_DISCORD_ID,
    interactionId: INTERACTION_ID,
    reason: null,
    reportedDiscordId: REPORTED_DISCORD_ID,
    reportedName: 'Alex Club Nickname',
  });
});

test('report submission resolves the selected member name without fuzzy matching', async () => {
  const apiRequests: Request[] = [];
  globalThis.fetch = createDiscordFetch([]);
  const report = projection({ messageId: null });

  for (const target of [
    {
      globalName: 'Alex Global Name',
      nick: null,
      username: 'alex.username',
    },
    {
      globalName: null,
      nick: null,
      username: 'alex.username',
    },
  ]) {
    await handleMemberReportModalSubmit(
      reportModalInteraction([MEMBER_ROLE_ID], null, target),
      createApiEnv(apiRequests, (request) => {
        const pathname = new URL(request.url).pathname;
        return pathname === '/api/v1/member-reports/by-discord'
          ? Response.json({ ok: true, report, reports: [report] })
          : Response.json({ ok: true });
      }),
    );
  }

  assert.equal(apiRequests.length, 4);
  assert.deepEqual(
    await Promise.all(
      [apiRequests[0]!, apiRequests[2]!].map(async (request) => {
        const body = (await request.clone().json()) as Record<string, unknown>;
        return {
          reportedDiscordId: body.reportedDiscordId,
          reportedName: body.reportedName,
        };
      }),
    ),
    [
      {
        reportedDiscordId: REPORTED_DISCORD_ID,
        reportedName: 'Alex Global Name',
      },
      {
        reportedDiscordId: REPORTED_DISCORD_ID,
        reportedName: 'alex.username',
      },
    ],
  );
});

test('report submission rejects unresolved, bot, and non-member targets', async () => {
  for (const target of [
    { includeMember: false },
    { includeUser: false },
    { bot: true },
    { memberRoles: [] },
  ]) {
    const apiRequests: Request[] = [];
    const response = await handleMemberReportModalSubmit(
      reportModalInteraction([MEMBER_ROLE_ID], null, target),
      createApiEnv(apiRequests, () => Response.json({ ok: true })),
    );

    assert.equal(apiRequests.length, 0);
    assert.equal(
      response.data?.content,
      target.memberRoles
        ? 'Select a PPC member for this report.'
        : 'I could not verify that Discord member. Select them again.',
    );
  }
});

test('report submission requires exactly one valid Discord member ID', async () => {
  for (const selectedIds of [
    [],
    [REPORTED_DISCORD_ID, '323456789012345679'],
    ['not-a-discord-id'],
  ]) {
    const apiRequests: Request[] = [];
    const response = await handleMemberReportModalSubmit(
      reportModalInteraction([MEMBER_ROLE_ID], null, { selectedIds }),
      createApiEnv(apiRequests, () => Response.json({ ok: true })),
    );

    assert.equal(apiRequests.length, 0);
    assert.equal(
      response.data?.content,
      'Select one Discord member for this report.',
    );
  }
});

test('report submission rejects a reason longer than 500 Unicode characters', async () => {
  const apiRequests: Request[] = [];
  const response = await handleMemberReportModalSubmit(
    reportModalInteraction([MEMBER_ROLE_ID], '🙂'.repeat(501)),
    createApiEnv(apiRequests, () => Response.json({ ok: true })),
  );

  assert.equal(apiRequests.length, 0);
  assert.equal(
    response.data?.content,
    'Keep the optional reason to 500 characters or fewer.',
  );
});

test('report submission checks the member role again before calling the API', async () => {
  const apiRequests: Request[] = [];
  const response = await handleMemberReportModalSubmit(
    reportModalInteraction(),
    createApiEnv(apiRequests, () => Response.json({ ok: true })),
  );

  assert.equal(apiRequests.length, 0);
  assert.equal(
    response.data?.content,
    'You need the PPC Member role before you can submit a report.',
  );
});

test('report submission requires the signed Discord interaction ID', async () => {
  const apiRequests: Request[] = [];
  const interaction = reportModalInteraction([MEMBER_ROLE_ID]);
  delete interaction.id;
  const response = await handleMemberReportModalSubmit(
    interaction,
    createApiEnv(apiRequests, () => Response.json({ ok: true })),
  );

  assert.equal(apiRequests.length, 0);
  assert.equal(
    response.data?.content,
    'I could not verify this report submission. Open /report and try again.',
  );
});

test('report submission fails safely when the API omits related projections', async () => {
  const apiRequests: Request[] = [];
  const discordRequests: Array<{
    body: Record<string, unknown>;
    method: string;
    path: string;
  }> = [];
  globalThis.fetch = createDiscordFetch(discordRequests);
  const response = await handleMemberReportModalSubmit(
    reportModalInteraction([MEMBER_ROLE_ID]),
    createApiEnv(apiRequests, () =>
      Response.json({ ok: true, report: projection() }),
    ),
  );

  assert.equal(apiRequests.length, 1);
  assert.equal(discordRequests.length, 0);
  assert.equal(
    response.data?.content,
    'I could not submit your report. Please try again, or use the website report form.',
  );
});

test('report embeds use gold, orange, and red as matching report counts rise', async () => {
  const colors: number[] = [];
  const counts = [1, 2, 3, 8];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      embeds: Array<{ color: number }>;
    };
    colors.push(body.embeds[0]!.color);
    return Response.json({ id: '523456789012345678' });
  };

  for (const relatedReportCount of counts) {
    await postMemberReportMessage(
      createEnv(),
      projection({ relatedReportCount }),
    );
  }

  assert.deepEqual(colors, [0xf2c94c, 0xf97316, 0xef4444, 0xef4444]);
});

test('report embeds show a non-inline reason only when one is provided', async () => {
  const embedFields: Array<
    Array<{ inline?: boolean; name: string; value: string }>
  > = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      embeds: Array<{
        fields: Array<{ inline?: boolean; name: string; value: string }>;
      }>;
    };
    embedFields.push(body.embeds[0]!.fields);
    return Response.json({ id: '523456789012345678' });
  };

  await postMemberReportMessage(
    createEnv(),
    projection({ reason: '  The same conduct has happened before.  ' }),
  );
  await postMemberReportMessage(createEnv(), projection({ reason: null }));

  assert.deepEqual(
    embedFields[0]!.filter(({ name }) => name === 'Reason'),
    [
      {
        inline: false,
        name: 'Reason',
        value: 'The same conduct has happened before.',
      },
    ],
  );
  assert.deepEqual(
    embedFields[1]!.filter(({ name }) => name === 'Reason'),
    [],
  );
});

test('the internal report event has a dedicated parser and persists new messages', async () => {
  const apiRequests: Request[] = [];
  const discordRequests: Array<{
    body: Record<string, unknown>;
    method: string;
    path: string;
  }> = [];
  globalThis.fetch = createDiscordFetch(discordRequests);
  const event = parseInternalEvent(projection());

  assert.equal(event.kind, 'memberReport');
  const result = await dispatchInternalEvent(
    event,
    createApiEnv(apiRequests, () => Response.json({ ok: true })),
  );

  assert.deepEqual(result, {
    channelId: MEMBER_REPORT_CHANNEL_ID,
    messageId: '523456789012345678',
    ok: true,
    type: 'website.member_report.sync',
  });
  assert.equal(discordRequests.length, 1);
  assert.equal(apiRequests.length, 1);
  assert.equal(
    new URL(apiRequests[0]!.url).pathname,
    `/api/v1/member-reports/${REPORT_ID}/sync-result-by-discord`,
  );
});

test('a missing stored report message is replaced and the new ID is persisted', async () => {
  const apiRequests: Request[] = [];
  const discordRequests: Array<{
    body: Record<string, unknown>;
    method: string;
    path: string;
  }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    discordRequests.push({
      body: JSON.parse(String(init?.body)),
      method: init?.method ?? 'GET',
      path: url.pathname,
    });
    if (init?.method === 'PATCH') {
      return Response.json({ message: 'Unknown Message' }, { status: 404 });
    }
    return Response.json({ id: '523456789012345678' });
  };

  const result = await dispatchInternalEvent(
    parseInternalEvent(projection({ messageId: STORED_MESSAGE_ID })),
    createApiEnv(apiRequests, () => Response.json({ ok: true })),
  );

  assert.equal(result.messageId, '523456789012345678');
  assert.deepEqual(
    discordRequests.map(({ method, path }) => ({ method, path })),
    [
      {
        method: 'PATCH',
        path: `/api/v10/channels/${MEMBER_REPORT_CHANNEL_ID}/messages/${STORED_MESSAGE_ID}`,
      },
      {
        method: 'POST',
        path: `/api/v10/channels/${MEMBER_REPORT_CHANNEL_ID}/messages`,
      },
    ],
  );
  assert.equal(apiRequests.length, 1);
  assert.deepEqual(await apiRequests[0]!.clone().json(), {
    channelId: MEMBER_REPORT_CHANNEL_ID,
    messageId: '523456789012345678',
  });
});

test('new report messages reconcile a duplicate nonce across sync-result retries', async () => {
  const apiRequests: Request[] = [];
  const discordRequests: Array<{
    body: Record<string, unknown>;
    method: string;
    path: string;
  }> = [];
  let postAttempts = 0;
  let reportNonce = '';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    discordRequests.push({ body, method, path: url.pathname });

    if (method === 'POST') {
      postAttempts += 1;
      reportNonce = String(body.nonce);
      return postAttempts === 1
        ? Response.json({ id: '523456789012345678' })
        : Response.json(
            { code: 50_009, message: 'Nonce was already used.' },
            { status: 400 },
          );
    }

    if (
      method === 'GET' &&
      url.pathname === `/api/v10/channels/${MEMBER_REPORT_CHANNEL_ID}/messages`
    ) {
      assert.equal(url.searchParams.get('limit'), '100');
      return Response.json([
        {
          author: { bot: true, id: '623456789012345678' },
          id: '523456789012345678',
          nonce: reportNonce,
        },
      ]);
    }

    throw new Error(`Unexpected Discord request: ${method} ${url.pathname}`);
  };
  let syncAttempts = 0;
  const env = createApiEnv(apiRequests, () => {
    syncAttempts += 1;
    return syncAttempts === 1
      ? Response.json({ ok: false }, { status: 503 })
      : Response.json({ ok: true });
  });
  const report = projection();

  await assert.rejects(() =>
    dispatchInternalEvent(parseInternalEvent(report), env),
  );
  await dispatchInternalEvent(parseInternalEvent(report), env);

  assert.equal(discordRequests.length, 3);
  const firstBody = discordRequests[0]!.body;
  const secondBody = discordRequests[1]!.body;
  assert.equal(typeof firstBody.nonce, 'string');
  assert.equal(String(firstBody.nonce).length <= 25, true);
  assert.equal(firstBody.nonce, secondBody.nonce);
  assert.equal(firstBody.enforce_nonce, true);
  assert.equal(secondBody.enforce_nonce, true);
  assert.deepEqual(
    discordRequests.map(({ method, path }) => ({ method, path })),
    [
      {
        method: 'POST',
        path: `/api/v10/channels/${MEMBER_REPORT_CHANNEL_ID}/messages`,
      },
      {
        method: 'POST',
        path: `/api/v10/channels/${MEMBER_REPORT_CHANNEL_ID}/messages`,
      },
      {
        method: 'GET',
        path: `/api/v10/channels/${MEMBER_REPORT_CHANNEL_ID}/messages`,
      },
    ],
  );
  assert.equal(apiRequests.length, 2);
});

test('invalid report sync events are rejected before dispatch', () => {
  assert.throws(
    () =>
      parseInternalEvent(
        projection({
          relatedReportCount: 0,
        }),
      ),
    /relatedReportCount must be at least 1/,
  );
  assert.throws(
    () =>
      parseInternalEvent(
        projection({
          matchMethod: 'guess' as 'manual',
        }),
      ),
    /matchMethod is invalid/,
  );
  const missingReason = projection();
  delete (missingReason as { reason?: string | null }).reason;
  assert.equal(parseMemberReportProjection(missingReason).reason, null);
  assert.throws(
    () =>
      parseInternalEvent({
        ...projection(),
        reason: 42,
      }),
    /reason must be a string/,
  );
  assert.throws(
    () =>
      parseInternalEvent(
        projection({
          reason: '🙂'.repeat(501),
        }),
      ),
    /reason cannot exceed 500 characters/,
  );
  assert.equal(
    parseMemberReportProjection(projection({ reason: '  Useful context.  ' }))
      .reason,
    'Useful context.',
  );
  assert.equal(
    parseMemberReportProjection(projection({ reason: '🙂'.repeat(500) }))
      .reason,
    '🙂'.repeat(500),
  );
});

test('only Executive members can open match correction', async () => {
  const customId = `${MEMBER_REPORT_CORRECT_CUSTOM_ID_PREFIX}${REPORT_ID}`;
  for (const roles of [[], [DISCORD_ROLE_IDS.admin]]) {
    const rejected = await handleButtonInteraction(
      componentInteraction(customId, roles),
      createEnv(),
    );
    assert.equal(
      rejected.data?.content,
      'Only the Executive role can correct report matches.',
    );
  }

  const accepted = await handleButtonInteraction(
    componentInteraction(customId, [DISCORD_ROLE_IDS.executive]),
    createEnv(),
  );
  assert.equal(accepted.type, InteractionResponseType.MODAL);
  assert.equal(
    accepted.data?.custom_id,
    `${MEMBER_REPORT_CORRECT_MODAL_CUSTOM_ID_PREFIX}${REPORT_ID}`,
  );
  assert.deepEqual(accepted.data?.components, [
    {
      component: {
        custom_id: 'member_report_correct_user',
        max_values: 1,
        min_values: 1,
        placeholder: 'Select the correct member',
        required: true,
        type: MessageComponentTypes.USER_SELECT,
      },
      description: 'All reports matched to this member will be recounted.',
      label: 'Correct member',
      type: 18,
    },
  ]);
  assert.equal(
    shouldDeferDiscordInteraction(
      componentInteraction(customId, [DISCORD_ROLE_IDS.executive]),
    ),
    false,
  );
});

test('manual correction updates every returned report message with a stored ID', async () => {
  const apiRequests: Request[] = [];
  const discordRequests: Array<{
    body: Record<string, unknown>;
    method: string;
    path: string;
  }> = [];
  globalThis.fetch = createDiscordFetch(discordRequests);
  const correctedReports = [
    projection({
      matchMethod: 'manual',
      messageId: STORED_MESSAGE_ID,
      relatedReportCount: 2,
    }),
    projection({
      matchMethod: 'manual',
      messageId: RELATED_MESSAGE_ID,
      relatedReportCount: 2,
      reportId: RELATED_REPORT_ID,
    }),
  ];
  const interaction = correctionModalInteraction([DISCORD_ROLE_IDS.executive]);
  const response = await handleMemberReportCorrectionModalSubmit(
    interaction,
    createApiEnv(apiRequests, () =>
      Response.json({ ok: true, reports: correctedReports }),
    ),
  );

  assert.equal(apiRequests.length, 1);
  assert.equal(
    new URL(apiRequests[0]!.url).pathname,
    `/api/v1/admin/member-reports/${REPORT_ID}/match-by-discord`,
  );
  assert.deepEqual(await apiRequests[0]!.clone().json(), {
    discordId: ACTOR_DISCORD_ID,
    reportedDiscordId: REPORTED_DISCORD_ID,
    reportedName: 'Alex Club Nickname',
  });
  assert.deepEqual(
    discordRequests.map(({ method, path }) => ({ method, path })),
    [
      {
        method: 'PATCH',
        path: `/api/v10/channels/${MEMBER_REPORT_CHANNEL_ID}/messages/${STORED_MESSAGE_ID}`,
      },
      {
        method: 'PATCH',
        path: `/api/v10/channels/${MEMBER_REPORT_CHANNEL_ID}/messages/${RELATED_MESSAGE_ID}`,
      },
    ],
  );
  assert.equal(
    response.data?.content,
    'Member match corrected. Updated 2 report messages.',
  );
});

test('manual correction rechecks the Executive role', async () => {
  for (const roles of [[], [DISCORD_ROLE_IDS.admin]]) {
    const apiRequests: Request[] = [];
    const response = await handleMemberReportCorrectionModalSubmit(
      correctionModalInteraction(roles),
      createApiEnv(apiRequests, () => Response.json({ ok: true, reports: [] })),
    );

    assert.equal(apiRequests.length, 0);
    assert.equal(
      response.data?.content,
      'Only the Executive role can correct report matches.',
    );
  }
});

test('report and correction modal submissions defer without deferring their openers', async () => {
  for (const interaction of [
    reportModalInteraction([MEMBER_ROLE_ID]),
    correctionModalInteraction([DISCORD_ROLE_IDS.executive]),
  ]) {
    let backgroundWork: Promise<unknown> | undefined;
    globalThis.fetch = async () => Response.json({});
    const executionContext = {
      waitUntil(promise: Promise<unknown>) {
        backgroundWork = promise;
      },
    } as ExecutionContext;

    assert.equal(shouldDeferDiscordInteraction(interaction), true);
    const response = deferDiscordInteraction(
      interaction,
      createApiEnv([], () => Response.json({ ok: false })),
      executionContext,
    );
    assert.equal(
      response.type,
      InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
    assert.ok(backgroundWork);
    await backgroundWork;
  }
});

function projection(
  overrides: Partial<{
    behavior: string;
    matchMethod: 'exact' | 'manual' | 'similar' | 'unmatched';
    messageId: null | string;
    reason: null | string;
    relatedReportCount: number;
    reportId: string;
    reportedName: string;
    submittedAt: string;
    submittedName: string;
  }> = {},
) {
  return {
    behavior:
      overrides.behavior ??
      'They repeatedly insulted another member during the club meeting.',
    matchMethod: overrides.matchMethod ?? 'similar',
    messageId: overrides.messageId === undefined ? null : overrides.messageId,
    reason:
      overrides.reason === undefined
        ? 'This has happened at several club meetings.'
        : overrides.reason,
    relatedReportCount: overrides.relatedReportCount ?? 1,
    reportId: overrides.reportId ?? REPORT_ID,
    reportedName: overrides.reportedName ?? 'Alex Smith',
    submittedAt: overrides.submittedAt ?? '2026-07-30T12:00:00.000Z',
    submittedName: overrides.submittedName ?? 'Alex Smith',
    type: 'website.member_report.sync' as const,
  };
}

function commandInteraction(
  roles: string[] = [],
  name = 'report',
  channelId?: string,
) {
  return {
    channel_id: channelId,
    data: { name },
    member: { roles, user: { id: ACTOR_DISCORD_ID } },
    type: InteractionType.APPLICATION_COMMAND,
  } as ApplicationCommandInteraction;
}

function clearReportsInteraction(
  roles: string[],
  confirmation: string | undefined,
  actorId: null | string | undefined = ACTOR_DISCORD_ID,
) {
  return {
    data: {
      name: 'clear-reports',
      options:
        confirmation === undefined
          ? []
          : [{ name: 'confirm', type: 3, value: confirmation }],
    },
    member: { roles, user: { id: actorId ?? undefined } },
    type: InteractionType.APPLICATION_COMMAND,
  } as ApplicationCommandInteraction;
}

function componentInteraction(customId: string, roles: string[] = []) {
  return {
    data: {
      component_type: MessageComponentTypes.BUTTON,
      custom_id: customId,
    },
    member: { roles, user: { id: ACTOR_DISCORD_ID } },
    type: InteractionType.MESSAGE_COMPONENT,
  } as ComponentInteraction;
}

function reportModalInteraction(
  roles: string[] = [],
  reason: string | null = '  This has happened at several club meetings.  ',
  target: TargetFixtureOptions = {},
) {
  const reasonComponents =
    reason === null
      ? []
      : [
          {
            component: {
              custom_id: 'member_report_reason',
              value: reason,
            },
          },
        ];
  return {
    application_id: '623456789012345678',
    data: {
      components: [
        {
          component: {
            custom_id: 'member_report_target',
            values: target.selectedIds ?? [REPORTED_DISCORD_ID],
          },
        },
        {
          component: {
            custom_id: 'member_report_behavior',
            value:
              'They repeatedly insulted another member during the club meeting.',
          },
        },
        ...reasonComponents,
      ],
      custom_id: MEMBER_REPORT_MODAL_CUSTOM_ID,
      resolved: resolvedTarget(target),
    },
    id: INTERACTION_ID,
    member: { roles, user: { id: ACTOR_DISCORD_ID } },
    token: TEST_INTERACTION_TOKEN,
    type: InteractionType.MODAL_SUBMIT,
  } as ModalSubmitInteraction;
}

function correctionModalInteraction(roles: string[] = []) {
  return {
    application_id: '623456789012345678',
    data: {
      components: [
        {
          component: {
            custom_id: 'member_report_correct_user',
            values: [REPORTED_DISCORD_ID],
          },
        },
      ],
      custom_id: `${MEMBER_REPORT_CORRECT_MODAL_CUSTOM_ID_PREFIX}${REPORT_ID}`,
      resolved: resolvedTarget(),
    },
    member: { roles, user: { id: ACTOR_DISCORD_ID } },
    token: TEST_INTERACTION_TOKEN,
    type: InteractionType.MODAL_SUBMIT,
  } as ModalSubmitInteraction;
}

function resolvedTarget(target: TargetFixtureOptions = {}) {
  return {
    members:
      target.includeMember === false
        ? {}
        : {
            [REPORTED_DISCORD_ID]: {
              nick:
                target.nick === undefined ? 'Alex Club Nickname' : target.nick,
              roles: target.memberRoles ?? [MEMBER_ROLE_ID],
            },
          },
    users:
      target.includeUser === false
        ? {}
        : {
            [REPORTED_DISCORD_ID]: {
              bot: target.bot ?? false,
              global_name:
                target.globalName === undefined
                  ? 'Alex Global Name'
                  : target.globalName,
              id: REPORTED_DISCORD_ID,
              username: target.username ?? 'alex.username',
            },
          },
  };
}

function createEnv(): Env {
  return {
    DISCORD_APPLICATION_ID: '623456789012345678',
    DISCORD_GUILD_ID: '723456789012345678',
    DISCORD_TOKEN: 'test-token',
  };
}

function createApiEnv(
  requests: Request[],
  respond: (request: Request) => Response | Promise<Response>,
): Env {
  return {
    ...createEnv(),
    API_WORKER: {
      connect: () => {
        throw new Error('Socket connections are not used by this test.');
      },
      fetch: async (input) => {
        const request =
          input instanceof Request ? input : new Request(String(input));
        requests.push(request);
        return respond(request);
      },
    },
    INTERNAL_TOKEN: 'test-internal-token',
  };
}

function createDiscordFetch(
  requests: Array<{
    body: Record<string, unknown>;
    method: string;
    path: string;
  }>,
) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      body: JSON.parse(String(init?.body)),
      method: init?.method ?? 'GET',
      path: url.pathname,
    });
    return Response.json({ id: '523456789012345678' });
  };
}
