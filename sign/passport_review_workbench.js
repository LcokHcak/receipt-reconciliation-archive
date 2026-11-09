require('dotenv').config()

const { handleStartupFailure, startWorkbenchServer } = require('./workbench_server')

if (require.main === module) {
  startWorkbenchServer().catch(handleStartupFailure)
}

module.exports = {
  startWorkbenchServer,
}
