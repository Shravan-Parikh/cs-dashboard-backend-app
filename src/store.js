/**
 * store.js — tiny file-backed user store.
 *
 * Deliberately dependency-free (JSON on disk) so the POC has no native build
 * step. Swap for Postgres/SQLite when the product grows.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');

function load() {
  if (!existsSync(USERS_FILE)) return { users: [] };
  try {
    return JSON.parse(readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return { users: [] };
  }
}

function save(db) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify(db, null, 2));
}

export function findUserByEmail(email) {
  return load().users.find((u) => u.email.toLowerCase() === email.toLowerCase());
}

export function createUser(user) {
  const db = load();
  db.users.push(user);
  save(db);
  return user;
}

export function countUsers() {
  return load().users.length;
}
