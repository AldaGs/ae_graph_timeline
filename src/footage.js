import { ReadError } from './reader.js';

const DROPPED_ITEMS_FN = 'NTL_DroppedProjectItems';

export const droppedProjectItemsCall = (compId) => `${DROPPED_ITEMS_FN}(${Number(compId)})`;

export function parseDroppedProjectItems(jsonText) {
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new ReadError(`project-item drop did not return JSON: "${String(jsonText).slice(0, 120)}"`);
  }
  if (payload?.ok !== true || !Array.isArray(payload.items)) {
    throw new ReadError(payload?.message || 'project-item drop returned an invalid result', payload);
  }
  const items = payload.items.map((item) => {
    if (!Number.isFinite(item?.itemId) || typeof item.name !== 'string' || !item.name.length) {
      throw new ReadError('project-item drop did not identify its footage', payload);
    }
    return {
      kind: 'footage',
      itemId: item.itemId,
      name: item.name,
      path: typeof item.path === 'string' && item.path.length ? item.path : null,
      missing: item.missing === true,
    };
  });
  return {
    items,
    rejected: Number.isFinite(payload.rejected) ? payload.rejected : 0,
  };
}
