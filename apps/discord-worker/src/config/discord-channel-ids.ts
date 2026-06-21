export const DISCORD_CHANNEL_IDS = {
  darkroomStats: '1513248086275788980',
  darkroomUserCountVoice: '1513247977706229891',
  photographerRequestsIndividual: '1512507940303671546',
  photographerRequestsOrganization: '1512508172139499670',
  verification: '1512506154079486004',
  wiki: '1512574749090517132',
} as const;

export const PHOTOGRAPHER_REQUEST_CHANNEL_IDS = new Set<string>([
  DISCORD_CHANNEL_IDS.photographerRequestsIndividual,
  DISCORD_CHANNEL_IDS.photographerRequestsOrganization,
]);
