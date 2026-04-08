const { buildScreenshotPath } = require('../src/services/screenshot');

describe('screenshot', () => {
  test('buildScreenshotPath generates correct path', () => {
    const result = buildScreenshotPath(42, 'LOGIN_FAILED');
    expect(result).toMatch(/\/var\/log\/creditloader\/failures\//);
    expect(result).toMatch(/42/);
    expect(result).toMatch(/LOGIN_FAILED/);
    expect(result).toMatch(/\.png$/);
  });

  test('buildScreenshotPath sanitizes step name', () => {
    const result = buildScreenshotPath(1, 'MODAL/SUBMIT');
    expect(result).not.toContain('/SUBMIT');
    expect(result).toMatch(/MODAL-SUBMIT/);
  });
});
