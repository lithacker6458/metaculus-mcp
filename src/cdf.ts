/**
 * Continuous-question CDF helpers.
 *
 * Metaculus only accepts continuous forecasts as a CDF sampled at
 * (inbound_outcome_count + 1) evenly spaced points across the question's scaled
 * range — 201 points for the default inbound_outcome_count of 200.
 *
 * Everything in this file is a TypeScript port of the algorithms documented in the
 * official Metaculus OpenAPI spec (docs/openapi.yml in the Metaculus/metaculus repo,
 * "How to generate a continuous cdf?" section, accessed 2026-07-12):
 *   - nominal_location_to_cdf_location  (linear + logarithmic scaling)
 *   - generate_continuous_cdf           (percentile sketch -> interpolated CDF)
 *   - the offset/rescale step of standardize_cdf (bound handling + minimum slope)
 *
 * Validity rules enforced (all quoted from the spec, accessed 2026-07-12):
 *   1. strictly increasing by at least 0.01 / inbound_outcome_count per step
 *      (0.00005 for the default 200);
 *   2. no step may increase by more than 0.2 * (200 / inbound_outcome_count);
 *   3. closed lower bound  => cdf[0] must be exactly 0.0;
 *      open lower bound    => cdf[0] must be at least 0.001;
 *      closed upper bound  => cdf[-1] must be exactly 1.0;
 *      open upper bound    => cdf[-1] must be at most 0.999.
 *
 * Note: the spec's ContinuousForecast schema separately mentions a 0.59 max step
 * ("the largest number obtainable via the sliders"); we enforce the stricter 0.2
 * rule from the CDF guide and report it clearly if violated.
 */

export interface QuestionScaling {
  range_min?: number | null;
  range_max?: number | null;
  zero_point?: number | null;
  inbound_outcome_count?: number | null;
}

export interface QuestionForCdf {
  id?: number;
  type?: string; // "numeric" | "date" | "discrete" | ...
  open_lower_bound?: boolean;
  open_upper_bound?: boolean;
  inbound_outcome_count?: number | null;
  scaling?: QuestionScaling | null;
}

const DEFAULT_INBOUND_OUTCOME_COUNT = 200;

function inboundOutcomeCount(q: QuestionForCdf): number {
  return (
    q.scaling?.inbound_outcome_count ??
    q.inbound_outcome_count ??
    DEFAULT_INBOUND_OUTCOME_COUNT
  );
}

/**
 * Convert a nominal value (a number in the question's units, or an ISO 8601
 * datetime string for date questions) to Metaculus's internal [0, 1] location,
 * honoring linear or logarithmic (zero_point) scaling.
 * Port of the spec's `nominal_location_to_cdf_location`.
 */
export function nominalToCdfLocation(
  nominal: number | string,
  question: QuestionForCdf,
): number {
  let scaled: number;
  if (question.type === "date") {
    const ms = Date.parse(String(nominal));
    if (Number.isNaN(ms)) {
      throw new Error(
        `Cannot parse "${nominal}" as an ISO 8601 datetime for a date question. ` +
          `Use e.g. "2027-06-30T00:00:00Z".`,
      );
    }
    scaled = ms / 1000; // spec: range_min/range_max for date questions are unix timestamps
  } else {
    scaled = Number(nominal);
    if (Number.isNaN(scaled)) {
      throw new Error(`Cannot parse "${nominal}" as a number.`);
    }
  }

  const scaling = question.scaling;
  const rangeMin = scaling?.range_min;
  const rangeMax = scaling?.range_max;
  if (rangeMin == null || rangeMax == null) {
    throw new Error(
      `Question ${question.id ?? "?"} has no scaling.range_min/range_max — ` +
        `cannot build a CDF. Fetch the question with get_question and confirm it is a ` +
        `continuous (numeric/date/discrete) question.`,
    );
  }
  const zeroPoint = scaling?.zero_point;
  if (zeroPoint !== null && zeroPoint !== undefined) {
    // logarithmically scaled question
    const derivRatio = (rangeMax - zeroPoint) / (rangeMin - zeroPoint);
    return (
      (Math.log((scaled - rangeMin) * (derivRatio - 1) + (rangeMax - rangeMin)) -
        Math.log(rangeMax - rangeMin)) /
      Math.log(derivRatio)
    );
  }
  // linearly scaled question
  return (scaled - rangeMin) / (rangeMax - rangeMin);
}

/**
 * Build a valid (inbound_outcome_count + 1)-point CDF from a percentile sketch.
 * Port of the spec's `generate_continuous_cdf` plus the offset/rescale step of
 * `standardize_cdf` (which guarantees the minimum-slope and bound rules).
 *
 * @param percentiles map of percentile (0-100, exclusive) -> nominal value,
 *   e.g. { "5": 100, "25": 250, "50": 400, "75": 600, "95": 1200 }.
 *   For date questions, values are ISO 8601 datetime strings.
 * @param belowLowerBound probability mass strictly below the question range
 *   (must be 0/omitted for a closed lower bound).
 * @param aboveUpperBound probability mass strictly above the question range.
 */
export function buildCdfFromPercentiles(
  percentiles: Record<string, number | string>,
  question: QuestionForCdf,
  belowLowerBound?: number,
  aboveUpperBound?: number,
): number[] {
  const count = inboundOutcomeCount(question);
  const points: Array<[number, number]> = [];

  // For CLOSED bounds the spec allows only zero mass outside the range, so when the
  // caller omits the outside-mass hint we default it to the single legal value (0).
  if (belowLowerBound === undefined && question.open_lower_bound === false) belowLowerBound = 0;
  if (aboveUpperBound === undefined && question.open_upper_bound === false) aboveUpperBound = 0;

  if (belowLowerBound !== undefined) points.push([0.0, belowLowerBound]);
  if (aboveUpperBound !== undefined) points.push([1.0, 1 - aboveUpperBound]);

  for (const [key, nominal] of Object.entries(percentiles)) {
    const parts = String(key).split("_");
    const pct = Number(parts[parts.length - 1]);
    if (Number.isNaN(pct) || pct <= 0 || pct >= 100) {
      throw new Error(
        `Percentile key "${key}" must end in a number strictly between 0 and 100.`,
      );
    }
    points.push([nominalToCdfLocation(nominal, question), pct / 100]);
  }

  if (points.length < 2) {
    throw new Error("Provide at least two percentile points to sketch a distribution.");
  }

  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first[0] > 0.0 || last[0] < 1.0) {
    throw new Error(
      "Percentiles must encompass the bounds of the question (spec requirement). " +
        "Your percentile locations span only part of the question's range: either add " +
        "percentiles at/beyond range_min and range_max, or pass probability_below_lower_bound / " +
        "probability_above_upper_bound to state how much mass lies outside the range.",
    );
  }

  // Monotonicity sanity check on the sketch itself.
  for (let i = 1; i < points.length; i++) {
    if (points[i]![1] < points[i - 1]![1]) {
      throw new Error(
        "Percentile sketch is not monotonic: a later location has a lower cumulative " +
          "probability. Check that your percentile values increase with the percentile.",
      );
    }
  }

  const cdfAt = (location: number): number => {
    let prev = points[0]!;
    for (let i = 1; i < points.length; i++) {
      const cur = points[i]!;
      if (prev[0] <= location && location <= cur[0]) {
        if (cur[0] === prev[0]) return cur[1];
        return prev[1] + ((cur[1] - prev[1]) * (location - prev[0])) / (cur[0] - prev[0]);
      }
      prev = cur;
    }
    // location outside sketched range (should not happen after the checks above)
    return location <= points[0]![0] ? points[0]![1] : points[points.length - 1]![1];
  };

  let cdf: number[] = [];
  for (let i = 0; i <= count; i++) cdf.push(cdfAt(i / count));

  cdf = standardizeCdf(cdf, question);
  validateCdf(cdf, question);
  return cdf;
}

/**
 * The offset/rescale step of the spec's `standardize_cdf`: pins closed bounds to
 * exactly 0/1, guarantees >=0.1% mass outside open bounds, and mixes in a 1%
 * uniform component so every step exceeds the minimum slope.
 * (The spec's additional PMF spike-capping step is intentionally NOT applied;
 * spiky inputs fail validation with a clear error instead of being silently reshaped.)
 */
export function standardizeCdf(cdf: number[], question: QuestionForCdf): number[] {
  if (cdf.length === 0) return [];
  const lowerOpen = question.open_lower_bound === true;
  const upperOpen = question.open_upper_bound === true;

  const scaleLowerTo = lowerOpen ? 0 : cdf[0]!;
  const scaleUpperTo = upperOpen ? 1.0 : cdf[cdf.length - 1]!;
  const rescaledInboundMass = scaleUpperTo - scaleLowerTo;
  if (rescaledInboundMass <= 0) {
    throw new Error("Degenerate CDF: no probability mass inside the question range.");
  }

  const standardize = (F: number, location: number): number => {
    const rescaled = (F - scaleLowerTo) / rescaledInboundMass;
    if (lowerOpen && upperOpen) return 0.988 * rescaled + 0.01 * location + 0.001;
    if (lowerOpen) return 0.989 * rescaled + 0.01 * location + 0.001;
    if (upperOpen) return 0.989 * rescaled + 0.01 * location;
    return 0.99 * rescaled + 0.01 * location;
  };

  const n = cdf.length - 1;
  const result = cdf.map((value, i) => standardize(value, i / n));
  // Round to 10 decimal places, as the spec's reference implementation does.
  return result.map((v) => Math.round(v * 1e10) / 1e10);
}

/** Enforce the spec's CDF validity rules; throws with an actionable message. */
export function validateCdf(cdf: number[], question: QuestionForCdf): void {
  const count = inboundOutcomeCount(question);
  if (cdf.length !== count + 1) {
    throw new Error(
      `CDF must have exactly ${count + 1} values for this question ` +
        `(inbound_outcome_count=${count}); got ${cdf.length}.`,
    );
  }
  const lowerOpen = question.open_lower_bound === true;
  const upperOpen = question.open_upper_bound === true;
  const firstVal = cdf[0]!;
  const lastVal = cdf[cdf.length - 1]!;
  const eps = 1e-9;

  if (!lowerOpen && Math.abs(firstVal) > eps) {
    throw new Error(
      `Closed lower bound: cdf[0] must be exactly 0.0 (got ${firstVal}). Any probability of ` +
        `the outcome equalling the lower bound belongs in the first inbound bucket (cdf[1]).`,
    );
  }
  if (lowerOpen && firstVal < 0.001 - eps) {
    throw new Error(
      `Open lower bound: cdf[0] must be at least 0.001 (got ${firstVal}) — at least 0.1% of ` +
        `probability mass must sit below the range.`,
    );
  }
  if (!upperOpen && Math.abs(lastVal - 1.0) > eps) {
    throw new Error(
      `Closed upper bound: the last CDF value must be exactly 1.0 (got ${lastVal}).`,
    );
  }
  if (upperOpen && lastVal > 0.999 + eps) {
    throw new Error(
      `Open upper bound: the last CDF value must be at most 0.999 (got ${lastVal}) — at least ` +
        `0.1% of probability mass must sit above the range.`,
    );
  }

  const minStep = 0.01 / count;
  const maxStep = 0.2 * (DEFAULT_INBOUND_OUTCOME_COUNT / count);
  for (let i = 1; i < cdf.length; i++) {
    const step = cdf[i]! - cdf[i - 1]!;
    if (step < minStep - eps) {
      throw new Error(
        `CDF must be strictly increasing by at least ${minStep} per step ` +
          `(violated at index ${i}: step=${step}). Spread your distribution out slightly.`,
      );
    }
    if (step > maxStep + eps) {
      throw new Error(
        `CDF step at index ${i} is ${step}, above the documented per-step cap of ${maxStep}. ` +
          `Your distribution is too spiky for the API — widen the gap between nearby percentiles.`,
      );
    }
  }
}
