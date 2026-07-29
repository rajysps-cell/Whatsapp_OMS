/**
 * Set a user's OMS password from the server console.
 *
 *   node scripts/set-password.mjs <username> <new-password>
 *   npm run set-password -- admin MyNewPassword123
 *
 * Use this whenever a password is lost or a hand-off file has gone stale — the password is typed
 * by the person who owns it and never travels through a file, a log, or a chat transcript.
 * Signs the user out everywhere and clears any lockout.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH
  ? path.resolve(process.cwd(), process.env.DB_PATH)
  : path.join(here, '..', 'data.sqlite');

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('\nUsage: node scripts/set-password.mjs <username> <new-password>\n');
  console.error('Example: node scripts/set-password.mjs admin MyNewPassword123\n');
  process.exit(1);
}
if (password.length < 8) {
  console.error('\nPassword must be at least 8 characters.\n');
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const user = db.prepare('SELECT id, username, role FROM users WHERE username = ? COLLATE NOCASE').get(username);
if (!user) {
  const all = db.prepare('SELECT username FROM users').all().map((u) => u.username);
  console.error(`\nNo user named "${username}". Existing users: ${all.join(', ') || '(none)'}\n`);
  process.exit(1);
}

const salt = randomBytes(16).toString('hex');
// must_change = 0: this password was chosen by its owner, so there is nothing to force.
db.prepare('UPDATE users SET pass_hash = ?, salt = ?, must_change = 0, active = 1 WHERE id = ?').run(
  scryptSync(password, salt, 64).toString('hex'),
  salt,
  user.id,
);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
db.prepare('DELETE FROM login_attempts WHERE username = ?').run(String(user.username).toLowerCase());

// Read it back and prove the new password verifies before reporting success.
const row = db.prepare('SELECT salt, pass_hash FROM users WHERE id = ?').get(user.id);
const ok = scryptSync(password, row.salt, 64).toString('hex') === row.pass_hash;

console.log(`\n  Password updated for "${user.username}" (${user.role}).`);
console.log(`  Verified: ${ok ? 'yes' : 'NO — something went wrong'}`);
console.log(`  Sign in at https://oms.ysps.shop with this password.\n`);
process.exit(ok ? 0 : 1);
