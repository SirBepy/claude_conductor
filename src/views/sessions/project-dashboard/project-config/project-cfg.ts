import type { TicketTracker } from "../../../../types/ipc.generated";

/** The slice of a `list_projects` row the settings rows read. */
export interface ProjectCfg {
  id: string;
  path: string;
  preferred_account_id?: string | null;
  claude_ai_connectors?: boolean;
  tracker?: TicketTracker | null;
  keep_running_in_gaming_mode?: boolean;
  default_model?: string | null;
  default_effort?: string | null;
}
