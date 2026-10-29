import {
	buildMetadataFilter,
	decodeFieldName,
	encodeFieldOption,
	toCustomSchema,
} from '../nodes/ValkeyVectorStore/shared/filters';
import type { MetadataField } from '../nodes/ValkeyVectorStore/shared/indexSchema';

const fields: MetadataField[] = [
	{ name: 'source', type: 'TAG' },
	{ name: 'tenant', type: 'TAG' },
	{ name: 'year', type: 'NUMERIC' },
];

const build = (rows: object[]) => buildMetadataFilter(rows, fields, 'kb');

describe('field option encoding', () => {
	it('round-trips name|TYPE and accepts bare names', () => {
		expect(encodeFieldOption({ name: 'source', type: 'TAG' })).toBe('source|TAG');
		expect(decodeFieldName('source|TAG')).toBe('source');
		expect(decodeFieldName('source')).toBe('source');
	});

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
		[{ field: 'source|TAG', tagOperator: 'is', value: 'faq.pdf' }, { source: 'faq.pdf' }],
		[
			{ field: 'source|TAG', tagOperator: 'isAnyOf', value: 'billing.pdf, faq.pdf' },
			{ source: ['billing.pdf', 'faq.pdf'] },
		],
		[
			{ field: 'year|NUMERIC', numericOperator: 'equals', value: '2024' },
			{ year: { min: 2024, max: 2024 } },
		],
		[{ field: 'year|NUMERIC', numericOperator: 'gte', value: '2024' }, { year: { min: 2024 } }],
		[{ field: 'year|NUMERIC', numericOperator: 'lte', value: 2024 }, { year: { max: 2024 } }],
		[
			{ field: 'year|NUMERIC', numericOperator: 'between', value: '2023', valueTo: '2025' },
			{ year: { min: 2023, max: 2025 } },
		],
	])('maps %j', (row, expected) => {
		expect(build([row])).toEqual(expected);
	});

	it('uses the type default operator when none is stored', () => {
		expect(build([{ field: 'source|TAG', value: 'a' }])).toEqual({ source: 'a' });
		expect(build([{ field: 'year|NUMERIC', value: '1' }])).toEqual({ year: { min: 1 } });
	});

	it('ANDs conditions on different fields', () => {
		expect(
			build([
				{ field: 'source|TAG', tagOperator: 'is', value: 'billing.pdf' },
				{ field: 'year|NUMERIC', numericOperator: 'between', value: '2023', valueTo: '2025' },
			]),
		).toEqual({ source: 'billing.pdf', year: { min: 2023, max: 2025 } });
	});

	it('intersects NUMERIC conditions on the same field', () => {
		expect(
			build([
				{ field: 'year', numericOperator: 'gte', value: '2020' },
				{ field: 'year', numericOperator: 'lte', value: '2024' },
			]),
		).toEqual({ year: { min: 2020, max: 2024 } });
	});

	it('accepts array values from expressions', () => {
		expect(build([{ field: 'tenant', tagOperator: 'isAnyOf', value: ['acme', 'globex'] }])).toEqual(
			{
				tenant: ['acme', 'globex'],
			},
		);
	});

	it('rejects a field that is not indexed, including from an expression', () => {
		expect(() => build([{ field: 'category', tagOperator: 'is', value: 'x' }])).toThrow(
			'"category" is not an indexed field of index "kb"',
		);
	});

	it('rejects an operator of the wrong type', () => {
		expect(() => build([{ field: 'source', tagOperator: 'gte', value: 'x' }])).toThrow(
			'operator "gte" is not valid for TAG field "source"',
		);
		expect(() => build([{ field: 'year', numericOperator: 'isAnyOf', value: '1' }])).toThrow(
			'operator "isAnyOf" is not valid for NUMERIC field "year"',
		);
	});

	it('rejects a non-numeric NUMERIC value', () => {
		expect(() => build([{ field: 'year', numericOperator: 'gte', value: 'abc' }])).toThrow(
			'the value must be a number, got "abc"',
		);
		expect(() =>
			build([{ field: 'year', numericOperator: 'between', value: '1', valueTo: '' }]),
		).toThrow('must be a number');
	});

	it('rejects an empty TAG value', () => {
		expect(() => build([{ field: 'source', tagOperator: 'isAnyOf', value: ' , ' }])).toThrow(
			'the value is empty',
		);
	});

	it('rejects two TAG conditions on one field', () => {
		expect(() =>
			build([
				{ field: 'source', tagOperator: 'is', value: 'a' },
				{ field: 'source', tagOperator: 'is', value: 'b' },
			]),
		).toThrow('already has a condition');
	});

	it('rejects NUMERIC conditions that can never match', () => {
		expect(() =>
			build([
				{ field: 'year', numericOperator: 'gte', value: '2025' },
				{ field: 'year', numericOperator: 'lte', value: '2020' },
			]),
		).toThrow('can never match');
	});

	it('names the condition in errors', () => {
		expect(() => build([{ field: '' }])).toThrow('Metadata Filter condition 1: no field selected');
	});
});
