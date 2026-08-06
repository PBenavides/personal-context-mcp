import {
  ACCURACY_NOTE,
  cardioMet,
  DEFAULT_ENERGY_MODEL,
  estimateWorkoutEnergy,
  muscleRecruitment,
  recruitmentFactor,
  restingEnergy,
  type EnergyModel,
  type EnergyTemplate,
  type EnergyWorkout,
} from './hevy-energy.js';

describe('restingEnergy', () => {
  it('prefers measured lean mass via Katch-McArdle', () => {
    const result = restingEnergy({ weightKg: 80, leanMassKg: 65.6 });
    // 370 + 21.6 x 65.6 = 1787 kcal/day -> 1.24 kcal/min
    expect(result.basis).toBe('katch_mcardle_measured_lean_mass');
    expect(result.kcalPerMinute).toBeCloseTo(1.24, 2);
  });

  it('derives lean mass from body fat when only a percentage is logged', () => {
    const result = restingEnergy({ weightKg: 80, fatPercent: 18 });
    expect(result.basis).toBe('katch_mcardle_derived_lean_mass');
    expect(result.leanMassKg).toBeCloseTo(65.6, 1);
  });

  it('falls back to the MET convention on weight alone, which reads higher', () => {
    const lean = restingEnergy({ weightKg: 80, fatPercent: 18 });
    const weightOnly = restingEnergy({ weightKg: 80 });
    expect(weightOnly.basis).toBe('met_convention_total_weight');
    // 3.5 x 80 / 200 = 1.4 — the ~13% overestimate the lean-mass path exists to avoid.
    expect(weightOnly.kcalPerMinute).toBeCloseTo(1.4, 2);
    expect(weightOnly.kcalPerMinute).toBeGreaterThan(lean.kcalPerMinute);
  });

  it('refuses to invent a body mass', () => {
    expect(() => restingEnergy({})).toThrow(/cannot estimate energy without body mass/);
  });
});

describe('muscle size scaling', () => {
  it('scores a compound push at the 1.0 reference', () => {
    expect(
      muscleRecruitment({ primary: 'chest', secondaries: ['triceps', 'shoulders'] }),
    ).toBeCloseTo(1.0, 2);
  });

  it('ranks a squat above a push above an isolation curl', () => {
    const squat = recruitmentFactor({
      primary: 'quadriceps',
      secondaries: ['glutes', 'hamstrings'],
    });
    const push = recruitmentFactor({ primary: 'chest', secondaries: ['triceps', 'shoulders'] });
    const curl = recruitmentFactor({ primary: 'biceps', secondaries: ['forearms'] });
    expect(squat).toBeGreaterThan(push);
    expect(push).toBeGreaterThan(curl);
  });

  it('clamps both ends so the magnitude never runs away', () => {
    expect(recruitmentFactor({ primary: 'quadriceps', secondaries: ['glutes', 'hamstrings'] })).toBe(
      1.6,
    );
    expect(recruitmentFactor({ primary: 'neck' })).toBe(0.6);
  });

  it('treats an unknown muscle group as "other" rather than zero', () => {
    expect(muscleRecruitment({ primary: 'gills' })).toBe(muscleRecruitment({ primary: 'other' }));
  });
});

describe('cardioMet', () => {
  it('derives running intensity from pace via the ACSM equation', () => {
    // 10 km/h = 166.7 m/min -> VO2 36.8 -> 10.5 METs
    expect(cardioMet(10_000, 3600)).toBeCloseTo(10.5, 1);
  });

  it('uses the walking equation below the running threshold', () => {
    // 5 km/h = 83.3 m/min -> VO2 11.8 -> 3.4 METs
    expect(cardioMet(5000, 3600)).toBeCloseTo(3.4, 1);
  });

  it('returns undefined without both distance and duration', () => {
    expect(cardioMet(undefined, 3600)).toBeUndefined();
    expect(cardioMet(5000, undefined)).toBeUndefined();
  });
});

const TEMPLATES = new Map<string, EnergyTemplate>([
  [
    'bench',
    { title: 'Bench Press', primary_muscle_group: 'chest', secondary_muscle_groups: ['triceps'] },
  ],
  ['curl', { title: 'Bicep Curl', primary_muscle_group: 'biceps' }],
  ['run', { title: 'Running', primary_muscle_group: 'cardio' }],
]);

const HOUR_WORKOUT: EnergyWorkout = {
  id: 'w1',
  title: 'Push',
  start_time: '2026-08-04T18:00:00Z',
  end_time: '2026-08-04T19:00:00Z',
  exercises: [
    {
      title: 'Bench Press',
      exercise_template_id: 'bench',
      sets: [
        { type: 'warmup', weight_kg: 40, reps: 10 },
        { type: 'normal', weight_kg: 80, reps: 8, rpe: 8 },
        { type: 'normal', weight_kg: 80, reps: 8, rpe: 9 },
      ],
    },
  ],
};

const BODY = { weightKg: 80, fatPercent: 18, measuredOn: '2026-08-01' };

describe('estimateWorkoutEnergy', () => {
  it('produces a plausible session total and always carries the accuracy note', () => {
    const result = estimateWorkoutEnergy(HOUR_WORKOUT, TEMPLATES, BODY);
    expect(result.accuracy_note).toBe(ACCURACY_NOTE);
    expect(result.workout_id).toBe('w1');
    expect(result.duration_minutes).toBe(60);
    // An hour of light-volume lifting: well above resting, nowhere near a marathon.
    expect(result.estimated_kcal).toBeGreaterThan(80);
    expect(result.estimated_kcal).toBeLessThan(400);
  });

  it('splits time into active and recovery rather than charging the whole session at lifting MET', () => {
    const result = estimateWorkoutEnergy(HOUR_WORKOUT, TEMPLATES, BODY);
    const breakdown = result.breakdown as Record<string, number>;
    // 26 reps x 3s = 78s under tension; the rest of the hour is recovery.
    expect(breakdown.active_minutes).toBeCloseTo(1.3, 1);
    expect(breakdown.recovery_minutes).toBeCloseTo(58.7, 1);
    expect(breakdown.recovery_kcal).toBeGreaterThan(breakdown.active_kcal);
  });

  it('counts warmup sets, unlike every other Hevy aggregation', () => {
    const withoutWarmup: EnergyWorkout = {
      ...HOUR_WORKOUT,
      exercises: [{ ...HOUR_WORKOUT.exercises![0], sets: HOUR_WORKOUT.exercises![0].sets!.slice(1) }],
    };
    const full = estimateWorkoutEnergy(HOUR_WORKOUT, TEMPLATES, BODY);
    const trimmed = estimateWorkoutEnergy(withoutWarmup, TEMPLATES, BODY);
    expect((full.breakdown as Record<string, number>).active_kcal).toBeGreaterThan(
      (trimmed.breakdown as Record<string, number>).active_kcal,
    );
  });

  it('charges more for the same sets on a bigger muscle group', () => {
    const asCurl: EnergyWorkout = {
      ...HOUR_WORKOUT,
      exercises: [{ ...HOUR_WORKOUT.exercises![0], exercise_template_id: 'curl' }],
    };
    const bench = estimateWorkoutEnergy(HOUR_WORKOUT, TEMPLATES, BODY);
    const curl = estimateWorkoutEnergy(asCurl, TEMPLATES, BODY);
    expect((bench.breakdown as Record<string, number>).active_kcal).toBeGreaterThan(
      (curl.breakdown as Record<string, number>).active_kcal,
    );
  });

  it('reports per-exercise and per-muscle attribution that sums to the active cost', () => {
    const result = estimateWorkoutEnergy(HOUR_WORKOUT, TEMPLATES, BODY);
    const breakdown = result.breakdown as Record<string, unknown>;
    const byExercise = breakdown.by_exercise as Record<string, number>;
    const byMuscle = breakdown.by_primary_muscle_group as Record<string, number>;
    expect(Object.keys(byExercise)).toEqual(['Bench Press']);
    // Secondaries raised the cost via muscleFactor but are not credited kcal, so the split is
    // exhaustive rather than overlapping: triceps must not appear, and the parts sum to the whole.
    expect(Object.keys(byMuscle)).toEqual(['chest']);
    const sum = Object.values(byMuscle).reduce((total, kcal) => total + kcal, 0);
    expect(sum).toBeCloseTo(breakdown.active_kcal as number, 1);
  });

  it('warns when body composition is missing', () => {
    const result = estimateWorkoutEnergy(HOUR_WORKOUT, TEMPLATES, { weightKg: 80 });
    expect(result.warnings.join(' ')).toMatch(/No body composition available/);
  });

  it('warns when the measurement is much older than the workout', () => {
    const result = estimateWorkoutEnergy(HOUR_WORKOUT, TEMPLATES, {
      weightKg: 80,
      fatPercent: 18,
      measuredOn: '2025-05-20',
    });
    expect(result.warnings.join(' ')).toMatch(/days older than this workout/);
    expect((result.basis as Record<string, number>).measurement_age_days).toBeGreaterThan(400);
  });

  it('warns when the clock and the set data disagree, and charges no rest', () => {
    const impossible: EnergyWorkout = {
      ...HOUR_WORKOUT,
      end_time: '2026-08-04T18:00:30Z', // 30s session, but the sets imply 78s
    };
    const result = estimateWorkoutEnergy(impossible, TEMPLATES, BODY);
    expect(result.warnings.join(' ')).toMatch(/shorter than the time the sets imply/);
    expect((result.breakdown as Record<string, number>).recovery_kcal).toBe(0);
  });

  it('warns about sets that record neither reps nor duration', () => {
    const vague: EnergyWorkout = {
      ...HOUR_WORKOUT,
      exercises: [{ title: 'Plank', exercise_template_id: 'bench', sets: [{ type: 'normal' }] }],
    };
    const result = estimateWorkoutEnergy(vague, TEMPLATES, BODY);
    expect(result.warnings.join(' ')).toMatch(/neither reps nor duration/);
  });

  it('warns about an unknown exercise template instead of silently scoring it', () => {
    const unknown: EnergyWorkout = {
      ...HOUR_WORKOUT,
      exercises: [{ title: 'Mystery', exercise_template_id: 'nope', sets: [{ reps: 10 }] }],
    };
    const result = estimateWorkoutEnergy(unknown, TEMPLATES, BODY);
    expect(result.warnings.join(' ')).toMatch(/No exercise template for/);
  });

  it('flags an implausible sustained intensity as a data problem', () => {
    const absurd: EnergyWorkout = {
      id: 'w2',
      start_time: '2026-08-04T18:00:00Z',
      end_time: '2026-08-04T18:10:00Z',
      exercises: [
        {
          title: 'Running',
          exercise_template_id: 'run',
          // 10 km logged as taking 10 minutes: 60 km/h.
          sets: [{ type: 'normal', distance_meters: 10_000, duration_seconds: 600 }],
        },
      ],
    };
    const result = estimateWorkoutEnergy(absurd, TEMPLATES, BODY);
    expect(result.warnings.join(' ')).toMatch(/Implausible intensity/);
  });

  it('handles a workout with no exercises without dividing by zero', () => {
    const empty: EnergyWorkout = { ...HOUR_WORKOUT, exercises: [] };
    const result = estimateWorkoutEnergy(empty, TEMPLATES, BODY);
    expect(result.warnings.join(' ')).toMatch(/logs no exercises/);
    expect(Number.isFinite(result.estimated_kcal)).toBe(true);
  });

  it('lets a caller swap one piece of the model without forking the rest', () => {
    const doubled: EnergyModel = {
      ...DEFAULT_ENERGY_MODEL,
      muscleFactor: () => 2,
    };
    const base = estimateWorkoutEnergy(HOUR_WORKOUT, TEMPLATES, BODY);
    const swapped = estimateWorkoutEnergy(HOUR_WORKOUT, TEMPLATES, BODY, doubled);
    expect((swapped.breakdown as Record<string, number>).active_kcal).toBeGreaterThan(
      (base.breakdown as Record<string, number>).active_kcal,
    );
    // Time accounting is untouched by the swap.
    expect((swapped.breakdown as Record<string, number>).active_minutes).toBe(
      (base.breakdown as Record<string, number>).active_minutes,
    );
  });
});
