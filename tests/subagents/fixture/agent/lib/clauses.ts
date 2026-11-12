export const clauseIds = ['clause-001', 'clause-002', 'clause-003'] as const;
export type ClauseId = typeof clauseIds[number];
export const markers: Record<ClauseId, string> = {
  'clause-001': 'SBX12-PRIVATE-CLAUSE-001',
  'clause-002': 'SBX12-PRIVATE-CLAUSE-002',
  'clause-003': 'SBX12-PRIVATE-CLAUSE-003',
};
export function parseClause(text: string, assigned: ClauseId) {
  const match = /^Clause ID: (clause-\d{3})\nQuoted sentence: "([^"\n]+)"\n?$/.exec(text.replace(/\r\n/g, '\n'));
  if (!match || match[1] !== assigned) throw new Error('Assigned fixture ID/text format does not match');
  return { id: match[1], sentence: match[2] };
}
export function normalized(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalized).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${normalized(v)}`).join(',')}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Expected a JSON value');
  return json;
}
