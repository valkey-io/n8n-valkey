import { describeIntegration, integrationEnabled, RUN_PREFIX } from './integration/setup';

describe('test setup', () => {
	it('runs integration tests only when VALKEY_HOST is set', () => {
		expect(integrationEnabled).toBe(Boolean(process.env.VALKEY_HOST));
		expect(describeIntegration).toBe(integrationEnabled ? describe : describe.skip);
	});

	it('isolates integration keys under a per-run prefix', () => {
		expect(RUN_PREFIX).toMatch(/^n8n-test:[0-9a-f]{8}:$/);
	});
});
