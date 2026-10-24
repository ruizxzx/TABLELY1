#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = join(projectRoot, 'supabase', 'migrations');
const files = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql'));
const versions = new Map();
const invalidTimestamps = [];

for (const file of files) {
  const match = file.match(/^(\d+)_(.+)\.sql$/);
  if (!match) {
    invalidTimestamps.push(`${file} (missing numeric version prefix)`);
    continue;
  }

  const [, version] = match;
  const entries = versions.get(version) ?? [];
  entries.push(file);
  versions.set(version, entries);

  // Older migrations in this repository use short numeric versions. Validate
  // date/time structure for the timestamp formats used by modern migrations.
  if (version.length === 12 || version.length === 14) {
    const year = Number(version.slice(0, 4));
    const month = Number(version.slice(4, 6));
    const day = Number(version.slice(6, 8));
    const hour = Number(version.slice(8, 10));
    const minute = Number(version.slice(10, 12));
    const second = version.length === 14 ? Number(version.slice(12, 14)) : 0;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
        || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
      invalidTimestamps.push(`${file} (invalid ${version.length}-digit timestamp)`);
    }
  }
}

const duplicates = [...versions.entries()].filter(([, entries]) => entries.length > 1);
if (duplicates.length || invalidTimestamps.length) {
  console.error('Supabase migration version preflight failed.');
  for (const [version, entries] of duplicates) console.error(`Duplicate version ${version}: ${entries.join(', ')}`);
  for (const item of invalidTimestamps) console.error(`Invalid migration filename: ${item}`);
  process.exitCode = 1;
} else {
  console.log(`Migration version preflight passed (${files.length} SQL files; ${versions.size} unique numeric versions).`);
}
