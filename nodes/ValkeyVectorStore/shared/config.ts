import { VectorAlgorithms, assertValidAttributePart } from '@langchain/valkey';
import type { ValkeyVectorStoreConfig } from '@langchain/valkey';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

import { ValkeyUserError, messageOf } from './errors';
import type { ValkeyErrorCode } from './errors';
import type { FilterConditionRow } from './filters';
import { DISTANCE_METRICS, isDistanceMetric } from './indexSchema';
import type { CompatibilityConfig, DistanceMetric, MetadataField } from './indexSchema';

/** Reads node parameters; matches IExecuteFunctions / ISupplyDataFunctions / ILoadOptionsFunctions usage. */
export type ParamReader = (name: string, fallback: unknown) => unknown;

export interface ValkeyCredentials {
	host: string;
	port: number;
	username?: string;
	password?: string;
	tls: boolean;
	database: number;
}

export interface StoreConfig {
	indexName: string;
	keyPrefix: string;
	contentKey: string;
	metadataKey: string;
	vectorKey: string;
	metric: DistanceMetric;
	/** ID Metadata Field: metadata field holding each document's ID. Unset means random IDs. */
	idField?: string;
}

export interface InsertConfig extends StoreConfig {
	algorithm: VectorAlgorithms;
	ttl?: number;
	clearIndex: boolean;
	declaredFields: MetadataField[];
}

/** Update mode: the store settings plus the TTL applied to each updated document. */
export interface UpdateConfig extends StoreConfig {
	ttl?: number;
	/** Update upserts by ID: replaces the document, or creates it if missing. */
	updateMode: true;
}

interface WholeNumberRules {
	fallback: number;
	min: number;
	max?: number;
	code: ValkeyErrorCode;
}

function nonEmpty(value: unknown, fallback: string): string {
	const text = String(value ?? '').trim();
	return text === '' ? fallback : text;
}

/**
 * A boolean field set by an expression arrives as a string, for example
 * "true" from {{ $env.VALKEY_TLS }}. Accept "true"/"false" as well as real
 * booleans, and reject anything else instead of treating it as false.
 */
function booleanFlag(
	label: string,
	value: unknown,
	fallback: boolean,
	code: ValkeyErrorCode,
): boolean {
	if (typeof value === 'boolean') return value;
	if (value === undefined || value === null) return fallback;
	if (typeof value === 'string') {
		const text = value.trim().toLowerCase();
		if (text === '') return fallback;
		if (text === 'true') return true;
		if (text === 'false') return false;
	}
	const shown =
		typeof value === 'string'
			? `"${value}"`
			: typeof value === 'number'
				? String(value)
				: `a value of type ${typeof value}`;
	throw new ValkeyUserError(`${label} must be true or false, got ${shown}.`, code);
}

/** Number() turns a blank field into 0 and "abc" into NaN with no error, so check explicitly. */
function wholeNumber(label: string, value: unknown, rules: WholeNumberRules): number {
	const { fallback, min, max = Number.MAX_SAFE_INTEGER, code } = rules;
	if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
		return fallback;
	}
	const parsed =
		typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		const range = max === Number.MAX_SAFE_INTEGER ? `${min} or more` : `from ${min} to ${max}`;
		throw new ValkeyUserError(
			`${label} must be a whole number ${range}, got ${JSON.stringify(value)}.`,
			code,
		);
	}
	return parsed;
}

export function parseCredentials(data: ICredentialDataDecryptedObject): ValkeyCredentials {
	const host = String(data.host ?? '').trim();
	if (!host)
		throw new ValkeyUserError('The Valkey credential has no host set.', 'invalid-credential');
	const username = data.username ? String(data.username) : undefined;
	const password = data.password ? String(data.password) : undefined;
	// Glide sends a username only together with a password, so a username on its
	// own would silently connect as the default user.
	if (username && !password) {
		throw new ValkeyUserError(
			"The Valkey credential's Username needs a Password. Set a password, or clear the username to use the default user.",
			'invalid-credential',
		);
	}
	return {
		host,
		port: wholeNumber("The Valkey credential's Port", data.port, {
			fallback: 6379,
			min: 1,
			max: 65535,
			code: 'invalid-credential',
		}),
		username: data.username ? String(data.username) : undefined,
		password: data.password ? String(data.password) : undefined,
		// Defaults to true, like the credential's SSL/TLS toggle.
		tls: booleanFlag("The Valkey credential's SSL/TLS", data.tls, true, 'invalid-credential'),
		database: wholeNumber("The Valkey credential's Database Number", data.database, {
			fallback: 0,
			min: 0,
			code: 'invalid-credential',
		}),
	};
}

/** Matches the library's constructor check, before an insert can clear existing data. */
export function validateMetadataKey(metadataKey: string): void {
	try {
		assertValidAttributePart('Metadata Key', metadataKey);
	} catch (error) {
		const wrapped = new ValkeyUserError(messageOf(error), 'invalid-parameter');
		wrapped.cause = error;
		throw wrapped;
	}
}

export function readStoreConfig(get: ParamReader): StoreConfig {
	const indexName = String(get('valkeyIndex', '') ?? '').trim();
	if (!indexName) throw new ValkeyUserError('Valkey Index is required.', 'invalid-parameter');

	const options = (get('indexOptions', {}) ?? {}) as Record<string, unknown>;
	const metric = nonEmpty(options.distanceMetric, 'COSINE').toUpperCase();
	if (!isDistanceMetric(metric)) {
		throw new ValkeyUserError(
			`Distance Metric "${metric}" is not supported. Use ${DISTANCE_METRICS.join(', ')}.`,
			'invalid-parameter',
		);
	}

	const idField = String(options.idMetadataField ?? '').trim();
	const metadataKey = nonEmpty(options.metadataKey, 'metadata');
	validateMetadataKey(metadataKey);

	const keyPrefix = nonEmpty(options.keyPrefix, '');
	// Valkey matches key prefixes as plain strings, so the default prefix of an
	// index named "kb" (doc:kb:) would also cover the keys of "kb:archive"
	// (doc:kb:archive:). Delete Index and Documents would then delete the other
	// index's documents, and search would return them.
	if (!keyPrefix && indexName.includes(':')) {
		throw new ValkeyUserError(
			`Valkey Index "${indexName}" contains ":", so its default key prefix "doc:${indexName}:" could overlap the key prefix of another index. Set Key Prefix, or remove the ":" from the index name.`,
			'invalid-parameter',
		);
	}

	return {
		indexName,
		keyPrefix: keyPrefix || `doc:${indexName}:`,
		contentKey: nonEmpty(options.contentKey, 'content'),
		metadataKey,
		vectorKey: nonEmpty(options.vectorKey, 'content_vector'),
		metric,
		...(idField ? { idField } : {}),
	};
}

/**
 * Characters Valkey Search rejects in an attribute name (its default
 * punctuation set, checked by ValidateAttributeAlias in ft_create_parser.cc).
 * Kept in line with assertValidAttributePart in @langchain/valkey.
 */
const INVALID_FIELD_CHARS = ',.<>{}[]"\':;!@#$%^&*()-+=~/\\|?';
/** Accepted by FT.CREATE, but the query parser ends a name at whitespace. */
const WHITESPACE_CHARS = ' \t\n\v\f\r';

export function readDeclaredFields(get: ParamReader): MetadataField[] {
	const raw = (get('metadataFields', {}) ?? {}) as {
		fields?: Array<{ name?: unknown; type?: unknown }>;
	};
	const fields: MetadataField[] = [];
	const seen = new Set<string>();
	for (const row of raw.fields ?? []) {
		const name = String(row.name ?? '').trim();
		if (!name)
			throw new ValkeyUserError(
				'Metadata Fields to Index: a field has no name.',
				'invalid-parameter',
			);
		if (name.includes('.')) {
			throw new ValkeyUserError(
				`Metadata Fields to Index: "${name}" is a nested path. Only top-level metadata keys can be indexed.`,
				'invalid-parameter',
			);
		}
		// The name becomes part of the index attribute name, which Valkey Search
		// rejects if it contains punctuation, and cannot query if it contains
		// whitespace. Other characters, including non-ASCII letters, are fine.
		const bad = [...name].find(
			(ch) => INVALID_FIELD_CHARS.includes(ch) || WHITESPACE_CHARS.includes(ch),
		);
		if (bad !== undefined) {
			throw new ValkeyUserError(
				`Metadata Fields to Index: "${name}" contains ${JSON.stringify(bad)}. Field names cannot contain spaces or any of ${INVALID_FIELD_CHARS}`,
				'invalid-parameter',
			);
		}
		if (seen.has(name))
			throw new ValkeyUserError(
				`Metadata Fields to Index: "${name}" is declared twice.`,
				'invalid-parameter',
			);
		seen.add(name);
		const type = String(row.type ?? 'TAG').toUpperCase();
		if (type !== 'TAG' && type !== 'NUMERIC') {
			throw new ValkeyUserError(
				`Metadata Fields to Index: "${name}" has type ${type}. Only TAG and NUMERIC are supported.`,
				'invalid-parameter',
			);
		}
		fields.push({ name, type });
	}
	return fields;
}

/** TTL (Seconds) from an options collection; 0 or blank means no expiry. */
function readTtl(options: Record<string, unknown>): number | undefined {
	const ttl = wholeNumber('TTL (Seconds)', options.ttl, {
		fallback: 0,
		min: 0,
		code: 'invalid-parameter',
	});
	return ttl > 0 ? ttl : undefined;
}

const VECTOR_ALGORITHMS: readonly string[] = Object.values(VectorAlgorithms);

function isVectorAlgorithm(value: string): value is VectorAlgorithms {
	return VECTOR_ALGORITHMS.includes(value);
}

/**
 * Reads Vector Algorithm, case-insensitively, defaulting to HNSW when blank.
 * An unknown value is rejected: the algorithm is fixed when the index is
 * created, so silently using HNSW could only be undone by clearing the index.
 */
function readAlgorithm(value: unknown): VectorAlgorithms {
	const algorithm = nonEmpty(value, VectorAlgorithms.HNSW).toUpperCase();
	if (!isVectorAlgorithm(algorithm)) {
		throw new ValkeyUserError(
			`Vector Algorithm "${algorithm}" is not supported. Use ${VECTOR_ALGORITHMS.join(', ')}.`,
			'invalid-parameter',
		);
	}
	return algorithm;
}

export function readInsertConfig(get: ParamReader): InsertConfig {
	const base = readStoreConfig(get);
	const options = (get('insertOptions', {}) ?? {}) as Record<string, unknown>;
	return {
		...base,
		algorithm: readAlgorithm(options.algorithm),
		ttl: readTtl(options),
		clearIndex: options.clearIndex === true,
		declaredFields: readDeclaredFields(get),
	};
}

export function readUpdateConfig(get: ParamReader): UpdateConfig {
	const options = (get('options', {}) ?? {}) as Record<string, unknown>;
	const config: UpdateConfig = {
		...readStoreConfig(get),
		ttl: readTtl(options),
		updateMode: true,
	};
	// n8n's loader reads these itself after this; checking first gives a clear
	// error instead of an empty document or a TypeError from the loader.
	checkUpdateContent(get('jsonData', ''));
	checkUpdateMetadata(options.metadata);
	return config;
}

function checkUpdateContent(value: unknown): void {
	// An expression that resolves to nothing, e.g. {{ $json.text }} on an item without text.
	const content = value ?? '';
	if (typeof content !== 'string') {
		const kind = Array.isArray(content) ? 'a list' : typeof content;
		throw new ValkeyUserError(
			`Content must be text, got ${kind}. Set it to the text of the updated document, for example {{ $json.text }}.`,
			'invalid-parameter',
		);
	}
	if (content.trim() === '') {
		throw new ValkeyUserError(
			'Content is empty. Set it to the text of the updated document, for example {{ $json.text }}.',
			'invalid-parameter',
		);
	}
}

function checkUpdateMetadata(metadata: unknown): void {
	if (metadata === undefined) return;
	const rows = (metadata as { metadataValues?: unknown } | null)?.metadataValues;
	if (!Array.isArray(rows) || rows.length === 0) {
		throw new ValkeyUserError(
			'Options > Metadata has no fields. Add a field or remove the Metadata option.',
			'invalid-parameter',
		);
	}
	const seen = new Set<string>();
	for (const row of rows as Array<{ name?: unknown }>) {
		const name = typeof row?.name === 'string' ? row.name : '';
		if (name.trim() === '') {
			throw new ValkeyUserError('Options > Metadata: a field has no name.', 'invalid-parameter');
		}
		if (name !== name.trim()) {
			throw new ValkeyUserError(
				`Options > Metadata: field name "${name}" starts or ends with a space.`,
				'invalid-parameter',
			);
		}
		if (seen.has(name)) {
			throw new ValkeyUserError(`Options > Metadata: "${name}" is set twice.`, 'invalid-parameter');
		}
		seen.add(name);
	}
}

export function readFilterRows(get: ParamReader): FilterConditionRow[] {
	const raw = (get('metadataFilter', {}) ?? {}) as { conditions?: FilterConditionRow[] };
	return raw.conditions ?? [];
}

/** Library config fields shared by insert and retrieve (client and schema added by the caller). */
export function toLibraryConfig(
	config: StoreConfig,
): Omit<ValkeyVectorStoreConfig, 'valkeyClient'> {
	return {
		indexName: config.indexName,
		keyPrefix: config.keyPrefix,
		contentKey: config.contentKey,
		metadataKey: config.metadataKey,
		vectorKey: config.vectorKey,
	};
}

export function toCompatibilityConfig(config: StoreConfig): CompatibilityConfig {
	return {
		indexName: config.indexName,
		keyPrefix: config.keyPrefix,
		vectorKey: config.vectorKey,
		metadataKey: config.metadataKey,
		metric: config.metric,
	};
}
