import type { ActivityEvent } from "@browser-control-mcp/common";
import type { Capability } from "./acl/policy";

export type PopupRequest =
  | { type: "popup-opened"; tabId?: number; url?: string }
  | { type: "set-paused"; paused: boolean; tabId?: number }
  | { type: "approve-once"; tabId: number }
  | { type: "approve-always"; tabId: number }
  | { type: "reject"; tabId: number };

export interface PopupState {
  paused: boolean;
  connections: { port: number; connected: boolean }[];
  pending: Capability[];
  recent: ActivityEvent[];
}
