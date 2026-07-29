export type ModelFailureKind = "cancelled" | "request" | "provider";

export class ModelExecutionError extends Error {
  readonly kind: ModelFailureKind;

  constructor(message: string, kind: ModelFailureKind, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelExecutionError";
    this.kind = kind;
  }
}
