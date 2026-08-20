#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeMetadata, verifyRelease } from './gateway-release.mjs';

const ZERO_REVISION = '0'.repeat(40);
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const PRODUCTION = Object.freeze({
  currentLink: '/opt/pccbot-discord-gateway/current',
  deployedRef: 'refs/deployed/main',
  gitDirectory: '/opt/git/pccbot-discord-gateway.git',
  healthUrl: 'http://127.0.0.1:8790/health',
  previousLink: '/opt/pccbot-discord-gateway/previous',
  releaseRoot: '/opt/pccbot-discord-gateway',
  repository: 'PurduePhotographyClub/purdue-photo-discord',
  serviceName: 'pccbot-discord-gateway.service',
});

export function parseReceiveUpdate(input) {
  const lines = input
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw new Error('Gateway deployment requires exactly one ref update.');
  }
  const parts = lines[0].split(/\s+/u);
  if (parts.length !== 3) {
    throw new Error('Gateway deployment ref update is malformed.');
  }
  const [oldRevision, newRevision, refname] = parts;
  if (
    !REVISION_PATTERN.test(oldRevision) ||
    !REVISION_PATTERN.test(newRevision)
  ) {
    throw new Error(
      'Gateway deployment revisions must be 40 lowercase hex characters.',
    );
  }
  if (newRevision === ZERO_REVISION) {
    throw new Error('Gateway deployment ref deletions are not allowed.');
  }
  if (refname !== 'refs/heads/main') {
    throw new Error('Gateway deployment allows only refs/heads/main.');
  }
  return { newRevision, oldRevision, refname };
}

export function compareProvenance(nextMetadata, currentMetadata) {
  const next = normalizeMetadata(nextMetadata);
  const current = normalizeMetadata(currentMetadata);
  if (next.runId < current.runId) {
    throw new Error('Gateway release came from an older workflow run.');
  }
  if (next.runId === current.runId && next.runAttempt <= current.runAttempt) {
    throw new Error('Gateway release workflow attempt must increase.');
  }
}

export function validateSshOriginalCommand(command, gitDirectory) {
  if (command === `git-receive-pack '${gitDirectory}'`) {
    return 'receive';
  }
  if (command === `git-upload-pack '${gitDirectory}'`) {
    return 'upload';
  }
  throw new Error('SSH command denied.');
}

export async function makeReleaseTraversable(releaseDirectory) {
  await chmod(releaseDirectory, 0o750);
}

export function isGatewayHealthReady(health) {
  return (
    health?.ok === true &&
    health?.service === 'pccbot-discord-gateway' &&
    health?.status === 'ready' &&
    (health?.moderation?.enabled === false ||
      health?.moderation?.ready === true)
  );
}

export async function promoteRelease({
  currentLink,
  markDeployed,
  newRevision,
  nextRelease,
  previousLink,
  restart,
  waitForHealth,
}) {
  if (!REVISION_PATTERN.test(newRevision)) {
    throw new Error('Gateway release revision is invalid.');
  }
  const oldTarget = await readCurrentTarget(currentLink);
  if (!oldTarget) {
    throw new Error('Gateway current release link is missing.');
  }

  await replaceSymlink(nextRelease, currentLink, newRevision);
  try {
    await restart();
    if (!(await waitForHealth())) {
      throw new Error('Gateway release did not become ready.');
    }
    await replaceSymlink(oldTarget, previousLink, newRevision);
    await markDeployed(newRevision);
  } catch (error) {
    await replaceSymlink(oldTarget, currentLink, `${newRevision}-rollback`);
    await restart();
    if (!(await waitForHealth())) {
      throw new Error(
        `Gateway release failed and rollback did not become healthy: ${safeMessage(error)}`,
        { cause: error },
      );
    }
    throw new Error(
      `Gateway release failed and was rolled back: ${safeMessage(error)}`,
      { cause: error },
    );
  }
}

async function preReceive(input, config = PRODUCTION) {
  const update = parseReceiveUpdate(input);
  if (update.oldRevision !== ZERO_REVISION) {
    run('/usr/bin/git', [
      `--git-dir=${config.gitDirectory}`,
      'merge-base',
      '--is-ancestor',
      update.oldRevision,
      update.newRevision,
    ]);
  }
  assertRegularGitTree(config.gitDirectory, update.newRevision);

  const temporaryRelease = await mkdtemp('/tmp/pccbot-gateway-preflight-');
  try {
    extractRevision(config.gitDirectory, update.newRevision, temporaryRelease);
    const nextMetadata = await verifyRelease(temporaryRelease, {
      repository: config.repository,
    });
    if (update.oldRevision !== ZERO_REVISION) {
      const currentMetadata = readRevisionMetadata(
        config.gitDirectory,
        update.oldRevision,
      );
      if (currentMetadata) {
        compareProvenance(nextMetadata, currentMetadata);
      }
    }
  } finally {
    await rm(temporaryRelease, { force: true, recursive: true });
  }
}

async function postReceive(input, config = PRODUCTION) {
  const update = parseReceiveUpdate(input);
  const releasesDirectory = path.join(config.releaseRoot, 'releases');
  const releaseDirectory = path.join(releasesDirectory, update.newRevision);
  await mkdir(releasesDirectory, { recursive: true, mode: 0o755 });

  if (!(await pathExists(releaseDirectory))) {
    const stagingDirectory = await mkdtemp(
      path.join(releasesDirectory, `.${update.newRevision}.staging-`),
    );
    let promoted = false;
    try {
      extractRevision(
        config.gitDirectory,
        update.newRevision,
        stagingDirectory,
      );
      await verifyRelease(stagingDirectory, { repository: config.repository });
      assertNodeMajor();
      run(
        '/usr/bin/npm',
        ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: stagingDirectory },
      );
      run('/usr/bin/node', ['--check', 'dist/index.js'], {
        cwd: stagingDirectory,
      });
      await makeReleaseTraversable(stagingDirectory);
      await rename(stagingDirectory, releaseDirectory);
      promoted = true;
    } finally {
      if (!promoted) {
        await rm(stagingDirectory, { force: true, recursive: true });
      }
    }
  } else {
    await verifyRelease(releaseDirectory, { repository: config.repository });
  }

  await promoteRelease({
    currentLink: config.currentLink,
    markDeployed: async (revision) => {
      run('/usr/bin/git', [
        `--git-dir=${config.gitDirectory}`,
        'update-ref',
        config.deployedRef,
        revision,
      ]);
    },
    newRevision: update.newRevision,
    nextRelease: releaseDirectory,
    previousLink: config.previousLink,
    restart: async () => {
      run('/usr/bin/sudo', [
        '-n',
        '/usr/bin/systemctl',
        'restart',
        config.serviceName,
      ]);
    },
    waitForHealth: () => waitForGatewayHealth(config.healthUrl),
  });
  console.log(`Activated Gateway deploy revision ${update.newRevision}.`);
}

async function readCurrentTarget(link) {
  try {
    return await readlink(link);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function replaceSymlink(target, link, suffix) {
  const temporaryLink = `${link}.${suffix}.${randomUUID()}.tmp`;
  try {
    await symlink(target, temporaryLink);
    await rename(temporaryLink, link);
  } finally {
    await rm(temporaryLink, { force: true });
  }
}

function assertRegularGitTree(gitDirectory, revision) {
  const result = run('/usr/bin/git', [
    `--git-dir=${gitDirectory}`,
    'ls-tree',
    '-r',
    revision,
  ]);
  for (const line of result.trim().split('\n').filter(Boolean)) {
    if (!/^100644 blob [a-f0-9]{40}\t.+$/u.test(line)) {
      throw new Error('Gateway release Git tree contains a non-regular file.');
    }
  }
}

function extractRevision(gitDirectory, revision, destination) {
  const archive = run(
    '/usr/bin/git',
    [`--git-dir=${gitDirectory}`, 'archive', '--format=tar', revision],
    { encoding: null, maxBuffer: 64 * 1024 * 1024 },
  );
  run('/usr/bin/tar', ['-xf', '-', '-C', destination], {
    encoding: null,
    input: archive,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readRevisionMetadata(gitDirectory, revision) {
  const result = spawnSync(
    '/usr/bin/git',
    [`--git-dir=${gitDirectory}`, 'show', `${revision}:release.json`],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0) {
    return null;
  }
  try {
    return normalizeMetadata(JSON.parse(result.stdout));
  } catch {
    throw new Error('Current Gateway release provenance is malformed.');
  }
}

function assertNodeMajor() {
  const major = run('/usr/bin/node', [
    '--input-type=module',
    '--eval',
    'process.stdout.write(process.versions.node.split(".")[0]);',
  ]).trim();
  if (major !== '22') {
    throw new Error('Gateway deployments require Node.js 22.');
  }
}

async function waitForGatewayHealth(url, attempts = 40) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(2_000),
      });
      const health = await response.json();
      if (response.ok && isGatewayHealthReady(health)) {
        return true;
      }
    } catch {
      // The service may refuse connections while Discord is reconnecting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return false;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding === null ? null : 'utf8',
    env: {
      ...process.env,
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    },
    input: options.input,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `Gateway deployment command failed: ${path.basename(command)} (${result.status ?? 'unknown'}).`,
    );
  }
  return result.stdout;
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function safeMessage(error) {
  return error instanceof Error ? error.message : 'unknown deployment failure';
}

async function runCli() {
  const mode = process.argv[2];
  if (!['pre-receive', 'post-receive'].includes(mode)) {
    throw new Error(
      'Usage: gateway-server-deploy.mjs pre-receive|post-receive',
    );
  }
  const input = await readFile(0, 'utf8');
  if (mode === 'pre-receive') {
    await preReceive(input);
    return;
  }
  await postReceive(input);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runCli();
}
