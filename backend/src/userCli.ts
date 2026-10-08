import dotenv from 'dotenv';
import { loadConfig, ConfigError } from './config';
import { createPool } from './db';
import { passwordProblem } from './passwords';
import { FIRST_USERNAME, parseUsername, resetAdminPassword } from './users';

dotenv.config();

/**
 * The locked-out owner's way back in (docs/adr/0010), run inside api by deploy.sh:
 *
 *   printf '%s\n' "$PASSWORD" | node dist/userCli.js reset-admin-password [USERNAME]
 *
 * USERNAME, `admin` unless given, becomes an enabled Admin with the new password, and is created if
 * it does not exist (when no Admin is left, say). Every session it held ends. The password comes on
 * stdin, never on a command line any process on the host can read, and is never printed.
 */

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

async function main(): Promise<void> {
  const [command, rawUsername = FIRST_USERNAME, ...rest] = process.argv.slice(2);
  if (command !== 'reset-admin-password' || rest.length > 0) {
    console.error('Usage: printf "%s\\n" "$PASSWORD" | userCli.js reset-admin-password [USERNAME]');
    process.exit(2);
  }
  const name = parseUsername(rawUsername);
  if ('error' in name) {
    console.error(`Refused: ${name.error}`);
    process.exit(1);
  }
  // The first line, as a hidden prompt or a pipe gives it; a CRLF from PowerShell loses its CR.
  const password = (await readStdin()).split('\n')[0].replace(/\r$/, '');
  const problem = passwordProblem(password);
  if (problem !== undefined) {
    console.error(`Refused: ${problem}`);
    process.exit(1);
  }
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const pool = createPool(config.database);
  try {
    const { done, username } = await resetAdminPassword(pool, name.username, password, new Date());
    console.log(
      done === 'created'
        ? `Created ${username}, an Admin, with the new password. Sign in with it on the site.`
        : `${username} is an enabled Admin with the new password; its sessions have ended. Sign in with it on the site.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
