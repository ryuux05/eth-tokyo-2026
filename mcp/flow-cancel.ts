export class FlowCancelledError extends Error {
  constructor() {
    super("Owner closed the approval page before submitting a transaction");
    this.name = "FlowCancelledError";
  }
}
