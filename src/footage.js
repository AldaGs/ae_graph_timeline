import { ReadError } from './reader.js';

const SELECT_FN = 'NTL_SelectFootageFile';

export const selectFootageCall = () => `${SELECT_FN}()`;

export function parseFootageSelection(jsonText) {
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new ReadError(`footage picker did not return JSON: "${String(jsonText).slice(0, 120)}"`);
  }
  if (payload?.ok !== true || typeof payload.selected !== 'boolean') {
    throw new ReadError(payload?.message || 'footage picker returned an invalid result', payload);
  }
  if (!payload.selected) return { selected: false };
  if (typeof payload.path !== 'string' || !payload.path.length) {
    throw new ReadError('footage picker returned no path', payload);
  }
  return {
    selected: true,
    path: payload.path,
    name: typeof payload.name === 'string' && payload.name.length
      ? payload.name : payload.path.split(/[\\/]/).pop(),
  };
}
