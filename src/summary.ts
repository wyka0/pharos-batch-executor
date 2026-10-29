import type { ActionResult, PartialFailureSummary } from './types.js';

/** Explicitly summarize failed, successful, and post-failure actions. */
export function summarizePartialFailure(actions: readonly ActionResult[]): PartialFailureSummary {
  const firstFailure = actions.findIndex((action) => action.success === false);
  const afterFailure = firstFailure < 0 ? [] : actions.slice(firstFailure + 1);
  return {
    failedActionIds: actions.filter((action) => action.success === false).map((action) => action.id),
    succeededActionIds: actions.filter((action) => action.success === true).map((action) => action.id),
    unknownActionIds: actions.filter((action) => action.success === null).map((action) => action.id),
    remainingActionsBehavior:
      firstFailure < 0
        ? (actions.every((a) => a.success === true) ? 'No action failed; every action completed.' : 'Execution outcomes are unverified or uncommitted; no success is assumed.')
        : afterFailure.length === 0
          ? 'The failure occurred in the final action; there were no remaining actions.'
          : `Execution continued after action ${firstFailure}; ${afterFailure.filter((a) => a.success === true).length} of ${afterFailure.length} remaining actions succeeded, ${afterFailure.filter((a) => a.success === false).length} failed, and ${afterFailure.filter((a) => a.success === null).length} have unverified outcomes.`,
  };
}
