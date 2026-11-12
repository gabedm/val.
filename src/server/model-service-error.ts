/** Provider failures expose status metadata, never the provider's customer-bearing response body. */
export class ModelServiceError extends Error {
  constructor(
    readonly status: number,
    readonly headers = new Headers(),
    readonly possiblyBilled = false,
  ) {
    super(`The model service returned HTTP ${status}.`);
    this.name = "ModelServiceError";
  }
}
