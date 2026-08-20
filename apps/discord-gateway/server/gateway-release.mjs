#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HASH_FILE = 'SHA256SUMS';
const REQUIRED_FILES = [
  'dist/index.js',
  'package-lock.json',
  'package.json',
  'release.json',
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export async function packageRelease({ metadata, outputDirectory, root }) {
  const normalizedMetadata = normalizeMetadata(metadata);
  const repositoryRoot = await realpath(root);
  const output = path.resolve(outputDirectory);
  const resolvedOutput = await resolveProspectivePath(output);
  assertSafeOutput(repositoryRoot, resolvedOutput);

  try {
    await lstat(resolvedOutput);
    throw new Error(`Release output already exists: ${resolvedOutput}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const resolvedParent = path.dirname(resolvedOutput);
  await mkdir(resolvedParent, { recursive: true });
  const stagingDirectory = await mkdtemp(
    path.join(resolvedParent, `.${path.basename(output)}.tmp-`),
  );
  let promoted = false;

  try {
    const gatewayDirectory = path.join(repositoryRoot, 'apps/discord-gateway');
    const distDirectory = path.join(gatewayDirectory, 'dist');
    const deployDirectory = path.join(gatewayDirectory, 'deploy');
    await assertSourceDirectory(distDirectory);
    await assertSourceFile(path.join(deployDirectory, 'package.json'));
    await assertSourceFile(path.join(deployDirectory, 'package-lock.json'));

    await cp(distDirectory, path.join(stagingDirectory, 'dist'), {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    await cp(
      path.join(deployDirectory, 'package.json'),
      path.join(stagingDirectory, 'package.json'),
    );
    await cp(
      path.join(deployDirectory, 'package-lock.json'),
      path.join(stagingDirectory, 'package-lock.json'),
    );

    const releaseManifest = {
      nodeMajor: 22,
      repository: normalizedMetadata.repository,
      runAttempt: normalizedMetadata.runAttempt,
      runId: normalizedMetadata.runId,
      schema: 1,
      sourceSha: normalizedMetadata.sourceSha,
    };
    await writeFile(
      path.join(stagingDirectory, 'release.json'),
      `${JSON.stringify(releaseManifest, null, 2)}\n`,
      { mode: 0o644 },
    );

    const releaseFiles = await listReleaseFiles(stagingDirectory);
    const checksumLines = await Promise.all(
      releaseFiles.map(async (relativePath) => {
        const digest = await sha256(path.join(stagingDirectory, relativePath));
        return `${digest}  ${relativePath}`;
      }),
    );
    await writeFile(
      path.join(stagingDirectory, HASH_FILE),
      `${checksumLines.sort().join('\n')}\n`,
      { mode: 0o644 },
    );

    await verifyRelease(stagingDirectory, {
      repository: normalizedMetadata.repository,
    });
    await rename(stagingDirectory, resolvedOutput);
    promoted = true;
  } finally {
    if (!promoted) {
      await rm(stagingDirectory, { force: true, recursive: true });
    }
  }

  return resolvedOutput;
}

export async function verifyRelease(releaseDirectory, options = {}) {
  const inputStat = await lstat(releaseDirectory);
  if (inputStat.isSymbolicLink()) {
    throw new Error('release root must not be a symbolic link.');
  }
  const releaseRoot = await realpath(releaseDirectory);
  const rootStat = await lstat(releaseRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Release root must be a real directory.');
  }

  const files = await listReleaseFiles(releaseRoot);
  const fileSet = new Set(files);
  for (const requiredFile of [...REQUIRED_FILES, HASH_FILE]) {
    if (!fileSet.has(requiredFile)) {
      throw new Error(`Missing required release file: ${requiredFile}`);
    }
  }
  for (const relativePath of files) {
    if (
      relativePath !== HASH_FILE &&
      relativePath !== 'package-lock.json' &&
      relativePath !== 'package.json' &&
      relativePath !== 'release.json' &&
      !relativePath.startsWith('dist/')
    ) {
      throw new Error(`unexpected release file: ${relativePath}`);
    }
  }

  const checksums = parseChecksums(
    await readFile(path.join(releaseRoot, HASH_FILE), 'utf8'),
  );
  const expectedChecksumPaths = files
    .filter((relativePath) => relativePath !== HASH_FILE)
    .sort();
  assertSamePaths([...checksums.keys()].sort(), expectedChecksumPaths);

  const checksumResults = await Promise.all(
    [...checksums].map(async ([relativePath, expectedDigest]) => ({
      actualDigest: await sha256(path.join(releaseRoot, relativePath)),
      expectedDigest,
      relativePath,
    })),
  );
  const mismatch = checksumResults.find(
    ({ actualDigest, expectedDigest }) => actualDigest !== expectedDigest,
  );
  if (mismatch) {
    throw new Error(`Release checksum mismatch: ${mismatch.relativePath}`);
  }

  const manifest = JSON.parse(
    await readFile(path.join(releaseRoot, 'release.json'), 'utf8'),
  );
  if (manifest.schema !== 1 || manifest.nodeMajor !== 22) {
    throw new Error('Unsupported Gateway release manifest.');
  }
  const normalizedMetadata = normalizeMetadata(manifest);
  if (
    options.repository &&
    normalizedMetadata.repository !== options.repository
  ) {
    throw new Error('Gateway release repository provenance does not match.');
  }
  if (options.sourceSha && normalizedMetadata.sourceSha !== options.sourceSha) {
    throw new Error('Gateway release source SHA provenance does not match.');
  }

  const packageManifest = JSON.parse(
    await readFile(path.join(releaseRoot, 'package.json'), 'utf8'),
  );
  if (
    packageManifest.name !== 'pccbot-discord-gateway-server' ||
    packageManifest.private !== true ||
    packageManifest.type !== 'module' ||
    packageManifest.main !== 'dist/index.js'
  ) {
    throw new Error('Gateway production package manifest is invalid.');
  }

  return normalizedMetadata;
}

export function normalizeMetadata(metadata) {
  if (!SOURCE_SHA_PATTERN.test(metadata?.sourceSha ?? '')) {
    throw new Error(
      'Gateway release source SHA must be 40 lowercase hex characters.',
    );
  }
  if (!REPOSITORY_PATTERN.test(metadata?.repository ?? '')) {
    throw new Error('Gateway release repository is invalid.');
  }
  if (!Number.isSafeInteger(metadata?.runId) || metadata.runId < 1) {
    throw new Error(
      'Gateway release workflow run ID must be a positive integer.',
    );
  }
  if (!Number.isSafeInteger(metadata?.runAttempt) || metadata.runAttempt < 1) {
    throw new Error(
      'Gateway release workflow attempt must be a positive integer.',
    );
  }
  return {
    repository: metadata.repository,
    runAttempt: metadata.runAttempt,
    runId: metadata.runId,
    sourceSha: metadata.sourceSha,
  };
}

function assertSafeOutput(repositoryRoot, output) {
  const deployRoot = path.join(repositoryRoot, 'deploy');
  const insideRepository = isWithin(repositoryRoot, output);
  const insideDeployRoot = isWithin(deployRoot, output);
  if (
    output === path.parse(output).root ||
    output === repositoryRoot ||
    (insideRepository && !insideDeployRoot)
  ) {
    throw new Error(`Refusing unsafe output directory: ${output}`);
  }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..'
  );
}

async function resolveProspectivePath(candidate) {
  const missingParts = [];
  let cursor = candidate;
  while (true) {
    try {
      const existingPath = await realpath(cursor);
      return path.join(existingPath, ...missingParts);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new Error(`Unable to resolve release output path: ${candidate}`, {
          cause: error,
        });
      }
      missingParts.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertSourceDirectory(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Gateway release source is not a real directory: ${directory}`,
    );
  }
}

async function assertSourceFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Gateway release source is not a regular file: ${file}`);
  }
}

async function listReleaseFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const fileGroups = await Promise.all(
    entries
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const absolutePath = path.join(directory, entry.name);
        const relativePath = path
          .relative(root, absolutePath)
          .split(path.sep)
          .join('/');
        const stat = await lstat(absolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(
            `Release symbolic links are not allowed: ${relativePath}`,
          );
        }
        if (stat.isDirectory()) {
          return listReleaseFiles(root, absolutePath);
        }
        if (!stat.isFile()) {
          throw new Error(
            `Release entries must be regular files: ${relativePath}`,
          );
        }
        return [relativePath];
      }),
  );
  return fileGroups.flat().sort();
}

function parseChecksums(contents) {
  const checksums = new Map();
  for (const line of contents.trimEnd().split('\n')) {
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/u);
    if (!match || !SHA256_PATTERN.test(match[1])) {
      throw new Error('Gateway release checksum manifest is malformed.');
    }
    const relativePath = match[2];
    if (
      relativePath.startsWith('/') ||
      relativePath.includes('\\') ||
      relativePath.split('/').some((part) => part === '..' || part === '') ||
      checksums.has(relativePath)
    ) {
      throw new Error('Gateway release checksum path is unsafe or duplicated.');
    }
    checksums.set(relativePath, match[1]);
  }
  return checksums;
}

function assertSamePaths(actual, expected) {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      'Gateway release checksum paths do not match the release files.',
    );
  }
}

async function sha256(file) {
  const contents = await readFile(file);
  return createHash('sha256').update(contents).digest('hex');
}

async function runCli() {
  const mode = process.argv[2];
  const target = process.argv[3];
  if (!target || !['package', 'verify'].includes(mode)) {
    throw new Error('Usage: gateway-release.mjs package|verify DIRECTORY');
  }

  if (mode === 'verify') {
    const verified = await verifyRelease(target, {
      repository: process.env.GITHUB_REPOSITORY,
      sourceSha: process.env.GITHUB_SHA,
    });
    console.log(`Verified Gateway release for ${verified.sourceSha}.`);
    return;
  }

  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
  );
  const releaseMetadata = {
    repository: process.env.GITHUB_REPOSITORY,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    runId: Number(process.env.GITHUB_RUN_ID),
    sourceSha: process.env.GITHUB_SHA,
  };
  await packageRelease({
    metadata: releaseMetadata,
    outputDirectory: target,
    root: repositoryRoot,
  });
  console.log(`Packaged Gateway release for ${releaseMetadata.sourceSha}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runCli();
}
