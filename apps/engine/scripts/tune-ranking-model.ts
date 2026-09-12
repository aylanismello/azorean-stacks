#!/usr/bin/env bun
import { getSupabase } from "../lib/supabase";
import {
  DEFAULT_RANKING_MODEL,
  MIN_EMPIRICAL_APPLY_SAMPLES,
  RANKING_FEATURE_SCHEMA_VERSION,
  buildChronologicalObservations,
  fitRankingModel,
  hasMinimumEvidence,
  type RankingDecision,
  type RankingExposure,
  type RankingFitResult,
} from "../lib/ranking-model";

interface Arguments {
  apply: boolean;
  userId: string | null;
  help: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN_HOLDOUT_SAMPLES = 40;
const MIN_HOLDOUT_CLASS_SAMPLES = 10;
const MIN_BRIER_IMPROVEMENT = 0.002;

export function parseArguments(argv: string[]): Arguments {
  const unknown = argv.filter((argument, index) => {
    if (index > 0 && argv[index - 1] === "--user-id") return false;
    return !["--apply", "--user-id", "--help", "-h"].includes(argument);
  });
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const userIdIndex = argv.indexOf("--user-id");
  const userId = userIdIndex >= 0 ? argv[userIdIndex + 1] : null;
  if (userIdIndex >= 0 && !userId) throw new Error("--user-id requires a UUID");
  if (userId && !UUID_PATTERN.test(userId)) throw new Error("--user-id must be a valid UUID");
  return {
    apply: argv.includes("--apply"),
    userId,
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

async function fetchAll(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>,
): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await buildQuery(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

async function resolveUserId(db: any, explicitUserId: string | null): Promise<string> {
  if (explicitUserId) return explicitUserId;
  const exposureUsers = await fetchAll((from, to) => db
    .from("ranking_exposures")
    .select("user_id")
    .order("user_id", { ascending: true })
    .range(from, to));
  const users = [...new Set(exposureUsers.map((row) => row.user_id).filter(Boolean))];
  if (users.length !== 1) {
    throw new Error(users.length === 0
      ? "No prospective ranking exposures found; pass --user-id <uuid>."
      : `Multiple users found (${users.length}); pass --user-id <uuid> to prevent cross-user leakage.`);
  }
  return users[0] as string;
}

function fitQualityFailure(fit: RankingFitResult, label: string): string | null {
  const { before, after, aucDelta, brierDelta } = fit.comparison;
  if (fit.evaluationSamples < MIN_HOLDOUT_SAMPLES
    || before.positives < MIN_HOLDOUT_CLASS_SAMPLES
    || before.negatives < MIN_HOLDOUT_CLASS_SAMPLES
    || after.auc === null
    || after.brier === null) {
    return `invalid_${label}_chronological_holdout`;
  }
  if (brierDelta === null || brierDelta < MIN_BRIER_IMPROVEMENT) {
    return `candidate_did_not_materially_improve_${label}_holdout_brier`;
  }
  if (aucDelta === null || aucDelta < 0) return `candidate_reduced_${label}_holdout_auc`;
  return null;
}

export async function run(argv = process.argv.slice(2), suppliedDb?: any): Promise<{ summary: any; exitCode: number }> {
  const args = parseArguments(argv);
  if (args.help) {
    return {
      summary: {
        usage: "bun apps/engine/scripts/tune-ranking-model.ts [--user-id <uuid>] [--apply]",
        default: "dry-run; --apply records a gated candidate and never changes the production scorer",
        minimumApplySamples: MIN_EMPIRICAL_APPLY_SAMPLES,
        minimumHoldoutSamples: MIN_HOLDOUT_SAMPLES,
        featureSchemaVersion: RANKING_FEATURE_SCHEMA_VERSION,
      },
      exitCode: 0,
    };
  }

  const db = suppliedDb ?? getSupabase();
  const userId = await resolveUserId(db, args.userId);
  const [exposureRows, outcomeRows] = await Promise.all([
    fetchAll((from, to) => db
      .from("ranking_exposures")
      .select("id,track_id,exposed_at,predicted_score,score_components,model_version,feature_schema_version")
      .eq("user_id", userId)
      .order("exposed_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)),
    fetchAll((from, to) => db
      .from("ranking_outcomes")
      .select("exposure_id,track_id,outcome,outcome_at")
      .eq("user_id", userId)
      .order("outcome_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)),
  ]);

  const exposures: RankingExposure[] = exposureRows.map((row) => ({
    id: row.id,
    trackId: row.track_id,
    exposedAt: row.exposed_at,
    predictedScore: row.predicted_score,
    scoreComponents: row.score_components || {},
    modelVersion: row.model_version,
    featureSchemaVersion: row.feature_schema_version,
  }));
  const decisions: RankingDecision[] = outcomeRows.map((row) => ({
    exposureId: row.exposure_id,
    trackId: row.track_id,
    status: row.outcome,
    outcomeAt: row.outcome_at,
  }));
  const observations = buildChronologicalObservations(exposures, decisions);
  // The config table records gated candidates but the production scorer does
  // not consume it yet. Always evaluate against the actual production model;
  // treating a previously recorded candidate as incumbent would fabricate the
  // before/after comparison and silently drift away from live scoring.
  const baseline = DEFAULT_RANKING_MODEL;
  const includingSkips = fitRankingModel(observations, baseline, { includeSkips: true });
  const explicitOnly = fitRankingModel(observations, baseline, { includeSkips: false });
  const evidenceSufficient = hasMinimumEvidence(observations);

  let reason: string | null = null;
  if (!evidenceSufficient) reason = "insufficient_chronology_valid_immutable_evidence";
  else reason = fitQualityFailure(includingSkips, "including_skips")
    ?? fitQualityFailure(explicitOnly, "explicit")
    ?? null;

  const summary: any = {
    schemaVersion: 2,
    status: args.apply ? "refused" : "dry_run",
    applyRequested: args.apply,
    productionWeightsMutated: false,
    userId,
    evidence: {
      immutableExposures: exposures.length,
      immutableOutcomes: decisions.length,
      chronologyValid: observations.length,
      uniqueTracks: new Set(observations.map((row) => row.trackId)).size,
      explicitLabels: observations.filter((row) => row.outcome !== "skipped").length,
      includingSkips: observations.length,
      minimumApplySamples: MIN_EMPIRICAL_APPLY_SAMPLES,
      sufficient: evidenceSufficient,
    },
    leakageControls: {
      featureSource: "immutable_ranking_exposures",
      outcomeSource: "immutable_ranking_outcomes",
      exactExposureAttribution: true,
      exposureMustPrecedeOutcome: true,
      split: "chronological_prefix_train_later_holdout",
      featureSchemaVersion: RANKING_FEATURE_SCHEMA_VERSION,
    },
    baseline,
    candidate: includingSkips.model,
    evaluations: {
      includingSkips: {
        trainSamples: includingSkips.trainSamples,
        holdoutSamples: includingSkips.evaluationSamples,
        trainedThrough: includingSkips.trainedThrough,
        comparison: includingSkips.comparison,
      },
      approvalsVsRejections: {
        trainSamples: explicitOnly.trainSamples,
        holdoutSamples: explicitOnly.evaluationSamples,
        trainedThrough: explicitOnly.trainedThrough,
        comparison: explicitOnly.comparison,
      },
    },
    reason,
  };

  if (args.apply && reason === null) {
    const modelVersion = `empirical_ranking_v1_candidate_${new Date().toISOString()}`;
    const payload = {
      user_id: userId,
      model_version: modelVersion,
      feature_schema_version: RANKING_FEATURE_SCHEMA_VERSION,
      weights: includingSkips.model.weights,
      intercept: includingSkips.model.intercept,
      training_sample_count: includingSkips.trainSamples,
      trained_through: includingSkips.trainedThrough,
      evaluation: {
        including_skips: includingSkips.comparison,
        approvals_vs_rejections: explicitOnly.comparison,
        production_weights_mutated: false,
      },
      updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("user_ranking_model_config").upsert(payload, { onConflict: "user_id" });
    if (error) throw error;

    const verification = await db.from("user_ranking_model_config")
      .select("user_id,model_version,feature_schema_version,weights,intercept,training_sample_count,trained_through")
      .eq("user_id", userId)
      .single();
    if (verification.error) throw verification.error;
    if (verification.data?.model_version !== modelVersion
      || verification.data?.feature_schema_version !== RANKING_FEATURE_SCHEMA_VERSION
      || verification.data?.user_id !== userId
      || verification.data?.training_sample_count !== includingSkips.trainSamples) {
      throw new Error("Recorded ranking candidate could not be verified");
    }
    summary.status = "candidate_recorded";
    summary.recordedCandidateVersion = modelVersion;
    summary.verified = true;
  }

  return { summary, exitCode: args.apply && summary.status === "refused" ? 2 : 0 };
}

if (import.meta.main) {
  run()
    .then(({ summary, exitCode }) => {
      console.log(JSON.stringify(summary));
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(JSON.stringify({
        schemaVersion: 2,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
      process.exitCode = 1;
    });
}
