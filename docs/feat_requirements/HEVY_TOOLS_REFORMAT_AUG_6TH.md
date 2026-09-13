## On Hevy Tools reformat (made on August 6th)

The previous set of tools we have around Hevy API does not fullfill the purpose we want to enable towards effective interaction with the API. In order to do that we have to reformat the tools. First, we have access to the Swagger Docs (https://api.hevyapp.com/docs/#/) that we have to consider, we already check what it is possible within this API and have a set of proposed changes on the current tools we have.

The set of current tools in this repo as of 6 august 2026 can be described such as the following, defining a number per tool for further reference:
´´´hevy_current_tools

Read operations:
1. Recent Hevy workouts: hevy_recent_activity
 descr: Summary of recent gym activity: total workouts, working sets, volume (kg), and per-session breakdowns (exercises, duration, volume) over the last N days. Warmup sets are excluded from counts and volume.
input:
  - days: Lookback window (default 14)
2. Hevy activity by muscle group: hevy_activity_by_muscle
 descr: Recent gym activity broken down by muscle group (sets and volume, split primary/secondary involvement, sorted by volume) over the last N days.
 input:
  - days: Lookback window (default 14)
3. Search Hevy exercise templates: hevy_search_exercises
 descr: Find exercise templates by name and get their exercise_template_id — the starting point for writing a workout or routine. Ranked exact match first, then prefix, then substring.
 input:
  - query: Free-text exercise name, e.g. "bench press"
  - limit: Max matches (default 20)
4. Get a Hevy workout: hevy_get_workout
 descr: Fetch one logged workout by id, with all exercises and sets. Use before hevy_write_workout to see what's currently recorded.
 input:
  - workout_id: Workout id
5. List Hevy routines: hevy_routines
 descr: List all routines (reusable workout plans) with their exercises and sets, or pass routine_id for one.
 input:
  - routine_id: One routine instead of the full list (optional)

Write operations:
6. Create or update a Hevy workout: hevy_write_workout
    descr: Log a gym session that happened. Omit workout_id to create, pass one to update (merges over the existing record, preserving omitted fields). Creating requires title, start_time, end_time, exercises.
    input:
    - workout_id: Update this workout; omit to create
    - title: Workout title (required on create)
    - start_time: ISO 8601 start (required on create)
    - end_time: ISO 8601 end (required on create)
    - exercises: Ordered exercise list with sets
    - description: Session notes
    - is_private: Boolean
    - exercise_mode: replace (default) or append
    - dry_run: Return the request body without sending it
7. Create or update a Hevy routine: hevy_write_routine
    descr: Create or edit a reusable workout plan. Omit routine_id to create, pass one to update (merges over the existing record). Creating requires title and exercises; a folder can only be set at creation.
    input:
    - routine_id: Update this routine; omit to create
    - title: Routine title (required on create)
    - exercises: Ordered exercise list with sets
    - notes: Notes shown on the routine
    - folder_name: File under this folder, by name (create-only)
    - create_folder: Create folder_name if no matching folder exists
    - exercise_mode: replace (default) or append
    - dry_run: Return the request body without sending it
8. Create a Hevy custom exercise: hevy_create_custom_exercise
    descr: Create a custom exercise template, for when hevy_search_exercises finds nothing suitable. Accounts have a cap on custom exercises.
    input:
    - title: Exercise name, e.g. "Cable Y-Raise"
    - exercise_type: How the exercise is measured
    - equipment_category: Equipment used
    - muscle_group: Primary muscle group
    - other_muscles: Secondary muscles (optional)
    - dry_run: Return the request body without sending it

Where they're defined

- src/mcps/personal-tools/index.ts — tool registration: names, titles, descriptions, input schemas (lines 332–593)
- src/mcps/personal-tools/tools.ts — handler implementations (hevyRecentActivity, hevyActivityByMuscle, hevySearchExercises, hevyGetWorkout, hevyRoutines, hevyWriteWorkout, hevyWriteRoutine, hevyCreateCustomExercise)
- src/mcps/personal-tools/hevy-payloads.ts — request payload builders and shared constants (CUSTOM_EXERCISE_TYPES, EQUIPMENT_CATEGORIES, MUSCLE_GROUPS)
´´´

## Required Edits on the Tools layer:

1. Merge on Tool (1) and Tool (2) for better readibility on user's data.

The tool (1) - recent hevy workouts - is a bit shallow, the information that is relevant for now is only the minutes taken for the full workout but if we may want to have an understanding of which muscle groups were trained we will have to compute many times the MCP tool. We will pre-defined the information we need in order to not only reduce the amount of API Calls but also to provide more readeable information of what happened in that workour and what should it be highlighted or what it worths the attention. In that case the steps you have to make sure we have here are:

- The inputs should be extended to: 
    - type: all, muscles, cardio #First level of summarization by meta-categories: all, muscles, cardio. Default all.
    - depth: 0 or 1. When 0 is just a description without until the exercises_ids and 1 will include the specific text detail on the exercises. Default 0.
    - specific: specific muscle group or cardio: triceps, shoulders, cardio, biceps, etc.
    - days: default 4. Same mechanism as before. No depth=1 is allowed for more than 4 days.
- No combination of all and 1 is allowed at the same time...
- Mantain the time the user spent in the workout - in minutes is completely okay and good to know.
- Add the workout id also for possible further reference on the workout itself.
- Change the default param from 14 days to last 4 days.
- Group the workouts by its muscle_group exercises and by day. This will provide to the Tool the explicit information if the user has been trained this muscle a day ago, and therefore, we do not propose missaligned. You can complete this template, it is a draft only to show you a rough idea of what we are referring to:
    - If in depth is 0: {
        ... // lets imagine here we have the metadata
        ... "muscle_groups": {
                "triceps": {
                    "2026-06-28": {
                        "total_sets": 20,
                        "total_volume_kg": 9557,
                        "as_primary": 16,
                        "as_secondary": 4
                        "exercises_ids": { #This is the name of the exerciseTemplate (in Hevy API jargon) and its id
                            "Bench Press (Barbell)": "3BC06AD3",
                            "Chest Dip (Assisted)" : "4DC06AV3",
                            "Chest Press (Machine)" : "ASDU1234",
                            ...
                        }
                    },
                    "2026-06-30": {
                        ...
                    }
                },
                "biceps": {...}
        }
        }
    - If in depth is 1: {
        ... // lets imagine here we have the metadata
        ... "muscle_groups": {
                "triceps": {
                    "2026-06-28": {
                        "total_sets": 20,
                        "total_volume_kg": 9557,
                        "as_primary": 16,
                        "as_secondary": 4
                        "exercises_text": { #For this we have to 
                            "Bench Press (Barbell)": "{4} sets of {10} repetitions each with min of {15kg}, max of {20kg}.",
                            "Chest Dip (Assisted)" : "...",
                            "Chest Press (Machine)" : "...",
                            ...
                        }
                    },
                    "2026-06-30": {
                        ...
                    }
                },
                "biceps": {...}
        }
        }

2. In the Tool (3) we have to redefine it as search_exercise_catalog. And we have to expose the possible keywords search in the description, right now it is unclear what is this for.
- Change the name and description of the tool. so it would be easier to search. You have to be concise and not cover everything.
- Add a parameter to grab the information also by muscle_group or cardio.

3. Tool (4) is not working because you never are exposing the workout ids... 