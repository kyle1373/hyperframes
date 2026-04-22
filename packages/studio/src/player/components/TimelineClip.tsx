// TimelineClip — Visual clip component for the NLE timeline.
//
// Drag + trim: the clip body and its two edge handles carry
// `data-clip-role` attributes ("move" | "trim-left" | "trim-right").
// Timeline.tsx detects these on pointerdown, captures the pointer on the
// scroll container, and drives the drag from there so the click/double-
// click handlers keep working for simple selections.

import { memo, type ReactNode } from "react";
import type { TimelineElement } from "../store/playerStore";

interface TimelineClipProps {
  el: TimelineElement;
  pps: number;
  clipY: number;
  isSelected: boolean;
  isHovered: boolean;
  hasCustomContent: boolean;
  style: { clip: string; label: string };
  isComposition: boolean;
  onHoverStart: () => void;
  onHoverEnd: () => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  /** When true, render left/right trim handles and mark the body for drag. */
  timingEditable?: boolean;
  children?: ReactNode;
}

const HANDLE_W = 6;

export const TimelineClip = memo(function TimelineClip({
  el,
  pps,
  clipY,
  isSelected,
  isHovered,
  hasCustomContent,
  style,
  isComposition,
  onHoverStart,
  onHoverEnd,
  onClick,
  onDoubleClick,
  timingEditable = false,
  children,
}: TimelineClipProps) {
  const leftPx = el.start * pps;
  const widthPx = Math.max(el.duration * pps, 4);
  const showHandles = timingEditable && widthPx >= 18;

  return (
    <div
      data-clip="true"
      data-clip-role={timingEditable ? "move" : undefined}
      data-element-id={el.id}
      className={hasCustomContent ? "absolute" : "absolute flex items-center"}
      style={{
        left: leftPx,
        width: widthPx,
        top: clipY,
        bottom: clipY,
        borderRadius: 5,
        backgroundColor: hasCustomContent ? (isComposition ? "#111" : style.clip) : style.clip,
        backgroundImage:
          isComposition && !hasCustomContent
            ? `repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(255,255,255,0.08) 3px, rgba(255,255,255,0.08) 6px)`
            : undefined,
        border: isSelected
          ? `2px solid rgba(255,255,255,0.9)`
          : `1px solid rgba(255,255,255,${isHovered ? 0.3 : 0.15})`,
        boxShadow: isSelected
          ? `0 0 0 1px ${style.clip}, 0 2px 8px rgba(0,0,0,0.4)`
          : isHovered
            ? "0 1px 4px rgba(0,0,0,0.3)"
            : "none",
        transition: "border-color 120ms, box-shadow 120ms",
        zIndex: isSelected ? 10 : isHovered ? 5 : 1,
        cursor: timingEditable ? "grab" : "default",
      }}
      title={
        isComposition
          ? `${el.compositionSrc} \u2022 Double-click to open`
          : `${el.id || el.tag} \u2022 ${el.start.toFixed(2)}s \u2013 ${(el.start + el.duration).toFixed(2)}s \u2022 ${el.duration.toFixed(2)}s`
      }
      onPointerEnter={onHoverStart}
      onPointerLeave={onHoverEnd}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Left trim handle — visible on hover/selection, interactive always.
          Width = HANDLE_W so users have a real grab target without
          visually stealing space from the clip body. */}
      {showHandles && (
        <div
          data-clip-role="trim-left"
          title={`Trim start · now ${el.start.toFixed(2)}s`}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: HANDLE_W,
            cursor: "ew-resize",
            background:
              isSelected || isHovered
                ? "linear-gradient(90deg, rgba(255,255,255,0.85), rgba(255,255,255,0.15))"
                : "rgba(255,255,255,0.0)",
            transition: "background 120ms",
            zIndex: 20,
            touchAction: "none",
          }}
        />
      )}

      {children}

      {/* Right trim handle */}
      {showHandles && (
        <div
          data-clip-role="trim-right"
          title={`Trim end · now ${(el.start + el.duration).toFixed(2)}s (dur ${el.duration.toFixed(2)}s)`}
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            bottom: 0,
            width: HANDLE_W,
            cursor: "ew-resize",
            background:
              isSelected || isHovered
                ? "linear-gradient(270deg, rgba(255,255,255,0.85), rgba(255,255,255,0.15))"
                : "rgba(255,255,255,0.0)",
            transition: "background 120ms",
            zIndex: 20,
            touchAction: "none",
          }}
        />
      )}
    </div>
  );
});
