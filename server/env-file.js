// A very small, very careful .env writer.
//
// Finch's setup form saves the Plaid keys for the user instead of asking them
// to open a text editor. That means this process edits a file the user also
// owns, so the rules here are deliberately conservative:
//
//   * every line the user wrote — comments, blank lines, key order, unrelated
//     keys like PLAID_PORT and the commented-out CORS_ORIGIN — comes back out
//     byte for byte. Only the lines we were asked to change are rewritten.
//   * writes are atomic: serialise to `<path>.tmp` in the same directory, then
//     rename over the real file. A crash mid-write can't truncate a .env.
//   * the result is chmod 0600. This file holds a Plaid secret.
//   * the path comes from import.meta.url, never process.cwd(), so it is the
//     same .env whatever directory the server happened to be launched from.

import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** The project's .env — server/ is one level down, so the root is its parent. */
export const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

/** Owner read/write only: this file holds the Plaid secret. */
export const ENV_FILE_MODE = 0o600;

/** `KEY=value`, allowing indentation and the `export KEY=` form dotenv also accepts. */
const ENTRY = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Split text into lines that remember their own terminator, so a CRLF file
 * stays CRLF and a file with no trailing newline keeps not having one.
 */
function splitLines(text) {
  if (text === '') return [];

  const lines = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r)?/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    // The regex can match empty at the very end; that's the terminator, not a line.
    if (match[0] === '') break;
    lines.push({ text: match[1], eol: match[2] ?? '' });
    if (pattern.lastIndex >= text.length) break;
  }

  return lines;
}

/** One parsed line. `key` is null for comments, blanks, and anything unparseable. */
function parseLine({ text, eol }) {
  // A comment is a comment even when it looks like `# CORS_ORIGIN=`.
  if (/^\s*(#|$)/.test(text)) return { text, eol, key: null, value: null };

  const match = ENTRY.exec(text);
  if (!match) return { text, eol, key: null, value: null };

  return { text, eol, prefix: match[1], key: match[2], value: match[3] };
}

/**
 * Read a .env into an ordered list of lines.
 *
 * The returned object doubles as a restore point: `raw` is exactly what was on
 * disk (empty string when the file did not exist) and `mode` is its permission
 * bits, so restoreEnvFile() can put things back byte for byte.
 */
export async function readEnvFile(path = ENV_PATH) {
  let raw = null;
  let mode = null;

  try {
    raw = await readFile(path, 'utf8');
    mode = (await stat(path)).mode & 0o777;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  return {
    path,
    exists: raw !== null,
    raw: raw ?? '',
    mode,
    lines: splitLines(raw ?? '').map(parseLine),
  };
}

/** Lines back to text. The inverse of splitLines(). */
function render(lines) {
  return lines.map((line) => line.text + line.eol).join('');
}

/** Write via a temp file in the same directory, then rename. Never a partial .env. */
async function writeAtomic(path, contents, mode) {
  const tmp = `${path}.tmp`;

  try {
    await writeFile(tmp, contents, { encoding: 'utf8', mode });
    // writeFile only applies `mode` when it creates the file; a leftover tmp
    // from an earlier crash could have looser bits, so set them explicitly.
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }

  await chmod(path, mode);
}

/** Values are written raw, so they must not be able to forge a second line. */
function checkPair(key, value) {
  if (!KEY_NAME.test(key)) throw new Error(`"${key}" is not a valid .env key name.`);
  if (typeof value !== 'string') throw new Error(`The value for ${key} must be a string.`);
  if (/[\r\n]/.test(value)) throw new Error(`The value for ${key} can't contain a line break.`);
}

/**
 * Set keys in a .env, in place.
 *
 * Existing keys keep their position (and their `export ` prefix, if any); keys
 * that aren't there yet are appended at the end. Everything else in the file is
 * untouched. Duplicated keys are all updated, so no stale earlier copy is left
 * behind to confuse a reader. Undefined values are skipped.
 *
 * Values go in unquoted — the caller validates the character set, and Plaid's
 * keys are alphanumeric — but a newline or carriage return is rejected outright
 * rather than allowed to inject a line.
 *
 * Returns { updated, added, previous }, where `previous` is the pre-write
 * snapshot from readEnvFile(), ready to hand to restoreEnvFile() on rollback.
 */
export async function upsertEnvValues(path = ENV_PATH, values = {}) {
  const wanted = Object.entries(values).filter(([, value]) => value !== undefined);
  for (const [key, value] of wanted) checkPair(key, value);

  const previous = await readEnvFile(path);
  const lines = previous.lines.map((line) => ({ ...line }));

  // Match the file's own line ending; default to \n for a new or single-line file.
  const eol = [...lines].reverse().find((line) => line.eol)?.eol ?? '\n';

  const updated = [];
  const added = [];

  for (const [key, value] of wanted) {
    let found = false;

    for (const line of lines) {
      if (line.key !== key) continue;
      line.text = `${line.prefix ?? ''}${key}=${value}`;
      line.value = value;
      found = true;
    }

    if (found) {
      updated.push(key);
      continue;
    }

    // Appending: make sure the file currently ends with a newline first.
    if (lines.length && lines[lines.length - 1].eol === '') lines[lines.length - 1].eol = eol;
    lines.push({ text: `${key}=${value}`, eol, key, value, prefix: '' });
    added.push(key);
  }

  await writeAtomic(path, render(lines), ENV_FILE_MODE);

  return { path, updated, added, previous };
}

/**
 * Put a .env back exactly as readEnvFile() found it — same bytes, same mode.
 * If the file did not exist then, it is removed again.
 */
export async function restoreEnvFile(path = ENV_PATH, snapshot) {
  if (!snapshot) throw new Error('restoreEnvFile needs the snapshot readEnvFile returned.');

  if (!snapshot.exists) {
    await unlink(path).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    return;
  }

  await writeAtomic(path, snapshot.raw, snapshot.mode ?? ENV_FILE_MODE);
}
