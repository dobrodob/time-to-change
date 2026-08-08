import type { BotState, UserRole } from "../state/schema";

/**
 * The conversion budget is a singleton owned by the instance owner. Return a
 * copy without financial state for every other user-facing surface.
 */
export function budgetStateForRole(state: BotState, role: UserRole): BotState {
  if (role === "owner") return state;
  return {
    ...state,
    budget_target_eur: null,
    budget_deadline: null,
    budget_started_at: null,
    budget_converted_eur: 0,
    budget_converted_usd: 0,
  };
}
