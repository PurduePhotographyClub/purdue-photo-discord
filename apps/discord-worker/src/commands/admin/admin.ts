/**
 * Executive command index shown inside Discord.
 *
 * This is intentionally hand-written instead of reflecting the whole registry
 * because not every command is admin-only, and command copy should stay friendly.
 */
import type {
  DiscordCommand,
  DiscordMessagePayload,
} from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { getExecutiveRoleError } from './permissions';

export const adminCommand: DiscordCommand = {
  definition: {
    description: 'Show executive commands.',
    name: 'admin',
  },
  execute: (interaction, env) => {
    // /admin is itself protected, so non-executives cannot use it to discover
    // the executive command surface.
    const permissionError = getExecutiveRoleError(interaction, env);

    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    return ephemeralResponse(createAdminCommandList());
  },
};

function createAdminCommandList(): DiscordMessagePayload {
  const commands = [
    {
      name: '→ Gateway Control',
      value: [
        '`/status`',
        '> `activity:` `<text>` `none`',
        '> `activity_type:` `<verb>`',
        'Updates the bot presence and activity.',
        '\u200B',
      ].join('\n'),
    },
    {
      name: '→ Activation Keys',
      value: [
        '`/key`',
        '> `tier:` `member` `facilities`',
        '> `expires_at:` `YYYY-MM-DD`',
        'Generates a website activation key.',
        '\u200B',
      ].join('\n'),
    },
    {
      name: '→ Website Admin',
      value: [
        '`/grant-admin`',
        '> `email:` `<account email>`',
        'Grants website admin access to an account. Requires Discord Admin.',
        '\u200B',
      ].join('\n'),
    },
    {
      name: '→ Darkroom Stats',
      value: [
        '`/darkroom-stats`',
        'Syncs the stats message and Discord user-count voice channel.',
        '\u200B',
      ].join('\n'),
    },
    {
      name: '→ Studio Scheduling',
      value: [
        '`/studio-message`',
        'Posts or updates the public studio scheduling buttons.',
        '\u200B',
      ].join('\n'),
    },
    {
      name: '→ Equipment Loans',
      value: [
        '`/equipment-terms-message`',
        'Posts the equipment loan terms accept/deny buttons.',
        '\u200B',
      ].join('\n'),
    },
    {
      name: '→ System Check',
      value: [
        '`/health`',
        '> Checks the status of purdue photography backend',
      ].join('\n'),
    },
    {
      name: '→ Discord Verification',
      value: [
        '`/verify-message`',
        'Posts the camera Verify button in the verification channel.',
        '\u200B',
      ].join('\n'),
    },
    {
      name: '→ Wiki Hub',
      value: [
        '`/wiki-message`',
        'Posts the interactive wiki guide buttons in the wiki channel.',
      ].join('\n'),
    },
  ];

  return {
    embeds: [
      {
        color: 0xf2c94c,
        title: '🛠️ PPC Command Center',
        description:
          'Executive tools for keeping the PPC Discord bot online, visible, and behaving.\n',
        fields: commands.map((cmd) => ({ ...cmd, inline: false })),
        footer: {
          text: 'Purdue Photography Club • Executive tools',
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}
