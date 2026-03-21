export { scoreCustomerFit, type CustomerFitResult, type CustomerFitLabel } from "./customerFitService";
export { scoreQuoteWorthiness, type QuoteWorthinessResult, type QuoteWorthinessLabel } from "./quoteWorthinessService";
export { generateRecommendation, type RecommendationResult, type Recommendation } from "./recommendationService";
export { scoreConfidence, type ConfidenceResult, type ConfidenceLabel } from "./confidenceService";
export { classifySuburb, isCoreSuburb, isServiceArea, type SuburbGroup } from "./suburbGroupService";
export { detectRepeatCustomer, normalizePhone, normalizeEmail, addressMatches, type RepeatCustomerResult } from "./repeatCustomerService";
export { runScoringPipeline, type ScoringPipelineResult } from "./scoringPipelineService";
export { scoreAndSyncJob, type SyncResult } from "./jobScoringSync";
