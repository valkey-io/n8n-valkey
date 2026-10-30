import { isClusterEnabled, createValkeyClient } from '../nodes/ValkeyVectorStore/shared/client';
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
