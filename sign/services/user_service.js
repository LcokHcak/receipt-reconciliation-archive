const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcrypt');

const { ensureDir } = require('../lib/workbench_utils');

// 生产只保留 3 个员工角色：管理员、审核、财务。
const VALID_USER_ROLES = Object.freeze([
  'admin',        // 系统管理员（全部权限 + 用户管理）
  'reviewer',     // 审核员（收件 / 审核台 / 团号匹配 / remedy / 发布）
  'finance',      // 财务（月度页 / 账单 / 对账 / 导出）
]);

// admin 后台添加员工时，只展示新的 3 个核心角色
const PUBLIC_USER_ROLES = Object.freeze([
  'admin',
  'reviewer',
  'finance',
]);

// 旧角色 → 新角色的标准化映射（运行时鉴权用）
const LEGACY_ROLE_MAP = Object.freeze({});

function normalizeRoleForAuth(role) {
  return role;
}

const BCRYPT_ROUNDS = 10;

function normalizeUsername(username) {
  return String(username || '').trim();
}

function assertValidRole(role) {
  if (!VALID_USER_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
}

function assertValidPassword(password) {
  if (String(password || '').length < 6) {
    throw new Error('Password must be at least 6 characters');
  }
}

function toPublicUser(row) {
  if (!row) {
    return null;
  }
  const user = { ...row };
  delete user.password_hash;
  return user;
}

class UserService {
  constructor({ dbPath, db } = {}) {
    if (!db && !dbPath) {
      throw new Error('dbPath is required');
    }
    if (dbPath) {
      ensureDir(path.dirname(dbPath));
    }
    this.db = db || new DatabaseSync(dbPath);
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'reviewer',
        display_name TEXT,
        email TEXT,
        agent_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        is_active INTEGER DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    `);

    // 历史库可能没有 agent_code 列：尝试 ALTER，已存在就忽略
    try {
      this.db.exec('ALTER TABLE users ADD COLUMN agent_code TEXT');
    } catch (_e) { /* column already exists */ }

    this.insertUserStmt = this.db.prepare(`
      INSERT INTO users (username, password_hash, role, display_name, email, agent_code, created_at, updated_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    this.getByUsernameStmt = this.db.prepare('SELECT * FROM users WHERE username = ?');
    this.getByIdStmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    this.listUsersStmt = this.db.prepare('SELECT * FROM users ORDER BY created_at ASC, id ASC');
    this.countUsersStmt = this.db.prepare('SELECT COUNT(1) AS count FROM users');
    this.updateLastLoginStmt = this.db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?');
    this.softDeleteStmt = this.db.prepare('UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?');
  }

  async createUser(username, password, role = 'reviewer', options = {}) {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      throw new Error('username is required');
    }
    assertValidPassword(password);
    assertValidRole(role);

    if (this.getByUsernameStmt.get(normalizedUsername)) {
      throw new Error(`User already exists: ${normalizedUsername}`);
    }

    const now = new Date().toISOString();
    const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const result = this.insertUserStmt.run(
      normalizedUsername,
      passwordHash,
      role,
      options.displayName || options.display_name || '',
      options.email || '',
      options.agentCode || options.agent_code || '',
      now,
      now
    );

    return this.getUserById(Number(result.lastInsertRowid));
  }

  async authenticate(username, password) {
    const row = this.getByUsernameStmt.get(normalizeUsername(username));
    if (!row || row.is_active !== 1 || !VALID_USER_ROLES.includes(row.role)) {
      return null;
    }

    const matches = await bcrypt.compare(String(password || ''), row.password_hash);
    if (!matches) {
      return null;
    }

    const now = new Date().toISOString();
    this.updateLastLoginStmt.run(now, now, row.id);
    return this.getUserById(row.id);
  }

  async getUserById(userId, options = {}) {
    const row = this.getByIdStmt.get(Number(userId));
    return options.includePasswordHash ? row || null : toPublicUser(row);
  }

  async updateUser(userId, updates = {}) {
    const current = this.getByIdStmt.get(Number(userId));
    if (!current) {
      throw new Error(`User not found: ${userId}`);
    }

    const nextRole = updates.role || current.role;
    assertValidRole(nextRole);
    const now = new Date().toISOString();
    const fields = {
      username: updates.username ? normalizeUsername(updates.username) : current.username,
      role: nextRole,
      display_name: updates.displayName ?? updates.display_name ?? current.display_name ?? '',
      email: updates.email ?? current.email ?? '',
      agent_code: updates.agentCode ?? updates.agent_code ?? current.agent_code ?? '',
      is_active: updates.isActive ?? updates.is_active ?? current.is_active,
      updated_at: now,
    };

    if (!fields.username) {
      throw new Error('username is required');
    }

    this.db.prepare(`
      UPDATE users
      SET username = ?, role = ?, display_name = ?, email = ?, agent_code = ?, is_active = ?, updated_at = ?
      WHERE id = ?
    `).run(
      fields.username,
      fields.role,
      fields.display_name,
      fields.email,
      fields.agent_code,
      fields.is_active,
      fields.updated_at,
      Number(userId)
    );

    return this.getUserById(userId);
  }

  async deleteUser(userId) {
    this.softDeleteStmt.run(new Date().toISOString(), Number(userId));
    return this.getUserById(userId);
  }

  async resetPassword(userId, password) {
    const current = this.getByIdStmt.get(Number(userId));
    if (!current) {
      throw new Error(`User not found: ${userId}`);
    }
    assertValidPassword(password);

    const now = new Date().toISOString();
    const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    this.db.prepare(`
      UPDATE users
      SET password_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(passwordHash, now, Number(userId));

    return this.getUserById(userId);
  }

  async listUsers() {
    return this.listUsersStmt.all().map(toPublicUser);
  }

  async getUserCount() {
    return this.countUsersStmt.get().count;
  }

  async ensureBootstrapAdmin({ username, password }) {
    if (await this.getUserCount() > 0) {
      return null;
    }
    return this.createUser(username, password, 'admin', {
      displayName: 'Administrator',
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  BCRYPT_ROUNDS,
  VALID_USER_ROLES,
  PUBLIC_USER_ROLES,
  LEGACY_ROLE_MAP,
  normalizeRoleForAuth,
  UserService,
};
