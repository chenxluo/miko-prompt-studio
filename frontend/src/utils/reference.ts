import type { Task, TaskVersion } from '../types';

export function formatTaskReference(task: Task & { versions?: TaskVersion[] }): string {
  const directLabel = task.current_version?.version_label?.trim();
  if (directLabel) {
    return `${task.name}@${directLabel}`;
  }

  const currentVersionId = task.current_version_id ?? task.current_version?.task_version_id;
  if (currentVersionId && task.versions) {
    const matched = task.versions.find(
      (version) => version.task_version_id === currentVersionId,
    );
    const matchedLabel = matched?.version_label?.trim();
    if (matchedLabel) {
      return `${task.name}@${matchedLabel}`;
    }
  }

  return task.name;
}
