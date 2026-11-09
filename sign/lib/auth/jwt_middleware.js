const jwt = require('jsonwebtoken');

const TOKEN_COOKIE_NAME = 'token';
const TOKEN_EXPIRES_IN = '24h';
const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CORE_ACCESS_ROLES = Object.freeze(['admin', 'reviewer', 'finance']);

function resolveJwtSecret(options = {}) {
  const secret = options.secret || process.env.JWT_SECRET;
  if (secret) {
    return secret;
  }
  throw new Error('[auth] JWT_SECRET is required. Set it in .env before starting.');
}

function toTokenPayload(user) {
  return {
    userId: user.id,
    username: user.username,
    role: user.role,
  };
}

function generateToken(user, options = {}) {
  return jwt.sign(
    toTokenPayload(user),
    resolveJwtSecret(options),
    { expiresIn: options.expiresIn || TOKEN_EXPIRES_IN }
  );
}

function buildAuthCookieOptions(options = {}) {
  return {
    httpOnly: true,
    // 'lax' 而非 'strict':IP/HTTP 直连、<img> 资源加载等场景 strict 会丢 cookie,
    // 导致部分请求无 token → 401 抖动。lax 对单源应用足够安全,且更稳。
    sameSite: 'lax',
    secure: Boolean(options.secure),
    maxAge: options.maxAge || TOKEN_MAX_AGE_MS,
    path: '/',
  };
}

function setAuthCookie(res, token, options = {}) {
  res.cookie(TOKEN_COOKIE_NAME, token, buildAuthCookieOptions(options));
}

function clearAuthCookie(res) {
  res.cookie(TOKEN_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
}

function authenticateToken(options = {}) {
  return async (req, res, next) => {
    const token = req.cookies?.[TOKEN_COOKIE_NAME];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let payload;
    try {
      payload = jwt.verify(token, resolveJwtSecret(options));
    } catch (_error) {
      // token 过期/无效 = 需要重新登录 → 401(不是 403)。
      // 这样前端拦截器的"401 跳登录"会触发,会话过期自动回登录页,
      // 而不是停在当前页一直填写失败。403 仅保留给"已登录但权限不足"(requireRole)。
      return res.status(401).json({ error: 'Unauthorized', code: 'token_invalid' });
    }

    const userId = Number(payload.userId || payload.id);
    if (options.userService) {
      let user = null;
      try {
        user = await options.userService.getUserById(userId);
      } catch (error) {
        console.error('[auth] failed to refresh token user', error);
      }
      if (!user || user.is_active !== 1 || !CORE_ACCESS_ROLES.includes(user.role)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      req.user = {
        id: user.id,
        userId: user.id,
        username: user.username,
        role: user.role,
      };
      return next();
    }

    req.user = {
      ...payload,
      id: userId,
      userId,
    };
    return next();
  };
}

function normalizeRoleForAccess(role) {
  if (!role) return '';
  return role;
}

function requireRole(...args) {
  let roles;
  let opts = { allowAdmin: true };
  if (Array.isArray(args[0])) {
    roles = args[0];
    opts = { ...opts, ...(args[1] || {}) };
  } else {
    roles = args;
  }

  return (req, res, next) => {
    const role = req.user?.role;
    if (opts.allowAdmin && role === 'admin') {
      return next();
    }
    if (roles.includes(role)) {
      return next();
    }
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

module.exports = {
  TOKEN_COOKIE_NAME,
  TOKEN_EXPIRES_IN,
  TOKEN_MAX_AGE_MS,
  authenticateToken,
  buildAuthCookieOptions,
  clearAuthCookie,
  generateToken,
  normalizeRoleForAccess,
  requireRole,
  resolveJwtSecret,
  setAuthCookie,
};
