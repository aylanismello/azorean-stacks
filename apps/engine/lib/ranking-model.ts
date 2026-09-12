export const RANKING_FEATURES = [
  "artist",
  "genre",
  "seed",
  "curator",
  "source_context",
  "episode_density",
  "co_occurrence",
  "sonic_similarity",
] as const;

export const RANKING_FEATURE_SCHEMA_VERSION = "production_ranking_features_v1";
export type RankingFeature = (typeof RANKING_FEATURES)[number];
export type RankingWeights = Record<RankingFeature, number>;
export type RankingOutcome = "approved" | "rejected" | "skipped" | "listened";

export interface RankingModel {
  version: string;
  weights: RankingWeights;
  intercept: number;
}

export interface RankingExposure {
  id: string;
  trackId: string;
  exposedAt: string;
  scoreComponents: Record<string, unknown>;
  /** Raw relative score emitted by the production scorer, not a probability. */
  predictedScore?: number | null;
  featureSchemaVersion?: string | null;
}

export interface RankingDecision {
  exposureId: string;
  trackId: string;
  status: RankingOutcome;
  outcomeAt: string;
}

export interface RankingObservation {
  exposureId: string;
  trackId: string;
  exposedAt: string;
  outcomeAt: string;
  outcome: RankingOutcome;
  features: RankingWeights;
  /** Raw relative score shown at exposure time. */
  baselineScore: number | null;
}

export interface RankingMetrics {
  samples: number;
  positives: number;
  negatives: number;
  auc: number | null;
  brier: number | null;
  meanPositiveScore: number | null;
  meanNegativeScore: number | null;
}

export interface ModelComparison {
  before: RankingMetrics;
  after: RankingMetrics;
  aucDelta: number | null;
  brierDelta: number | null;
}

export interface FitOptions {
  includeSkips?: boolean;
  holdoutFraction?: number;
  minHoldout?: number;
  iterations?: number;
  learningRate?: number;
  l2ToBaseline?: number;
}

export interface RankingFitResult {
  model: RankingModel;
  trainSamples: number;
  evaluationSamples: number;
  comparison: ModelComparison;
  trainedThrough: string | null;
}

export const MIN_RANKING_WEIGHT = 0.02;
export const MAX_RANKING_WEIGHT = 0.3;
export const PRODUCTION_WEIGHT_TOTAL = 1.1;
export const MIN_EMPIRICAL_APPLY_SAMPLES = 200;
export const MIN_EMPIRICAL_CLASS_SAMPLES = 40;

/** Mirrors the scorer in update-signals.ts plus the bounded sonic contribution. */
export const DEFAULT_RANKING_MODEL: RankingModel = {
  version: "production_ranking_v1",
  weights: {
    artist: 0.18,
    genre: 0.08,
    seed: 0.24,
    curator: 0.12,
    source_context: 0.18,
    episode_density: 0.12,
    co_occurrence: 0.08,
    sonic_similarity: 0.1,
  },
  intercept: 0,
};

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Production signals are signed; missing evidence is neutral (zero). */
export function normalizeFeatures(components: Record<string, unknown>): RankingWeights {
  const safeComponents = components && typeof components === "object" ? components : {};
  return Object.fromEntries(RANKING_FEATURES.map((feature) => [
    feature,
    clamp(finiteNumber(safeComponents[feature]), -1, 1),
  ])) as RankingWeights;
}

/** Project arbitrary non-negative weights onto the production 1.1-weight simplex. */
export function normalizeWeights(input: Partial<Record<RankingFeature, number>>): RankingWeights {
  const raw = RANKING_FEATURES.map((feature) => Math.max(0, finiteNumber(input[feature])));
  const rawSum = raw.reduce((sum, value) => sum + value, 0);
  const values = raw.map((value, index) => rawSum > 0
    ? value / rawSum * PRODUCTION_WEIGHT_TOTAL
    : DEFAULT_RANKING_MODEL.weights[RANKING_FEATURES[index]]);

  for (let pass = 0; pass < RANKING_FEATURES.length * 4; pass++) {
    for (let index = 0; index < values.length; index++) {
      values[index] = clamp(values[index], MIN_RANKING_WEIGHT, MAX_RANKING_WEIGHT);
    }
    const residual = PRODUCTION_WEIGHT_TOTAL - values.reduce((sum, value) => sum + value, 0);
    if (Math.abs(residual) < 1e-12) break;
    const adjustable = values
      .map((value, index) => ({ value, index }))
      .filter(({ value }) => residual > 0 ? value < MAX_RANKING_WEIGHT : value > MIN_RANKING_WEIGHT);
    if (adjustable.length === 0) break;
    const share = residual / adjustable.length;
    for (const { index } of adjustable) values[index] += share;
  }

  const residue = PRODUCTION_WEIGHT_TOTAL - values.reduce((sum, value) => sum + value, 0);
  const residueIndex = values.findIndex((value) => residue >= 0
    ? value + residue <= MAX_RANKING_WEIGHT
    : value + residue >= MIN_RANKING_WEIGHT);
  if (residueIndex >= 0) values[residueIndex] += residue;

  return Object.fromEntries(RANKING_FEATURES.map((feature, index) => [feature, values[index]])) as RankingWeights;
}

/** Raw production-compatible relative ranking score. */
export function rankingScore(model: RankingModel, features: RankingWeights): number {
  return RANKING_FEATURES.reduce(
    (sum, feature) => sum + model.weights[feature] * features[feature],
    model.intercept,
  );
}

function sigmoid(linear: number): number {
  if (linear >= 0) return 1 / (1 + Math.exp(-linear));
  const exponential = Math.exp(linear);
  return exponential / (1 + exponential);
}

/** Logistic evaluation calibration; production still sorts by rankingScore. */
export function rankingProbability(model: RankingModel, features: RankingWeights): number {
  return sigmoid(rankingScore(model, features));
}

/**
 * Join immutable outcomes to the exact immutable exposure selected when the
 * outcome was recorded. Any mismatched, replayed, incompatible, or non-causal
 * pair fails closed instead of being rematched from mutable current state.
 */
export function buildChronologicalObservations(
  exposures: RankingExposure[],
  decisions: RankingDecision[],
): RankingObservation[] {
  const exposureById = new Map<string, RankingExposure>();
  for (const exposure of exposures) {
    if (!exposure.id || exposureById.has(exposure.id)) continue;
    if (!Number.isFinite(Date.parse(exposure.exposedAt))) continue;
    if ((exposure.featureSchemaVersion ?? RANKING_FEATURE_SCHEMA_VERSION) !== RANKING_FEATURE_SCHEMA_VERSION) continue;
    exposureById.set(exposure.id, exposure);
  }

  const usedExposureIds = new Set<string>();
  const observations: RankingObservation[] = [];
  for (const decision of decisions) {
    if (!["approved", "rejected", "skipped"].includes(decision.status)) continue;
    const exposure = exposureById.get(decision.exposureId);
    const outcomeAt = Date.parse(decision.outcomeAt);
    if (!exposure || usedExposureIds.has(decision.exposureId) || !Number.isFinite(outcomeAt)) continue;
    if (decision.trackId !== exposure.trackId || Date.parse(exposure.exposedAt) >= outcomeAt) continue;
    usedExposureIds.add(decision.exposureId);
    observations.push({
      exposureId: exposure.id,
      trackId: exposure.trackId,
      exposedAt: exposure.exposedAt,
      outcomeAt: decision.outcomeAt,
      outcome: decision.status,
      features: normalizeFeatures(exposure.scoreComponents),
      baselineScore: typeof exposure.predictedScore === "number" && Number.isFinite(exposure.predictedScore)
        ? exposure.predictedScore
        : null,
    });
  }

  return observations.sort((left, right) => {
    const timestampOrder = Date.parse(left.outcomeAt) - Date.parse(right.outcomeAt);
    return timestampOrder || left.exposureId.localeCompare(right.exposureId);
  });
}

function binaryOutcome(outcome: RankingOutcome, includeSkips: boolean): number | null {
  if (outcome === "approved") return 1;
  if (outcome === "rejected" || (includeSkips && outcome === "skipped")) return 0;
  return null;
}

export function rankingMetrics(labels: number[], scores: number[]): RankingMetrics {
  if (labels.length !== scores.length) throw new Error("labels and scores must have equal length");
  if (labels.some((label) => label !== 0 && label !== 1) || scores.some((score) => !Number.isFinite(score))) {
    throw new Error("metrics require binary labels and finite scores");
  }
  const positives = labels.filter((label) => label === 1).length;
  const negatives = labels.length - positives;
  const brier = labels.length === 0 ? null : labels.reduce(
    (sum, label, index) => sum + (scores[index] - label) ** 2,
    0,
  ) / labels.length;

  let auc: number | null = null;
  if (positives > 0 && negatives > 0) {
    let favorablePairs = 0;
    for (let positiveIndex = 0; positiveIndex < labels.length; positiveIndex++) {
      if (labels[positiveIndex] !== 1) continue;
      for (let negativeIndex = 0; negativeIndex < labels.length; negativeIndex++) {
        if (labels[negativeIndex] !== 0) continue;
        favorablePairs += scores[positiveIndex] > scores[negativeIndex]
          ? 1
          : scores[positiveIndex] === scores[negativeIndex] ? 0.5 : 0;
      }
    }
    auc = favorablePairs / (positives * negatives);
  }

  const positiveScores = scores.filter((_, index) => labels[index] === 1);
  const negativeScores = scores.filter((_, index) => labels[index] === 0);
  return {
    samples: labels.length,
    positives,
    negatives,
    auc,
    brier,
    meanPositiveScore: positiveScores.length
      ? positiveScores.reduce((sum, score) => sum + score, 0) / positiveScores.length
      : null,
    meanNegativeScore: negativeScores.length
      ? negativeScores.reduce((sum, score) => sum + score, 0) / negativeScores.length
      : null,
  };
}

export function compareModels(
  observations: RankingObservation[],
  before: RankingModel,
  after: RankingModel,
  includeSkips = true,
): ModelComparison {
  const usable = observations
    .map((observation) => ({ observation, label: binaryOutcome(observation.outcome, includeSkips) }))
    .filter((row): row is { observation: RankingObservation; label: number } => row.label !== null);
  const labels = usable.map((row) => row.label);
  // The frozen production score includes bounded bonuses/penalties outside the
  // tunable vector. Hold that residual fixed while changing only model weights.
  const beforeRaw = usable.map((row) => row.observation.baselineScore
    ?? rankingScore(before, row.observation.features));
  const afterRaw = usable.map((row, index) => {
    const baselineVectorScore = rankingScore(before, row.observation.features);
    const fixedProductionResidual = beforeRaw[index] - baselineVectorScore;
    return rankingScore(after, row.observation.features) + fixedProductionResidual;
  });
  const beforeMetrics = rankingMetrics(labels, beforeRaw.map(sigmoid));
  const afterMetrics = rankingMetrics(labels, afterRaw.map(sigmoid));
  return {
    before: beforeMetrics,
    after: afterMetrics,
    aucDelta: beforeMetrics.auc === null || afterMetrics.auc === null
      ? null : afterMetrics.auc - beforeMetrics.auc,
    brierDelta: beforeMetrics.brier === null || afterMetrics.brier === null
      ? null : beforeMetrics.brier - afterMetrics.brier,
  };
}

/** Fit on a chronological prefix and evaluate only on the later holdout. */
export function fitRankingModel(
  observations: RankingObservation[],
  baseline: RankingModel = DEFAULT_RANKING_MODEL,
  options: FitOptions = {},
): RankingFitResult {
  const includeSkips = options.includeSkips ?? true;
  const usable = [...observations]
    .sort((left, right) => Date.parse(left.outcomeAt) - Date.parse(right.outcomeAt)
      || left.exposureId.localeCompare(right.exposureId))
    .filter((observation) => binaryOutcome(observation.outcome, includeSkips) !== null);
  const holdoutFraction = clamp(options.holdoutFraction ?? 0.25, 0.1, 0.5);
  const minHoldout = Math.max(1, Math.floor(options.minHoldout ?? 40));
  const desiredHoldout = Math.max(minHoldout, Math.ceil(usable.length * holdoutFraction));
  const holdoutSize = usable.length > 1 ? Math.min(desiredHoldout, usable.length - 1) : 0;
  const train = holdoutSize ? usable.slice(0, -holdoutSize) : usable;
  const evaluation = holdoutSize ? usable.slice(-holdoutSize) : [];

  let weights = normalizeWeights(baseline.weights);
  let intercept = clamp(finiteNumber(baseline.intercept, DEFAULT_RANKING_MODEL.intercept), -4, 4);
  const iterations = Math.max(0, Math.floor(options.iterations ?? 600));
  const learningRate = clamp(options.learningRate ?? 0.15, 0.001, 1);
  const l2 = clamp(options.l2ToBaseline ?? 0.05, 0, 1);
  const baselineWeights = normalizeWeights(baseline.weights);

  if (train.length > 0) {
    for (let iteration = 0; iteration < iterations; iteration++) {
      const weightGradients = Object.fromEntries(RANKING_FEATURES.map((feature) => [feature, 0])) as RankingWeights;
      let interceptGradient = 0;
      for (const observation of train) {
        const label = binaryOutcome(observation.outcome, includeSkips)!;
        const error = rankingProbability({ version: baseline.version, weights, intercept }, observation.features) - label;
        interceptGradient += error;
        for (const feature of RANKING_FEATURES) weightGradients[feature] += error * observation.features[feature];
      }
      intercept = clamp(intercept - learningRate * interceptGradient / train.length, -4, 4);
      const updated = {} as RankingWeights;
      for (const feature of RANKING_FEATURES) {
        const regularizedGradient = weightGradients[feature] / train.length
          + l2 * (weights[feature] - baselineWeights[feature]);
        updated[feature] = weights[feature] - learningRate * regularizedGradient;
      }
      weights = normalizeWeights(updated);
    }
  }

  const model: RankingModel = {
    version: "empirical_ranking_v1_candidate",
    weights,
    intercept,
  };
  return {
    model,
    trainSamples: train.length,
    evaluationSamples: evaluation.length,
    comparison: compareModels(evaluation, baseline, model, includeSkips),
    trainedThrough: train.at(-1)?.outcomeAt ?? null,
  };
}

/** Strict, non-overridable evidence floor for any production write. */
export function hasMinimumEvidence(observations: RankingObservation[], minimum = MIN_EMPIRICAL_APPLY_SAMPLES): boolean {
  const floor = Math.max(MIN_EMPIRICAL_APPLY_SAMPLES, minimum);
  const uniqueExposures = new Set(observations.map((row) => row.exposureId));
  const uniqueTracks = new Set(observations.map((row) => row.trackId));
  const positives = observations.filter((row) => row.outcome === "approved").length;
  const explicitNegatives = observations.filter((row) => row.outcome === "rejected").length;
  return observations.length >= floor
    && uniqueExposures.size >= floor
    && uniqueTracks.size >= floor
    && positives >= MIN_EMPIRICAL_CLASS_SAMPLES
    && explicitNegatives >= MIN_EMPIRICAL_CLASS_SAMPLES;
}
