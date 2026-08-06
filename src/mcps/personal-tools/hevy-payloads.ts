/**
 * Request-body construction for Hevy writes. Pure: no client, no I/O, no network — so the
 * payload rules are unit-tested directly (`hevy-payloads.test.ts`) and the same builders back
 * both the create and update paths in `tools.ts`.
 *
 * Two Hevy quirks this module exists to hide:
 *
 *  - Reads return `supersets_id`; writes expect `superset_id`. `routineToWriteShape` translates,
 *    so supersets survive a read-edit-write round trip instead of being silently dropped.
 *  - There is no PATCH. `PUT` replaces the whole object, so anything absent from the payload is
 *    deleted — partial updates must re-send everything, which is what `routineToWriteShape`
 *    enables.
 *
 * Field support differs by target, and sending the wrong one is a 400:
 *
 *    workout sets  type, weight_kg, reps, distance_meters, duration_seconds, custom_metric, rpe
 *    routine sets  type, weight_kg, reps, distance_meters, duration_seconds, custom_metric,
 *                  rep_range
 *
 * The routine is the only write target today — `hevy_write_workout` and
 * `hevy_create_custom_exercise` were retired on 2026-08-06 and their body builders deleted with
 * them. The `forRoutine` flag and its workout branch stay because the distinction is real in the
 * API and the rules are cheaper to keep than to re-derive.
 */

/** Enum values mirrored from the Hevy OpenAPI spec (https://api.hevyapp.com/docs). */
export const SET_TYPES = ['warmup', 'normal', 'failure', 'dropset'] as const;
export const RPE_VALUES = [6, 7, 7.5, 8, 8.5, 9, 9.5, 10] as const;

export const MUSCLE_GROUPS = [
  'abdominals', 'shoulders', 'biceps', 'triceps', 'forearms', 'quadriceps', 'hamstrings',
  'calves', 'glutes', 'abductors', 'adductors', 'lats', 'upper_back', 'traps', 'lower_back',
  'chest', 'cardio', 'neck', 'full_body', 'other',
] as const;

export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

/** Measurement fields shared by workout and routine sets. */
const COMMON_SET_FIELDS = [
  'weight_kg', 'reps', 'distance_meters', 'duration_seconds', 'custom_metric',
] as const;

const INTEGER_SET_FIELDS = new Set<string>(['reps', 'distance_meters', 'duration_seconds']);

/** Aliases so callers can write the obvious thing; a canonical key always wins over its alias. */
const SET_ALIASES: Record<string, string> = {
  weight: 'weight_kg',
  kg: 'weight_kg',
  repetitions: 'reps',
  set_type: 'type',
  distance: 'distance_meters',
  duration: 'duration_seconds',
  meters: 'distance_meters',
  seconds: 'duration_seconds',
};

const EXERCISE_ALIASES: Record<string, string> = {
  template_id: 'exercise_template_id',
  id: 'exercise_template_id',
  name: 'exercise',
  title: 'exercise',
  rest: 'rest_seconds',
  supersets_id: 'superset_id', // read shape -> write shape
};

/** A spec could not be turned into a valid Hevy body. Nothing is sent when this is thrown. */
export class HevyPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HevyPayloadError';
  }
}

/** Loose caller-supplied spec; validated field by field rather than trusted. */
export type Spec = Record<string, unknown>;

export interface RepRange {
  start: number;
  end: number;
}

export interface BuiltSet {
  type: string;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  custom_metric?: number | null;
  rpe?: number | null;
  rep_range?: RepRange | null;
}

export interface BuiltExercise {
  exercise_template_id: string;
  superset_id?: number | null;
  notes?: string;
  rest_seconds?: number;
  sets: BuiltSet[];
}

export interface RoutineBody {
  routine: {
    title: string;
    notes?: string;
    folder_id?: number | null;
    exercises: BuiltExercise[];
  };
}

/** Resolves an exercise name to a template id, or throws explaining why it cannot. */
export type TemplateResolver = (name: string) => string;

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function toNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new HevyPayloadError(`${field} must be a number, got ${JSON.stringify(value)}`);
}

function toInteger(value: unknown, field: string): number {
  const num = toNumber(value, field);
  if (!Number.isInteger(num)) {
    throw new HevyPayloadError(`${field} must be a whole number, got ${JSON.stringify(value)}`);
  }
  return num;
}

function asSpec(value: unknown, what: string): Spec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HevyPayloadError(`${what} must be an object, got ${describe(value)}`);
  }
  return value as Spec;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/** Apply alias mapping, dropping any alias whose canonical name the caller also set. */
function normalizeKeys(spec: Spec, aliases: Record<string, string>): Spec {
  const out: Spec = {};
  for (const [key, value] of Object.entries(spec)) {
    const canonical = aliases[key] ?? key;
    if (canonical !== key && canonical in spec) {
      continue;
    }
    out[canonical] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

/**
 * Build one set. Accepts a loose spec such as `{reps: 10, weight: 60}` and defaults `type` to
 * "normal"; only fields the caller supplied are emitted so Hevy applies its own defaults.
 */
export function buildSet(rawSpec: unknown, forRoutine: boolean): BuiltSet {
  const spec = normalizeKeys(asSpec(rawSpec, 'set'), SET_ALIASES);

  const setType = spec.type ?? 'normal';
  if (typeof setType !== 'string' || !SET_TYPES.includes(setType as (typeof SET_TYPES)[number])) {
    throw new HevyPayloadError(
      `set type ${JSON.stringify(setType)} is invalid; expected one of ${SET_TYPES.join(', ')}`,
    );
  }

  const out: BuiltSet = { type: setType };

  for (const field of COMMON_SET_FIELDS) {
    if (!(field in spec)) {
      continue;
    }
    const value = spec[field];
    if (value === null) {
      out[field] = null;
    } else {
      out[field] = INTEGER_SET_FIELDS.has(field)
        ? toInteger(value, field)
        : toNumber(value, field);
    }
  }

  if (forRoutine) {
    if ('rpe' in spec) {
      throw new HevyPayloadError(
        'rpe is not supported on routine sets; it is recorded on logged workout sets only',
      );
    }
    if ('rep_range' in spec) {
      out.rep_range = buildRepRange(spec.rep_range);
    }
  } else {
    if ('rep_range' in spec) {
      throw new HevyPayloadError(
        'rep_range is not supported on workout sets; it is a routine planning field only',
      );
    }
    if ('rpe' in spec) {
      if (spec.rpe === null) {
        out.rpe = null;
      } else {
        const rpe = toNumber(spec.rpe, 'rpe');
        if (!RPE_VALUES.includes(rpe as (typeof RPE_VALUES)[number])) {
          throw new HevyPayloadError(
            `rpe ${JSON.stringify(spec.rpe)} is invalid; allowed values are ${RPE_VALUES.join(', ')}`,
          );
        }
        out.rpe = rpe;
      }
    }
  }

  return out;
}

/** Accepts `{start, end}`, `[8, 12]`, or `"8-12"`. */
export function buildRepRange(value: unknown): RepRange | null {
  if (value === null || value === undefined) {
    return null;
  }

  let candidate: unknown = value;

  if (typeof candidate === 'string') {
    const parts = candidate.replace(/to/gi, '-').split('-');
    if (parts.length !== 2) {
      throw new HevyPayloadError(
        `rep_range string ${JSON.stringify(value)} must look like '8-12'`,
      );
    }
    candidate = { start: parts[0].trim(), end: parts[1].trim() };
  }

  if (Array.isArray(candidate)) {
    if (candidate.length !== 2) {
      throw new HevyPayloadError('rep_range list must have exactly two entries');
    }
    candidate = { start: candidate[0], end: candidate[1] };
  }

  const spec = asSpec(candidate, 'rep_range');
  if (!('start' in spec) || !('end' in spec)) {
    throw new HevyPayloadError("rep_range requires both 'start' and 'end'");
  }
  const start = toNumber(spec.start, 'rep_range.start');
  const end = toNumber(spec.end, 'rep_range.end');
  if (start > end) {
    throw new HevyPayloadError(
      `rep_range start (${start}) must not be greater than end (${end})`,
    );
  }
  return { start, end };
}

/**
 * Expand an exercise spec's `sets` into set payloads. `sets` is either a list of set specs or an
 * integer count, where the count repeats the set fields written on the exercise itself — so
 * "3x8 @ 60kg" is `{exercise: "Squat", sets: 3, reps: 8, weight_kg: 60}`.
 */
function expandSets(spec: Spec, forRoutine: boolean): BuiltSet[] {
  const raw = spec.sets;
  const inlineFields = [...COMMON_SET_FIELDS, 'type', 'rpe', 'rep_range'] as const;
  const inline: Spec = {};
  for (const field of inlineFields) {
    if (field in spec) {
      inline[field] = spec[field];
    }
  }

  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 1) {
      throw new HevyPayloadError(`sets count must be a whole number >= 1, got ${raw}`);
    }
    if (Object.keys(inline).length === 0) {
      throw new HevyPayloadError(
        "a numeric 'sets' count needs set fields on the exercise (e.g. reps, weight_kg) to repeat",
      );
    }
    return Array.from({ length: raw }, () => buildSet({ ...inline }, forRoutine));
  }

  if (raw === undefined || raw === null) {
    if (Object.keys(inline).length > 0) {
      return [buildSet(inline, forRoutine)];
    }
    throw new HevyPayloadError(
      "exercise requires 'sets': a list of sets, or a count plus set fields such as reps/weight_kg",
    );
  }

  if (!Array.isArray(raw)) {
    throw new HevyPayloadError(
      `'sets' must be a list or an integer count, got ${describe(raw)}`,
    );
  }
  if (raw.length === 0) {
    throw new HevyPayloadError('exercise must have at least one set');
  }
  return raw.map(set => buildSet(set, forRoutine));
}

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------

/**
 * Build one exercise, resolving its template when the caller gave a name rather than an id.
 * `resolve` is only consulted for name-identified exercises.
 */
export function buildExercise(
  rawSpec: unknown,
  forRoutine: boolean,
  resolve?: TemplateResolver,
): BuiltExercise {
  const spec = normalizeKeys(asSpec(rawSpec, 'exercise'), EXERCISE_ALIASES);

  let templateId = spec.exercise_template_id;
  if (templateId === undefined || templateId === null || templateId === '') {
    const name = spec.exercise;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new HevyPayloadError(
        "exercise requires 'exercise_template_id' or 'exercise' (a name); " +
          'use hevy_search_exercise_catalog to look up template ids',
      );
    }
    if (!resolve) {
      throw new HevyPayloadError(
        `exercise ${JSON.stringify(name)} was given by name but no resolver is available; ` +
          "pass 'exercise_template_id' instead",
      );
    }
    templateId = resolve(name);
  }

  const out: BuiltExercise = {
    exercise_template_id: String(templateId),
    sets: [],
  };

  if (spec.notes !== undefined && spec.notes !== null) {
    out.notes = String(spec.notes);
  }

  if ('superset_id' in spec) {
    out.superset_id =
      spec.superset_id === null ? null : toInteger(spec.superset_id, 'superset_id');
  }

  if (spec.rest_seconds !== undefined && spec.rest_seconds !== null) {
    if (!forRoutine) {
      throw new HevyPayloadError(
        'rest_seconds is a routine planning field and is not accepted on logged workout exercises',
      );
    }
    out.rest_seconds = toInteger(spec.rest_seconds, 'rest_seconds');
  }

  out.sets = expandSets(spec, forRoutine);
  return out;
}

/** Build a list of exercises, tagging failures with the index that caused them. */
export function buildExercises(
  specs: unknown,
  forRoutine: boolean,
  resolve?: TemplateResolver,
): BuiltExercise[] {
  if (!Array.isArray(specs)) {
    throw new HevyPayloadError(`'exercises' must be a list, got ${describe(specs)}`);
  }
  return specs.map((spec, index) => {
    try {
      return buildExercise(spec, forRoutine, resolve);
    } catch (error) {
      if (error instanceof HevyPayloadError) {
        throw new HevyPayloadError(`exercises[${index}]: ${error.message}`);
      }
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/**
 * Body for `POST /v1/routines` and `PUT /v1/routines/{id}`.
 *
 * `includeFolderId` must be false when building an update: the API rejects `folder_id` on PUT,
 * so a routine cannot be moved between folders after creation.
 */
export function buildRoutineBody(args: {
  title: string;
  exercises: unknown;
  notes?: string;
  folderId?: number | null;
  includeFolderId?: boolean;
  resolve?: TemplateResolver;
}): RoutineBody {
  if (!args.title) {
    throw new HevyPayloadError('routine requires a title');
  }
  const includeFolderId = args.includeFolderId ?? true;

  const routine: RoutineBody['routine'] = {
    title: args.title,
    exercises: buildExercises(args.exercises, true, args.resolve),
  };
  if (args.notes !== undefined) {
    routine.notes = args.notes;
  }
  if (includeFolderId) {
    // null is meaningful: it means the default "My Routines" folder.
    routine.folder_id =
      args.folderId === undefined || args.folderId === null
        ? null
        : toInteger(args.folderId, 'folder_id');
  } else if (args.folderId !== undefined && args.folderId !== null) {
    throw new HevyPayloadError(
      'folder_id cannot be changed when updating a routine; the Hevy API only accepts it at ' +
        'creation time',
    );
  }
  return { routine };
}

// ---------------------------------------------------------------------------
// Read shape -> write shape
// ---------------------------------------------------------------------------
//
// GET responses carry server-assigned fields (index, title) that writes reject, and spell the
// superset field `supersets_id` where writes want `superset_id`. Converting makes a fetched
// object safe to send straight back, which every partial update depends on.

interface ReadSet {
  type?: string;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  custom_metric?: number | null;
  rpe?: number | null;
  rep_range?: { start?: number | null; end?: number | null } | null;
}

interface ReadExercise {
  exercise_template_id?: string;
  supersets_id?: number | null;
  notes?: string | null;
  rest_seconds?: string | number | null;
  sets?: ReadSet[];
}

function setToWriteShape(readSet: ReadSet, forRoutine: boolean): BuiltSet {
  const out: BuiltSet = { type: readSet.type ?? 'normal' };
  for (const field of COMMON_SET_FIELDS) {
    if (field in readSet) {
      out[field] = readSet[field];
    }
  }
  if (forRoutine) {
    const range = readSet.rep_range;
    if (range && range.start !== null && range.start !== undefined && range.end !== null && range.end !== undefined) {
      out.rep_range = { start: range.start, end: range.end };
    }
  } else if (readSet.rpe !== null && readSet.rpe !== undefined) {
    out.rpe = readSet.rpe;
  }
  return out;
}

function exerciseToWriteShape(readExercise: ReadExercise, forRoutine: boolean): BuiltExercise {
  const out: BuiltExercise = {
    exercise_template_id: readExercise.exercise_template_id ?? '',
    superset_id: readExercise.supersets_id ?? null,
    sets: (readExercise.sets ?? []).map(set => setToWriteShape(set, forRoutine)),
  };
  if (readExercise.notes !== null && readExercise.notes !== undefined) {
    out.notes = readExercise.notes;
  }
  if (
    forRoutine &&
    readExercise.rest_seconds !== null &&
    readExercise.rest_seconds !== undefined
  ) {
    // Documented as a string on reads but an integer on writes.
    const rest = Number(readExercise.rest_seconds);
    if (Number.isFinite(rest)) {
      out.rest_seconds = Math.trunc(rest);
    }
  }
  return out;
}

/** Convert a fetched routine's exercises into update-ready specs. */
export function routineToWriteShape(routine: { exercises?: ReadExercise[] }): BuiltExercise[] {
  return (routine.exercises ?? []).map(ex => exerciseToWriteShape(ex, true));
}
