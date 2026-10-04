import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getRespiratoryRateRejectionReason,
  isUsableRespiratoryRate,
} from './respiratory-rate-quality.mjs';

test('withholds low-confidence respiratory estimates and reports the reason', () => {
  const estimate = { value: 3, confidence: 0.12 };
  assert.equal(getRespiratoryRateRejectionReason(estimate), 'low-confidence');
  assert.equal(isUsableRespiratoryRate(estimate), false);
});

test('accepts estimates at 40% confidence in fraction or percent form', () => {
  assert.equal(
    isUsableRespiratoryRate({ value: 18, confidence: 0.4 }),
    true,
  );
  assert.equal(
    isUsableRespiratoryRate({ value: 18, confidence: 40 }),
    true,
  );
  assert.equal(
    isUsableRespiratoryRate({ value: 18, confidence: 0.39 }),
    false,
  );
});

test('rejects implausible RR even when the model confidence is high', () => {
  assert.equal(
    getRespiratoryRateRejectionReason({ value: 3, confidence: 0.95 }),
    'out-of-range',
  );
  assert.equal(
    getRespiratoryRateRejectionReason({ value: 18, confidence: 0.95 }),
    null,
  );
  assert.equal(
    getRespiratoryRateRejectionReason({ value: 61, confidence: 0.95 }),
    'out-of-range',
  );
});

test('rejects non-finite values and malformed confidence scores', () => {
  assert.equal(
    getRespiratoryRateRejectionReason({ value: Number.NaN, confidence: 0.95 }),
    'invalid',
  );
  assert.equal(
    getRespiratoryRateRejectionReason({ value: 18, confidence: Number.NaN }),
    'invalid',
  );
  assert.equal(isUsableRespiratoryRate(null), false);
});