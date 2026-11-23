import type { RouteOverrides } from "../../../../shared/routing-rules";
import type { ProjectMcpServer, SubchatCheck, TicketTracker } from "../../../../types/ipc.generated";

/** The slice of a `list_projects` row the settings rows read. */
export interface ProjectCfg {
  id: string;
  path: string;
  preferred_account_id?: string | null;
  claude_ai_connectors?: boolean;
  mcp_servers?: ProjectMcpServer[];
  tracker?: TicketTracker | null;
  default_model?: string | null;
  default_effort?: string | null;
  subchat_check?: SubchatCheck;
  payment_group?: string | null;
  routing_overrides?: RouteOverrides;
}
