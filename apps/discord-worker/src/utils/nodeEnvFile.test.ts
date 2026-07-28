import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { loadNodeEnvFileIfPresent } from './nodeEnvFile';

const TEST_ENV_NAME = 'PCCBOT_NODE_ENV_FILE_TEST';
const originalTestValue = process.env[TEST_ENV_NAME];

afterEach(() => {
  if (originalTestValue === undefined) {
    delete process.env[TEST_ENV_NAME];
  } else {
    process.env[TEST_ENV_NAME] = originalTestValue;
  }
});

test('loads local registration values from an env file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pccbot-node-env-'));
  const envFile = join(directory, '.dev.vars');
  await writeFile(envFile, `${TEST_ENV_NAME}=loaded-from-file\n`);
  delete process.env[TEST_ENV_NAME];

  loadNodeEnvFileIfPresent(envFile);

  assert.equal(process.env[TEST_ENV_NAME], 'loaded-from-file');
});

test('keeps explicitly exported registration values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pccbot-node-env-'));
  const envFile = join(directory, '.dev.vars');
  await writeFile(envFile, `${TEST_ENV_NAME}=loaded-from-file\n`);
  process.env[TEST_ENV_NAME] = 'exported-value';

  loadNodeEnvFileIfPresent(envFile);

  assert.equal(process.env[TEST_ENV_NAME], 'exported-value');
});

test('allows registration without a local env file', () => {
  assert.doesNotThrow(() =>
    loadNodeEnvFileIfPresent(
      join(tmpdir(), 'pccbot-missing-registration-env-file'),
    ),
  );
});
