import { DEFAULT_LENGTH, generateRandomString } from '@helpers/generate-random-string';

describe('generateRandomString', () => {
  // The default length is asserted against the exported constant rather than a
  // literal. The previous test hard-coded 8, which is the pre-hardening default;
  // that value gave a verification code roughly 47 bits of entropy, and the code
  // authorizes submitting a sponsored payment.
  it('generates a string of the default length', () => {
    const result = generateRandomString();
    expect(result.length).toBe(DEFAULT_LENGTH);
  });

  it('uses a default length with at least 100 bits of entropy', () => {
    // 62-symbol alphabet, so log2(62) ≈ 5.954 bits per character.
    expect(DEFAULT_LENGTH * Math.log2(62)).toBeGreaterThanOrEqual(100);
  });

  it('generates a string with only allowed characters', () => {
    const result = generateRandomString();
    expect(result).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('generates different strings on multiple calls', () => {
    const result1 = generateRandomString();
    const result2 = generateRandomString();
    expect(result1).not.toBe(result2);
  });

  it('generates a string of custom length when specified', () => {
    const result = generateRandomString(12);
    expect(result.length).toBe(12);
  });

  it('rejects a non-positive or non-integer length', () => {
    expect(() => generateRandomString(0)).toThrow();
    expect(() => generateRandomString(-1)).toThrow();
    expect(() => generateRandomString(1.5)).toThrow();
  });

  it('does not draw from Math.random', () => {
    // Guards against a regression to the non-cryptographic generator: V8's
    // xorshift128+ state is recoverable from a handful of observed outputs, after
    // which every past and future verification code is predictable.
    const spy = jest.spyOn(Math, 'random');
    try {
      generateRandomString();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
