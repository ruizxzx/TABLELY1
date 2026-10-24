#!/usr/bin/env node
// Apply the three Build 27 migration files to the hosted Supabase database.
//
// Prerequisites (set ONE of these):
//   SUPABASE_DB_URL         Full connection string, e.g.
//                           postgresql://postgres.zqgjpcjqmblqhqkhfdwc:YOUR_PASSWORD@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
//   -- or --
//   SUPABASE_DB_PASSWORD    Database password, plus optional:
//   SUPABASE_DB_HOST        Pooler host (defaults to aws-0-ap-south-1.pooler.supabase.com)
//   SUPABASE_PROJECT_REF    Project ref (defaults to the value in .env.local)
//   SUPABASE_DB_PORT        Port (defaults to 5432, the session pooler)
//
// Usage:
//   $env:SUPABASE_DB_PASSWORD="..."
//   node scripts/apply-build27-migrations.mjs

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const FILES = [
  '202610240001_build27_stability_foundation.sql',
  '202610240002_global_brand_logo_reconciliation.sql',
  '202610240003_fix_cross_restaurant_checkout_charges_reconciliation.sql',
];

function loadPg() {
  try {
    return require('pg');
  } catch {
    console.error('Installing the `pg` driver (--no-save, so package.json is untouched) …');
    const r = spawnSync(
      'npm',
      ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', 'pg'],
      { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
    );
    if (r.status !== 0) {
      console.error('Could not install pg. Run manually: npm install --no-save --no-package-lock pg');
      process.exit(2);
    }
    return require('pg');
  }
}

function readEnvFile() {
  const envPath = path.join(root, '.env.local');
  if (!existsSync(envPath)) return '';
  return require('node:fs').readFileSync(envPath, 'utf8');
}

function envValueFromFile(name) {
  const content = readEnvFile();
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[1] === name) {
      let v = m[2];
      if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  return '';
}

function projectRefFromEnvFile() {
  const url = envValueFromFile('NEXT_PUBLIC_SUPABASE_URL');
  try {
    return new URL(url).hostname.split('.')[0];
  } catch {
    return '';
  }
}

function buildConnectionString() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!password) {
    console.error(
      'Missing database credentials. Set either:\n' +
        '  SUPABASE_DB_URL  = full pooler connection string, or\n' +
        '  SUPABASE_DB_PASSWORD (+ optional SUPABASE_DB_HOST / SUPABASE_PROJECT_REF)',
    );
    process.exit(2);
  }
  const ref = process.env.SUPABASE_PROJECT_REF || projectRefFromEnvFile() || 'zqgjpcjqmblqhqkhfdwc';
  const host = process.env.SUPABASE_DB_HOST || 'aws-0-ap-south-1.pooler.supabase.com';
  const port = process.env.SUPABASE_DB_PORT || '5432';
  return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${host}:${port}/postgres`;
}

const connectionString = buildConnectionString();
const pg = loadPg();
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log('Connected. Applying Build 27 migrations …\n');
  for (const file of FILES) {
    const sql = await readFile(path.join(root, 'supabase', 'migrations', file), 'utf8');
    process.stdout.write(`  ${file} … `);
    await client.query(sql);
    console.log('OK');
  }
  console.log('\nAll 3 Build 27 migrations applied successfully.');
} catch (err) {
  console.error('\nMigration failed:');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
