const { normalizeSourceGroups } = require('./source_group_utils');

function normalizeAttachmentFile(item) {
  return {
    id: String(item?.id || '').trim(),
    originalFileName: String(item?.originalFileName || '').trim(),
    storedRelativePath: String(item?.storedRelativePath || '').trim(),
    extension: String(item?.extension || '').trim().toLowerCase(),
  };
}

function createWorkbenchSourceGroupResponseBuilder({ toStorageUrl }) {
  function buildResponseSourceGroups(batch) {
    const tasksByGroup = new Map();
    (Array.isArray(batch.tasks) ? batch.tasks : []).forEach((task) => {
      const groupKey = String(task?.sourceGroupKey || '').trim();
      if (!tasksByGroup.has(groupKey)) {
        tasksByGroup.set(groupKey, { taskCount: 0, completedCount: 0 });
      }
      const counts = tasksByGroup.get(groupKey);
      counts.taskCount += 1;
      if (task?.machineState === 'completed') {
        counts.completedCount += 1;
      }
    });

    batch.sourceGroups = normalizeSourceGroups(batch.sourceGroups || []);
    return batch.sourceGroups.map((group) => {
      const counts = tasksByGroup.get(group.key) || { taskCount: 0, completedCount: 0 };
      return {
        ...group,
        taskCount: counts.taskCount,
        completedCount: counts.completedCount,
        attachmentFiles: (group.attachmentFiles || []).map((attachment) => {
          const normalized = normalizeAttachmentFile(attachment);
          return {
            ...normalized,
            url: toStorageUrl(batch.id, normalized.storedRelativePath),
          };
        }),
      };
    });
  }

  return {
    buildResponseSourceGroups,
  };
}

module.exports = {
  createWorkbenchSourceGroupResponseBuilder,
  normalizeAttachmentFile,
};
