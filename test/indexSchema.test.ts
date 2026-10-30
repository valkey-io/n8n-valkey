import {
	assertCompatible,
	metadataFields,
	normalizeIndexInfo,
	readIndexInfo,
} from '../nodes/ValkeyVectorStore/shared/indexSchema';
import type { CompatibilityConfig } from '../nodes/ValkeyVectorStore/shared/indexSchema';
import { SEARCH_MODULE_MISSING } from '../nodes/ValkeyVectorStore/shared/errors';
import { HASH_INDEX, JSON_INDEX, RECORDED_HASH_INDEX } from './fixtures/ftInfo';

const config: CompatibilityConfig = {
	indexName: 'kb',
	keyPrefix: 'doc:kb:',
	vectorKey: 'content_vector',
	metadataKey: 'metadata',
	metric: 'COSINE',
};

describe('normalizeIndexInfo', () => {
	it('normalizes a reply recorded from a real ValkeySearch server', () => {
		const info = normalizeIndexInfo(RECORDED_HASH_INDEX as never);
		expect(info.dataType).toBe('HASH');
		expect(info.prefixes).toEqual(['probe5:']);
		expect(info.vectors).toEqual([{ name: 'v', dim: 4, metric: 'COSINE', algorithm: 'HNSW' }]);
		expect(metadataFields(info, 'metadata')).toEqual([{ name: 'year', type: 'NUMERIC' }]);
	});

	it('normalizes a HASH index', () => {
		const info = normalizeIndexInfo(HASH_INDEX);
		expect(info.dataType).toBe('HASH');
		expect(info.prefixes).toEqual(['doc:kb:']);
		expect(info.vectors).toEqual([
			{ name: 'content_vector', dim: 1536, metric: 'COSINE', algorithm: 'HNSW' },
		]);
		expect(metadataFields(info, 'metadata')).toEqual([
			{ name: 'source', type: 'TAG' },
			{ name: 'year', type: 'NUMERIC' },
		]);
	});

	it('accepts Buffer values and RediSearch-style keys', () => {
		const info = normalizeIndexInfo({
			index_name: Buffer.from('kb'),
			index_definition: { key_type: Buffer.from('HASH'), prefixes: [Buffer.from('doc:kb:')] },
			attributes: [
				{
					identifier: 'v',
					attribute: 'v',
					type: 'VECTOR',
					DIM: 4,
					DISTANCE: 'L2',
					ALGORITHM: 'FLAT',
				},
			],
		});
		expect(info.dataType).toBe('HASH');
		expect(info.prefixes).toEqual(['doc:kb:']);
		expect(info.vectors[0]).toEqual({ name: 'v', dim: 4, metric: 'L2', algorithm: 'FLAT' });
	});

	// Attribute entries recorded on 2026-10-29 with Glide from two servers, for
	// `metadata.t TAG SEPARATOR "|" CASESENSITIVE` and a default `metadata.d TAG`.
	const vectorAttribute = [
		'identifier',
		'v',
		'attribute',
		'v',
		'type',
		'VECTOR',
		'index',
		['dimensions', 2, 'distance_metric', 'COSINE', 'algorithm', ['name', 'FLAT']],
	];
	const withAttributes = (...attributes: unknown[]) =>
		normalizeIndexInfo({
			index_name: 'kb',
			index_definition: ['key_type', 'HASH', 'prefixes', ['p:']],
			attributes: [vectorAttribute, ...attributes],
		} as never);

	it('reads TAG separator and CASESENSITIVE sent as a value (search module 66049)', () => {
		const info = withAttributes(
			[
				'identifier',
				'metadata.d',
				'attribute',
				'metadata_d',
				'user_indexed_memory',
				0,
				'type',
				'TAG',
				'SEPARATOR',
				',',
				'CASESENSITIVE',
				'0',
				'size',
				'0',
			],
			[
				'identifier',
				'metadata.t',
				'attribute',
				'metadata_t',
				'user_indexed_memory',
				0,
				'type',
				'TAG',
				'SEPARATOR',
				'|',
				'CASESENSITIVE',
				'1',
				'size',
				'0',
			],
		);
		expect(metadataFields(info, 'metadata')).toEqual([
			{ name: 'd', type: 'TAG' },
			{ name: 't', type: 'TAG', separator: '|', caseSensitive: true },
		]);
	});

	it('keeps a TAG field whose CASESENSITIVE is a bare flag (search module 10003)', () => {
		const info = withAttributes(
			[
				'identifier',
				'metadata.d',
				'attribute',
				'metadata_d',
				'type',
				'TAG',
				'SEPARATOR',
				',',
				'size',
				'0',
			],
			[
				'identifier',
				'metadata.t',
				'attribute',
				'metadata_t',
				'type',
				'TAG',
				'SEPARATOR',
				'|',
				'CASESENSITIVE',
				'size',
				'0',
			],
		);
		expect(metadataFields(info, 'metadata')).toEqual([
			{ name: 'd', type: 'TAG' },
			{ name: 't', type: 'TAG', separator: '|', caseSensitive: true },
		]);
	});

	it('reads a bare CASESENSITIVE flag at the end of an entry', () => {
		const info = withAttributes(['identifier', 'metadata.t', 'type', 'TAG', 'CASESENSITIVE']);
		expect(metadataFields(info, 'metadata')).toEqual([
			{ name: 't', type: 'TAG', caseSensitive: true },
		]);
	});

	it('still skips a malformed odd-length entry', () => {
		const info = withAttributes(['identifier', 'metadata.t', 'type', 'TAG', 'size']);
		expect(metadataFields(info, 'metadata')).toEqual([]);
	});
});

describe('readIndexInfo', () => {
	const client = {} as never;

	it('returns null for a missing index', async () => {
		const ftInfo = async () => {
			throw new Error("Index with name 'kb' not found");
		};
		await expect(readIndexInfo(client, 'kb', ftInfo)).resolves.toBeNull();
	});

	it('reports a missing search module', async () => {
		const ftInfo = async () => {
			throw new Error("ERR unknown command 'FT.INFO'");
		};
		await expect(readIndexInfo(client, 'kb', ftInfo)).rejects.toThrow(SEARCH_MODULE_MISSING);
	});

	it.each([
		'timed out',
		'NOAUTH Authentication required.',
		"NOPERM no permissions to run the 'FT.INFO' command",
	])('passes "%s" through unchanged', async (message) => {
		const original = new Error(message);
		const ftInfo = async () => {
			throw original;
		};
		await expect(readIndexInfo(client, 'kb', ftInfo)).rejects.toBe(original);
	});
});

describe('assertCompatible', () => {
	const info = normalizeIndexInfo(HASH_INDEX);

	it('accepts a matching index', () => {
		expect(() =>
			assertCompatible(
				info,
				{ ...config, dimension: 1536, declaredFields: [{ name: 'source', type: 'TAG' }] },
				'insert',
			),
		).not.toThrow();
	});

	it('rejects a JSON index', () => {
		expect(() => assertCompatible(normalizeIndexInfo(JSON_INDEX), config, 'retrieve')).toThrow(
			'uses JSON storage. This node supports only HASH indexes',
		);
	});

	it('rejects a different prefix', () => {
		expect(() => assertCompatible(info, { ...config, keyPrefix: 'kb:' }, 'retrieve')).toThrow(
			'not the configured key prefix "kb:"',
		);
	});

	it('rejects a missing vector field', () => {
		expect(() => assertCompatible(info, { ...config, vectorKey: 'embedding' }, 'retrieve')).toThrow(
			'no VECTOR field named "embedding"',
		);
	});

	it('rejects a metric mismatch', () => {
		expect(() => assertCompatible(info, { ...config, metric: 'L2' }, 'retrieve')).toThrow(
			'uses distance metric COSINE',
		);
	});

	it.each(['insert', 'retrieve'] as const)(
		'rejects a dimension mismatch on %s, naming both dimensions',
		(mode) => {
			expect(() => assertCompatible(info, { ...config, dimension: 768 }, mode)).toThrow(
				'dimension 1536, but the connected embeddings produce 768',
			);
		},
	);

	it('rejects a missing declared field on insert', () => {
		expect(() =>
			assertCompatible(
				info,
				{ ...config, declaredFields: [{ name: 'category', type: 'TAG' }] },
				'insert',
			),
		).toThrow('no indexed metadata field "category"');
	});

	it('rejects a declared field with another type on insert', () => {
		expect(() =>
			assertCompatible(
				info,
				{ ...config, declaredFields: [{ name: 'year', type: 'TAG' }] },
				'insert',
			),
		).toThrow('"year" is indexed as NUMERIC');
	});

	it('ignores declared fields on retrieve', () => {
		expect(() =>
			assertCompatible(
				info,
				{ ...config, declaredFields: [{ name: 'category', type: 'TAG' }] },
				'retrieve',
			),
		).not.toThrow();
	});

	it('throws rather than logging', () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
		expect(() => assertCompatible(info, { ...config, metric: 'IP' }, 'retrieve')).toThrow();
		expect(warn).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
		warn.mockRestore();
		log.mockRestore();
	});
});
