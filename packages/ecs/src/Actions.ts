// biome-ignore lint/suspicious/noExplicitAny: intentionally generic
export type GenericAction = { tag: number; value: any };

/**
 * Lightweight action class for ECS action system
 * Replaces CustomEvent to eliminate DOM overhead
 */
export class CustomAction<T extends GenericAction> {
  public defaultPrevented = false;

  constructor(public readonly detail: T) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}
