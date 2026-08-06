/**
 * Energy-expenditure estimation for a logged Hevy workout. Pure: no client, no I/O — the model
 * is unit-tested directly (`hevy-energy.test.ts`) and `tools.ts` only feeds it fetched data.
 *
 * The model is a sum over time segments of `resting_kcal_per_minute × MET × minutes`, with three
 * deliberate departures from the textbook MET formula:
 *
 *  1. **Resting rate is measured, not assumed.** The MET convention fixes 1 MET at 3.5 mL
 *     O2/kg/min of *total* body mass, which overestimates for anyone carrying fat — fat is close
 *     to inert during exercise. Katch-McArdle derives the resting rate from lean mass instead,
 *     and lean mass is exactly what Hevy's body measurements can supply.
 *  2. **Rest is not lifting.** A logged workout's duration is mostly rest. Charging the whole
 *     session at a lifting MET is the single biggest error in naive estimates, so time is split
 *     into active (under tension) and recovery segments.
 *  3. **Muscle size scales the cost.** A set of squats and a set of wrist curls are not the same
 *     expenditure. Each exercise's MET is scaled by how much muscle it recruits, from the
 *     template's primary and secondary groups.
 *
 * Every piece is swappable: see `EnergyModel` and `DEFAULT_ENERGY_MODEL`. Callers can replace one
 * function without forking the whole calculation.
 *
 * ## Accuracy
 *
 * This is an estimate and it is not a good one in absolute terms — ±20-30% against indirect
 * calorimetry, and resistance training is the weakest case in the literature. It is useful for
 * *relative* comparison (this session against last week's) and misleading as a calorie budget.
 * `ACCURACY_NOTE` travels with every result so the caveat cannot be dropped on the way out.
 */

/** Attached to every estimate. Callers are expected to surface it, not strip it. */
export const ACCURACY_NOTE =
  'Rough estimate, ±20-30% at best. Derived from set/rep/duration data and body mass, not ' +
  'measured — resistance-training estimates are the least reliable kind. Use it to compare ' +
  'sessions with each other, not as a calorie budget.';

export const MODEL_VERSION = 'v1';

// ---------------------------------------------------------------------------
// Body composition -> resting metabolic rate
// ---------------------------------------------------------------------------

export interface BodyComposition {
  weightKg?: number;
  leanMassKg?: number;
  fatPercent?: number;
  /** Date of the measurement these came from, YYYY-MM-DD. */
  measuredOn?: string;
}

export type RestingBasis =
  /** Best: lean mass logged directly. */
  | 'katch_mcardle_measured_lean_mass'
  /** Good: lean mass derived from weight and body-fat percentage. */
  | 'katch_mcardle_derived_lean_mass'
  /** Weakest: no body composition at all, so the population-average MET convention. */
  | 'met_convention_total_weight';

export interface RestingEnergy {
  kcalPerMinute: number;
  basis: RestingBasis;
  leanMassKg?: number;
}

/**
 * Resting kcal/min, personalized as far as the available measurement allows.
 *
 * Degrades in three steps rather than guessing: measured lean mass, lean mass derived from
 * body-fat percentage, then the unpersonalized MET convention. Mifflin-St Jeor is deliberately
 * absent — it needs age, sex and height, none of which the Hevy API exposes.
 */
export function restingEnergy(body: BodyComposition): RestingEnergy {
  const measuredLean = positive(body.leanMassKg);
  const weight = positive(body.weightKg);
  const fat = body.fatPercent;

  const derivedLean =
    measuredLean ??
    (weight !== undefined && typeof fat === 'number' && fat > 0 && fat < 100
      ? weight * (1 - fat / 100)
      : undefined);

  if (derivedLean !== undefined) {
    // Katch-McArdle: RMR kcal/day = 370 + 21.6 x lean mass (kg).
    return {
      kcalPerMinute: (370 + 21.6 * derivedLean) / 1440,
      basis: measuredLean === undefined
        ? 'katch_mcardle_derived_lean_mass'
        : 'katch_mcardle_measured_lean_mass',
      leanMassKg: round2(derivedLean),
    };
  }

  if (weight !== undefined) {
    // 1 MET = 3.5 mL O2/kg/min, and 1 L of O2 releases ~5 kcal => kcal/min = 3.5 x kg / 200.
    return { kcalPerMinute: (3.5 * weight) / 200, basis: 'met_convention_total_weight' };
  }

  throw new Error(
    'cannot estimate energy without body mass: no Hevy body measurement has a weight, and no ' +
      'weight_kg override was passed',
  );
}

// ---------------------------------------------------------------------------
// Muscle size
// ---------------------------------------------------------------------------

/**
 * Relative skeletal-muscle mass per Hevy muscle group, scaled so that a conventional compound
 * push (chest primary; triceps and shoulders secondary) lands on `REFERENCE_RECRUITMENT` = 1.0.
 *
 * These are approximations of muscle-volume proportions, not measurements of Pablo — they carry
 * the ordering (quads dwarf forearms) rather than exact anatomy, which is all the model needs.
 */
export const MUSCLE_MASS_WEIGHTS: Record<string, number> = {
  quadriceps: 1.0,
  glutes: 0.95,
  hamstrings: 0.75,
  lats: 0.7,
  upper_back: 0.65,
  chest: 0.6,
  shoulders: 0.45,
  adductors: 0.45,
  triceps: 0.35,
  calves: 0.35,
  abdominals: 0.3,
  lower_back: 0.3,
  abductors: 0.3,
  biceps: 0.25,
  traps: 0.25,
  forearms: 0.15,
  neck: 0.1,
  full_body: 1.2,
  cardio: 1.0,
  other: 0.5,
};

/** A compound push scores 1.0: chest 0.6 + half of (triceps 0.35 + shoulders 0.45). */
export const REFERENCE_RECRUITMENT = 1.0;

/** Secondary movers do real work but less of it; half weight is the usual rule of thumb. */
export const SECONDARY_WEIGHT = 0.5;

/**
 * Clamp on the muscle-size multiplier. Without it an isolation curl would be scaled to a third
 * of its true cost and a squat to double — the ordering is trustworthy, the magnitude is not.
 */
export const RECRUITMENT_CLAMP: readonly [number, number] = [0.6, 1.6];

export interface MuscleProfile {
  primary?: string;
  secondaries?: string[];
}

/** Raw recruitment score for an exercise, before clamping. */
export function muscleRecruitment(profile: MuscleProfile): number {
  const weightOf = (group?: string): number =>
    MUSCLE_MASS_WEIGHTS[group ?? ''] ?? MUSCLE_MASS_WEIGHTS.other;
  const secondary = (profile.secondaries ?? []).reduce(
    (total, group) => total + weightOf(group),
    0,
  );
  return weightOf(profile.primary) + SECONDARY_WEIGHT * secondary;
}

/** The multiplier actually applied to an exercise's MET. */
export function recruitmentFactor(profile: MuscleProfile): number {
  const [min, max] = RECRUITMENT_CLAMP;
  return clamp(muscleRecruitment(profile) / REFERENCE_RECRUITMENT, min, max);
}

// ---------------------------------------------------------------------------
// MET assignment
// ---------------------------------------------------------------------------

/** Seconds of tension per rep when the set records reps but no duration (~2s down, 1s up). */
export const SECONDS_PER_REP = 3;
/** Fallback active time for a set that records neither reps nor duration. */
export const FALLBACK_SET_SECONDS = 30;
/** Vigorous resistance training, before muscle-size scaling (Compendium of Physical Activities). */
export const RESISTANCE_BASE_MET = 6.0;
/** Between sets: elevated, not resting. */
export const RECOVERY_MET = 1.8;
/** Cardio recorded as duration only, with no distance to derive a speed from. */
export const FALLBACK_CARDIO_MET = 7.0;
/** ACSM switches equations at roughly 8 km/h. */
const RUNNING_THRESHOLD_M_PER_MIN = 134;

/**
 * MET for a cardio effort from its actual pace, via the ACSM walking/running equations, rather
 * than a lookup table — Hevy records distance and duration, so the speed is known.
 */
export function cardioMet(distanceMeters?: number, durationSeconds?: number): number | undefined {
  const distance = positive(distanceMeters);
  const duration = positive(durationSeconds);
  if (distance === undefined || duration === undefined) {
    return undefined;
  }
  const metersPerMinute = distance / (duration / 60);
  // VO2 (mL/kg/min), zero grade; MET is VO2 over the 3.5 resting baseline.
  const vo2 =
    metersPerMinute >= RUNNING_THRESHOLD_M_PER_MIN
      ? 0.2 * metersPerMinute + 3.5
      : 0.1 * metersPerMinute + 3.5;
  return vo2 / 3.5;
}

/** RPE nudges intensity a little; absent RPE means no adjustment. */
export function rpeFactor(rpe?: number | null): number {
  if (typeof rpe !== 'number' || !Number.isFinite(rpe)) {
    return 1;
  }
  return clamp(1 + (rpe - 8) * 0.03, 0.85, 1.15);
}

// ---------------------------------------------------------------------------
// The pluggable model
// ---------------------------------------------------------------------------

export interface EnergySet {
  type?: string;
  reps?: number | null;
  weight_kg?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
}

export interface EnergyExercise {
  title?: string;
  exercise_template_id?: string;
  sets?: EnergySet[];
}

export interface EnergyWorkout {
  id?: string;
  title?: string;
  start_time?: string;
  end_time?: string;
  exercises?: EnergyExercise[];
}

export interface EnergyTemplate {
  title?: string;
  primary_muscle_group?: string;
  secondary_muscle_groups?: string[];
}

export interface SetContext {
  set: EnergySet;
  exercise: EnergyExercise;
  template?: EnergyTemplate;
  isCardio: boolean;
}

/**
 * Every step of the calculation, swappable one at a time. Replace `metForSet` to try a different
 * intensity model, or `muscleFactor` to plug in real per-muscle volumes, without touching the
 * time accounting.
 */
export interface EnergyModel {
  /** Body composition -> resting kcal/min. */
  resting(body: BodyComposition): RestingEnergy;
  /** Seconds under tension for one set. */
  activeSeconds(context: SetContext): number;
  /** MET for one set's active phase, before the muscle-size factor. */
  metForSet(context: SetContext): number;
  /** Muscle-size multiplier for an exercise. */
  muscleFactor(template?: EnergyTemplate): number;
  /** MET charged to the time between sets. */
  recoveryMet(): number;
  /** Post-exercise elevated consumption, as a fraction of the active cost. */
  epocFraction(context: { cardioShare: number }): number;
}

export const DEFAULT_ENERGY_MODEL: EnergyModel = {
  resting: restingEnergy,

  activeSeconds({ set }): number {
    const duration = positive(set.duration_seconds);
    if (duration !== undefined) {
      return duration;
    }
    const reps = positive(set.reps);
    return reps === undefined ? FALLBACK_SET_SECONDS : reps * SECONDS_PER_REP;
  },

  metForSet({ set, isCardio }): number {
    if (isCardio) {
      return (
        cardioMet(set.distance_meters ?? undefined, set.duration_seconds ?? undefined) ??
        FALLBACK_CARDIO_MET
      );
    }
    return RESISTANCE_BASE_MET * rpeFactor(set.rpe);
  },

  muscleFactor(template): number {
    return recruitmentFactor({
      primary: template?.primary_muscle_group,
      secondaries: template?.secondary_muscle_groups,
    });
  },

  recoveryMet(): number {
    return RECOVERY_MET;
  },

  // Resistance work carries a real but modest afterburn; steady cardio much less.
  epocFraction({ cardioShare }): number {
    return 0.08 * (1 - cardioShare) + 0.02 * cardioShare;
  },
};

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

export interface EnergyEstimate {
  workout_id?: string;
  title: string;
  date: string;
  duration_minutes: number | null;
  estimated_kcal: number;
  accuracy_note: string;
  basis: Record<string, unknown>;
  breakdown: Record<string, unknown>;
  warnings: string[];
}

/** Anything odd enough that the caller should see it next to the number. */
interface Accumulator {
  warnings: string[];
}

export function estimateWorkoutEnergy(
  workout: EnergyWorkout,
  templates: Map<string, EnergyTemplate>,
  body: BodyComposition,
  model: EnergyModel = DEFAULT_ENERGY_MODEL,
): EnergyEstimate {
  const acc: Accumulator = { warnings: [] };
  const resting = model.resting(body);

  if (resting.basis === 'met_convention_total_weight') {
    acc.warnings.push(
      'No body composition available (no lean_mass_kg or fat_percent on the latest measurement), ' +
        'so the resting rate is the population-average MET convention rather than Katch-McArdle. ' +
        'Logging body fat in Hevy would personalize this.',
    );
  }
  const measurementAge = daysBetween(body.measuredOn, workout.start_time);
  if (measurementAge !== undefined && measurementAge > 90) {
    acc.warnings.push(
      `The body measurement used is ${measurementAge} days older than this workout ` +
        `(measured ${body.measuredOn}); body mass has probably changed since.`,
    );
  }

  const exercises = workout.exercises ?? [];
  if (exercises.length === 0) {
    acc.warnings.push('This workout logs no exercises, so only session time is charged.');
  }

  let activeSeconds = 0;
  let activeKcal = 0;
  let cardioActiveSeconds = 0;
  const byExercise: Record<string, number> = {};
  const byMuscle: Record<string, number> = {};
  let untimedSets = 0;

  for (const exercise of exercises) {
    const template = templates.get(exercise.exercise_template_id ?? '');
    if (!template && exercise.exercise_template_id) {
      acc.warnings.push(
        `No exercise template for ${JSON.stringify(exercise.title ?? exercise.exercise_template_id)}; ` +
          'it was scored with the default muscle weighting.',
      );
    }
    const isCardio = template?.primary_muscle_group === 'cardio';
    const muscleFactor = model.muscleFactor(template);
    const title = exercise.title ?? 'Unknown';

    // Warmups burn energy too, so unlike every other Hevy aggregation here they are NOT excluded.
    const sets = exercise.sets ?? [];
    let exerciseKcal = 0;

    for (const set of sets) {
      const context: SetContext = { set, exercise, template, isCardio };
      const seconds = model.activeSeconds(context);
      if (
        positive(set.duration_seconds) === undefined &&
        positive(set.reps) === undefined
      ) {
        untimedSets += 1;
      }
      const met = model.metForSet(context) * (isCardio ? 1 : muscleFactor);
      const kcal = resting.kcalPerMinute * met * (seconds / 60);

      activeSeconds += seconds;
      activeKcal += kcal;
      exerciseKcal += kcal;
      if (isCardio) {
        cardioActiveSeconds += seconds;
      }
    }

    byExercise[title] = round1((byExercise[title] ?? 0) + exerciseKcal);
    // Charged wholly to the primary group, so this split sums to exactly `active_kcal`. Secondary
    // movers already raised the cost through `muscleFactor`; splitting the kcal across them too
    // would either double-count or make the parts stop summing to the whole. Hence the field name.
    const primary = template?.primary_muscle_group ?? 'other';
    byMuscle[primary] = round1((byMuscle[primary] ?? 0) + exerciseKcal);
  }

  if (untimedSets > 0) {
    acc.warnings.push(
      `${untimedSets} set(s) record neither reps nor duration; each was charged a flat ` +
        `${FALLBACK_SET_SECONDS}s of work.`,
    );
  }

  const durationMinutes = workoutMinutes(workout);
  const activeMinutes = activeSeconds / 60;

  let recoveryMinutes = 0;
  if (durationMinutes === null) {
    acc.warnings.push(
      'The workout has no usable start/end time, so only time under tension is charged — the ' +
        'rest between sets is missing from this estimate.',
    );
  } else if (durationMinutes < activeMinutes) {
    acc.warnings.push(
      `Logged duration (${round1(durationMinutes)} min) is shorter than the time the sets imply ` +
        `(${round1(activeMinutes)} min); the set data and the clock disagree, so no rest time ` +
        'was charged.',
    );
  } else {
    recoveryMinutes = durationMinutes - activeMinutes;
  }

  const recoveryKcal = resting.kcalPerMinute * model.recoveryMet() * recoveryMinutes;
  const cardioShare = activeSeconds === 0 ? 0 : cardioActiveSeconds / activeSeconds;
  const epocKcal = activeKcal * model.epocFraction({ cardioShare });
  const total = activeKcal + recoveryKcal + epocKcal;

  // A sustained rate this high is not physiological for a whole session; it means the inputs are
  // wrong (a duration in the wrong unit, a mis-logged set) rather than a very hard workout.
  if (durationMinutes !== null && durationMinutes > 0 && total / durationMinutes > 20) {
    acc.warnings.push(
      `Implausible intensity: ${round1(total / durationMinutes)} kcal/min sustained over the ` +
        'session. Check the logged sets and duration — the inputs are more likely wrong than the ' +
        'session that extreme.',
    );
  }

  return {
    workout_id: workout.id,
    title: workout.title ?? 'Untitled',
    date: (workout.start_time ?? '').slice(0, 10),
    duration_minutes: durationMinutes === null ? null : round1(durationMinutes),
    estimated_kcal: Math.round(total),
    accuracy_note: ACCURACY_NOTE,
    basis: {
      model_version: MODEL_VERSION,
      resting_basis: resting.basis,
      resting_kcal_per_minute: round2(resting.kcalPerMinute),
      ...(resting.leanMassKg === undefined ? {} : { lean_mass_kg: resting.leanMassKg }),
      ...(body.weightKg === undefined ? {} : { body_weight_kg: body.weightKg }),
      ...(body.measuredOn === undefined ? {} : { body_measured_on: body.measuredOn }),
      ...(measurementAge === undefined ? {} : { measurement_age_days: measurementAge }),
      muscle_size_scaling: 'MET scaled by recruited muscle mass (primary + half of secondary)',
    },
    breakdown: {
      active_kcal: round1(activeKcal),
      recovery_kcal: round1(recoveryKcal),
      epoc_kcal: round1(epocKcal),
      active_minutes: round1(activeMinutes),
      recovery_minutes: round1(recoveryMinutes),
      by_exercise: byExercise,
      by_primary_muscle_group: byMuscle,
    },
    warnings: acc.warnings,
  };
}

// ---------------------------------------------------------------------------

function positive(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function workoutMinutes(workout: EnergyWorkout): number | null {
  const start = Date.parse(workout.start_time ?? '');
  const end = Date.parse(workout.end_time ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return (end - start) / 60_000;
}

function daysBetween(from?: string, to?: string): number | undefined {
  const a = Date.parse(from ?? '');
  const b = Date.parse(to ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return undefined;
  }
  return Math.round((b - a) / 86_400_000);
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;
