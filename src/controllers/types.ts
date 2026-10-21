/**
 * A controller tool owns one flow and its matching help section.
 *
 * Adding a controller means implementing this interface and registering the
 * instance in main.ts. The tab bar, auto-detection and show/hide logic stay
 * independent of the update protocol.
 */

export type ControllerId = "xbox" | "gulikit";

export interface Detection {
  detected: boolean;
  /** Short human-readable reason, shown under the controller tabs. */
  detail: string;
}

export interface ControllerTool {
  readonly id: ControllerId;
  readonly tabLabel: string;
  readonly flow: HTMLElement;
  readonly help: HTMLElement;

  /** Read-only detection used by the Auto tab. Must not open or claim a device. */
  detect(): Promise<Detection>;

  /** Called when this flow becomes visible. */
  activate(): void;

  /** Called when another flow becomes visible. */
  deactivate(): void;
}
