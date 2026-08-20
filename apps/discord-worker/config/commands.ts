/**
 * Slash-command registry for Discord registration and runtime dispatch.
 *
 * Add commands here when they should be registered with Discord and callable
 * from the interaction handler.
 */
import { adminCommand } from '../src/commands/admin/admin';
import { clearReportsCommand } from '../src/commands/admin/clearReports';
import { darkroomStatsCommand } from '../src/commands/admin/darkroomStats';
import { eventCarpoolsSetupCommand } from '../src/commands/admin/eventCarpoolsSetup';
import { equipmentTermsMessageCommand } from '../src/commands/admin/equipmentTermsMessage';
import { grantAdminCommand } from '../src/commands/admin/grantAdmin';
import { honeypotWarningCommand } from '../src/commands/admin/honeypotWarning';
import { jobs101MessageCommand } from '../src/commands/admin/jobs101Message';
import { keyCommand } from '../src/commands/admin/key';
import { postReportMessageCommand } from '../src/commands/admin/postReportMessage';
import { statusCommand } from '../src/commands/admin/status';
import { studioMessageCommand } from '../src/commands/admin/studioMessage';
import { verifyMessageCommand } from '../src/commands/admin/verifyMessage';
import { wikiMessageCommand } from '../src/commands/admin/wikiMessage';
import { equipmentCommand } from '../src/commands/general/equipment';
import { eventCarpoolsCommand } from '../src/commands/general/eventCarpools';
import { healthCommand } from '../src/commands/general/health';
import { merchCommand } from '../src/commands/general/merch';
import { newsletterCommand } from '../src/commands/general/newsletter';
import { reportCommand } from '../src/commands/general/report';
import { wikiCommand } from '../src/commands/general/wiki';
import type {
  DiscordApplicationCommandDefinition,
  DiscordCommand,
} from '../src/discord/types';

export const commands = [
  adminCommand,
  clearReportsCommand,
  darkroomStatsCommand,
  equipmentCommand,
  equipmentTermsMessageCommand,
  eventCarpoolsCommand,
  eventCarpoolsSetupCommand,
  grantAdminCommand,
  healthCommand,
  honeypotWarningCommand,
  jobs101MessageCommand,
  keyCommand,
  merchCommand,
  newsletterCommand,
  postReportMessageCommand,
  reportCommand,
  statusCommand,
  studioMessageCommand,
  verifyMessageCommand,
  wikiMessageCommand,
  wikiCommand,
] as const satisfies readonly DiscordCommand[];

export const commandDefinitions: DiscordApplicationCommandDefinition[] =
  commands.map((command) => command.definition);

export function getCommand(commandName: string): DiscordCommand | undefined {
  // Discord command names are lowercase today, but normalize anyway so tests and
  // future command sources do not depend on casing.
  const normalizedName = commandName.toLowerCase();

  return commands.find(
    (command) => command.definition.name.toLowerCase() === normalizedName,
  );
}
