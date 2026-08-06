import {
  buildCustomExerciseBody,
  buildExercise,
  buildExercises,
  buildRepRange,
  buildRoutineBody,
  buildSet,
  buildWorkoutBody,
  HevyPayloadError,
  routineToWriteShape,
  workoutToWriteShape,
} from './hevy-payloads.js';

/** Stand-in resolver: only these two names are known, so ambiguity/misses are testable. */
const KNOWN: Record<string, string> = {
  'bench press (barbell)': '79D0BB3A',
  'squat (barbell)': 'D04AC939',
};
const resolve = (name: string): string => {
  const id = KNOWN[name.trim().toLowerCase()];
  if (!id) {
    throw new HevyPayloadError(`no exercise template matches ${JSON.stringify(name)}`);
  }
  return id;
};

describe('buildSet', () => {
  it('applies aliases and defaults type to normal', () => {
    expect(buildSet({ reps: 10, weight: 60 }, false)).toEqual({
      type: 'normal',
      weight_kg: 60,
      reps: 10,
    });
  });

  it('prefers an explicit canonical key over its alias', () => {
    expect(buildSet({ weight: 1, weight_kg: 60, reps: 5 }, false)).toEqual({
      type: 'normal',
      weight_kg: 60,
      reps: 5,
    });
  });

  it('keeps an explicit null so the field can be cleared', () => {
    expect(buildSet({ reps: 10, weight_kg: null }, false).weight_kg).toBeNull();
  });

  it('omits fields the caller never supplied', () => {
    expect(Object.keys(buildSet({ reps: 5 }, false))).toEqual(['type', 'reps']);
  });

  it.each([6, 7, 7.5, 8, 8.5, 9, 9.5, 10])('accepts rpe %p on workout sets', rpe => {
    expect(buildSet({ reps: 5, rpe }, false).rpe).toBe(rpe);
  });

  it('rejects an off-scale rpe', () => {
    expect(() => buildSet({ reps: 5, rpe: 8.7 }, false)).toThrow(/rpe .* is invalid/);
  });

  it('rejects an unknown set type', () => {
    expect(() => buildSet({ type: 'cooldown' }, false)).toThrow(/set type .* is invalid/);
  });

  it('rejects fractional reps', () => {
    expect(() => buildSet({ reps: 8.5 }, false)).toThrow(/whole number/);
  });

  it('rejects a non-numeric weight', () => {
    expect(() => buildSet({ weight_kg: 'heavy' }, false)).toThrow(/must be a number/);
  });

  it('rejects rpe on routine sets and rep_range on workout sets', () => {
    expect(() => buildSet({ reps: 5, rpe: 8 }, true)).toThrow(/rpe is not supported/);
    expect(() => buildSet({ reps: 5, rep_range: '8-12' }, false)).toThrow(
      /rep_range is not supported/,
    );
  });
});

describe('buildRepRange', () => {
  it.each([
    ['8-12', { start: 8, end: 12 }],
    ['8 to 12', { start: 8, end: 12 }],
    [[6, 10], { start: 6, end: 10 }],
    [{ start: 5, end: 5 }, { start: 5, end: 5 }],
  ])('parses %p', (input, expected) => {
    expect(buildRepRange(input)).toEqual(expected);
  });

  it('rejects an inverted range', () => {
    expect(() => buildRepRange('12-8')).toThrow(/must not be greater than/);
  });

  it('rejects a malformed string', () => {
    expect(() => buildRepRange('8..12')).toThrow(/must look like/);
  });
});

describe('buildExercise', () => {
  it('resolves a name to a template id', () => {
    const built = buildExercise(
      { exercise: 'Bench Press (Barbell)', sets: 1, reps: 5 },
      false,
      resolve,
    );
    expect(built.exercise_template_id).toBe('79D0BB3A');
  });

  it('expands a numeric sets count by repeating the exercise-level set fields', () => {
    const built = buildExercise(
      { exercise_template_id: 'X1', sets: 3, reps: 8, weight_kg: 60 },
      false,
    );
    expect(built.sets).toEqual([
      { type: 'normal', weight_kg: 60, reps: 8 },
      { type: 'normal', weight_kg: 60, reps: 8 },
      { type: 'normal', weight_kg: 60, reps: 8 },
    ]);
  });

  it('treats bare set fields with no sets key as a single set', () => {
    expect(buildExercise({ exercise_template_id: 'X1', reps: 12 }, false).sets).toHaveLength(1);
  });

  it('maps the read-shape supersets_id onto the write-shape superset_id', () => {
    expect(buildExercise({ exercise_template_id: 'X1', supersets_id: 3, reps: 5 }, false))
      .toMatchObject({ superset_id: 3 });
  });

  it('accepts rest_seconds on routines but rejects it on workouts', () => {
    expect(
      buildExercise({ exercise_template_id: 'X1', rest: 90, reps: 5 }, true).rest_seconds,
    ).toBe(90);
    expect(() =>
      buildExercise({ exercise_template_id: 'X1', rest_seconds: 90, reps: 5 }, false),
    ).toThrow(/rest_seconds is a routine planning field/);
  });

  it('rejects an exercise with no identity', () => {
    expect(() => buildExercise({ sets: 1, reps: 5 }, false)).toThrow(
      /requires 'exercise_template_id' or 'exercise'/,
    );
  });

  it('rejects a name when no resolver is available', () => {
    expect(() => buildExercise({ exercise: 'Bench Press (Barbell)', reps: 5 }, false)).toThrow(
      /no resolver is available/,
    );
  });

  it('rejects a sets count with nothing to repeat', () => {
    expect(() => buildExercise({ exercise_template_id: 'X1', sets: 3 }, false)).toThrow(
      /needs set fields/,
    );
  });

  it('rejects an empty sets list', () => {
    expect(() => buildExercise({ exercise_template_id: 'X1', sets: [] }, false)).toThrow(
      /at least one set/,
    );
  });
});

describe('buildExercises', () => {
  it('tags a failure with the index that caused it', () => {
    expect(() =>
      buildExercises([{ exercise_template_id: 'X1', reps: 5 }, { reps: 5 }], false),
    ).toThrow(/exercises\[1\]:/);
  });

  it('rejects a non-list', () => {
    expect(() => buildExercises({ exercise_template_id: 'X1' }, false)).toThrow(
      /'exercises' must be a list/,
    );
  });
});

describe('buildWorkoutBody', () => {
  const exercises = [{ exercise_template_id: 'X1', reps: 5 }];

  it('wraps the body under the workout key', () => {
    const body = buildWorkoutBody({
      title: 'Push',
      startTime: '2026-08-06T18:00:00Z',
      endTime: '2026-08-06T19:00:00Z',
      exercises,
    });
    expect(Object.keys(body)).toEqual(['workout']);
    expect(body.workout).toMatchObject({
      title: 'Push',
      start_time: '2026-08-06T18:00:00Z',
      end_time: '2026-08-06T19:00:00Z',
    });
  });

  it('requires a title and both timestamps', () => {
    expect(() =>
      buildWorkoutBody({ title: '', startTime: 'a', endTime: 'b', exercises }),
    ).toThrow(/requires a title/);
    expect(() =>
      buildWorkoutBody({ title: 'Push', startTime: '', endTime: '', exercises }),
    ).toThrow(/start_time and end_time/);
  });
});

describe('buildRoutineBody', () => {
  const exercises = [{ exercise_template_id: 'X1', reps: 5 }];

  it('sends folder_id null on create, meaning the default folder', () => {
    const body = buildRoutineBody({ title: 'Upper A', exercises });
    expect(Object.keys(body)).toEqual(['routine']);
    expect(body.routine.folder_id).toBeNull();
  });

  it('omits folder_id entirely on update, which the API rejects', () => {
    const body = buildRoutineBody({ title: 'Upper A', exercises, includeFolderId: false });
    expect('folder_id' in body.routine).toBe(false);
  });

  it('refuses a folder change on update rather than silently dropping it', () => {
    expect(() =>
      buildRoutineBody({ title: 'U', exercises, folderId: 1, includeFolderId: false }),
    ).toThrow(/cannot be changed when updating/);
  });
});

describe('buildCustomExerciseBody', () => {
  it('builds a valid body', () => {
    expect(
      buildCustomExerciseBody({
        title: 'Cable Y-Raise',
        exerciseType: 'weight_reps',
        equipmentCategory: 'machine',
        muscleGroup: 'shoulders',
        otherMuscles: ['traps'],
      }).exercise,
    ).toEqual({
      title: 'Cable Y-Raise',
      exercise_type: 'weight_reps',
      equipment_category: 'machine',
      muscle_group: 'shoulders',
      other_muscles: ['traps'],
    });
  });

  it.each([
    ['muscleGroup', { muscleGroup: 'delts' }, /muscle_group/],
    ['equipmentCategory', { equipmentCategory: 'cable' }, /equipment_category/],
    ['exerciseType', { exerciseType: 'weight_and_reps' }, /exercise_type/],
    ['otherMuscles', { otherMuscles: ['delts'] }, /other_muscles/],
  ])('rejects an invalid %s', (_label, override, pattern) => {
    expect(() =>
      buildCustomExerciseBody({
        title: 'X',
        exerciseType: 'weight_reps',
        equipmentCategory: 'machine',
        muscleGroup: 'shoulders',
        ...override,
      }),
    ).toThrow(pattern);
  });
});

describe('read shape to write shape', () => {
  const fetchedRoutine = {
    exercises: [
      {
        index: 0,
        title: 'Bench Press (Barbell)',
        rest_seconds: '90',
        notes: 'controlled',
        exercise_template_id: '79D0BB3A',
        supersets_id: 1,
        sets: [
          { index: 0, type: 'warmup', weight_kg: 20, reps: 10, rep_range: null, rpe: null },
          { index: 1, type: 'normal', weight_kg: 60, reps: 8, rep_range: { start: 6, end: 8 } },
        ],
      },
    ],
  };

  it('strips server-assigned fields and renames the superset key', () => {
    const [exercise] = routineToWriteShape(fetchedRoutine);
    expect(exercise).not.toHaveProperty('index');
    expect(exercise).not.toHaveProperty('title');
    expect(exercise).not.toHaveProperty('supersets_id');
    expect(exercise.superset_id).toBe(1);
  });

  it('coerces the read-side rest_seconds string to an integer', () => {
    expect(routineToWriteShape(fetchedRoutine)[0].rest_seconds).toBe(90);
  });

  it('drops a null rep_range but keeps a real one, and never emits rpe on routines', () => {
    const [exercise] = routineToWriteShape(fetchedRoutine);
    expect(exercise.sets[0]).not.toHaveProperty('rep_range');
    expect(exercise.sets[1].rep_range).toEqual({ start: 6, end: 8 });
    expect(exercise.sets.every(set => !('rpe' in set))).toBe(true);
  });

  it('round-trips a fetched routine back through the builder unchanged in shape', () => {
    const body = buildRoutineBody({
      title: 'Upper A',
      exercises: routineToWriteShape(fetchedRoutine),
      includeFolderId: false,
    });
    expect(body.routine.exercises[0].superset_id).toBe(1);
    expect(body.routine.exercises[0].sets).toHaveLength(2);
  });

  it('preserves workout rpe and emits no rest_seconds', () => {
    const [exercise] = workoutToWriteShape({
      exercises: [
        {
          exercise_template_id: '79D0BB3A',
          supersets_id: null,
          sets: [{ type: 'normal', weight_kg: 60, reps: 8, rpe: 8.5 }],
        },
      ],
    });
    expect(exercise.sets[0].rpe).toBe(8.5);
    expect(exercise).not.toHaveProperty('rest_seconds');
  });
});
