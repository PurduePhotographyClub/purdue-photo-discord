import type { DiscordCommand } from '../../discord/types';
import { handleEventCarpoolsSetupCommand } from '../../services/discordEventCarpoolService';

export const eventCarpoolsSetupCommand: DiscordCommand = {
  definition: {
    description: 'Create or repair the event-carpools forum.',
    name: 'event-carpools-setup',
  },
  execute: handleEventCarpoolsSetupCommand,
};
