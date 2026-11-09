const assert = require('node:assert/strict');
const test = require('node:test');

const {
  authenticateToken,
  generateToken,
  requireRole,
  resolveJwtSecret,
} = require('../lib/auth/jwt_middleware');

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('resolveJwtSecret requires JWT_SECRET when no explicit secret is provided', () => {
  const previousSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;

  try {
    assert.throws(
      () => resolveJwtSecret(),
      /JWT_SECRET is required/
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousSecret;
    }
  }
});

test('authenticateToken accepts a valid httpOnly cookie token', async () => {
  const secret = 'test-secret';
  const token = generateToken({ id: 12, username: 'admin', role: 'admin' }, { secret });
  const req = { cookies: { token } };
  const res = createResponse();
  let nextCalled = false;

  await authenticateToken({ secret })(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.user.userId, 12);
  assert.equal(req.user.id, 12);
  assert.equal(req.user.role, 'admin');
});

test('authenticateToken rejects missing and invalid tokens', async () => {
  const missingReq = { cookies: {} };
  const missingRes = createResponse();

  await authenticateToken({ secret: 'test-secret' })(missingReq, missingRes, () => {});
  assert.equal(missingRes.statusCode, 401);
  assert.equal(missingRes.payload.error, 'Unauthorized');

  // 无效/过期 token → 401(需重新登录),前端拦截器据此跳登录页。
  const invalidReq = { cookies: { token: 'bad-token' } };
  const invalidRes = createResponse();
  await authenticateToken({ secret: 'test-secret' })(invalidReq, invalidRes, () => {});
  assert.equal(invalidRes.statusCode, 401);
  assert.equal(invalidRes.payload.error, 'Unauthorized');
});

test('authenticateToken rechecks active core-role users when userService is present', async () => {
  const secret = 'test-secret';
  const token = generateToken({ id: 12, username: 'stale', role: 'reviewer' }, { secret });
  const userService = {
    async getUserById(id) {
      assert.equal(id, 12);
      return { id: 12, username: 'fresh', role: 'finance', is_active: 1 };
    },
  };
  const req = { cookies: { token } };
  const res = createResponse();
  let nextCalled = false;

  await authenticateToken({ secret, userService })(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, {
    id: 12,
    userId: 12,
    username: 'fresh',
    role: 'finance',
  });
});

test('authenticateToken rejects disabled and legacy-role users from the database', async () => {
  const secret = 'test-secret';
  const token = generateToken({ id: 12, username: 'stale', role: 'reviewer' }, { secret });

  const disabledRes = createResponse();
  await authenticateToken({
    secret,
    userService: { async getUserById() { return { id: 12, username: 'stale', role: 'reviewer', is_active: 0 }; } },
  })({ cookies: { token } }, disabledRes, () => {});
  assert.equal(disabledRes.statusCode, 401);
  assert.equal(disabledRes.payload.error, 'Unauthorized');

  const legacyRes = createResponse();
  await authenticateToken({
    secret,
    userService: { async getUserById() { return { id: 12, username: 'legacy', role: 'image_reviewer', is_active: 1 }; } },
  })({ cookies: { token } }, legacyRes, () => {});
  assert.equal(legacyRes.statusCode, 401);
  assert.equal(legacyRes.payload.error, 'Unauthorized');
});

test('requireRole allows admins and matching roles only', () => {
  let explicitAdminAllowed = false;
  requireRole('admin')({ user: { role: 'admin' } }, createResponse(), () => {
    explicitAdminAllowed = true;
  });
  assert.equal(explicitAdminAllowed, true);

  let allowed = false;
  requireRole('reviewer')({ user: { role: 'reviewer' } }, createResponse(), () => {
    allowed = true;
  });
  assert.equal(allowed, true);

  let adminAllowed = false;
  requireRole('reviewer')({ user: { role: 'admin' } }, createResponse(), () => {
    adminAllowed = true;
  });
  assert.equal(adminAllowed, true);

  const deniedRes = createResponse();
  requireRole('reviewer')({ user: { role: 'finance' } }, deniedRes, () => {});
  assert.equal(deniedRes.statusCode, 403);
  assert.equal(deniedRes.payload.error, 'Insufficient permissions');
});

test('requireRole can disable the default admin override for array roles', () => {
  const adminRes = createResponse();
  requireRole(['finance'], { allowAdmin: false })(
    { user: { role: 'admin' } },
    adminRes,
    () => {
      throw new Error('admin should not satisfy finance when allowAdmin is false');
    }
  );
  assert.equal(adminRes.statusCode, 403);
  assert.equal(adminRes.payload.error, 'Insufficient permissions');

  let financeAllowed = false;
  requireRole(['finance'], { allowAdmin: false })(
    { user: { role: 'finance' } },
    createResponse(),
    () => {
      financeAllowed = true;
    }
  );
  assert.equal(financeAllowed, true);

  const reviewerRes = createResponse();
  requireRole(['finance'], { allowAdmin: false })(
    { user: { role: 'reviewer' } },
    reviewerRes,
    () => {
      throw new Error('reviewer should not satisfy finance');
    }
  );
  assert.equal(reviewerRes.statusCode, 403);
  assert.equal(reviewerRes.payload.error, 'Insufficient permissions');
});

test('requireRole rejects legacy roles instead of mapping them to reviewer and finance', () => {
  for (const role of ['intake', 'image_reviewer', 'field_reviewer']) {
    const res = createResponse();
    requireRole('reviewer')({ user: { role } }, res, () => {
      throw new Error(`${role} should not satisfy reviewer`);
    });
    assert.equal(res.statusCode, 403);
  }

  const finalApproverRes = createResponse();
  requireRole('finance')({ user: { role: 'final_approver' } }, finalApproverRes, () => {
    throw new Error('final_approver should not satisfy finance');
  });
  assert.equal(finalApproverRes.statusCode, 403);

  const deniedRes = createResponse();
  requireRole('finance')({ user: { role: 'viewer' } }, deniedRes, () => {});
  assert.equal(deniedRes.statusCode, 403);
});
