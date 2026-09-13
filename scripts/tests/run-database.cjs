/* eslint-disable @typescript-eslint/no-require-imports -- Local Docker test runner. */
const { execFileSync, spawnSync } = require('node:child_process');
const postgres = require('postgres');
const name = `godomall-review-test-${process.pid}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

(async () => {
  let started = false;
  try {
    docker('run', '--rm', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=local-regression', '-p', '127.0.0.1::5432', 'postgres:17-alpine');
    started = true;
    const port = docker('port', name, '5432').split(':').at(-1);
    const url = `postgres://postgres:local-regression@127.0.0.1:${port}/postgres`;
    const sql = postgres(url, { connect_timeout: 1 });
    try {
      for (let attempt = 0; ; attempt++) {
        try { await sql`select 1`; break; }
        catch (error) {
          if (attempt === 30) throw error;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    } finally { await sql.end({ timeout: 1 }); }
    const result = spawnSync(process.execPath, ['--test', 'scripts/tests/database.test.cjs'], {
      stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url },
    });
    process.exitCode = result.status ?? 1;
  } finally {
    if (started) docker('stop', name);
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
