#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productionPaths = [
  'app/functions',
  'app/src',
  'cloudflare/worker/scripts',
  'cloudflare/worker/src',
  'landing-astro/scripts',
  'landing-astro/src',
  'scripts',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result;
}

function failRegressions(label, observed, baseline) {
  const regressions = Object.entries(baseline).filter(([key, maximum]) => observed[key] > maximum);
  if (regressions.length > 0) {
    throw new Error(regressions.map(([key, maximum]) => `${label} ${key} regressed: ${observed[key]} > ${maximum}`).join('\n'));
  }
  if (Object.entries(baseline).some(([key, maximum]) => observed[key] < maximum)) {
    console.log(`${label} improved; lower the checked-in baseline in the next intentional update.`);
  }
}

function checkFormat() {
  const result = run('pnpm', ['exec', 'biome', 'format', '--reporter=json', ...productionPaths], {
    allowFailure: true,
  });
  const report = JSON.parse(result.stdout);
  const observed = { files: report.summary.errors };
  // Debt: https://github.com/sass-maker/knowledge-base/issues/33
  const baseline = { files: 0 };
  console.log(`Format: ${observed.files} files outside the Biome baseline.`);
  failRegressions('Format', observed, baseline);
}

function checkUnused() {
  run('pnpm', ['exec', 'knip', '--dependencies', '--include', 'files,dependencies,unlisted,unresolved,binaries', '--reporter', 'symbols', '--no-config-hints']);
  const report = JSON.parse(run('pnpm', ['exec', 'knip', '--include', 'exports,types', '--reporter', 'json', '--no-exit-code', '--no-config-hints']).stdout);
  const observed = report.issues.reduce(
    (counts, issue) => ({
      exports: counts.exports + (issue.exports?.length ?? 0),
      types: counts.types + (issue.types?.length ?? 0),
    }),
    { exports: 0, types: 0 },
  );
  // Debt: https://github.com/sass-maker/knowledge-base/issues/33
  const baseline = { exports: 0, types: 0 };
  console.log(`Unused: 0 high-confidence findings; ${observed.exports} exports, ${observed.types} types.`);
  failRegressions('Unused', observed, baseline);
}

function checkComplexity() {
  const result = run('uvx', ['--from', 'lizard==1.23.0', 'lizard', ...productionPaths, '-x', '**/*.test.*', '--csv']);
  const rows = result.stdout
    .trim()
    .split('\n')
    .map((line) => line.match(/^(\d+),(\d+),(\d+),(\d+),(\d+),/u))
    .filter(Boolean)
    .map((match) => match.slice(1).map(Number));
  const observed = {
    functions: rows.length,
    nloc: rows.reduce((sum, row) => sum + row[0], 0),
    violations: rows.filter((row) => row[1] > 20 || row[4] > 100 || row[3] > 7).length,
    maxCcn: Math.max(0, ...rows.map((row) => row[1])),
    maxLength: Math.max(0, ...rows.map((row) => row[4])),
    maxParams: Math.max(0, ...rows.map((row) => row[3])),
  };
  // Debt: https://github.com/sass-maker/knowledge-base/issues/33
  const baseline = {
    violations: 53,
    maxCcn: 121,
    maxLength: 5988,
    maxParams: 9,
  };
  console.log(
    `Complexity: ${observed.functions} functions, ${observed.nloc} NLOC, ${observed.violations} violations; ` +
      `max CCN ${observed.maxCcn}, max length ${observed.maxLength}, max params ${observed.maxParams}.`,
  );
  failRegressions('Complexity', observed, baseline);
}

function checkDuplication() {
  const outputDirectory = join(tmpdir(), `knowledge-base-jscpd-${process.pid}`);
  run('pnpm', [
    'exec',
    'jscpd',
    ...productionPaths,
    '--format',
    'javascript,typescript',
    '--min-lines',
    '8',
    '--min-tokens',
    '60',
    '--mode',
    'strict',
    '--ignore',
    '**/*.test.*,**/*.spec.*,**/*.d.ts,**/node_modules/**,**/coverage/**,**/dist/**',
    '--reporters',
    'json',
    '--output',
    outputDirectory,
    '--silent',
    '--no-tips',
  ]);
  const observed = JSON.parse(readFileSync(join(outputDirectory, 'jscpd-report.json'), 'utf8')).statistics.total;
  // Debt: https://github.com/sass-maker/knowledge-base/issues/33
  const baseline = {
    clones: 50,
    duplicatedLines: 537,
    percentage: 2.355056573984738,
  };
  console.log(
    `Duplication: ${observed.duplicatedLines}/${observed.lines} lines (${observed.percentage.toFixed(4)}%), ` +
      `${observed.clones} groups across ${observed.sources} files.`,
  );
  failRegressions('Duplication', observed, baseline);
}

function audit(directory) {
  const report = JSON.parse(run('pnpm', ['--dir', directory, 'audit', '--json'], { allowFailure: true }).stdout);
  const advisories = Object.values(report.advisories ?? {});
  return {
    critical: advisories.filter((item) => item.severity === 'critical').length,
    high: advisories.filter((item) => item.severity === 'high').length,
    ids: advisories.filter((item) => ['critical', 'high'].includes(item.severity)).map((item) => item.github_advisory_id),
  };
}

function checkDependencies() {
  const reports = {
    root: audit('.'),
    app: audit('app'),
    worker: audit('cloudflare/worker'),
    landing: audit('landing-astro'),
  };
  const acceptedIds = {
    root: new Set([
      'GHSA-2pvr-wf23-7pc7',
      'GHSA-2v37-7h3g-55p8',
      'GHSA-4cwx-7wf7-3272',
      'GHSA-5p4m-2wfm-xmqj',
      'GHSA-7p8r-x3mc-p8w7',
      'GHSA-8hv8-536x-4wqp',
      'GHSA-mh99-v99m-4gvg',
      'GHSA-mwp4-54f8-5fhr',
      'GHSA-rgw5-rvv9-x895',
      'GHSA-v2hh-gcrm-f6hx',
    ]),
    app: new Set(['GHSA-2v37-7h3g-55p8', 'GHSA-3jxr-9vmj-r5cp', 'GHSA-4cwx-7wf7-3272', 'GHSA-mh99-v99m-4gvg', 'GHSA-rgw5-rvv9-x895']),
    worker: new Set(['GHSA-28wg-ghj8-5hjv', 'GHSA-2v37-7h3g-55p8', 'GHSA-4cwx-7wf7-3272', 'GHSA-r28c-9q8g-f849']),
    landing: new Set(['GHSA-2v37-7h3g-55p8', 'GHSA-7p8r-x3mc-p8w7']),
  };
  for (const [scope, report] of Object.entries(reports)) {
    const unexpected = report.ids.filter((id) => !acceptedIds[scope].has(id));
    if (unexpected.length > 0) {
      throw new Error(`Unaccepted ${scope} critical/high advisories: ${unexpected.join(', ')}`);
    }
  }
  const observed = {
    rootCritical: reports.root.critical,
    rootHigh: reports.root.high,
    appCritical: reports.app.critical,
    appHigh: reports.app.high,
    workerCritical: reports.worker.critical,
    workerHigh: reports.worker.high,
    landingCritical: reports.landing.critical,
    landingHigh: reports.landing.high,
  };
  // Debt: https://github.com/sass-maker/knowledge-base/issues/33
  const baseline = {
    rootCritical: 0,
    rootHigh: 0,
    appCritical: 0,
    appHigh: 8,
    workerCritical: 0,
    workerHigh: 4,
    landingCritical: 0,
    landingHigh: 1,
  };
  console.log(
    `Dependencies: 0 critical; high advisories root ${observed.rootHigh}, app ${observed.appHigh}, ` +
      `worker ${observed.workerHigh}, landing ${observed.landingHigh}.`,
  );
  failRegressions('Dependencies', observed, baseline);
}

function checkSuppressions() {
  const result = run(
    'git',
    [
      'grep',
      '-n',
      '-E',
      '(biome-ignore|eslint-disable|@ts-ignore|@ts-expect-error|istanbul ignore|c8 ignore)',
      '--',
      ...productionPaths,
      ':(exclude)scripts/check-code-health.mjs',
    ],
    { allowFailure: true },
  );
  const observed = result.stdout.trim() ? result.stdout.trim().split('\n').length : 0;
  const baseline = { count: 0 };
  console.log(`Suppressions: ${observed} inline directives.`);
  failRegressions('Suppressions', { count: observed }, baseline);
}

const checks = {
  complexity: checkComplexity,
  dependencies: checkDependencies,
  duplication: checkDuplication,
  format: checkFormat,
  suppressions: checkSuppressions,
  unused: checkUnused,
};
const selected = process.argv[2];

if (!Object.hasOwn(checks, selected)) {
  console.error(`Usage: check-code-health.mjs <${Object.keys(checks).join('|')}>`);
  process.exit(2);
}

try {
  checks[selected]();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
