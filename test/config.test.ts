import {
	parseCredentials,
	readDeclaredFields,
	readInsertConfig,
	readStoreConfig,
	readUpdateConfig,
} from '../nodes/ValkeyVectorStore/shared/config';
import type { ParamReader } from '../nodes/ValkeyVectorStore/shared/config';

const params =
	(values: Record<string, unknown>): ParamReader =>
	(name, fallback) =>
		name in values ? values[name] : fallback;

describe('readStoreConfig', () => {
	it('applies defaults, including prefix doc:<index>:', () => {
		expect(readStoreConfig(params({ valkeyIndex: 'kb' }))).toEqual({
			indexName: 'kb',
			keyPrefix: 'doc:kb:',
			contentKey: 'content',
			metadataKey: 'metadata',
			vectorKey: 'content_vector',
			metric: 'COSINE',
		});
	});

	it('maps index options', () => {
		expect(
			readStoreConfig(
				params({
					valkeyIndex: 'kb',
					indexOptions: {
						keyPrefix: 'kb:',
						contentKey: 'text',
						vectorKey: 'embedding',
						distanceMetric: 'L2',
					},
				}),
			),
		).toMatchObject({ keyPrefix: 'kb:', contentKey: 'text', vectorKey: 'embedding', metric: 'L2' });
	});

	it('requires an index name', () => {
		expect(() => readStoreConfig(params({ valkeyIndex: ' ' }))).toThrow('Valkey Index is required');
	});

	it.each([undefined, '', '   '])(
		'rejects an index name containing ":" when Key Prefix is %j',
		(keyPrefix) => {
			const read = () =>
				readStoreConfig(params({ valkeyIndex: 'kb:archive', indexOptions: { keyPrefix } }));
			expect(read).toThrow(expect.objectContaining({ code: 'invalid-parameter' }));
			expect(read).toThrow('Valkey Index "kb:archive" contains ":"');
		},
	);

	it('accepts an index name containing ":" when Key Prefix is set', () => {
		expect(
			readStoreConfig(
				params({ valkeyIndex: 'idx:products', indexOptions: { keyPrefix: 'product:' } }),
			),
		).toMatchObject({ indexName: 'idx:products', keyPrefix: 'product:' });
	});

	it('gives indexes "kb" and "kb-archive" default prefixes that do not overlap', () => {
		const live = readStoreConfig(params({ valkeyIndex: 'kb' })).keyPrefix;
		const archive = readStoreConfig(params({ valkeyIndex: 'kb-archive' })).keyPrefix;
		expect(archive.startsWith(live)).toBe(false);
	});

	it.each(['bad-key', 'bad.key', 'bad:key', 'bad key', 'bad\tkey', 'bad\nkey'])(
		'rejects Metadata Key %j as an invalid parameter',
		(metadataKey) => {
			expect(() => {
				readStoreConfig(params({ valkeyIndex: 'kb', indexOptions: { metadataKey } }));
			}).toThrow(expect.objectContaining({ code: 'invalid-parameter' }));
		},
	);

	it.each(['custom_metadata', 'café', '日本語'])('accepts Metadata Key %j', (metadataKey) => {
		expect(
			readStoreConfig(params({ valkeyIndex: 'kb', indexOptions: { metadataKey } })).metadataKey,
		).toBe(metadataKey);
	});

	it('defaults a blank Metadata Key before validating it', () => {
		expect(
			readStoreConfig(params({ valkeyIndex: 'kb', indexOptions: { metadataKey: '   ' } }))
				.metadataKey,
		).toBe('metadata');
	});

	it('reads ID Metadata Field, trimmed, and leaves it unset when empty', () => {
		const read = (idMetadataField: unknown) =>
			readStoreConfig(params({ valkeyIndex: 'kb', indexOptions: { idMetadataField } })).idField;
		expect(read(' doc_key ')).toBe('doc_key');
		expect(read('')).toBeUndefined();
		expect(read(undefined)).toBeUndefined();
	});
});

describe('readInsertConfig', () => {
	it('maps insert options', () => {
		expect(
			readInsertConfig(
				params({
					valkeyIndex: 'kb',
					insertOptions: { ttl: 3600, algorithm: 'FLAT', clearIndex: true },
				}),
			),
		).toMatchObject({ ttl: 3600, algorithm: 'FLAT', clearIndex: true, declaredFields: [] });
	});

	it('treats TTL 0 as no expiry and defaults to HNSW', () => {
		expect(readInsertConfig(params({ valkeyIndex: 'kb' }))).toMatchObject({
			ttl: undefined,
			algorithm: 'HNSW',
			clearIndex: false,
		});
	});

	it('uses the default for a blank TTL and accepts a numeric string', () => {
		expect(readInsertConfig(params({ valkeyIndex: 'kb', insertOptions: { ttl: '' } })).ttl).toBe(
			undefined,
		);
		expect(readInsertConfig(params({ valkeyIndex: 'kb', insertOptions: { ttl: '60' } })).ttl).toBe(
			60,
		);
	});

	it.each([['abc'], [-1], [1.5], [true]])('rejects TTL %p', (ttl) => {
		const read = () => readInsertConfig(params({ valkeyIndex: 'kb', insertOptions: { ttl } }));
		expect(read).toThrow(
			`TTL (Seconds) must be a whole number 0 or more, got ${JSON.stringify(ttl)}.`,
		);
		expect(read).toThrow(expect.objectContaining({ code: 'invalid-parameter' }));
	});
});

describe('readUpdateConfig', () => {
	/** Update params with a valid Content, which every update needs. */
	const update = (values: Record<string, unknown>) =>
		params({ valkeyIndex: 'kb', jsonData: 'new text', ...values });

	it('reads the store settings and the TTL from the update Options', () => {
		expect(
			readUpdateConfig(update({ indexOptions: { keyPrefix: 'p:' }, options: { ttl: 60 } })),
		).toMatchObject({ indexName: 'kb', keyPrefix: 'p:', ttl: 60 });
	});

	it('treats a missing or 0 TTL as no expiry', () => {
		expect(readUpdateConfig(update({})).ttl).toBeUndefined();
		expect(readUpdateConfig(update({ options: { ttl: 0 } })).ttl).toBeUndefined();
	});

	it('ignores the Insert Options TTL', () => {
		expect(readUpdateConfig(update({ insertOptions: { ttl: 60 } })).ttl).toBeUndefined();
	});

	it('rejects an invalid TTL like insert does', () => {
		const read = () => readUpdateConfig(update({ options: { ttl: -1 } }));
		expect(read).toThrow('TTL (Seconds) must be a whole number 0 or more, got -1.');
		expect(read).toThrow(expect.objectContaining({ code: 'invalid-parameter' }));
	});

	it.each([[''], ['   '], [undefined], [null]])('rejects empty Content %p', (jsonData) => {
		const read = () => readUpdateConfig(params({ valkeyIndex: 'kb', jsonData }));
		expect(read).toThrow('Content is empty.');
		expect(read).toThrow(expect.objectContaining({ code: 'invalid-parameter' }));
	});

	it.each([
		[{ a: 'x' }, 'object'],
		[['x'], 'a list'],
		[5, 'number'],
	])('rejects Content %p that is not text', (jsonData, kind) => {
		expect(() => readUpdateConfig(update({ jsonData }))).toThrow(
			`Content must be text, got ${kind}.`,
		);
	});

	it('accepts Metadata fields', () => {
		const metadata = {
			metadataValues: [
				{ name: 'tenant', value: 'a' },
				{ name: 'status', value: '' },
			],
		};
		expect(() => readUpdateConfig(update({ options: { metadata } }))).not.toThrow();
	});

	it.each([
		[{}, 'Options > Metadata has no fields.'],
		[{ metadataValues: [] }, 'Options > Metadata has no fields.'],
		[{ metadataValues: [{ name: ' ', value: 'a' }] }, 'Options > Metadata: a field has no name.'],
		[
			{ metadataValues: [{ name: 'tenant ', value: 'a' }] },
			'Options > Metadata: field name "tenant " starts or ends with a space.',
		],
		[
			{
				metadataValues: [
					{ name: 'tenant', value: 'a' },
					{ name: 'tenant', value: 'b' },
				],
			},
			'Options > Metadata: "tenant" is set twice.',
		],
	])('rejects Metadata %p', (metadata, message) => {
		const read = () => readUpdateConfig(update({ options: { metadata } }));
		expect(read).toThrow(message);
		expect(read).toThrow(expect.objectContaining({ code: 'invalid-parameter' }));
	});
});

describe('readDeclaredFields', () => {
	it('reads TAG and NUMERIC fields', () => {
		expect(
			readDeclaredFields(
				params({
					metadataFields: {
						fields: [
							{ name: 'source', type: 'TAG' },
							{ name: 'year', type: 'NUMERIC' },
						],
					},
				}),
			),
		).toEqual([
			{ name: 'source', type: 'TAG' },
			{ name: 'year', type: 'NUMERIC' },
		]);
	});

	it.each([
		[[{ name: '' }], 'has no name'],
		[[{ name: 'file.name', type: 'TAG' }], 'nested path'],
		[[{ name: 'a' }, { name: 'a' }], 'declared twice'],
		[[{ name: 'a', type: 'TEXT' }], 'Only TAG and NUMERIC'],
		[[{ name: 'user-type' }], 'contains "-"'],
		[[{ name: 'tenant:id' }], 'contains ":"'],
		[[{ name: 'a@b' }], 'contains "@"'],
		[[{ name: 'a\tb' }], 'contains "\\t"'],
	])('rejects %j', (fields, message) => {
		expect(() => readDeclaredFields(params({ metadataFields: { fields } }))).toThrow(message);
	});

	it('rejects an inner space (leading and trailing spaces are trimmed)', () => {
		expect(() =>
			readDeclaredFields(params({ metadataFields: { fields: [{ name: 'user type' }] } })),
		).toThrow('contains " "');
	});

	it.each(['user_type', 'Tenant_ID', '_private', '2024_total', 'café', '日本語', 'a`b'])(
		'accepts %j',
		(name) => {
			expect(readDeclaredFields(params({ metadataFields: { fields: [{ name }] } }))).toEqual([
				{ name, type: 'TAG' },
			]);
		},
	);
});

describe('parseCredentials', () => {
	it('applies defaults', () => {
		expect(parseCredentials({ host: 'h' })).toEqual({
			host: 'h',
			port: 6379,
			username: undefined,
			password: undefined,
			tls: true,
			database: 0,
		});
	});

	it.each([
		[true, true],
		[false, false],
		['true', true],
		['false', false],
		[' TRUE ', true],
		['False', false],
		['', true],
	])('reads SSL/TLS %j as %p', (tls, expected) => {
		expect(parseCredentials({ host: 'h', tls }).tls).toBe(expected);
	});

	it.each([
		['yes', '"yes"'],
		['1', '"1"'],
		[1, '1'],
		[{}, 'a value of type object'],
	])('rejects SSL/TLS %j instead of connecting without TLS', (tls, shown) => {
		const read = () => parseCredentials({ host: 'h', tls });
		expect(read).toThrow(expect.objectContaining({ code: 'invalid-credential' }));
		expect(read).toThrow(`The Valkey credential's SSL/TLS must be true or false, got ${shown}.`);
	});

	it('requires a host', () => {
		expect(() => parseCredentials({ host: '  ' })).toThrow('no host');
	});

	it('uses the defaults for a blank port or database number', () => {
		const result = parseCredentials({ host: 'h', port: '', database: '  ' });
		expect(result.port).toBe(6379);
		expect(result.database).toBe(0);
	});

	it('accepts numbers and numeric strings from expressions', () => {
		const result = parseCredentials({ host: 'h', port: '6380', database: 3 });
		expect(result.port).toBe(6380);
		expect(result.database).toBe(3);
	});

	it.each([['abc'], [0], [99999], [6379.5], [true]])('rejects port %p', (port) => {
		expect(() => parseCredentials({ host: 'h', port })).toThrow(
			`The Valkey credential's Port must be a whole number from 1 to 65535, got ${JSON.stringify(port)}.`,
		);
	});

	it.each([['-1'], [1.5], ['abc']])('rejects database number %p', (database) => {
		expect(() => parseCredentials({ host: 'h', database })).toThrow(
			`The Valkey credential's Database Number must be a whole number 0 or more, got ${JSON.stringify(database)}.`,
		);
	});

	it('tags a rejected number as an invalid credential', () => {
		expect(() => parseCredentials({ host: 'h', port: 'abc' })).toThrow(
			expect.objectContaining({ code: 'invalid-credential' }),
		);
	});
});
