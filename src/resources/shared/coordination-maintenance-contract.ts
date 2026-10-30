// Project/App: gsd-pi
// File Purpose: Fixed native coordination-maintenance transport contract; no database or writer access.

export type CoordinationMaintenanceCommand = "prepare" | "apply" | "receipt";

export interface CoordinationMaintenanceFrame {
  requestId: string;
  command: CoordinationMaintenanceCommand;
  input: unknown;
}

export interface CoordinationMaintenanceReply {
  status: "prepared" | "committed" | "replayed" | "refused";
  readonly [key: string]: unknown;
}

/** Each method validates its own fixed input shape; none accepts SQL or a callback. */
export interface CoordinationMaintenanceHost {
  prepare(input: unknown): CoordinationMaintenanceReply;
  apply(input: unknown): CoordinationMaintenanceReply;
  receipt(input: unknown): CoordinationMaintenanceReply;
  close(): void;
}

export interface CoordinationMaintenanceHostOptions {
  projectDir: string;
}

export interface CoordinationMaintenanceModule {
  openCoordinationMaintenanceHost(options: CoordinationMaintenanceHostOptions): CoordinationMaintenanceHost;
}
