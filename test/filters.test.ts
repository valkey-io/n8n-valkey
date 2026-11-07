import { buildMetadataFilter, toCustomSchema } from '../nodes/ValkeyVectorStore/shared/filters';
import type { MetadataField } from '../nodes/ValkeyVectorStore/shared/indexSchema';

const fields: MetadataField[] = [
	{ name: 'source', type: 'TAG' },
	{ name: 'tenant', type: 'TAG' },
	{ name: 'year', type: 'NUMERIC' },
];

const build = (rows: object[]) => buildMetadataFilter(rows, fields, 'kb');

describe('toCustomSchema', () => {
	it('builds customSchema from index fields', () => {
		expect(toCustomSchema(fields)).toEqual({
			source: { type: 'TAG' },
			tenant: { type: 'TAG' },
			year: { type: 'NUMERIC' },
		});
	});

	it('passes a TAG separator and CASESENSITIVE only when the index sets them', () => {
		expect(
			toCustomSchema([
				{ name: 'tenant', type: 'TAG', separator: '|', caseSensitive: true },
				{ name: 'source', type: 'TAG' },
			]),
		).toEqual({
			tenant: { type: 'TAG', SEPARATOR: '|', CASESENSITIVE: true },
			source: { type: 'TAG' },
		});
	});
});

describe('buildMetadataFilter', () => {
	it('returns undefined for no conditions', () => {
		expect(build([])).toBeUndefined();
	});

	it.each([
		[{ field: 'source', operator: 'is', value: 'faq.pdf' }, { source: 'faq.pdf' }],
		[
			{ field: 'source', operator: 'isAnyOf', value: 'billing.pdf, faq.pdf' },
			{ source: ['billing.pdf', 'faq.pdf'] },
		],
		[{ field: 'year', operator: 'equals', value: '2024' }, { year: { min: 2024, max: 2024 } }],
		[{ field: 'year', operator: 'gte', value: '2024' }, { year: { min: 2024 } }],
		[{ field: 'year', operator: 'lte', value: 2024 }, { year: { max: 2024 } }],
		[
			{ field: 'year', operator: 'between', value: '2023', valueTo: '2025' },
			{ year: { min: 2023, max: 2025 } },
		],
	])('maps %j', (row, expected) => {
		expect(build([row])).toEqual(expected);
	});

	it('uses the type default operator when none is stored', () => {
		expect(build([{ field: 'source', value: 'a' }])).toEqual({ source: 'a' });
		expect(build([{ field: 'year', value: '1' }])).toEqual({ year: { min: 1 } });
	});

	it('trims the field name', () => {
		expect(build([{ field: ' source ', value: 'a' }])).toEqual({ source: 'a' });
	});

	it('ANDs conditions on different fields', () => {
		expect(
			build([
				{ field: 'source', operator: 'is', value: 'billing.pdf' },
				{ field: 'year', operator: 'between', value: '2023', valueTo: '2025' },
			]),
		).toEqual({ source: 'billing.pdf', year: { min: 2023, max: 2025 } });
	});

	it('intersects NUMERIC conditions on the same field', () => {
		expect(
			build([
				{ field: 'year', operator: 'gte', value: '2020' },
				{ field: 'year', operator: 'lte', value: '2024' },
			]),
		).toEqual({ year: { min: 2020, max: 2024 } });
		expect(
			build([
				{ field: 'year', operator: 'gte', value: '2020' },
				{ field: 'year', operator: 'gte', value: '2022' },
			]),
		).toEqual({ year: { min: 2022 } });
		expect(
			build([
				{ field: 'year', operator: 'lte', value: '2024' },
				{ field: 'year', operator: 'lte', value: '2021' },
			]),
		).toEqual({ year: { max: 2021 } });
	});

	it('accepts array values from expressions', () => {
		expect(build([{ field: 'tenant', operator: 'isAnyOf', value: ['acme', 'globex'] }])).toEqual({
			tenant: ['acme', 'globex'],
		});
	});

	it('rejects several values for "is" instead of matching any of them', () => {
		const run = () => build([{ field: 'tenant', operator: 'is', value: ['acme', 'globex'] }]);
		expect(run).toThrow(expect.objectContaining({ code: 'invalid-filter' }));
		expect(run).toThrow(
			'Metadata Filter condition 1 ("tenant"): "Is" takes one value, got 2. Use "Is Any Of" for several values.',
		);
	});

	it('accepts a one-value array for "is"', () => {
		expect(build([{ field: 'tenant', operator: 'is', value: ['acme'] }])).toEqual({
			tenant: 'acme',
		});
	});

	it('rejects a field that is not indexed', () => {
		expect(() => build([{ field: 'category', operator: 'is', value: 'x' }])).toThrow(
			'"category" is not an indexed field of index "kb"',
		);
	});

	it('rejects an operator of the wrong type', () => {
		expect(() => build([{ field: 'source', operator: 'gte', value: 'x' }])).toThrow(
			'operator "Greater Than or Equal" is not valid for TAG field "source". Use "Is" or "Is Any Of".',
		);
		expect(() => build([{ field: 'year', operator: 'isAnyOf', value: '1' }])).toThrow(
			'operator "Is Any Of" is not valid for NUMERIC field "year". Use "Equals", "Greater Than or Equal", "Less Than or Equal" or "Between".',
		);
	});

	it('rejects "Is" on a NUMERIC field given by an expression, instead of running ">="', () => {
		const run = () => build([{ field: 'year', operator: 'is', value: '2024' }]);
		expect(run).toThrow(expect.objectContaining({ code: 'invalid-filter' }));
		expect(run).toThrow('operator "Is" is not valid for NUMERIC field "year"');
	});

	it('rejects an unknown operator', () => {
		expect(() => build([{ field: 'source', operator: 'contains', value: 'x' }])).toThrow(
			'operator "contains" is not valid for TAG field "source"',
		);
	});

	it.each([undefined, null, ''])('uses the type default when the operator is %j', (operator) => {
		expect(
			build([
				{ field: 'source', operator, value: 'a' },
				{ field: 'year', operator, value: '2024' },
			]),
		).toEqual({ source: 'a', year: { min: 2024 } });
	});

	it('rejects a non-numeric NUMERIC value', () => {
		expect(() => build([{ field: 'year', operator: 'gte', value: 'abc' }])).toThrow(
			'the value must be a number, got "abc"',
		);
		expect(() => build([{ field: 'year', operator: 'between', value: '1', valueTo: '' }])).toThrow(
			'must be a number',
		);
	});

	it('rejects an empty TAG value', () => {
		expect(() => build([{ field: 'source', operator: 'isAnyOf', value: ' , ' }])).toThrow(
			'the value is empty',
		);
	});

	it.each([
		['an object for "is"', 'is', { id: 'acme' }, 'got {"id":"acme"} (object)'],
		['an object in a list', 'isAnyOf', [{ id: 'acme' }], 'got {"id":"acme"} (object)'],
		['a nested list', 'isAnyOf', [['acme']], 'got ["acme"] (list)'],
		['undefined in a list', 'isAnyOf', ['acme', undefined], 'got undefined'],
		['null in a list', 'isAnyOf', ['acme', null], 'got null'],
	])(
		'rejects %s as a TAG value instead of converting it to text',
		(_label, operator, value, got) => {
			const run = () => build([{ field: 'tenant', operator, value }]);
			expect(run).toThrow(
				`Metadata Filter condition 1 ("tenant"): TAG values must be text or a list of text, ${got}.`,
			);
		},
	);

	it.each([
		['a number', 42, '42'],
		['a boolean', true, 'true'],
	])('accepts %s as a TAG value', (_label, value, text) => {
		expect(build([{ field: 'tenant', operator: 'is', value }])).toEqual({ tenant: text });
	});

	it('rejects a null TAG value as empty', () => {
		expect(() => build([{ field: 'tenant', operator: 'is', value: null }])).toThrow(
			'the value is empty',
		);
	});

	describe('a TAG value that contains the field separator', () => {
		const pipeFields: MetadataField[] = [{ name: 'tags', type: 'TAG', separator: '|' }];
		const buildPipe = (rows: object[]) => buildMetadataFilter(rows, pipeFields, 'kb');

		it('rejects "Is" with a comma on a field with the default separator', () => {
			expect(() => build([{ field: 'source', operator: 'is', value: 'a,b' }])).toThrow(
				'Metadata Filter condition 1 ("source"): the value "a,b" contains ",", which separates tags in this field, so it can never match. Use "Is Any Of" with the parts.',
			);
		});

		it('rejects an "Is Any Of" list element that contains the separator', () => {
			expect(() => build([{ field: 'source', operator: 'isAnyOf', value: ['x', 'a,b'] }])).toThrow(
				'the value "a,b" contains ","',
			);
			expect(() => build([{ field: 'source', operator: 'isAnyOf', value: ['x', 'a,b'] }])).toThrow(
				'Give the parts as separate values.',
			);
		});

		it('rejects "Is" with the separator of a field that sets its own', () => {
			expect(() => buildPipe([{ field: 'tags', operator: 'is', value: 'a|b' }])).toThrow(
				'the value "a|b" contains "|"',
			);
		});

		it('accepts a comma in a field whose separator is not a comma', () => {
			expect(buildPipe([{ field: 'tags', operator: 'is', value: 'a,b' }])).toEqual({
				tags: 'a,b',
			});
		});

		it('rejects a typed "Is Any Of" value whose parts contain the field separator', () => {
			expect(() => buildPipe([{ field: 'tags', operator: 'isAnyOf', value: 'a|b, c' }])).toThrow(
				'the value "a|b" contains "|"',
			);
		});
	});

	it('rejects two TAG conditions on one field', () => {
		expect(() =>
			build([
				{ field: 'source', operator: 'is', value: 'a' },
				{ field: 'source', operator: 'is', value: 'b' },
			]),
		).toThrow('already has a condition');
	});

	it('rejects NUMERIC conditions that can never match', () => {
		expect(() =>
			build([
				{ field: 'year', operator: 'gte', value: '2025' },
				{ field: 'year', operator: 'lte', value: '2020' },
			]),
		).toThrow('can never match');
	});

	it('names the condition in errors', () => {
		expect(() => build([{ field: '' }])).toThrow('Metadata Filter condition 1: no field selected');
	});
});

// Valkey accepts these as field names; plain object lookups would find the
// Object.prototype members instead of the fields.
describe.each(['__proto__', 'constructor', 'toString'])('a field named %s', (name) => {
	const protoFields: MetadataField[] = [
		{ name, type: 'TAG' },
		{ name: 'year', type: 'NUMERIC' },
	];
	const buildProto = (rows: object[]) => buildMetadataFilter(rows, protoFields, 'kb');

	it('is an own key of customSchema', () => {
		const schema = toCustomSchema(protoFields);
		expect(Object.keys(schema)).toEqual([name, 'year']);
		expect(schema[name]).toEqual({ type: 'TAG' });
	});

	it('accepts one "Is" condition and keeps it as an own key', () => {
		const filter = buildProto([{ field: name, operator: 'is', value: 'a' }]);
		expect(Object.keys(filter ?? {})).toEqual([name]);
		expect(filter?.[name]).toBe('a');
	});

	it('still rejects a second condition on the same field', () => {
		expect(() =>
			buildProto([
				{ field: name, operator: 'is', value: 'a' },
				{ field: name, operator: 'is', value: 'b' },
			]),
		).toThrow(`Metadata Filter condition 2 ("${name}"): field "${name}" already has a condition.`);
	});
});

describe('a NUMERIC field named like an Object.prototype member', () => {
	it.each(['constructor', 'toString'])('starts %s from no range', (name) => {
		const filter = buildMetadataFilter(
			[{ field: name, operator: 'gte', value: '2020' }],
			[{ name, type: 'NUMERIC' }],
			'kb',
		);
		expect(filter?.[name]).toEqual({ min: 2020 });
	});
});
