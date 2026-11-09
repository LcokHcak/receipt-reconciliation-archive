const { forwardAsync } = require('./handler_utils')

function createWorkbenchStateHandlers({ workbenchStateService, myTodoService }) {
  function getHealth(_req, res) {
    res.json({ ok: true, now: new Date().toISOString() })
  }

  const getState = forwardAsync(async (req, res) => {
    res.json(await workbenchStateService.getWorkbenchState(req.user || null))
  })

  const getMyTodos = forwardAsync(async (req, res) => {
    const role = String(req.user?.role || 'reviewer').trim() || 'reviewer'
    const payload = await myTodoService.getMyTodos({ role, operatorUser: req.user || null })
    return res.json({
      ok: true,
      user: req.user ? { id: req.user.id, username: req.user.username, role } : null,
      ...payload,
    })
  })

  return {
    getHealth,
    getMyTodos,
    getState,
  }
}

module.exports = {
  createWorkbenchStateHandlers,
}
