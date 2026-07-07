/**
 * Public exports for commands and the command registry.
 *
 * Other Worker modules import from here when they need the registered command
 * list or a specific command handler.
 */
export {
  adminCommand,
  darkroomStatsCommand,
  equipmentTermsMessageCommand,
  honeypotWarningCommand,
  statusCommand,
  studioMessageCommand,
} from './admin';
export { equipmentCommand, healthCommand, wikiCommand } from './general';
export {
  commandDefinitions,
  commands,
  getCommand,
} from '../../config/commands';
