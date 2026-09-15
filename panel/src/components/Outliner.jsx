// The outliner, drawn the way Blender's is.
//
// Blender's LOOK, not its hierarchy: a disclosure triangle, a type icon, a name,
// indent guides, and the per-row toggles pinned right. Every layer is a child of
// the composition and nothing else - see src/outline.js, which is where the tree
// lives as data, with its own tests. This file is the drawing and the pointer
// handling, and nothing else.
//
// Icons are lucide, chosen to match what After Effects puts in its own timeline
// switches column, so the two panels name the same thing the same way.

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Axis3d, Braces, ChevronDown, ChevronRight, Clapperboard, Eye, EyeOff,
  Image as ImageIcon, Lightbulb, PenTool, Sparkles, Square, Type, Video,
} from 'lucide-react';

import { LABEL_COLORS } from '../../../src/graph.js';
import { outlineTree, outlineRows, moveInOutline } from '../../../src/outline.js';
import './Outliner.css';

// One icon per AE layer kind. A kind with no entry falls back to footage, which
// is what After Effects itself calls a layer it has nothing more specific for.
const KIND_ICON = {
  solid: Square,
  null: Axis3d,
  text: Type,
  shape: PenTool,
  footage: ImageIcon,
  precomp: Clapperboard,
  camera: Video,
  light: Lightbulb,
  effect: Sparkles,
  expression: Braces,
};

const ROW_ICON = {
  comp: Clapperboard,
  logic: Braces,
  unwired: Sparkles,
  effect: Sparkles,
};

function RowIcon({ row }) {
  const Icon = ROW_ICON[row.type] || KIND_ICON[row.kind] || ImageIcon;
  return <Icon className="ntl-out-icon" size={13} strokeWidth={1.75} aria-hidden="true" />;
}

// The parent is not drawn: the design has no chip for it, and nesting the row
// under its parent is exactly what this outliner does not do. It is said on
// hover instead, so the relationship is available without costing a column.
const titleOf = (row, graph) => {
  const parent = row.parent ? graph.nodes[row.parent]?.name : null;
  if (parent) return `${row.name} — parented to ${parent}`;
  return row.matchName || row.name;
};

// "All", "none" or "some". A checkbox cannot be told `indeterminate` through an
// attribute, so the DOM node is set directly - the one place this file reaches
// past React, and only because the platform gives no other way.
function TriCheckbox({ checked, mixed, disabled, label, onChange }) {
  const set = (node) => { if (node) node.indeterminate = !checked && mixed; };
  return <input type="checkbox" className="ntl-out-check" ref={set}
    checked={checked} disabled={disabled} aria-label={label} title={label}
    onChange={(e) => onChange(e.target.checked)} />;
}

// Where a drop lands relative to the row under the pointer. Blender shows the
// same thing as a line above or below, and the halfway point is what decides it.
const dropHalf = (event, element) => {
  const box = element.getBoundingClientRect();
  return event.clientY - box.top < box.height / 2 ? 'before' : 'after';
};

export function Outliner({ graph, commands, version, editable = true, selected, onSelect }) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  // Two copies of one fact, on purpose. The REF is what the handlers act on:
  // React state set in dragstart is not visible to the drop handler's closure
  // until a re-render, and a drag is a sequence of events, not a render cycle.
  // The state is only what draws the dragged row faded.
  const draggingRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [dropOn, setDropOn] = useState(null);

  const groups = useMemo(() => outlineTree(graph), [graph, version]);
  const rows = useMemo(() => outlineRows(groups, collapsed), [groups, collapsed]);

  const toggleCollapsed = useCallback((id) => setCollapsed((was) => {
    const next = new Set(was);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

  // An effect row selects the node the user drew, when there is one. An inline
  // effect has no node of its own, so it selects the layer that carries it -
  // which is also the layer whose Effect Controls holds it.
  const selectRow = useCallback((row) => {
    if (row.type === 'comp' || row.type === 'logic' || row.type === 'unwired') {
      toggleCollapsed(row.id);
      return;
    }
    onSelect?.(row.type === 'effect' ? (row.nodeId ?? row.parentId) : row.id);
  }, [onSelect, toggleCollapsed]);

  const isSelected = (row) => (row.type === 'effect'
    ? row.nodeId !== null && selected === row.nodeId
    : selected === row.id);

  // The reference puts a checkbox on the collection row, and the honest reading
  // of it here is "is every layer in this comp visible". Wrapped in ONE gesture:
  // S5 put After Effects' undo stack at 99 entries, and hiding twelve layers is
  // one thing the user did, not twelve.
  const setAllEnabled = useCallback(async (enabled) => {
    const layers = groups.find((g) => g.type === 'comp')?.children || [];
    const changing = layers.filter((row) => row.enabled !== enabled);
    if (!changing.length) return;
    commands.beginGesture(enabled ? 'Show all layers' : 'Hide all layers');
    try {
      for (const row of changing) commands.setEnabled(row.id, enabled);
    } finally {
      await commands.endGesture();
    }
  }, [groups, commands]);

  const onDrop = useCallback((event, row) => {
    event.preventDefault();
    setDropOn(null);
    setDragging(null);
    const source = draggingRef.current;
    draggingRef.current = null;
    if (!editable || !source || row.type !== 'layer') return;
    const next = moveInOutline(groups, source, row.id,
      { before: dropHalf(event, event.currentTarget) === 'before' });
    // null means the move would change nothing. There is no reorder to send,
    // and sending one anyway would cost an undo entry for a drag that moved
    // nothing - out of the 99 After Effects keeps.
    if (next) commands.reorder(next);
  }, [editable, groups, commands]);

  if (rows.length === 0) return null;

  return (
    <div className="ntl-outliner">
      <div className="ntl-out-title">Outliner</div>
      <div className="ntl-out-list" role="tree" aria-label="Composition outliner">
        {rows.map((row) => {
          const draggable = editable && row.type === 'layer';
          return (
            <div
              key={`${row.type}:${row.id}`}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected(row)}
              aria-expanded={row.hasChildren ? !collapsed.has(row.id) : undefined}
              className={[
                'ntl-out-row',
                `is-${row.type}`,
                isSelected(row) ? 'is-selected' : '',
                row.type === 'layer' && !row.enabled ? 'is-hidden' : '',
                dragging === row.id ? 'is-dragging' : '',
                dropOn?.id === row.id ? `is-drop-${dropOn.half}` : '',
              ].filter(Boolean).join(' ')}
              style={{ '--depth': row.depth }}
              draggable={draggable}
              onDragStart={(e) => {
                if (!draggable) return;
                e.dataTransfer.effectAllowed = 'move';
                // Set for the platform's benefit; the id we act on is our own
                // state, because dataTransfer cannot be read during dragover
                // and the drop indicator has to know what is moving.
                e.dataTransfer.setData('text/plain', row.id);
                draggingRef.current = row.id;
                setDragging(row.id);
              }}
              onDragEnd={() => { draggingRef.current = null; setDragging(null); setDropOn(null); }}
              onDragOver={(e) => {
                if (!editable || !draggingRef.current || row.type !== 'layer') return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropOn({ id: row.id, half: dropHalf(e, e.currentTarget) });
              }}
              onDragLeave={() => setDropOn((was) => (was?.id === row.id ? null : was))}
              onDrop={(e) => onDrop(e, row)}
            >
              <span className="ntl-out-indent" aria-hidden="true" />

              {row.hasChildren ? (
                <button
                  className="ntl-out-twist"
                  aria-label={`${collapsed.has(row.id) ? 'Expand' : 'Collapse'} ${row.name}`}
                  onClick={(e) => { e.stopPropagation(); toggleCollapsed(row.id); }}
                >
                  {collapsed.has(row.id)
                    ? <ChevronRight size={12} strokeWidth={2} />
                    : <ChevronDown size={12} strokeWidth={2} />}
                </button>
              ) : <span className="ntl-out-twist is-empty" aria-hidden="true" />}

              <RowIcon row={row} />

              <button className="ntl-out-name" onClick={() => selectRow(row)}
                title={titleOf(row, graph)}>
                {row.name}
                {row.count !== undefined && <span className="ntl-out-count">{row.count}</span>}
              </button>

              {row.type === 'comp' && (
                <TriCheckbox
                  checked={(row.children || []).every((child) => child.enabled)}
                  mixed={(row.children || []).some((child) => child.enabled)}
                  disabled={!editable}
                  label={`Show every layer in ${row.name}`}
                  onChange={(next) => void setAllEnabled(next)}
                />
              )}

              {row.type === 'layer' && (
                <>
                  <button
                    className="ntl-out-swatch"
                    aria-label={`Change ${row.name} label`}
                    disabled={!editable}
                    style={{ backgroundColor: LABEL_COLORS[row.label] || 'transparent' }}
                    title="Label colour"
                    onClick={() => commands.setLabel(row.id,
                      ((row.label || 0) + 1) % LABEL_COLORS.length)}
                  />
                  <button
                    className="ntl-out-toggle"
                    aria-label={`${row.enabled ? 'Hide' : 'Show'} ${row.name}`}
                    aria-pressed={row.enabled}
                    disabled={!editable}
                    title={row.enabled ? 'Visible' : 'Hidden'}
                    onClick={() => commands.setEnabled(row.id, !row.enabled)}
                  >
                    {row.enabled
                      ? <Eye size={13} strokeWidth={1.75} />
                      : <EyeOff size={13} strokeWidth={1.75} />}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
