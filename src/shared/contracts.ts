import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "./contracts.schema.json";
import type {
  AsyncCommandResult,
  CaseSnapshot,
  CaseSummary,
  CheckCommand,
  CheckoutCommand,
  CleanupCommand,
  ConsentCommand,
  CreateCaseCommand,
  DraftCommand,
  EmptyCommand,
  Evidence,
  ExitAuthorizationCommand,
  ExitReviewCommand,
  FaultCommand,
  LoginCommand,
  LoginResult,
  ModelRecommendation,
  Operation,
  PauseExitsCommand,
  PolicyCommand,
  PolicyDraft,
  PreviewCommand,
  RecoveryCommand,
  ResetCommand,
  RetryCommand,
  ReturnCommand,
  SampleOutput,
  ScenarioCommand,
  SessionView,
  WhatIfCommand,
  WhatIfResult,
  CatalogueResponse,
} from "./contracts.types";

export type * from "./contracts.types";

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
ajv.addSchema(schema);

/** Compiles one named definition from the shared schema. */
export function validatorFor<T = unknown>(definition: string) {
  return ajv.compile<T>({ $ref: `${schema.$id}#/$defs/${definition}` });
}

export const validate = {
  emptyCommand: validatorFor<EmptyCommand>("EmptyCommand"),
  loginCommand: validatorFor<LoginCommand>("LoginCommand"),
  recoveryCommand: validatorFor<RecoveryCommand>("RecoveryCommand"),
  createCaseCommand: validatorFor<CreateCaseCommand>("CreateCaseCommand"),
  returnCommand: validatorFor<ReturnCommand>("ReturnCommand"),
  sessionView: validatorFor<SessionView>("SessionView"),
  loginResult: validatorFor<LoginResult>("LoginResult"),
  caseSummary: validatorFor<CaseSummary>("CaseSummary"),
  caseSnapshot: validatorFor<CaseSnapshot>("CaseSnapshot"),
  evidence: validatorFor<Evidence>("Evidence"),
  operation: validatorFor<Operation>("Operation"),
  asyncCommandResult: validatorFor<AsyncCommandResult>("AsyncCommandResult"),
  sampleOutput: validatorFor<SampleOutput>("SampleOutput"),
  modelRecommendation: validatorFor<ModelRecommendation>("ModelRecommendation"),
  policyDraft: validatorFor<PolicyDraft>("PolicyDraft"),
  draftCommand: validatorFor<DraftCommand>("DraftCommand"),
  policyCommand: validatorFor<PolicyCommand>("PolicyCommand"),
  checkCommand: validatorFor<CheckCommand>("CheckCommand"),
  scenarioCommand: validatorFor<ScenarioCommand>("ScenarioCommand"),
  previewCommand: validatorFor<PreviewCommand>("PreviewCommand"),
  consentCommand: validatorFor<ConsentCommand>("ConsentCommand"),
  checkoutCommand: validatorFor<CheckoutCommand>("CheckoutCommand"),
  exitReviewCommand: validatorFor<ExitReviewCommand>("ExitReviewCommand"),
  exitAuthorizationCommand: validatorFor<ExitAuthorizationCommand>("ExitAuthorizationCommand"),
  pauseExitsCommand: validatorFor<PauseExitsCommand>("PauseExitsCommand"),
  retryCommand: validatorFor<RetryCommand>("RetryCommand"),
  resetCommand: validatorFor<ResetCommand>("ResetCommand"),
  faultCommand: validatorFor<FaultCommand>("FaultCommand"),
  cleanupCommand: validatorFor<CleanupCommand>("CleanupCommand"),
  whatIfCommand: validatorFor<WhatIfCommand>("WhatIfCommand"),
  whatIfResult: validatorFor<WhatIfResult>("WhatIfResult"),
  catalogueResponse: validatorFor<CatalogueResponse>("CatalogueResponse"),
};
