import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_MODEL_STATUS, applyModelEvent, modelStatusLines } from '../extension/model-status.js';

const run = (events, start = INITIAL_MODEL_STATUS) => events.reduce((state, event, i) => applyModelEvent(state, event, 1000 + i), start);
const answer = (turnId, actualModel, requestedModel = null, { effort = null, requestedEffort = null } = {}) => [
  { type: 'turn_start', turnId, requestedModel, requestedEffort },
  ...(actualModel ? [{ type: 'model', turnId, actualModel, sourceField: 'server_ste_metadata.model_slug' }] : []),
  ...(effort ? [{ type: 'effort', turnId, actualEffort: effort, sourceField: 'message.metadata.thinking_effort' }] : []),
  { type: 'turn_end', turnId },
];

test('shows nothing before any answer has been observed', () => {
  assert.equal(modelStatusLines(INITIAL_MODEL_STATUS), null);
  assert.equal(modelStatusLines(run([{ type: 'turn_start', turnId: 't1', requestedModel: 'gpt-5-6-thinking' }])), null);
});

test('shows the server model and its source', () => {
  const lines = modelStatusLines(run(answer('t1', 'gpt-5-6-thinking', 'gpt-5-6-thinking')));
  assert.equal(lines.actual, 'gpt-5-6-thinking');
  assert.equal(lines.source, 'server response (server_ste_metadata.model_slug)');
  assert.equal(lines.mismatch, false);
});

test('flags Mismatch when requested and actual differ, and not otherwise', () => {
  const differ = modelStatusLines(run(answer('t1', 'gpt-5-5-mini', 'gpt-5-6-thinking')));
  assert.deepEqual([differ.requested, differ.actual, differ.mismatch], ['gpt-5-6-thinking', 'gpt-5-5-mini', true]);
  assert.equal(modelStatusLines(run(answer('t2', 'gpt-5-6-thinking', 'gpt-5-6-thinking'))).mismatch, false);
});

test('never invents a mismatch when the request named no model', () => {
  const lines = modelStatusLines(run(answer('t1', 'gpt-5-6-thinking', null)));
  assert.deepEqual([lines.requested, lines.mismatch], ['', false]);
});

test('a finished answer without model metadata shows Unknown', () => {
  const lines = modelStatusLines(run(answer('t1', null, 'gpt-5-6-thinking')));
  assert.equal(lines.actual, 'Unknown');
  assert.equal(lines.mismatch, false);
});

test('a new turn keeps the previous value visible until the server names a model', () => {
  const first = run(answer('t1', 'gpt-5-6-thinking'));
  const pending = applyModelEvent(first, { type: 'turn_start', turnId: 't2', requestedModel: null });
  assert.equal(modelStatusLines(pending).actual, 'gpt-5-6-thinking');

  const updated = applyModelEvent(pending, { type: 'model', turnId: 't2', actualModel: 'gpt-5-5-mini', sourceField: 'server_ste_metadata.model_slug' });
  assert.equal(modelStatusLines(updated).actual, 'gpt-5-5-mini');
});

test('a second answer without metadata replaces the earlier value with Unknown, not a stale model', () => {
  const state = run([...answer('t1', 'gpt-5-6-thinking'), ...answer('t2', null)]);
  assert.equal(modelStatusLines(state).actual, 'Unknown');
});

test('only the latest answer is shown after many answers', () => {
  const state = run([...answer('t1', 'a-model'), ...answer('t2', 'b-model'), ...answer('t3', 'c-model')]);
  assert.equal(modelStatusLines(state).actual, 'c-model');
});

test('late events from an earlier turn cannot overwrite the current one', () => {
  let state = run([...answer('t1', 'a-model'), { type: 'turn_start', turnId: 't2', requestedModel: null }]);
  state = applyModelEvent(state, { type: 'model', turnId: 't1', actualModel: 'stale-model', sourceField: 'x' });
  state = applyModelEvent(state, { type: 'turn_end', turnId: 't1' });
  assert.equal(modelStatusLines(state).actual, 'a-model');
  assert.equal(state.turn.id, 't2');
});

test('rejects malformed events and slugs', () => {
  const start = run([{ type: 'turn_start', turnId: 't1', requestedModel: null }]);
  for (const bad of [
    { type: 'model', turnId: 't1', actualModel: '<b>x</b>', sourceField: 'f' },
    { type: 'model', turnId: 't1', actualModel: 'x'.repeat(65), sourceField: 'f' },
    { type: 'model', turnId: 't1', actualModel: 'gpt', sourceField: 42 },
    { type: 'model', actualModel: 'gpt', sourceField: 'f' },
    null,
  ]) assert.equal(applyModelEvent(start, bad), start);
});

test('shows the server effort raw, whether it arrives before or after the model', () => {
  const after = modelStatusLines(run(answer('t1', 'gpt-5-6-thinking', null, { effort: 'extended' })));
  assert.equal(after.effort, 'extended');

  const before = run([
    { type: 'turn_start', turnId: 't1' },
    { type: 'effort', turnId: 't1', actualEffort: 'extended', sourceField: 'f' },
  ]);
  assert.equal(modelStatusLines(before), null);
  const both = applyModelEvent(before, { type: 'model', turnId: 't1', actualModel: 'gpt-5-6-thinking', sourceField: 'f' });
  assert.equal(modelStatusLines(both).effort, 'extended');
});

test('an answer without effort shows no effort line and does not keep the previous effort', () => {
  const state = run([...answer('t1', 'a-model', null, { effort: 'extended' }), ...answer('t2', 'b-model')]);
  assert.equal(modelStatusLines(state).effort, '');
});

test('flags Mismatch when only the effort differs, and shows what was requested', () => {
  const lines = modelStatusLines(run(answer('t1', 'gpt-5-6-thinking', 'gpt-5-6-thinking', { effort: 'standard', requestedEffort: 'extended' })));
  assert.deepEqual([lines.requested, lines.effort, lines.mismatch], ['gpt-5-6-thinking · extended', 'standard', true]);
  const same = modelStatusLines(run(answer('t2', 'gpt-5-6-thinking', 'gpt-5-6-thinking', { effort: 'extended', requestedEffort: 'extended' })));
  assert.equal(same.mismatch, false);
});

test('Unknown model also clears effort', () => {
  const lines = modelStatusLines(run(answer('t1', null, 'gpt-5-6-thinking', { requestedEffort: 'extended' })));
  assert.deepEqual([lines.actual, lines.effort, lines.mismatch], ['Unknown', '', false]);
});
