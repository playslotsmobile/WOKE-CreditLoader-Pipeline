const masterBalance = require('../src/services/masterBalance');

describe('masterBalance', () => {
  describe('tierFor', () => {
    test('HEALTHY when above info threshold', () => {
      expect(masterBalance.tierFor(100000)).toBe('HEALTHY');
      expect(masterBalance.tierFor(50001)).toBe('HEALTHY');
    });

    test('INFO at or below 50k, above 10k', () => {
      expect(masterBalance.tierFor(50000)).toBe('INFO');
      expect(masterBalance.tierFor(25000)).toBe('INFO');
      expect(masterBalance.tierFor(10001)).toBe('INFO');
    });

    test('WARN at or below 10k, above 2k', () => {
      expect(masterBalance.tierFor(10000)).toBe('WARN');
      expect(masterBalance.tierFor(5000)).toBe('WARN');
      expect(masterBalance.tierFor(2001)).toBe('WARN');
    });

    test('CRITICAL at or below 2k', () => {
      expect(masterBalance.tierFor(2000)).toBe('CRITICAL');
      expect(masterBalance.tierFor(500)).toBe('CRITICAL');
      expect(masterBalance.tierFor(0)).toBe('CRITICAL');
      expect(masterBalance.tierFor(-100)).toBe('CRITICAL');
    });

    test('handles string input', () => {
      expect(masterBalance.tierFor('5803.57')).toBe('WARN');
    });
  });

  describe('parseCurrency', () => {
    test('parses dollar format', () => {
      expect(masterBalance.parseCurrency('$5,803.57')).toBe(5803.57);
    });

    test('parses space-separated thousands (iConnect format)', () => {
      expect(masterBalance.parseCurrency('36 170.41')).toBe(36170.41);
    });

    test('parses plain decimal', () => {
      expect(masterBalance.parseCurrency('1000.00')).toBe(1000);
    });

    test('handles negative', () => {
      expect(masterBalance.parseCurrency('-1,234.56')).toBe(-1234.56);
    });

    test('returns null for invalid input', () => {
      expect(masterBalance.parseCurrency(null)).toBeNull();
      expect(masterBalance.parseCurrency('')).toBeNull();
      expect(masterBalance.parseCurrency('abc')).toBeNull();
    });
  });

  describe('THRESHOLDS', () => {
    test('matches operator-configured values', () => {
      expect(masterBalance.THRESHOLDS.INFO).toBe(50000);
      expect(masterBalance.THRESHOLDS.WARN).toBe(10000);
      expect(masterBalance.THRESHOLDS.CRITICAL).toBe(2000);
    });
  });

  describe('MASTERS', () => {
    test('has correct Play777 master identity', () => {
      expect(masterBalance.MASTERS.PLAY777.label).toBe('Master715');
      expect(masterBalance.MASTERS.PLAY777.operator).toBe('1110');
    });

    test('has correct iConnect master identity', () => {
      expect(masterBalance.MASTERS.ICONNECT.label).toBe('tonydist');
    });
  });
});
