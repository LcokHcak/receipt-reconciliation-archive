'use strict';

/**
 * admin_user_routes — admin 后台用户/员工管理 API。
 *
 * 仅 admin 角色可访问。员工注册由 admin 后台创建（不开放公开注册）。
 *
 *   GET    /api/admin/users              列出所有员工
 *   POST   /api/admin/users              创建新员工
 *   PATCH  /api/admin/users/:id          修改员工资料（含角色 / agent_code / 启用状态）
 *   POST   /api/admin/users/:id/reset-password   重置密码
 *   DELETE /api/admin/users/:id          停用员工（软删除）
 *
 * 字段约定：
 *   username        登录账号
 *   password        密码（至少 6 位，仅创建/重置时）
 *   role            'admin' | 'reviewer' | 'finance'
 *   display_name    中文姓名（"侯丹妮"）
 *   agent_code      员工编号（"9号"），用于收票汇总按员工分 sheet
 *   email           可选
 *   is_active       是否启用（0/1）
 */

const {
  authenticateToken: createAuthenticateToken,
  requireRole: defaultRequireRole,
} = require('../lib/auth/jwt_middleware');
const { PUBLIC_USER_ROLES } = require('../services/user_service');

function resolveTokenMiddleware(auth = {}, userService) {
  if (typeof auth.authenticateToken === 'function') {
    return auth.authenticateToken.length >= 3
      ? auth.authenticateToken
      : auth.authenticateToken({ secret: auth.jwtSecret, userService: auth.userService || userService });
  }
  if (auth.jwtSecret) {
    return createAuthenticateToken({ secret: auth.jwtSecret, userService: auth.userService || userService });
  }
  return null;
}

function createAdminUserRoutes({ userService, auth }) {
  if (!userService) throw new Error('admin_user_routes: userService required');

  const tokenMiddleware = resolveTokenMiddleware(auth, userService);
  const roleGuard = auth?.requireRole || defaultRequireRole;
  const protect = tokenMiddleware && roleGuard
    ? [tokenMiddleware, roleGuard('admin')]
    : [];

  function register(app) {
    app.get('/api/admin/users', ...protect, async (req, res) => {
      try {
        const users = await userService.listUsers();
        // 只暴露 3 个生产角色给 admin UI。
        res.json({ users, roles: PUBLIC_USER_ROLES });
      } catch (error) {
        console.error('[admin_users] list failed', error);
        res.status(500).json({ error: error?.message || 'Failed to list users' });
      }
    });

    app.post('/api/admin/users', ...protect, async (req, res) => {
      try {
        const { username, password, role, displayName, agentCode, email } = req.body || {};
        const user = await userService.createUser(username, password, role || 'reviewer', {
          displayName: displayName || '',
          agentCode: agentCode || '',
          email: email || '',
        });
        res.json({ user });
      } catch (error) {
        console.error('[admin_users] create failed', error);
        res.status(400).json({ error: error?.message || 'Failed to create user' });
      }
    });

    app.patch('/api/admin/users/:id', ...protect, async (req, res) => {
      try {
        const userId = Number(req.params.id);
        const { username, role, displayName, agentCode, email, isActive } = req.body || {};
        const user = await userService.updateUser(userId, {
          username, role, displayName, agentCode, email, isActive,
        });
        res.json({ user });
      } catch (error) {
        console.error('[admin_users] update failed', error);
        res.status(400).json({ error: error?.message || 'Failed to update user' });
      }
    });

    app.post('/api/admin/users/:id/reset-password', ...protect, async (req, res) => {
      try {
        const userId = Number(req.params.id);
        const { password } = req.body || {};
        const user = await userService.resetPassword(userId, password);
        res.json({ user });
      } catch (error) {
        console.error('[admin_users] reset-password failed', error);
        res.status(400).json({ error: error?.message || 'Failed to reset password' });
      }
    });

    app.delete('/api/admin/users/:id', ...protect, async (req, res) => {
      try {
        const userId = Number(req.params.id);
        // 防止删除自己
        if (Number(req.user?.id || req.user?.userId) === userId) {
          return res.status(400).json({ error: '不能停用当前登录账号' });
        }
        const user = await userService.deleteUser(userId);
        res.json({ user });
      } catch (error) {
        console.error('[admin_users] delete failed', error);
        res.status(400).json({ error: error?.message || 'Failed to delete user' });
      }
    });
  }

  return { register };
}

module.exports = { createAdminUserRoutes };
