import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const releaseModuleUrl = pathToFileURL(
  path.join(repositoryRoot, 'apps/discord-gateway/server/gateway-release.mjs'),
).href;
const deployModuleUrl = pathToFileURL(
  path.join(
    repositoryRoot,
    'apps/discord-gateway/server/gateway-server-deploy.mjs',
  ),
).href;

const sourceSha = 'a'.repeat(40);
const repository = 'PurduePhotographyClub/purdue-photo-discord';

async function createFixtureRepository() {
  const root = await mkdtemp(path.join(tmpdir(), 'gateway-release-source-'));
  const gateway = path.join(root, 'apps/discord-gateway');
  await mkdir(path.join(gateway, 'dist/http'), { recursive: true });
  await mkdir(path.join(gateway, 'deploy'), { recursive: true });
  await writeFile(
    path.join(gateway, 'dist/index.js'),
    'console.log("gateway");\n',
  );
  await writeFile(
    path.join(gateway, 'dist/http/server.js'),
    'export const ready = true;\n',
  );
  await writeFile(
    path.join(gateway, 'deploy/package.json'),
    `${JSON.stringify(
      {
        name: 'pccbot-discord-gateway-server',
        version: '1.0.0',
        private: true,
        type: 'module',
        main: 'dist/index.js',
        dependencies: { 'discord.js': '14.27.0' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(gateway, 'deploy/package-lock.json'),
    `${JSON.stringify(
      {
        name: 'pccbot-discord-gateway-server',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {},
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function metadata(overrides = {}) {
  return {
    repository,
    runAttempt: 1,
    runId: 1234,
    sourceSha,
    ...overrides,
  };
}

test('packages a deterministic, allowlisted, tamper-evident Gateway release', async () => {
  const { packageRelease, verifyRelease } = await import(releaseModuleUrl);
  const root = await createFixtureRepository();
  const first = path.join(root, 'deploy/first');
  const second = path.join(root, 'deploy/second');

  await packageRelease({ metadata: metadata(), outputDirectory: first, root });
  await packageRelease({ metadata: metadata(), outputDirectory: second, root });

  assert.deepEqual(await verifyRelease(first, { repository }), metadata());
  assert.equal(
    await readFile(path.join(first, 'SHA256SUMS'), 'utf8'),
    await readFile(path.join(second, 'SHA256SUMS'), 'utf8'),
  );
  assert.equal(
    await readFile(path.join(first, 'release.json'), 'utf8'),
    await readFile(path.join(second, 'release.json'), 'utf8'),
  );
  await assert.rejects(
    verifyRelease(first, { repository, sourceSha: 'b'.repeat(40) }),
    /source SHA provenance does not match/u,
  );

  await writeFile(path.join(first, 'dist/index.js'), 'tampered\n');
  await assert.rejects(
    verifyRelease(first, { repository }),
    /checksum mismatch/u,
  );
});

test('refuses unsafe or pre-existing package targets without clobbering them', async () => {
  const { packageRelease } = await import(releaseModuleUrl);
  const root = await createFixtureRepository();
  const existing = path.join(root, 'deploy/existing');
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, 'sentinel.txt'), 'keep me\n');

  await assert.rejects(
    packageRelease({ metadata: metadata(), outputDirectory: root, root }),
    /unsafe output directory/u,
  );
  await assert.rejects(
    packageRelease({ metadata: metadata(), outputDirectory: existing, root }),
    /already exists/u,
  );
  assert.equal(
    await readFile(path.join(existing, 'sentinel.txt'), 'utf8'),
    'keep me\n',
  );
});

test('rejects unexpected files and symbolic links in a release', async () => {
  const { packageRelease, verifyRelease } = await import(releaseModuleUrl);
  const root = await createFixtureRepository();
  const clean = path.join(root, 'deploy/clean');
  const unexpected = path.join(root, 'deploy/unexpected');
  const linked = path.join(root, 'deploy/linked');
  const linkedRoot = path.join(root, 'deploy/linked-root');

  await packageRelease({
    metadata: metadata(),
    outputDirectory: unexpected,
    root,
  });
  await writeFile(path.join(unexpected, 'secret.env'), 'not-allowed\n');
  await assert.rejects(
    verifyRelease(unexpected, { repository }),
    /unexpected release file/u,
  );

  await packageRelease({ metadata: metadata(), outputDirectory: linked, root });
  await symlink('/etc/passwd', path.join(linked, 'dist/escape.js'));
  await assert.rejects(
    verifyRelease(linked, { repository }),
    /symbolic links are not allowed/u,
  );

  await packageRelease({ metadata: metadata(), outputDirectory: clean, root });
  await symlink(clean, linkedRoot);
  await assert.rejects(
    verifyRelease(linkedRoot, { repository }),
    /release root must not be a symbolic link/u,
  );
});

test('validates one fast-forward main update and monotonic workflow provenance', async () => {
  const { compareProvenance, parseReceiveUpdate } = await import(
    deployModuleUrl
  );
  const oldRevision = '1'.repeat(40);
  const newRevision = '2'.repeat(40);

  assert.deepEqual(
    parseReceiveUpdate(`${oldRevision} ${newRevision} refs/heads/main\n`),
    { newRevision, oldRevision, refname: 'refs/heads/main' },
  );
  assert.throws(
    () =>
      parseReceiveUpdate(`${oldRevision} ${'0'.repeat(40)} refs/heads/main\n`),
    /deletions are not allowed/u,
  );
  assert.throws(
    () => parseReceiveUpdate(`${oldRevision} ${newRevision} refs/heads/dev\n`),
    /only refs\/heads\/main/u,
  );
  assert.throws(
    () =>
      parseReceiveUpdate(
        `${oldRevision} ${newRevision} refs/heads/main\n${oldRevision} ${newRevision} refs/tags/v1\n`,
      ),
    /exactly one ref update/u,
  );

  assert.doesNotThrow(() =>
    compareProvenance(
      metadata({ runAttempt: 2, runId: 200 }),
      metadata({ runAttempt: 1, runId: 200 }),
    ),
  );
  assert.throws(
    () =>
      compareProvenance(
        metadata({ runAttempt: 1, runId: 199 }),
        metadata({ runAttempt: 1, runId: 200 }),
      ),
    /older workflow run/u,
  );
  assert.throws(
    () =>
      compareProvenance(
        metadata({ runAttempt: 1, runId: 200 }),
        metadata({ runAttempt: 1, runId: 200 }),
      ),
    /workflow attempt must increase/u,
  );
});

test('allows only Git transport commands for the dedicated SSH key', async () => {
  const { validateSshOriginalCommand } = await import(deployModuleUrl);
  const gitDirectory = '/opt/git/pccbot-discord-gateway.git';

  assert.equal(
    validateSshOriginalCommand(
      `git-receive-pack '${gitDirectory}'`,
      gitDirectory,
    ),
    'receive',
  );
  assert.equal(
    validateSshOriginalCommand(
      `git-upload-pack '${gitDirectory}'`,
      gitDirectory,
    ),
    'upload',
  );
  for (const command of [
    '',
    'bash',
    `git-receive-pack '${gitDirectory}'; id`,
    "git-upload-pack '/tmp/other.git'",
  ]) {
    assert.throws(
      () => validateSshOriginalCommand(command, gitDirectory),
      /command denied/u,
    );
  }
});

test('receive-hook CLI reads updates from standard input', () => {
  const deployScript = path.join(
    repositoryRoot,
    'apps/discord-gateway/server/gateway-server-deploy.mjs',
  );
  const result = spawnSync(process.execPath, [deployScript, 'pre-receive'], {
    encoding: 'utf8',
    input: '',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires exactly one ref update/u);
  assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE/u);
});

test('receive-hook CLI bounds standard input', () => {
  const deployScript = path.join(
    repositoryRoot,
    'apps/discord-gateway/server/gateway-server-deploy.mjs',
  );
  const result = spawnSync(process.execPath, [deployScript, 'pre-receive'], {
    encoding: 'utf8',
    input: 'x'.repeat(4097),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ref update is too large/u);
});

test('makes a prepared release traversable by the dedicated runtime group', async () => {
  const { makeReleaseTraversable } = await import(deployModuleUrl);
  const release = await mkdtemp(path.join(tmpdir(), 'gateway-permissions-'));
  await chmod(release, 0o700);

  await makeReleaseTraversable(release);

  assert.equal((await stat(release)).mode & 0o777, 0o750);
});

test('readiness accepts disabled moderation but fails closed when enabled and unready', async () => {
  const { isGatewayHealthReady } = await import(deployModuleUrl);
  const baseHealth = {
    ok: true,
    service: 'pccbot-discord-gateway',
    status: 'ready',
  };

  assert.equal(
    isGatewayHealthReady({
      ...baseHealth,
      moderation: { enabled: false, ready: false },
    }),
    true,
  );
  assert.equal(
    isGatewayHealthReady({
      ...baseHealth,
      moderation: { enabled: true, ready: false },
    }),
    false,
  );
  assert.equal(
    isGatewayHealthReady({
      ...baseHealth,
      moderation: { enabled: true, ready: true },
    }),
    true,
  );
});

async function makeReleaseLinks() {
  const root = await mkdtemp(path.join(tmpdir(), 'gateway-promotion-'));
  const releases = path.join(root, 'releases');
  const previousRelease = path.join(releases, 'previous-release');
  const nextRelease = path.join(releases, 'next-release');
  const currentLink = path.join(root, 'current');
  const previousLink = path.join(root, 'previous');
  await mkdir(previousRelease, { recursive: true });
  await mkdir(nextRelease, { recursive: true });
  await symlink(previousRelease, currentLink);
  return { currentLink, nextRelease, previousLink, previousRelease, root };
}

test('atomically promotes a healthy release and records the previous release', async () => {
  const { promoteRelease } = await import(deployModuleUrl);
  const fixture = await makeReleaseLinks();
  const restarts = [];
  const deployed = [];

  await promoteRelease({
    ...fixture,
    markDeployed: async (revision) => deployed.push(revision),
    newRevision: '3'.repeat(40),
    restart: async () => restarts.push('restart'),
    waitForHealth: async () => true,
  });

  assert.equal(
    path.resolve(fixture.root, await readFileLink(fixture.currentLink)),
    fixture.nextRelease,
  );
  assert.equal(
    path.resolve(fixture.root, await readFileLink(fixture.previousLink)),
    fixture.previousRelease,
  );
  assert.deepEqual(restarts, ['restart']);
  assert.deepEqual(deployed, ['3'.repeat(40)]);
});

test('restores the previous release when readiness fails', async () => {
  const { promoteRelease } = await import(deployModuleUrl);
  const fixture = await makeReleaseLinks();
  const restarts = [];
  const health = [false, true];
  const deployed = [];

  await assert.rejects(
    promoteRelease({
      ...fixture,
      markDeployed: async (revision) => deployed.push(revision),
      newRevision: '4'.repeat(40),
      restart: async () => restarts.push('restart'),
      waitForHealth: async () => health.shift(),
    }),
    /rolled back/u,
  );

  assert.equal(
    path.resolve(fixture.root, await readFileLink(fixture.currentLink)),
    fixture.previousRelease,
  );
  assert.deepEqual(restarts, ['restart', 'restart']);
  assert.deepEqual(deployed, []);
});

async function readFileLink(link) {
  const { readlink } = await import('node:fs/promises');
  return readlink(link);
}

test('workflow deploys the verified Gateway artifact only for main deployment events', async () => {
  const ci = await readFile(
    path.join(repositoryRoot, '.github/workflows/ci.yml'),
    'utf8',
  );
  const autoMerge = await readFile(
    path.join(repositoryRoot, '.github/workflows/auto-merge.yml'),
    'utf8',
  );

  assert.match(ci, /deploy_merged_main:/u);
  assert.match(ci, /Package verified gateway release/u);
  assert.match(ci, /discord-gateway-release-\$\{\{ github\.sha \}\}/u);
  assert.match(ci, /deploy-gateway:/u);
  assert.match(ci, /needs: verify/u);
  assert.match(ci, /environment: production/u);
  assert.match(ci, /group: discord-gateway-production/u);
  assert.match(ci, /github\.event_name == 'push'/u);
  assert.match(ci, /inputs\.deploy_merged_main/u);
  assert.doesNotMatch(
    ci,
    /github\.event_name == 'workflow_dispatch' && inputs\.deploy_merged_main/u,
  );
  assert.match(
    ci,
    /github\.event_name == 'workflow_dispatch' &&\s+github\.ref == 'refs\/heads\/main' &&\s+inputs\.deploy_merged_main/u,
  );
  assert.match(ci, /GATEWAY_DEPLOY_SSH_KEY/u);
  assert.match(ci, /GATEWAY_VPS_KNOWN_HOSTS/u);
  assert.match(ci, /refs\/deployed\/main/u);
  assert.match(ci, /creating a new deployment attempt/u);
  assert.match(ci, /git -C "\$GITHUB_WORKSPACE" fetch --quiet origin main/u);
  assert.match(autoMerge, /inputs\[deploy_merged_main\].*true/u);

  const actionReferences = [
    ...ci.matchAll(/uses: (actions\/[^@\s]+)@([^\s]+)/gu),
  ];
  assert.ok(actionReferences.length > 0);
  for (const [, action, revision] of actionReferences) {
    assert.match(
      revision,
      /^[a-f0-9]{40}$/u,
      `${action} must use an immutable SHA`,
    );
  }
  assert.ok(
    ci.indexOf('Upload gateway deploy artifact') < ci.indexOf('React Doctor'),
    'React Doctor must run after the immutable release artifact is uploaded',
  );
});

test('systemd and SSH templates keep runtime secrets and privileges constrained', async () => {
  const unit = await readFile(
    path.join(
      repositoryRoot,
      'apps/discord-gateway/systemd/pccbot-discord-gateway.service.example',
    ),
    'utf8',
  );
  const forcedCommand = await readFile(
    path.join(
      repositoryRoot,
      'apps/discord-gateway/server/pccbot-gateway-git-command',
    ),
    'utf8',
  );

  assert.match(unit, /EnvironmentFile=\/etc\/pccbot-discord-gateway\.env/u);
  assert.match(unit, /SupplementaryGroups=pccbot-release/u);
  assert.match(
    unit,
    /WorkingDirectory=\/opt\/pccbot-discord-gateway\/current/u,
  );
  assert.match(
    unit,
    /ExecStart=\/usr\/bin\/node --enable-source-maps dist\/index\.js/u,
  );
  assert.match(unit, /ProtectSystem=strict/u);
  assert.match(unit, /ProtectHome=true/u);
  assert.match(unit, /CapabilityBoundingSet=/u);
  assert.doesNotMatch(unit, /npm start/u);

  assert.match(forcedCommand, /SSH_ORIGINAL_COMMAND/u);
  assert.match(forcedCommand, /git-receive-pack/u);
  assert.match(forcedCommand, /git-upload-pack/u);
  assert.doesNotMatch(forcedCommand, /eval/u);
});
