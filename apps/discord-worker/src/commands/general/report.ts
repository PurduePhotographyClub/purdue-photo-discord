import type { DiscordCommand } from '../../discord/types';
import { handleMemberReportCommand } from '../../services/discordMemberReportService';

export const reportCommand: DiscordCommand = {
  definition: {
    description:
      'Anonymously report a member’s behaviour to the Executive team.',
    name: 'report',
  },
  execute: (interaction) => handleMemberReportCommand(interaction),
};
