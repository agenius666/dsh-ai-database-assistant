/**
 * Mapping from engine outcome to the task-level status vocabulary.
 *
 * Task status and exception review status are deliberately different axes:
 * a task can be `incomplete` while every finding the run did produce is `confirmed`.
 *
 * @module src/engine/status
 */

/** Map one engine result status onto a run status. */
const RUN_STATUS_BY_ENGINE_STATUS = Object.freeze({
  succeeded: 'passed',
  exceptions: 'exceptions',
  incomplete: 'incomplete',
  undetermined: 'undetermined',
});

/**
 * Derive the persisted run status from an engine result.
 *
 * @param {{status: string, exceptions?: unknown[]}} result engine result.
 * @returns {string} run status.
 */
export function deriveRunStatus(result) {
  return RUN_STATUS_BY_ENGINE_STATUS[result?.status] ?? 'undetermined';
}
