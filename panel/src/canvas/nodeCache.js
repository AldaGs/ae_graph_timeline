// The model is mutable: compare serialized display data, never object identity.
// Cache only the current graph so closing a comp releases its display records.
export function createNodeCache() {
  let previous = new Map();
  return (nodes) => {
    const next = new Map();
    const result = nodes.map((node) => {
      const signature = JSON.stringify(node.data);
      const old = previous.get(node.id);
      const data = old?.signature === signature ? old.data : node.data;
      next.set(node.id, { signature, data });
      return { ...node, data };
    });
    previous = next;
    return result;
  };
}
