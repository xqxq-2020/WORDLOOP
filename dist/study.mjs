import { WORDS, WORD_BY_ID } from './words.mjs';

export const MINUTE = 60_000;
export const DAY = 1_440 * MINUTE;
export const NEW_LIMIT = 10;
export const ROUND_SIZE = 10;
export const RETENTION = 0.9;
export const RETRY = 10 * MINUTE;
export const INDEPENDENT_GAP = 8 * MINUTE;
const DELAYED_GAP = 20 * 60 * MINUTE;
const DEFAULT_HLR = [-1.35, 1.05, -0.45, -0.35];
const CHANNELS = ['reading', 'listening'];

// The published FSRS-6 weights and memory equations.
// https://open-spaced-repetition.github.io/ts-fsrs/guide/model/fsrs-6
const W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
  1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
  1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];
const DECAY = W[20];
const FACTOR = RETENTION ** (-1 / DECAY) - 1;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const initialDifficulty = grade => W[4] - Math.exp(W[5] * (grade - 1)) + 1;

export function dayKey(at) {
  const date = new Date(at);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-');
}

export function recallProbability(elapsedDays, stability) {
  return (1 + FACTOR * Math.max(0, elapsedDays) / stability) ** -DECAY;
}

function fsrsUpdate(track, grade, elapsed) {
  if (track.lastAt === null) {
    return { difficulty: clamp(initialDifficulty(grade), 1, 10), stability: W[grade - 1] };
  }

  const { difficulty, stability } = track;
  const damped = difficulty - W[6] * (grade - 3) * (10 - difficulty) / 9;
  const nextDifficulty = clamp(W[7] * initialDifficulty(4) + (1 - W[7]) * damped, 1, 10);
  const retrievability = recallProbability(elapsed, stability);
  let nextStability;

  if (elapsed < 1) {
    const gain = stability ** -W[19] * Math.exp(W[17] * (grade - 3 + W[18]));
    nextStability = stability * (grade === 1 ? gain : Math.max(1, gain));
  } else if (grade === 1) {
    const forgotten = W[11] * difficulty ** -W[12] *
      ((stability + 1) ** W[13] - 1) * Math.exp(W[14] * (1 - retrievability));
    nextStability = Math.min(forgotten, stability / Math.exp(W[17] * W[18]));
  } else {
    const hardPenalty = grade === 2 ? W[15] : 1;
    const easyBonus = grade === 4 ? W[16] : 1;
    nextStability = stability * (1 + Math.exp(W[8]) * (11 - difficulty) *
      stability ** -W[9] * Math.expm1(W[10] * (1 - retrievability)) * hardPenalty * easyBonus);
  }

  return { difficulty: nextDifficulty, stability: clamp(nextStability, 0.001, 36_500) };
}

function intervalDays(stability) {
  const days = stability / FACTOR * (RETENTION ** (-1 / DECAY) - 1);
  return clamp(Math.round(days), 1, 180);
}

function hlrFeatures(track, channel) {
  return [1, Math.log2(1 + track.corrects), Math.log2(1 + track.misses), Number(channel === 'listening')];
}

function hlrPrediction(weights, track, channel, elapsed) {
  const x = hlrFeatures(track, channel);
  const logHalfLife = weights.reduce((total, weight, i) => total + weight * x[i], 0);
  const halfLife = 2 ** clamp(logHalfLife, -8, 10);
  const ratio = elapsed / halfLife;
  return { x, ratio, p: 2 ** -ratio };
}

function updateHlr(model, prediction, fsrs, correct) {
  const outcome = Number(correct);
  const { x, ratio, p } = prediction;
  const scale = 1 + x.reduce((sum, feature) => sum + feature ** 2, 0);
  const gradient = (outcome - p) * p * Math.LN2 ** 2 * ratio;
  model.weights = model.weights.map((weight, i) =>
    clamp(weight + 0.12 * gradient * x[i] / scale, -4, 4));
  model.samples += 1;
  model.fsrsError += (fsrs - outcome) ** 2;
  model.hlrError += (p - outcome) ** 2;
}

function blankTrack() {
  return {
    stability: 0, difficulty: 0, lastAt: null, dueAt: null,
    corrects: 0, misses: 0, known: 0.22, lastEvidenceDay: null,
    delayedDay: null, lastCorrect: null,
  };
}

function blankCard() {
  return {
    introAt: null, exposureAt: null, reading: blankTrack(), listening: blankTrack(),
    transfer: { dueAt: null, index: 0, passed: false, shown: [] },
  };
}

export function freshState() {
  return {
    version: 1, cards: {}, events: [],
    hlr: { weights: [...DEFAULT_HLR], samples: 0, fsrsError: 0, hlrError: 0 },
    reminderTime: '09:00',
  };
}

export function markExposure(state, id, at) {
  const card = state.cards[id] ??= blankCard();
  card.exposureAt = at;
}

export function wordStatus(card) {
  if (!card || card.introAt === null) return 'unseen';
  const { reading, listening, transfer } = card;
  const mastered = [reading, listening].every(track =>
    track.known >= 0.78 && track.delayedDay && track.lastCorrect === true);
  if (mastered && reading.delayedDay !== listening.delayedDay) {
    return transfer.passed ? 'applied' : 'mastered';
  }
  return reading.corrects + listening.corrects > 0 ? 'consolidating' : 'learning';
}

export function stats(state) {
  const counts = { unseen: 0, learning: 0, consolidating: 0, mastered: 0, applied: 0 };
  for (const word of WORDS) counts[wordStatus(state.cards[word.id])] += 1;
  return counts;
}

function updateEvidence(track, correct, at, delayed) {
  track.lastCorrect = correct;
  const today = dayKey(at);
  if (track.lastEvidenceDay === today) return;

  const guess = 0.04;
  const slip = 0.13;
  const learning = 0.12;
  const numerator = track.known * (correct ? 1 - slip : slip);
  const denominator = numerator + (1 - track.known) * (correct ? guess : 1 - guess);
  const posterior = numerator / denominator;

  track.known = clamp(posterior + (1 - posterior) * learning, 0.01, 0.995);
  track.lastEvidenceDay = today;
  if (correct && delayed) track.delayedDay = today;
}

function transferEligible(card) {
  return card.transfer.dueAt !== null && wordStatus(card) === 'mastered';
}

function availableTasks(state, now) {
  const tasks = [];
  for (const word of WORDS) {
    const card = state.cards[word.id];
    if (!card || card.introAt === null) continue;

    for (const channel of CHANNELS) {
      const track = card[channel];
      if (track.dueAt === null) continue;
      const elapsed = track.lastAt === null ? null : (now - track.lastAt) / DAY;
      const p = elapsed === null ? 0.55 : recallProbability(elapsed, track.stability);
      tasks.push({ id: word.id, kind: channel, dueAt: track.dueAt, p });
    }

    if (transferEligible(card)) {
      tasks.push({ id: word.id, kind: 'transfer', dueAt: card.transfer.dueAt, p: 0.98 });
    }
  }
  return tasks;
}

export function getPlan(state, now) {
  const tasks = availableTasks(state, now);
  const due = tasks.filter(task => task.dueAt <= now)
    .sort((a, b) => a.p - b.p || a.dueAt - b.dueAt);
  const upcoming = tasks.filter(task => task.dueAt > now)
    .sort((a, b) => a.dueAt - b.dueAt);
  const today = dayKey(now);
  const newToday = Object.values(state.cards)
    .filter(card => card.introAt !== null && dayKey(card.introAt) === today).length;
  const newWords = WORDS.filter(word => !state.cards[word.id] || state.cards[word.id].introAt === null)
    .slice(0, Math.max(0, NEW_LIMIT - newToday));
  const used = new Set();
  const round = [];

  for (const task of due) {
    if (used.has(task.id)) continue;
    used.add(task.id);
    round.push(task);
    if (round.length === ROUND_SIZE) break;
  }
  const reviewCount = round.length;
  for (const word of newWords.slice(0, ROUND_SIZE - round.length)) {
    round.push({ id: word.id, kind: 'reading', dueAt: null, isNew: true });
  }

  return {
    dueCount: due.length, due, upcoming, newToday, newCount: newWords.length,
    round, reviewCount,
  };
}

function normalize(text) {
  return text.normalize('NFKC').toLowerCase().trim().replace(/[\p{P}\p{Z}\s]/gu, '');
}

function meaningBase(text) {
  const normalized = normalize(text);
  return normalized.length > 2 ? normalized.replace(/[的地]$/u, '') : normalized;
}

export function answerMatches(word, kind, answer) {
  if (kind === 'transfer') return normalize(answer) === word.id;
  const accepted = new Set([word.meaning, ...word.aliases].map(meaningBase));
  const parts = answer.trim().split(/[、，,；;\/／\n]+/u).map(meaningBase).filter(Boolean);
  return parts.length > 0 && parts.every(part => accepted.has(part));
}

export function nextContext(state, id) {
  const transfer = state.cards[id]?.transfer;
  const word = WORD_BY_ID[id];
  return transfer ? transfer.index % word.contexts.length : 0;
}

function taskIsCurrent(state, task, at) {
  const card = state.cards[task.id];
  if (task.isNew) {
    return (!card || card.introAt === null) && getPlan(state, at).newCount > 0;
  }
  if (!card || card.introAt === null || task.dueAt > at) return false;
  if (task.kind === 'transfer' && !transferEligible(card)) return false;
  return card[task.kind].dueAt === task.dueAt;
}

export function recordAttempt(state, task, response) {
  const { at, answer, mode, hints, listens, responseMs, contextIndex } = response;
  if (!taskIsCurrent(state, task, at)) return null;

  const word = WORD_BY_ID[task.id];
  const card = state.cards[task.id] ??= blankCard();
  const transfer = task.kind === 'transfer';
  const track = transfer ? null : card[task.kind];
  const lastExposure = card.exposureAt;
  const sinceExposure = lastExposure === null ? Infinity : at - lastExposure;
  const independent = mode !== 'reveal' && hints === 0 && listens <= 3 && sinceExposure >= INDEPENDENT_GAP;
  const correct = mode === 'input' ? answerMatches(word, task.kind, answer) : mode === 'skip' ? false : null;
  const elapsed = track && track.lastAt !== null ? Math.max(0, at - track.lastAt) / DAY : null;
  const delayed = lastExposure !== null && sinceExposure >= DELAYED_GAP && dayKey(lastExposure) !== dayKey(at);
  let prediction = null;
  let applied = false;
  let dueAt;

  if (card.introAt === null) {
    card.introAt = at;
    card.listening.dueAt = at + DAY;
  }

  if (transfer) {
    const unseenContext = !card.transfer.shown.includes(contextIndex);
    applied = independent && correct && delayed && unseenContext;
    card.transfer.passed = applied;
    if (!card.transfer.shown.includes(contextIndex)) card.transfer.shown.push(contextIndex);
    card.transfer.index = (contextIndex + 1) % word.contexts.length;
    if (!applied && card.transfer.shown.length === word.contexts.length) {
      // A new pair of fill-in prompts can be offered after a longer gap.
      card.transfer.shown = [];
      card.transfer.dueAt = at + 7 * DAY;
    } else {
      card.transfer.dueAt = applied ? null : at + DAY;
    }
    dueAt = card.transfer.dueAt;
  } else if (independent) {
    if (elapsed !== null) {
      const fsrs = recallProbability(elapsed, track.stability);
      const hlr = hlrPrediction(state.hlr.weights, track, task.kind, elapsed);
      prediction = { p_fsrs: fsrs, p_hlr: hlr.p, model_version: 'fsrs6+hlr1' };
      updateHlr(state.hlr, hlr, fsrs, correct);
    }

    const memory = fsrsUpdate(track, correct ? 3 : 1, elapsed);
    Object.assign(track, memory, { lastAt: at });
    if (correct) track.corrects += 1;
    else track.misses += 1;
    updateEvidence(track, correct, at, delayed && elapsed !== null);
    track.dueAt = at + (correct ? intervalDays(track.stability) * DAY : RETRY);
    dueAt = track.dueAt;
  } else {
    track.dueAt = at + RETRY;
    dueAt = track.dueAt;
  }

  card.exposureAt = at;
  if (wordStatus(card) === 'mastered' && !card.transfer.passed && card.transfer.dueAt === null) {
    card.transfer.dueAt = at + DAY;
  }
  if (!transfer && transferEligible(card) && card.transfer.dueAt < at + DAY) {
    card.transfer.dueAt = at + DAY;
  }

  const event = {
    item_id: [word.id, task.kind, transfer ? contextIndex : 'meaning'].join('/'),
    lexeme_id: word.id, sense_id: 'core', channel: transfer ? 'reading' : task.kind,
    answered_at: at, elapsed_days: elapsed, first_try_correct: independent ? correct : null,
    hint_count: hints, answer_revealed: mode === 'reveal', choice_count: 0,
    question_type: transfer ? 'context_fill' : 'typed_meaning',
    response_time_ms: responseMs, listen_count: listens, item_version: 1,
    evidence_quality: independent ? 'independent' : 'exposure', prediction,
    next_due: dueAt, mastery_status: wordStatus(card),
  };
  state.events.push(event);
  if (state.events.length > 3000) state.events.splice(0, state.events.length - 3000);

  return { independent, correct, dueAt, applied, status: event.mastery_status };
}
