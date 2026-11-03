import { GlideClient } from '@valkey/valkey-glide';

import {
	connectGlide,
	createValkeyClient,
	isClusterEnabled,
} from '../nodes/ValkeyVectorStore/shared/client';
import { parseCredentials } from '../nodes/ValkeyVectorStore/shared/config';
import { CLUSTER_MODE_ERROR } from '../nodes/ValkeyVectorStore/shared/errors';

function fakeClient(infoReply: string | Error) {
	return {
		info: jest.fn(async () => {
			if (infoReply instanceof Error) throw infoReply;
			return infoReply;
		}),
		close: jest.fn(),
	};
}

describe('isClusterEnabled', () => {
	it('detects cluster_enabled:1', () => {
		expect(isClusterEnabled('# Cluster\r\ncluster_enabled:1\r\n')).toBe(true);
		expect(isClusterEnabled('# Cluster\r\ncluster_enabled:0\r\n')).toBe(false);
	});
});

describe('connectGlide', () => {
	let createClient: jest.SpyInstance;

	beforeEach(() => {
		createClient = jest
			.spyOn(GlideClient, 'createClient')
			.mockResolvedValue({ close: jest.fn() } as never);
	});

	afterEach(() => createClient.mockRestore());

	it('passes every credential field and both timeouts to Glide', async () => {
		await connectGlide(
			parseCredentials({
				host: 'cache.example.com',
				port: 6380,
				username: 'app',
				password: 'secret',
				tls: true,
				database: 3,
			}),
		);
		expect(createClient).toHaveBeenCalledTimes(1);
		expect(createClient).toHaveBeenCalledWith({
			addresses: [{ host: 'cache.example.com', port: 6380 }],
			useTLS: true,
			credentials: { username: 'app', password: 'secret' },
			databaseId: 3,
			// A TLS-only server reached without TLS never answers; these bound the wait.
			requestTimeout: 10000,
			advancedConfiguration: { connectionTimeout: 5000 },
		});
	});

	it('sends no credentials for an empty password string', async () => {
		// parseCredentials turns '' into undefined; connectGlide must not rely on it.
		await connectGlide({ host: 'localhost', port: 6379, tls: false, database: 0, password: '' });
		expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ credentials: undefined }));
	});
});

describe('createValkeyClient', () => {
	const credentials = parseCredentials({ host: 'h' });

	it('returns a standalone client', async () => {
		const client = fakeClient('cluster_enabled:0\r\n');
		const result = await createValkeyClient(credentials, async () => client as never);
		expect(result).toBe(client);
		expect(client.close).not.toHaveBeenCalled();
	});

	it('rejects cluster mode and closes the client', async () => {
		const client = fakeClient('cluster_enabled:1\r\n');
		await expect(createValkeyClient(credentials, async () => client as never)).rejects.toThrow(
			CLUSTER_MODE_ERROR,
		);
		expect(client.close).toHaveBeenCalled();
	});

	it('passes other errors through and closes the client', async () => {
		const client = fakeClient(new Error('NOAUTH Authentication required.'));
		await expect(createValkeyClient(credentials, async () => client as never)).rejects.toThrow(
			'NOAUTH',
		);
		expect(client.close).toHaveBeenCalled();
	});
});
