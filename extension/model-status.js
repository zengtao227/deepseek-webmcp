// Turn lifecycle for the "actual model" line in the Side Panel. Pure, so it is tested directly.
// The previous answer's value stays visible while a new turn is pending; it is replaced only by
// a model name the server sent for the new turn, or by Unknown when that turn ended without one.

const SLUG = /^[A-Za-z0-9._:-]{1,64}$/;

export const INITIAL_MODEL_STATUS = Object.freeze({ latest: null, turn: null });

function slugOrNull(value) {
  return typeof value === 'string' && SLUG.test(value) ? value : null;
}

function latestOf(turn, now) {
  return {
    actualModel: turn.actual.actualModel,
    sourceField: turn.actual.sourceField,
    actualEffort: turn.actualEffort,
    requestedModel: turn.requestedModel,
    requestedEffort: turn.requestedEffort,
    timestamp: now,
  };
}

export function applyModelEvent(state, event, now = Date.now()) {
  if (typeof event?.turnId !== 'string' || !event.turnId) return state;

  if (event.type === 'turn_start') {
    return {
      ...state,
      turn: {
        id: event.turnId,
        requestedModel: slugOrNull(event.requestedModel),
        requestedEffort: slugOrNull(event.requestedEffort),
        actual: null,
        actualEffort: null,
      },
    };
  }

  // Events from a turn that is no longer the current one are stale.
  if (state.turn?.id !== event.turnId) return state;

  if (event.type === 'model') {
    const actualModel = slugOrNull(event.actualModel);
    if (!actualModel || typeof event.sourceField !== 'string') return state;
    const turn = { ...state.turn, actual: { actualModel, sourceField: event.sourceField.slice(0, 80) } };
    return { turn, latest: latestOf(turn, now) };
  }

  if (event.type === 'effort') {
    const actualEffort = slugOrNull(event.actualEffort);
    if (!actualEffort) return state;
    const turn = { ...state.turn, actualEffort };
    // Effort is shown next to a model name; before the model is known it only waits on the turn.
    return { turn, latest: turn.actual ? latestOf(turn, now) : state.latest };
  }

  if (event.type === 'turn_end') {
    if (state.turn.actual) return { ...state, turn: null };
    return {
      turn: null,
      latest: {
        actualModel: null,
        sourceField: null,
        actualEffort: null,
        requestedModel: state.turn.requestedModel,
        requestedEffort: state.turn.requestedEffort,
        timestamp: now,
      },
    };
  }

  return state;
}

// Returns null until the first answer has finished, so the panel shows nothing it does not know.
// Raw server values are shown as-is: ChatGPT's own labels (High, Medium...) are not mapped here.
export function modelStatusLines(state) {
  const latest = state.latest;
  if (!latest) return null;
  if (latest.actualModel === null) return { actual: 'Unknown', effort: '', source: '', requested: '', mismatch: false };
  const differs = (requested, actual) => requested !== null && actual !== null && requested !== actual;
  const requested = [latest.requestedModel, latest.requestedEffort].filter((part) => part !== null).join(' · ');
  return {
    actual: latest.actualModel,
    effort: latest.actualEffort ?? '',
    source: `server response (${latest.sourceField})`,
    requested,
    mismatch: differs(latest.requestedModel, latest.actualModel) || differs(latest.requestedEffort, latest.actualEffort),
  };
}
