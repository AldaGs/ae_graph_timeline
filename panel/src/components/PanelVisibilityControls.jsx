import { useEffect } from 'react';

const isTyping = (target) => target instanceof Element && Boolean(target.closest(
  'input, textarea, select, [contenteditable="true"]',
));

export default function PanelVisibilityControls({
  inspectorVisible,
  outlinerVisible,
  onToggleInspector,
  onToggleOutliner,
}) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if (key !== 't' && key !== 'n') return;
      event.preventDefault();
      event.stopPropagation();
      if (key === 't') onToggleInspector();
      else onToggleOutliner();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onToggleInspector, onToggleOutliner]);

  return (
    <>
      <button
        className={`ntl-panel-toggle is-inspector${inspectorVisible ? ' is-open' : ''}`}
        type="button"
        aria-label={`${inspectorVisible ? 'Hide' : 'Show'} inspector (T)`}
        aria-pressed={inspectorVisible}
        title={`${inspectorVisible ? 'Hide' : 'Show'} Inspector · T`}
        onClick={onToggleInspector}
      >T</button>
      <button
        className={`ntl-panel-toggle is-outliner${outlinerVisible ? ' is-open' : ''}`}
        type="button"
        aria-label={`${outlinerVisible ? 'Hide' : 'Show'} outliner (N)`}
        aria-pressed={outlinerVisible}
        title={`${outlinerVisible ? 'Hide' : 'Show'} Outliner · N`}
        onClick={onToggleOutliner}
      >N</button>
    </>
  );
}
