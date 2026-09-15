import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Pause, Play, Repeat2,
} from 'lucide-react';

const ICON_SIZE = 13;
const RULER_INSET = 11;

function isEditing(target) {
  return target instanceof Element && Boolean(target.closest(
    'input, textarea, select, button, [contenteditable="true"]',
  ));
}

function FrameField({ value, min, max, disabled, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(value)); }, [value]);

  const commit = () => {
    editing.current = false;
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(String(value));
  };

  return (
    <input
      className="ntl-current-frame"
      aria-label="Current frame"
      type="number"
      min={min}
      max={max}
      step="1"
      value={draft}
      disabled={disabled}
      onFocus={() => { editing.current = true; }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.currentTarget.blur(); }
        if (event.key === 'Escape') {
          setDraft(String(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function TimelineRuler({ transport, disabled, onScrub, onScrubStart, onScrubEnd }) {
  const rulerRef = useRef(null);
  const scrubbing = useRef(false);
  const length = Math.max(1, transport.endFrame - transport.startFrame);
  const percent = (frame) => ((frame - transport.startFrame) / length) * 100;
  const frameFromPointer = (clientX) => {
    const rect = rulerRef.current.getBoundingClientRect();
    const width = Math.max(1, rect.width - (RULER_INSET * 2));
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left - RULER_INSET) / width));
    return Math.round(transport.startFrame + (ratio * length));
  };
  const move = (event) => onScrub(frameFromPointer(event.clientX));

  return (
    <div
      ref={rulerRef}
      className={`ntl-ruler${disabled ? ' is-disabled' : ''}`}
      role="slider"
      aria-label="Composition playhead"
      aria-valuemin={transport.startFrame}
      aria-valuemax={transport.endFrame}
      aria-valuenow={transport.currentFrame}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={(event) => {
        if (disabled) return;
        scrubbing.current = true;
        onScrubStart();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        move(event);
      }}
      onPointerMove={(event) => { if (scrubbing.current) move(event); }}
      onPointerUp={(event) => {
        if (!scrubbing.current) return;
        move(event);
        scrubbing.current = false;
        onScrubEnd();
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => {
        if (scrubbing.current) onScrubEnd();
        scrubbing.current = false;
      }}
      onKeyDown={(event) => {
        if (disabled || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
        event.preventDefault();
        onScrub(transport.currentFrame + (event.key === 'ArrowLeft' ? -1 : 1));
      }}
    >
      <div className="ntl-ruler-inner">
        <div className="ntl-work-range" style={{
          left: `${percent(transport.workStartFrame)}%`,
          width: `${percent(transport.workEndFrame) - percent(transport.workStartFrame)}%`,
        }} />
        <span className="ntl-ruler-start">{transport.startFrame}</span>
        <span className="ntl-ruler-end">{transport.endFrame}</span>
        <div className="ntl-playhead" style={{ left: `${percent(transport.currentFrame)}%` }}>
          <span className="ntl-playhead-label">{transport.currentFrame}</span>
          <span className="ntl-playhead-line" />
        </div>
      </div>
    </div>
  );
}

export default function PlaybackBar({ playback }) {
  const { transport, enabled, playing } = playback;

  // Capture before React Flow sees Space: in the graph it is a viewport-pan
  // modifier, while in an AE/Blender-style transport it is play/pause.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.code !== 'Space' || event.repeat || !enabled || isEditing(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      playback.togglePlaying();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled, playback.togglePlaying]);

  const t = transport || {
    currentFrame: 0, startFrame: 0, endFrame: 0,
    workStartFrame: 0, workEndFrame: 0, frameRate: 0,
  };
  const button = (label, action, icon) => (
    <button className="ntl-transport-button" type="button" title={label}
      aria-label={label} disabled={!enabled} onClick={action}>
      {icon}
    </button>
  );

  return (
    <div className="ntl-playback" aria-label="Playback controls">
      <TimelineRuler transport={t} disabled={!enabled} onScrub={playback.scrubFrame}
        onScrubStart={playback.beginScrub} onScrubEnd={playback.endScrub} />
      <div className="ntl-playback-controls-row">
        <div className="ntl-transport-controls">
        {button('Go to work area start', playback.first, <ChevronsLeft size={ICON_SIZE} />)}
        {button('Previous frame', playback.previous, <ChevronLeft size={ICON_SIZE} />)}
        {button(playing ? 'Pause (Space)' : 'Play (Space)', playback.togglePlaying,
          playing ? <Pause size={ICON_SIZE} fill="currentColor" /> : <Play size={ICON_SIZE} fill="currentColor" />)}
        {button('Next frame', playback.next, <ChevronRight size={ICON_SIZE} />)}
        {button('Go to work area end', playback.last, <ChevronsRight size={ICON_SIZE} />)}
        <button className={`ntl-transport-button ntl-loop${playback.loop ? ' is-active' : ''}`}
          type="button" title="Loop work area" aria-label="Loop work area"
          aria-pressed={playback.loop} disabled={!enabled} onClick={playback.toggleLoop}>
          <Repeat2 size={ICON_SIZE} />
        </button>
        </div>

        <label className="ntl-frame-field">
          <span>Frame</span>
          <FrameField value={t.currentFrame} min={t.startFrame} max={t.endFrame}
            disabled={!enabled} onCommit={playback.seek} />
        </label>

        <span className="ntl-work-area" title={`Composition ${t.startFrame}–${t.endFrame}`}>
          Work Area&nbsp; {t.workStartFrame}–{t.workEndFrame}
        </span>
        <span className="ntl-fps">{Number(t.frameRate.toFixed(3))} fps{t.dropFrame ? ' DF' : ''}</span>
      </div>
    </div>
  );
}
