import type { ToolTarget } from "../keys";

export type EngineAction =
  | { readonly kind: "session-start"; readonly source: string | undefined }
  | { readonly kind: "prompt"; readonly prompt: string }
  | { readonly kind: "tool-recall"; readonly target: ToolTarget }
  | {
      readonly kind: "command-failed";
      readonly toolInput: unknown;
      readonly error: string | undefined;
      readonly interrupted: boolean;
    }
  | { readonly kind: "command-passed"; readonly toolInput: unknown }
  | { readonly kind: "feedback-receipt"; readonly toolInput: unknown }
  | { readonly kind: "store-receipt" }
  | { readonly kind: "stop"; readonly stopHookActive: boolean };

export interface HookRequest {
  readonly event: string;
  readonly scope: "session" | "project";
  readonly sessionId: string | undefined;
  readonly cwd: string | undefined;
  readonly actions: readonly EngineAction[];
}

export type HostInput = Readonly<Record<string, unknown>>;

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function fieldOf(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null && field in value
    ? (value as HostInput)[field]
    : undefined;
}
