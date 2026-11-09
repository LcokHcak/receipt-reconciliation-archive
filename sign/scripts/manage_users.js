#!/usr/bin/env node

const path = require('node:path');

const { UserService } = require('../services/user_service');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage', 'workbench_v2.db');

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || 'help';
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!String(token).startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = args[index + 1];
    if (!next || String(next).startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }

  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (value === undefined || value === true || String(value).trim() === '') {
    throw new Error(`Missing required option: --${key}`);
  }
  return String(value);
}

function findUserByUsername(users, username) {
  const normalized = String(username || '').trim();
  return users.find((user) => user.username === normalized) || null;
}

function writeJson(stream, payload) {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function getUsage() {
  return [
    'Usage:',
    '  node scripts/manage_users.js list [--db path]',
    '  node scripts/manage_users.js create --username name --password pass --role role [--display-name name] [--email email] [--db path]',
    '  node scripts/manage_users.js update-role --username name --role role [--db path]',
    '  node scripts/manage_users.js reset-password --username name --password pass [--db path]',
    '  node scripts/manage_users.js deactivate --username name [--db path]',
    '  node scripts/manage_users.js bootstrap-admin --username name --password pass [--db path]',
  ].join('\n');
}

async function runUserManagementCli(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;

  let service = null;
  try {
    const { command, options } = parseArgs(argv);
    const dbPath = options.db || env.WORKBENCH_DB_PATH || deps.defaultDbPath || DEFAULT_DB_PATH;

    if (command === 'help' || options.help) {
      stdout.write(`${getUsage()}\n`);
      return 0;
    }

    service = new UserService({ dbPath });

    if (command === 'list') {
      writeJson(stdout, { ok: true, users: await service.listUsers() });
      return 0;
    }

    if (command === 'create') {
      const user = await service.createUser(
        requireOption(options, 'username'),
        requireOption(options, 'password'),
        requireOption(options, 'role'),
        {
          displayName: options['display-name'] || '',
          email: options.email || '',
        }
      );
      writeJson(stdout, { ok: true, user });
      return 0;
    }

    if (command === 'bootstrap-admin') {
      const user = await service.ensureBootstrapAdmin({
        username: requireOption(options, 'username'),
        password: requireOption(options, 'password'),
      });
      writeJson(stdout, { ok: true, created: Boolean(user), user });
      return 0;
    }

    const username = requireOption(options, 'username');
    const user = findUserByUsername(await service.listUsers(), username);
    if (!user) {
      throw new Error(`User not found: ${username}`);
    }

    if (command === 'update-role') {
      const updated = await service.updateUser(user.id, {
        role: requireOption(options, 'role'),
      });
      writeJson(stdout, { ok: true, user: updated });
      return 0;
    }

    if (command === 'reset-password') {
      const updated = await service.resetPassword(user.id, requireOption(options, 'password'));
      writeJson(stdout, { ok: true, user: updated });
      return 0;
    }

    if (command === 'deactivate') {
      const updated = await service.deleteUser(user.id);
      writeJson(stdout, { ok: true, user: updated });
      return 0;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  } finally {
    if (service) {
      service.close();
    }
  }
}

if (require.main === module) {
  runUserManagementCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  DEFAULT_DB_PATH,
  parseArgs,
  runUserManagementCli,
};
