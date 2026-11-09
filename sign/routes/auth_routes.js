const {
  authenticateToken,
  clearAuthCookie,
  generateToken,
  setAuthCookie,
} = require('../lib/auth/jwt_middleware');
const { createRateLimiter } = require('../lib/auth/rate_limiter');

function sendInvalidCredentials(res) {
  return res.status(401).json({ error: 'Invalid credentials' });
}

function registerAuthRoutes({
  app,
  userService,
  jwtSecret,
  cookieSecure = false,
  loginRateLimit = {},
}) {
  if (!app) {
    throw new Error('app is required');
  }
  if (!userService) {
    throw new Error('userService is required');
  }

  const auth = authenticateToken({ secret: jwtSecret, userService });
  const loginLimiter = createRateLimiter({
    windowMs: loginRateLimit.windowMs ?? 60_000,
    max: loginRateLimit.max ?? 5,
    message: '登录尝试过多，请稍后重试',
    ...loginRateLimit,
  });

  app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
    try {
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      if (!username || !password) {
        return sendInvalidCredentials(res);
      }

      const user = await userService.authenticate(username, password);
      if (!user) {
        return sendInvalidCredentials(res);
      }

      const token = generateToken(user, { secret: jwtSecret });
      setAuthCookie(res, token, { secure: cookieSecure });
      return res.json({ ok: true, user });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    clearAuthCookie(res);
    return res.json({ ok: true });
  });

  app.get('/api/auth/me', auth, async (req, res, next) => {
    try {
      const user = await userService.getUserById(req.user.userId);
      if (!user || user.is_active !== 1) {
        clearAuthCookie(res);
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.json({ ok: true, user });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/auth/refresh', auth, async (req, res, next) => {
    try {
      const user = await userService.getUserById(req.user.userId);
      if (!user || user.is_active !== 1) {
        clearAuthCookie(res);
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const token = generateToken(user, { secret: jwtSecret });
      setAuthCookie(res, token, { secure: cookieSecure });
      return res.json({ ok: true, user });
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = {
  registerAuthRoutes,
};
