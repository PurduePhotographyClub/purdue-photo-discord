import type { DiscordCommand } from '../../discord/types';
import { handleEventCarpoolsCommand } from '../../services/discordEventCarpoolService';

export const eventCarpoolsCommand: DiscordCommand = {
  definition: {
    description: 'Create a community carpool for any event or trip.',
    name: 'event-carpools',
  },
  execute: () => handleEventCarpoolsCommand(),
};
