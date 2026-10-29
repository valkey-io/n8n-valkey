import { Document } from '@langchain/core/documents';
import { Batch, GlideFt } from '@valkey/valkey-glide';

import type { InsertConfig } from '../nodes/ValkeyVectorStore/shared/config';
import { VectorAlgorithms } from '@langchain/valkey';
import { normalizeIndexInfo } from '../nodes/ValkeyVectorStore/shared/indexSchema';
import type { IndexInfo, MetadataField } from '../nodes/ValkeyVectorStore/shared/indexSchema';
import {
	defaultInsertDeps,
	insertBatch,
	newInsertState,
	validateDocumentMetadata,
} from '../nodes/ValkeyVectorStore/shared/insert';
import type { InsertDeps } from '../nodes/ValkeyVectorStore/shared/insert';
import { HASH_INDEX } from './indexSchema.test';

const baseConfig: InsertConfig = {
	indexName: 'kb',
	keyPrefix: 'doc:kb:',
	contentKey: 'content',
	metadataKey: 'metadata',
	vectorKey: 'content_vector',
	metric: 'COSINE',
	algorithm: VectorAlgorithms.HNSW,
	clearIndex: false,
	declaredFields: [],
};

const docs = (n: number, metadata: Record<string, unknown> = {}) =>
	Array.from({ length: n }, (_, i) => new Document({ pageContent: `doc ${i}`, metadata }));

function embeddings(dimension = 1536, fail?: Error) {
	return {
		embedDocuments: jest.fn(async (texts: string[]) => {
			if (fail) throw fail;
			return texts.map(() => new Array(dimension).fill(0.1));
		}),
		embedQuery: jest.fn(),
	};
}

/** Simulates a server: the index exists once something has been written or after FT.CREATE. */
function fakeDeps(
	options: { info?: IndexInfo | null; addVectors?: InsertDeps['addVectors'] } = {},
) {
	const events: string[] = [];
	let info: IndexInfo | null = options.info === undefined ? null : options.info;
	const client = { close: jest.fn() };
	const deps: InsertDeps = {
		openClient: async () => client as never,
		readInfo: jest.fn(async () => info),
		clear: jest.fn(async () => {
			events.push('clear');
			info = null;
			return 0;
		}),
		addVectors:
			options.addVectors ??
			jest.fn(async (_c, _cfg, _e, vectors: number[][]) => {
				events.push(`write:${vectors.length}`);
				info = normalizeIndexInfo(HASH_INDEX);
			}),
	};
	return { deps, events, client };
}

describe('validateDocumentMetadata', () => {
	it('names the document, field and value for a non-numeric NUMERIC value', () => {
		expect(() =>
			validateDocumentMetadata(docs(1, { year: 'unknown' }), [{ name: 'year', type: 'NUMERIC' }]),
		).toThrow('Document 1: metadata field "year" is declared NUMERIC but has value "unknown"');
	});

	it('allows a missing declared field', () => {
		expect(() =>
			validateDocumentMetadata(docs(1, {}), [{ name: 'year', type: 'NUMERIC' }]),
		).not.toThrow();
	});

	it('rejects a non-string TAG value', () => {
		expect(() =>
			validateDocumentMetadata(docs(1, { page: 4 }), [{ name: 'page', type: 'TAG' }]),
		).toThrow('declared TAG but has value 4 (number)');
	});
});

describe('insertBatch', () => {
	it.each([
		['empty', [], 'length 0'],
		['shorter', [0.1, 0.2], 'length 2'],
		['NaN', [0.1, NaN, 0.3], 'length 3'],
		['Infinity', [0.1, Infinity, 0.3], 'length 3'],
	])(
		'rejects a later %s vector before Delete Index and Documents deletes anything',
		async (_label, badVector, length) => {
			const { deps, events } = fakeDeps({ info: normalizeIndexInfo(HASH_INDEX) });
			const openClient = jest.spyOn(deps, 'openClient');
			const embed = {
				embedDocuments: jest.fn(async () => [[0.1, 0.2, 0.3], badVector]),
				embedQuery: jest.fn(),
			};

			await expect(
				insertBatch({ ...baseConfig, clearIndex: true }, embed, docs(2), newInsertState(), deps),
			).rejects.toMatchObject({
				code: 'embeddings-response',
				message: expect.stringContaining(`${length} for document 2; expected 3 finite numbers`),
			});

			expect(openClient).not.toHaveBeenCalled();
			expect(deps.clear).not.toHaveBeenCalled();
			expect(deps.addVectors).not.toHaveBeenCalled();
			expect(events).toEqual([]);
		},
	);

	it('accepts a batch whose vectors all have the same length', async () => {
		const { deps, events } = fakeDeps();
		await insertBatch(
			{ ...baseConfig, clearIndex: true },
			embeddings(3),
			docs(3),
			newInsertState(),
			deps,
		);
		expect(events).toEqual(['clear', 'write:3']);
	});
	it('rejects an invalid Metadata Key before embedding, connecting, or clearing', async () => {
		const { deps, events } = fakeDeps({ info: normalizeIndexInfo(HASH_INDEX) });
		const openClient = jest.spyOn(deps, 'openClient');
		const embed = embeddings();
		const state = newInsertState();

		await expect(
			insertBatch(
				{ ...baseConfig, metadataKey: 'bad-key', clearIndex: true },
				embed,
				docs(1),
				state,
				deps,
			),
		).rejects.toMatchObject({
			code: 'invalid-parameter',
			message: expect.stringContaining('Invalid Metadata Key "bad-key"'),
			cause: expect.any(Error),
		});

		expect(embed.embedDocuments).not.toHaveBeenCalled();
		expect(openClient).not.toHaveBeenCalled();
		expect(deps.readInfo).not.toHaveBeenCalled();
		expect(deps.clear).not.toHaveBeenCalled();
		expect(deps.addVectors).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		expect(state.cleared).toBe(false);
	});

	it('writes into a new index and counts documents', async () => {
		const { deps, events, client } = fakeDeps();
		const state = newInsertState();
		await insertBatch(baseConfig, embeddings(), docs(3), state, deps);
		expect(events).toEqual(['write:3']);
		expect(state.written).toBe(3);
		expect(client.close).toHaveBeenCalled();
	});

	it('fails on a dimension mismatch before writing, and closes the client', async () => {
		const { deps, events, client } = fakeDeps({ info: normalizeIndexInfo(HASH_INDEX) });
		await expect(
			insertBatch(baseConfig, embeddings(768), docs(2), newInsertState(), deps),
		).rejects.toThrow('dimension 1536, but the connected embeddings produce 768');
		expect(events).toEqual([]);
		expect(client.close).toHaveBeenCalled();
	});

	it('clears once per execution across batches', async () => {
		const { deps, events } = fakeDeps({ info: normalizeIndexInfo(HASH_INDEX) });
		const config = { ...baseConfig, clearIndex: true };
		const state = newInsertState();
		await insertBatch(config, embeddings(), docs(200), state, deps);
		await insertBatch(config, embeddings(), docs(200), state, deps);
		await insertBatch(config, embeddings(), docs(50), state, deps);
		expect(events).toEqual(['clear', 'write:200', 'write:200', 'write:50']);
		expect(state.written).toBe(450);
	});

	it('does not clear when embedding fails', async () => {
		const { deps, events } = fakeDeps({ info: normalizeIndexInfo(HASH_INDEX) });
		await expect(
			insertBatch(
				{ ...baseConfig, clearIndex: true },
				embeddings(1536, new Error('401 invalid API key')),
				docs(2),
				newInsertState(),
				deps,
			),
		).rejects.toThrow('401 invalid API key');
		expect(events).toEqual([]);
		expect(deps.clear).not.toHaveBeenCalled();
	});

	it('says the index was cleared when writing fails after clearing', async () => {
		const { deps } = fakeDeps({
			addVectors: async () => {
				throw new Error('OOM command not allowed');
			},
		});
		await expect(
			insertBatch(
				{ ...baseConfig, clearIndex: true },
				embeddings(),
				docs(2),
				newInsertState(),
				deps,
			),
		).rejects.toThrow(/OOM command not allowed.*The index was cleared/);
	});

	it('clears by the existing index prefixes, not the configured Key Prefix', async () => {
		const existing = normalizeIndexInfo({ ...HASH_INDEX, key_prefixes: ['doc:old:'] });
		const { deps, events } = fakeDeps({ info: existing });
		await insertBatch(
			{ ...baseConfig, keyPrefix: 'doc:new:', clearIndex: true },
			embeddings(),
			docs(2),
			newInsertState(),
			deps,
		);
		expect(deps.clear).toHaveBeenCalledWith(expect.anything(), 'kb', ['doc:old:']);
		expect(events).toEqual(['clear', 'write:2']);
	});

	it('reads the index before clearing it', async () => {
		const order: string[] = [];
		const { deps } = fakeDeps({ info: normalizeIndexInfo(HASH_INDEX) });
		const readInfo = deps.readInfo;
		deps.readInfo = jest.fn(async (...args: Parameters<typeof readInfo>) => {
			order.push('readInfo');
			return await readInfo(...args);
		});
		const clear = deps.clear;
		deps.clear = jest.fn(async (...args: Parameters<typeof clear>) => {
			order.push('clear');
			return await clear(...args);
		});
		await insertBatch(
			{ ...baseConfig, clearIndex: true },
			embeddings(),
			docs(1),
			newInsertState(),
			deps,
		);
		expect(order.slice(0, 2)).toEqual(['readInfo', 'clear']);
	});

	it('falls back to the configured Key Prefix when the index no longer exists', async () => {
		const { deps } = fakeDeps({ info: null });
		await insertBatch(
			{ ...baseConfig, keyPrefix: 'doc:kb:', clearIndex: true },
			embeddings(),
			docs(1),
			newInsertState(),
			deps,
		);
		expect(deps.clear).toHaveBeenCalledWith(expect.anything(), 'kb', ['doc:kb:']);
	});

	it('names the cleared prefixes when writing fails after clearing', async () => {
		const { deps } = fakeDeps({
			info: normalizeIndexInfo({ ...HASH_INDEX, key_prefixes: ['doc:old:'] }),
			addVectors: async () => {
				throw new Error('OOM command not allowed');
			},
		});
		await expect(
			insertBatch(
				{ ...baseConfig, keyPrefix: 'doc:new:', clearIndex: true },
				embeddings(),
				docs(2),
				newInsertState(),
				deps,
			),
		).rejects.toThrow(
			'The index was cleared before this insert (deleted documents under "doc:old:")',
		);
	});

	it('reports how many documents were written before a failing batch', async () => {
		let calls = 0;
		const { deps } = fakeDeps({
			addVectors: async () => {
				calls += 1;
				if (calls === 3) throw new Error('connection reset');
			},
		});
		const state = newInsertState();
		await insertBatch(baseConfig, embeddings(), docs(200), state, deps);
		await insertBatch(baseConfig, embeddings(), docs(200), state, deps);
		await expect(insertBatch(baseConfig, embeddings(), docs(50), state, deps)).rejects.toThrow(
			'connection reset 400 document(s) were written in earlier batches',
		);
	});

	it('retries once when another execution created the index first', async () => {
		let calls = 0;
		const { deps } = fakeDeps({
			addVectors: async () => {
				calls += 1;
				if (calls === 1) throw new Error('Index already exists');
			},
		});
		const state = newInsertState();
		await insertBatch(baseConfig, embeddings(), docs(2), state, deps);
		expect(calls).toBe(2);
		expect(deps.readInfo).toHaveBeenCalledTimes(2);
		expect(state.written).toBe(2);
	});

	it('passes server errors through unchanged on the first batch', async () => {
		const original = new Error("NOPERM no permissions to run the 'FT.INFO' command");
		const { deps } = fakeDeps();
		deps.readInfo = async () => {
			throw original;
		};
		await expect(
			insertBatch(baseConfig, embeddings(), docs(1), newInsertState(), deps),
		).rejects.toBe(original);
	});
});

describe('insertBatch writes the metadata fields of an existing index', () => {
	const SOURCE_AND_YEAR = [
		{ name: 'source', type: 'TAG' },
		{ name: 'year', type: 'NUMERIC' },
	];

	/** fakeDeps whose addVectors records the metadata fields of each write. */
	function capturing(info: IndexInfo | null) {
		const written: MetadataField[][] = [];
		const result = fakeDeps({ info });
		const record = result.deps.addVectors;
		result.deps.addVectors = jest.fn(async (...args: Parameters<InsertDeps['addVectors']>) => {
			written.push(args[6]);
			await record(...args);
		});
		return { ...result, written };
	}

	it('writes all indexed fields when no fields are declared', async () => {
		const { deps, written } = capturing(normalizeIndexInfo(HASH_INDEX));
		await insertBatch(
			baseConfig,
			embeddings(),
			docs(1, { source: 'a', year: 2024 }),
			newInsertState(),
			deps,
		);
		expect(written).toEqual([SOURCE_AND_YEAR]);
	});

	it('writes all indexed fields when only some are declared', async () => {
		const { deps, written } = capturing(normalizeIndexInfo(HASH_INDEX));
		const config = { ...baseConfig, declaredFields: [{ name: 'source', type: 'TAG' as const }] };
		await insertBatch(
			config,
			embeddings(),
			docs(1, { source: 'a', year: 2024 }),
			newInsertState(),
			deps,
		);
		expect(written).toEqual([SOURCE_AND_YEAR]);
	});

	it('writes all indexed fields when replacing a document by ID', async () => {
		const { deps, written } = capturing(normalizeIndexInfo(HASH_INDEX));
		const config = { ...baseConfig, idField: 'doc_key' };
		const doc = new Document({
			pageContent: 'replacement',
			metadata: { doc_key: '1', source: 'a' },
		});
		await insertBatch(config, embeddings(), [doc], newInsertState(), deps);
		expect(written).toEqual([SOURCE_AND_YEAR]);
	});

	it('uses the declared fields when the index does not exist', async () => {
		const { deps, written } = capturing(null);
		const config = { ...baseConfig, declaredFields: [{ name: 'tenant', type: 'TAG' as const }] };
		await insertBatch(config, embeddings(), docs(1, { tenant: 'acme' }), newInsertState(), deps);
		expect(written).toEqual([[{ name: 'tenant', type: 'TAG' }]]);
	});

	it('uses the declared fields when Delete Index and Documents recreates the index', async () => {
		const { deps, written, events } = capturing(normalizeIndexInfo(HASH_INDEX));
		const config = {
			...baseConfig,
			clearIndex: true,
			declaredFields: [{ name: 'tenant', type: 'TAG' as const }],
		};
		await insertBatch(config, embeddings(), docs(1, { tenant: 'acme' }), newInsertState(), deps);
		expect(events).toEqual(['clear', 'write:1']);
		expect(written).toEqual([[{ name: 'tenant', type: 'TAG' }]]);
	});

	it('rejects a bad value for an undeclared indexed field before writing', async () => {
		const { deps, events } = capturing(normalizeIndexInfo(HASH_INDEX));
		await expect(
			insertBatch(baseConfig, embeddings(), docs(1, { year: 'last year' }), newInsertState(), deps),
		).rejects.toMatchObject({
			message: expect.stringContaining('"year" is declared NUMERIC but has value "last year"'),
		});
		expect(deps.addVectors).not.toHaveBeenCalled();
		expect(events).toEqual([]);
	});

	it('uses the fields of the index another execution created when retrying', async () => {
		const written: MetadataField[][] = [];
		let calls = 0;
		const { deps } = fakeDeps({
			info: null,
			addVectors: async (...args) => {
				written.push(args[6]);
				calls += 1;
				if (calls === 1) throw new Error('Index already exists');
			},
		});
		const created = normalizeIndexInfo(HASH_INDEX);
		deps.readInfo = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(created);
		const config = { ...baseConfig, declaredFields: [{ name: 'source', type: 'TAG' as const }] };
		await insertBatch(config, embeddings(), docs(1, { source: 'a' }), newInsertState(), deps);
		expect(written).toEqual([[{ name: 'source', type: 'TAG' }], SOURCE_AND_YEAR]);
	});

	it('writes the hash field of an undeclared indexed field through the library', async () => {
		const ftInfo = jest.spyOn(GlideFt, 'info').mockResolvedValue({ index_name: 'kb' } as never);
		const hset = jest.spyOn(Batch.prototype, 'hset');
		try {
			const client = { close: jest.fn(), exec: jest.fn(async () => []) };
			const deps = defaultInsertDeps(async () => client as never);
			deps.readInfo = async () => normalizeIndexInfo(HASH_INDEX);
			const config = { ...baseConfig, idField: 'doc_key' };
			const doc = new Document({
				pageContent: 'replacement',
				metadata: { doc_key: '1', source: 'a.pdf', year: 2024 },
			});
			await insertBatch(config, embeddings(), [doc], newInsertState(), deps);
			const fields = hset.mock.calls[0][1] as Record<string, unknown>;
			expect(fields['metadata.source']).toBe('a.pdf');
			expect(fields['metadata.year']).toBe('2024');
		} finally {
			ftInfo.mockRestore();
			hset.mockRestore();
		}
	});

	it("joins TAG arrays with the existing index's separator", async () => {
		const ftInfo = jest.spyOn(GlideFt, 'info').mockResolvedValue({ index_name: 'kb' } as never);
		const hset = jest.spyOn(Batch.prototype, 'hset');
		try {
			const client = { close: jest.fn(), exec: jest.fn(async () => []) };
			const deps = defaultInsertDeps(async () => client as never);
			const piped = normalizeIndexInfo(HASH_INDEX);
			piped.fields = piped.fields.map((f) =>
				f.identifier === 'metadata.source' ? { ...f, separator: '|', caseSensitive: true } : f,
			);
			deps.readInfo = async () => piped;
			const doc = new Document({ pageContent: 'x', metadata: { source: ['a.pdf', 'b.pdf'] } });
			await insertBatch(baseConfig, embeddings(), [doc], newInsertState(), deps);
			const fields = hset.mock.calls[0][1] as Record<string, unknown>;
			expect(fields['metadata.source']).toBe('a.pdf|b.pdf');
		} finally {
			ftInfo.mockRestore();
			hset.mockRestore();
		}
	});
});

describe('insertBatch with ID Metadata Field', () => {
	const config = { ...baseConfig, idField: 'doc_key' };
	const withIds = (...ids: unknown[]) =>
		ids.map((id, i) => new Document({ pageContent: `doc ${i}`, metadata: { doc_key: id } }));

	/** fakeDeps whose addVectors records the ids it was given. */
	function recordingDeps() {
		const calls: Array<string[] | undefined> = [];
		const { deps, client } = fakeDeps({
			addVectors: async (_c, _cfg, _e, _v, _d, ids) => {
				calls.push(ids);
			},
		});
		return { deps, calls, client };
	}

	it('passes each document metadata value as its ID, numbers as text', async () => {
		const { deps, calls } = recordingDeps();
		await insertBatch(config, embeddings(), withIds('faq-1', 2), newInsertState(), deps);
		expect(calls).toEqual([['faq-1', '2']]);
	});

	it('passes no IDs when the option is off', async () => {
		const { deps, calls } = recordingDeps();
		await insertBatch(baseConfig, embeddings(), withIds('faq-1'), newInsertState(), deps);
		expect(calls).toEqual([undefined]);
	});

	it.each([
		[undefined, 'is missing'],
		[null, 'is missing'],
		['', 'IDs must be non-empty strings or numbers'],
		['   ', 'IDs must be non-empty strings or numbers'],
		[{ a: 1 }, 'IDs must be non-empty strings or numbers'],
		[Number.NaN, 'IDs must be non-empty strings or numbers'],
	])('rejects ID value %p before embedding', async (value, message) => {
		const { deps, calls } = recordingDeps();
		const embed = embeddings();
		await expect(
			insertBatch(config, embed, withIds(value), newInsertState(), deps),
		).rejects.toThrow(message);
		expect(embed.embedDocuments).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	it('does not trim IDs: "a" and "a " are different', async () => {
		const { deps, calls } = recordingDeps();
		await insertBatch(config, embeddings(), withIds('a', 'a '), newInsertState(), deps);
		expect(calls).toEqual([['a', 'a ']]);
	});

	it('rejects a repeated ID in one batch, counting 1 and "1" and a prefixed ID as the same', async () => {
		for (const pair of [
			['faq-1', 'faq-1'],
			[1, '1'],
			['faq-1', 'doc:kb:faq-1'],
		]) {
			const { deps, calls } = recordingDeps();
			await expect(
				insertBatch(config, embeddings(), withIds(...pair), newInsertState(), deps),
			).rejects.toThrow('appears in more than one document');
			expect(calls).toEqual([]);
		}
	});

	it('rejects an ID repeated in a later batch and says earlier batches were written', async () => {
		const { deps, calls } = recordingDeps();
		const state = newInsertState();
		await insertBatch(config, embeddings(), withIds('faq-1', 'faq-2'), state, deps);
		const failure = insertBatch(config, embeddings(), withIds('faq-3', 'faq-2'), state, deps);
		await expect(failure).rejects.toThrow(
			/ID "faq-2" appears in more than one document.*2 document\(s\) from earlier batches were already written/,
		);
		await expect(failure).rejects.toMatchObject({ code: 'partial-write' });
		expect(calls).toEqual([['faq-1', 'faq-2']]);
	});
});
