import { describeIntegration, integrationEnabled, RUN_PREFIX } from './integration/setup';

describe('test setup', () => {
	it('runs unit tests without a Valkey server', () => {
		expect(typeof integrationEnabled).toBe('boolean');
	});

	it('isolates integration keys under a per-run prefix', () => {
		expect(RUN_PREFIX).toMatch(/^n8n-test:[0-9a-f]{8}:$/);
	});
});

describeIntegration('integration gate', () => {
	it('is only defined when VALKEY_HOST is set', () => {
		expect(process.env.VALKEY_HOST).toBeTruthy();
	});
});
