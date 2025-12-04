import { describe, it, expect } from 'vitest';

import { isValidHNItem, isValidHNUpdates } from '../types';

describe('isValidHNItem', () => {
  it('accepts valid items', () => {
    const item = {
      id: 123,
      type: 'story',
      time: 1_700_000_000,
    };
    expect(isValidHNItem(item)).toBe(true);
  });

  it('rejects objects missing required fields', () => {
    expect(isValidHNItem({})).toBe(false);
  });

  it('rejects invalid types', () => {
    const item = {
      id: 123,
      type: 'invalid',
      time: 1,
    };
    expect(isValidHNItem(item)).toBe(false);
  });
});

describe('isValidHNUpdates', () => {
  it('accepts valid update payloads', () => {
    const updates = {
      items: [1, 2, 3],
      profiles: ['alice', 'bob'],
    };
    expect(isValidHNUpdates(updates)).toBe(true);
  });

  it('rejects payloads with wrong types', () => {
    const updates = {
      items: [1, 'bad'],
      profiles: ['alice'],
    };
    expect(isValidHNUpdates(updates)).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isValidHNUpdates(null)).toBe(false);
  });
});
