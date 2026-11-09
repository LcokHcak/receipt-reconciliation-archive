const path = require('path');

const { buildWorkbenchStatePayload } = require('./workbench_meta_service');
const { filterBatchesByOperator } = require('../lib/operator_scope');

function createWorkbenchStateService({
  workbenchRoot,
  defaultCustomerLibraryRoot,
  listBatches,
  getSignatureServiceState,
  customerLibraryRepository,
  customerIntakeService,
}) {
  return {
    async getWorkbenchState(operatorUser = null) {
      const batches = await listBatches();
      return buildWorkbenchStatePayload({
        rootDir: workbenchRoot,
        batches: filterBatchesByOperator(batches, operatorUser),
        customerLibrary: {
          activeRoot: customerLibraryRepository.getActiveRoot(),
          defaultRoot: path.resolve(defaultCustomerLibraryRoot),
        },
        signatureService: getSignatureServiceState(),
      });
    },

    getCustomerLibraryState(operatorUser = null) {
      const workspaces = customerIntakeService.listWorkspaces(operatorUser);
      return {
        ok: true,
        ...customerIntakeService.getState(),
        defaultRoot: path.resolve(defaultCustomerLibraryRoot),
        workspaceKey: workspaces.at(-1) || '',
        workspaces,
        months: customerIntakeService.listMonths(operatorUser),
      };
    },
  };
}

module.exports = {
  createWorkbenchStateService,
};
