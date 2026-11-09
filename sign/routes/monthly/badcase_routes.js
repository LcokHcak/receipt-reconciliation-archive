'use strict';

/**
 * Badcase surface — internal feedback loop (A1/A2).
 *
 * Lets operators browse every match-time decision the pipeline made
 * (input + normalized + candidates + reason), drill into one to see the
 * full snapshot JSON, and stamp it with a verdict + free-text note so
 * the engineer can later filter to "everything operator marked wrong".
 */

const { workspaceKeyFromReq, clampInt } = require('./route_utils');

const ALLOWED_VERDICTS = Object.freeze(['pending', 'wrong_match', 'should_match', 'acceptable']);

function registerBadcaseRoutes({ app, guards, deps }) {
  const { read, fieldReview } = guards;
  const { matchBadcaseRepo } = deps;

  if (!matchBadcaseRepo) return;

  app.get('/api/monthly/workspaces/:workspaceKey/badcases', ...read, (req, res) => {
    const workspaceKey = workspaceKeyFromReq(req);
    const { stage = null, kind = null, verdict = null, ruleVersion = null } = req.query;
    const limit = clampInt(req.query.limit, 1, 500, 100);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    const filters = {
      workspaceKey,
      stage: stage || null,
      kind: kind || null,
      verdict: verdict || null,
      ruleVersion: ruleVersion || null,
    };
    const rows = matchBadcaseRepo.list({ ...filters, limit, offset });
    const total = matchBadcaseRepo.count(filters);
    res.json({ rows, total });
  });

  app.get(
    '/api/monthly/workspaces/:workspaceKey/badcases/summary',
    ...read,
    (req, res) => {
      const workspaceKey = workspaceKeyFromReq(req);
      res.json({
        byStageKind: matchBadcaseRepo.summary(workspaceKey),
        byVerdict: matchBadcaseRepo.verdictBreakdown(workspaceKey),
      });
    }
  );

  app.get(
    '/api/monthly/workspaces/:workspaceKey/badcases/:id',
    ...read,
    (req, res) => {
      const workspaceKey = workspaceKeyFromReq(req);
      const row = matchBadcaseRepo.findById({
        id: Number(req.params.id), workspaceKey,
      });
      if (!row) return res.status(404).json({ error: 'badcase not found' });
      res.json(row);
    }
  );

  app.post(
    '/api/monthly/workspaces/:workspaceKey/badcases/:id/verdict',
    ...fieldReview,
    (req, res) => {
      const workspaceKey = workspaceKeyFromReq(req);
      const id = Number(req.params.id);
      const { userNote = null, userVerdict = 'pending' } = req.body || {};
      if (!ALLOWED_VERDICTS.includes(userVerdict)) {
        return res.status(400).json({
          error: `userVerdict must be one of ${ALLOWED_VERDICTS.join(', ')}`,
        });
      }
      const changes = matchBadcaseRepo.setVerdict({
        id, workspaceKey,
        userNote, userVerdict,
        reviewedBy: req.user?.username || 'api',
      });
      res.json({ ok: changes > 0, changes });
    }
  );
}

module.exports = { registerBadcaseRoutes, ALLOWED_VERDICTS };
