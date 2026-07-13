import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const readSource = async (relativePath: string) =>
  readFile(resolve(sourceDirectory, relativePath), 'utf8');

test('internal scheduling events authenticate before parsing or logging payload metadata', async () => {
  const source = await readSource('../routes/internalEvents.ts');
  const authorizeIndex = source.indexOf('await authorizeGatewayRequest');
  const parseIndex = source.indexOf('parseInternalEvent(');
  const receivedLogIndex = source.indexOf(
    "logger.info('Received internal event.'",
  );

  assert.ok(authorizeIndex > 0);
  assert.ok(authorizeIndex < parseIndex);
  assert.ok(authorizeIndex < receivedLogIndex);
});

test('schedule event revisions cross the parser boundary', async () => {
  const [parser, types] = await Promise.all([
    readSource('../internal-events/parser.ts'),
    readSource('../internal-events/types.ts'),
  ]);

  assert.match(parser, /syncRevision must be a non-negative integer/);
  assert.match(types, /syncRevision:\s*number/);
});

test('schedule root messages use deterministic Discord nonces', async () => {
  const [darkroom, studio] = await Promise.all([
    readSource('./discordDarkroomScheduleService.ts'),
    readSource('./discordStudioScheduleService.ts'),
  ]);

  assert.match(darkroom, /nonce:\s*buildDarkroomScheduleMessageNonce/);
  assert.match(darkroom, /nonce:\s*buildDarkroomWeeklyMessageNonce/);
  assert.match(studio, /nonce:\s*buildStudioScheduleMessageNonce/);
  assert.match(studio, /nonce:\s*buildStudioReviewMessageNonce/);
});

test('schedule channels are verified by guild, category, and ownership marker', async () => {
  const [darkroom, studio] = await Promise.all([
    readSource('./discordDarkroomScheduleService.ts'),
    readSource('./discordStudioScheduleService.ts'),
  ]);

  assert.match(darkroom, /assertDarkroomScheduleChannelOwnership/);
  assert.match(darkroom, /channel\.guild_id !== guildId/);
  assert.match(
    darkroom,
    /split\('\s*\|\s*'\)\.at\(-1\)\?\.startsWith\(markerPrefix\)/,
  );
  assert.match(studio, /assertStudioScheduleChannelOwnership/);
  assert.match(studio, /channel\.guild_id !== guildId/);
  assert.match(
    studio,
    /split\('\s*\|\s*'\)\.at\(-1\)\?\.startsWith\(markerPrefix\)/,
  );
  assert.doesNotMatch(darkroom, /isExplicitLegacyAdoption/);
  assert.match(darkroom, /status === 404\) return false/);
  assert.match(studio, /isDiscordNotFoundError\(error\)\) return false/);
  assert.match(darkroom, /1_024 - marker\.length - 3/);
  assert.match(studio, /1_024 - marker\.length - 3/);
  assert.match(darkroom, /storedRevision > event\.syncRevision/);
  assert.match(studio, /storedRevision > event\.syncRevision/);
  assert.match(
    darkroom,
    /existingChannel[\s\S]*assertDarkroomScheduleChannelOwnership/,
  );
  assert.match(
    studio,
    /existingChannel[\s\S]*assertStudioScheduleChannelOwnership/,
  );
});

test('darkroom interaction synchronization settles channel and weekly work independently', async () => {
  const source = await readSource('./discordDarkroomScheduleService.ts');

  assert.match(source, /syncDarkroomInteractionState/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /weeklyJoinMessageEvents/);
  assert.match(source, /weekly refresh is missing its message ID/);
});

test('stale weekly messages are reported and existing schedule markers advance', async () => {
  const [dispatcher, darkroom, studio] = await Promise.all([
    readSource('../internal-events/dispatcher.ts'),
    readSource('./discordDarkroomScheduleService.ts'),
    readSource('./discordStudioScheduleService.ts'),
  ]);

  assert.match(darkroom, /stale:\s*result === null/);
  assert.match(dispatcher, /ok:\s*result\.ok/);
  assert.match(studio, /if \(!didCreateChannel\)/);
});

test('Discord retry-after values are treated as seconds without a millisecond heuristic', async () => {
  const source = await readSource('../discord/api.ts');

  assert.doesNotMatch(source, /retryAfter > 50/);
  assert.match(source, /retryAfter \* 1_000/);
  assert.match(source, /DISCORD_MAX_INLINE_RETRY_DELAY_MS\s*=\s*500/);
});
