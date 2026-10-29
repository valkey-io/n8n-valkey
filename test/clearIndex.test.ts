import { clearIndex, escapeGlob } from '../nodes/ValkeyVectorStore/shared/clearIndex';
import { SEARCH_MODULE_MISSING } from '../nodes/ValkeyVectorStore/shared/errors';

function fakeKeyspace(keys: string[]) {
	const store = new Set(keys);
	const scanCalls: Array<{ cursor: string; match?: string }> = [];
	// Like real SCAN, keys present for the whole scan are returned even if
	// already-returned keys are deleted between calls.
	let snapshot: string[] = [];
	const client = {
		scan: jest.fn(async (cursor: string, options?: { match?: string; count?: number }) => {
			scanCalls.push({ cursor, match: options?.match });
			// Pretend glob: only supports a literal prefix followed by `*`, with escapes.
			const pattern = (options?.match ?? '*').replace(/\*$/, '').replace(/\\(.)/g, '$1');
			if (cursor === '0') snapshot = [...store];
			const all = snapshot.filter((k) => k.startsWith(pattern));
			const page = Number(cursor);
			const slice = all.slice(page * 2, page * 2 + 2);
			const next = page * 2 + 2 >= all.length ? '0' : String(page + 1);
			return [next, slice] as [string, string[]];
		}),
		unlink: jest.fn(async (toDelete: string[]) => {
			toDelete.forEach((k) => store.delete(k));
			return toDelete.length;
		}),
	};
	return { client, store, scanCalls };
}

describe('escapeGlob', () => {
	it('escapes glob metacharacters', () => {
		expect(escapeGlob('doc:k*b?[x]\\:')).toBe('doc:k\\*b\\?\\[x\\]\\\\:');
	});
});

describe('clearIndex', () => {
	it('drops the index and deletes only keys under the prefix', async () => {
		const { client, store } = fakeKeyspace([
			'doc:kb:1',
			'doc:kb:2',
			'doc:kb:3',
			'doc:kbx:1',
			'other',
		]);
		const drop = jest.fn(async () => 'OK');
		const deleted = await clearIndex(client, 'kb', ['doc:kb:'], drop);
		expect(drop).toHaveBeenCalledWith(client, 'kb');
		expect(deleted).toBe(3);
		expect([...store].sort()).toEqual(['doc:kbx:1', 'other']);
	});

	it('scans with an escaped prefix pattern', async () => {
		const { client, scanCalls } = fakeKeyspace([]);
		await clearIndex(client, 'kb', ['a*b:'], async () => 'OK');
		expect(scanCalls[0].match).toBe('a\\*b:*');
	});

	it('continues when the index does not exist', async () => {
		const { client, store } = fakeKeyspace(['doc:kb:1']);
		const drop = async () => {
			throw new Error("Index with name 'kb' not found");
		};
		await expect(clearIndex(client, 'kb', ['doc:kb:'], drop)).resolves.toBe(1);
		expect(store.size).toBe(0);
	});

	it('deletes the documents before dropping the index', async () => {
		const { client, store } = fakeKeyspace(['doc:kb:1', 'doc:kb:2']);
		let keysWhenDropped = -1;
		const drop = jest.fn(async () => {
			keysWhenDropped = store.size;
			return 'OK';
		});
		await clearIndex(client, 'kb', ['doc:kb:'], drop);
		expect(keysWhenDropped).toBe(0);
	});

	it('keeps the index when deleting documents fails partway, and says how far it got', async () => {
		const { client, store } = fakeKeyspace([
			'doc:kb:1',
			'doc:kb:2',
			'doc:kb:3',
			'doc:kb:4',
			'doc:kb:5',
		]);
		const realScan = client.scan.getMockImplementation()!;
		let calls = 0;
		client.scan.mockImplementation(async (...args: Parameters<typeof realScan>) => {
			if (++calls === 2) throw new Error('connection reset');
			return await realScan(...args);
		});
		const drop = jest.fn(async () => 'OK');
		const error = await clearIndex(client, 'kb', ['doc:kb:'], drop).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(
			/Could not delete all documents of index "kb": connection reset\. 2 key\(s\) were confirmed deleted; additional keys may have been deleted if a command response was lost\. The index was not dropped\. Run the node again/,
		);
		expect(drop).not.toHaveBeenCalled();
		expect(store.size).toBe(3);
	});

	it.each([0, 1])(
		'reports uncertain deletions when an UNLINK response is lost after %i confirmed batch(es)',
		async (confirmedBatches) => {
			const { client, store } = fakeKeyspace([
				'doc:kb:1',
				'doc:kb:2',
				'doc:kb:3',
				'doc:kb:4',
				'doc:kb:5',
			]);
			const realUnlink = client.unlink.getMockImplementation()!;
			const timeout = new Error('request timed out');
			let calls = 0;
			client.unlink.mockImplementation(async (keys) => {
				const deleted = await realUnlink(keys);
				if (++calls === confirmedBatches + 1) throw timeout;
				return deleted;
			});
			const drop = jest.fn(async () => 'OK');

			await expect(clearIndex(client, 'kb', ['doc:kb:'], drop)).rejects.toMatchObject({
				code: 'clear-index-failed',
				cause: timeout,
				message:
					'Could not delete all documents of index "kb": request timed out. ' +
					`${confirmedBatches * 2} key(s) were confirmed deleted; additional keys may have been deleted if a command response was lost. ` +
					'The index was not dropped. Run the node again to finish deleting.',
			});
			expect(store.size).toBe(5 - (confirmedBatches + 1) * 2);
			expect(drop).not.toHaveBeenCalled();

			const remaining = store.size;
			await expect(clearIndex(client, 'kb', ['doc:kb:'], drop)).resolves.toBe(remaining);
			expect(store.size).toBe(0);
			expect(drop).toHaveBeenCalledTimes(1);
		},
	);

	it('does not double the punctuation of a server message that ends with one', async () => {
		const { client } = fakeKeyspace(['doc:kb:1']);
		client.scan.mockRejectedValueOnce(new Error('ResponseError: unknown command beginning with: '));
		const error = (await clearIndex(client, 'kb', ['doc:kb:'], async () => 'OK').catch(
			(e: Error) => e,
		)) as Error;
		expect(error.message).toContain('"kb": ResponseError: unknown command beginning with. ');
		expect(error.message).toContain('The index was not dropped.');
		expect(error.message).not.toContain('..');
	});

	it('does not delete under later prefixes after a failure', async () => {
		const { client, store } = fakeKeyspace(['a:1', 'b:1']);
		client.unlink.mockRejectedValueOnce(new Error('NOPERM'));
		await expect(clearIndex(client, 'kb', ['a:', 'b:'], async () => 'OK')).rejects.toThrow(
			'NOPERM',
		);
		expect(store.has('b:1')).toBe(true);
	});

	it('reports that the documents are gone when dropping the index fails', async () => {
		const { client, store } = fakeKeyspace(['doc:kb:1', 'doc:kb:2']);
		const drop = async () => {
			throw new Error('NOPERM this user has no permissions to run FT.DROPINDEX');
		};
		await expect(clearIndex(client, 'kb', ['doc:kb:'], drop)).rejects.toThrow(
			/All 2 document key\(s\) of index "kb" were deleted, but the index could not be dropped: NOPERM.*Run the node again/,
		);
		expect(store.size).toBe(0);
	});

	it('reports a missing search module', async () => {
		const { client } = fakeKeyspace([]);
		const drop = async () => {
			throw new Error("ERR unknown command 'FT.DROPINDEX'");
		};
		await expect(clearIndex(client, 'kb', ['doc:kb:'], drop)).rejects.toThrow(
			SEARCH_MODULE_MISSING,
		);
	});

	it('deletes under every given prefix and leaves other keys alone', async () => {
		const { client, store } = fakeKeyspace(['old:1', 'old:2', 'new:1', 'keep:1']);
		const deleted = await clearIndex(client, 'kb', ['old:', 'new:'], async () => 'OK');
		expect(deleted).toBe(3);
		expect([...store]).toEqual(['keep:1']);
	});

	it('refuses an empty prefix before deleting or dropping anything', async () => {
		const { client, store } = fakeKeyspace(['a']);
		const drop = jest.fn(async () => 'OK');
		await expect(clearIndex(client, 'kb', [''], drop)).rejects.toThrow('non-empty key prefix');
		await expect(clearIndex(client, 'kb', ['doc:kb:', ''], drop)).rejects.toThrow(
			'non-empty key prefix',
		);
		await expect(clearIndex(client, 'kb', [], drop)).rejects.toThrow('non-empty key prefix');
		expect(drop).not.toHaveBeenCalled();
		expect(store.size).toBe(1);
	});
});
