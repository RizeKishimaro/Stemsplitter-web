


import { useState } from "react";
import {
  useClipStore,
  splitClip,
  linkClips,
  canLinkClip,
  setClipLoop,
} from "../../../stores/clip.store";
import { audioEngine } from "../../audio-engine/AudioEngine";
import "./TrackHeader.css";

export type TrackType = "drums" | "bass" | "vocals" | "other";

interface TrackHeaderProps {
  type: TrackType;
}

type ControlIcon =
  | "scissors"
  | "link"
  | "speaker"
  | "curve"
  | "back"
  | "download"
  | "master"
  | "assign";

const tracks = {
  drums: {
    label: "DRUMS",
    icon: "/icons/icon-drums.svg",
    color: "#f0441e",
  },
  bass: {
    label: "BASS",
    icon: "/icons/icon-bass.svg",
    color: "#2850df",
  },
  vocals: {
    label: "VOCALS",
    icon: "/icons/icon-vocals.svg",
    color: "#ed4385",
  },
  other: {
    label: "OTHER",
    icon: "/icons/icon-other.svg",
    color: "#159966",
  },
} satisfies Record<TrackType, {
  label: string;
  icon: string;
  color: string;
}>;

function ControlGlyph({ name }: { name: ControlIcon }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      {name === "scissors" && (
        <g {...common}>
          <circle cx="5" cy="5" r="2.5" />
          <circle cx="5" cy="15" r="2.5" />
          <path d="M7 6.5 17 16 M7 13.5 17 4" />
        </g>
      )}

      {name === "link" && (
        <g {...common}>
          <path d="m8 12 4-4" />
          <path d="M7 14H5a4 4 0 0 1 0-8h4" />
          <path d="M13 6h2a4 4 0 0 1 0 8h-4" />
        </g>
      )}

      {name === "speaker" && (
        <g {...common}>
          <path d="M3 8h3l4-3v10l-4-3H3z" />
          <path d="M13 7a4 4 0 0 1 0 6 M15 4a8 8 0 0 1 0 12" />
        </g>
      )}

      {name === "curve" && (
        <g {...common}>
          <path d="M4 15V9a4 4 0 0 1 4-4h8" />
          <path d="m12 2 4 3-4 3" />
        </g>
      )}

      {name === "back" && (
        <g {...common}>
          <path d="M16 5H8a4 4 0 0 0 0 8h8" />
          <path d="m11 9-4 4 4 4" />
        </g>
      )}

      {name === "download" && (
        <g {...common}>
          <path d="M10 2v10 M6 8l4 4 4-4" />
          <path d="M3 14v3h14v-3" />
        </g>
      )}

      {name === "master" && (
        <g {...common}>
          <circle cx="10" cy="10" r="7" />
          <path d="M5 5l10 10" />
        </g>
      )}

      {name === "assign" && (
        <g {...common}>
          <path d="M4 4h12v12H4z" />
          <path d="M7 10h6 M10 7v6" />
        </g>
      )}
    </svg>
  );
}

function ToolButton({
  icon,
  label,
  disabled = false,
  active = false,
  onClick,
}: {
  icon: ControlIcon;
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`track-header__tool ${active ? "is-active" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <ControlGlyph name={icon} />
    </button>
  );
}

export function TrackHeader({ type }: TrackHeaderProps) {
  const [muted, setMuted] = useState(false);
  const [solo, setSolo] = useState(false);

  const clipState = useClipStore();
  const track = tracks[type];

  const selectedClip = clipState.selectedClipId
    ? clipState.clips[clipState.selectedClipId]
    : null;

  // Only allow track tools to affect a selected clip
  // belonging to this track.
  const hasSelectedTrackClip =
    !!selectedClip &&
    selectedClip.active &&
    selectedClip.stem === type;

  const canSplit = hasSelectedTrackClip;
  const canLink =
    hasSelectedTrackClip &&
    canLinkClip(selectedClip.id);

  const handleSplit = () => {
    if (!canSplit || !selectedClip) return;
    splitClip(selectedClip.id);
  };

  const handleLink = () => {
    if (!canLink || !selectedClip) return;
    linkClips(selectedClip.id);
  };

  const handleLoop = () => {
    if (!hasSelectedTrackClip || !selectedClip) return;
    const enabled = !selectedClip.loopEnabled;
    setClipLoop(selectedClip.id, enabled);
    audioEngine.setClipLoop(selectedClip.id, enabled);
  };

  return (
    <header
      className={`track-header track-header--${type}`}
      style={{ "--track-color": track.color } as React.CSSProperties}
    >
      <div className="track-header__identity">
        <div className="track-header__icon">
          <img src={track.icon} alt="" draggable={false} />

          {type === "bass" && (
            <img
              className="track-header__bass-detail"
              src="/icons/icon-bass-detail.svg"
              alt=""
              draggable={false}
            />
          )}
        </div>

        <span className="track-header__name">{track.label}</span>
      </div>

      <div className="track-header__control-panel">
        {/* MUTE / SOLO */}
        <div className="track-header__group track-header__group--mute">
          <div className="track-header__group-label">
            Mute/<br />Solo
          </div>

          <div className="track-header__group-buttons">
            <button
              type="button"
              className={muted ? "is-active" : ""}
              aria-label={`${track.label} mute`}
              aria-pressed={muted}
              onClick={() => setMuted(value => {
                const next = !value;
                audioEngine.setTrackMuted(type, next);
                return next;
              })}
            >
              M
            </button>

            <button
              type="button"
              className={solo ? "is-active" : ""}
              aria-label={`${track.label} solo`}
              aria-pressed={solo}
              onClick={() => setSolo(value => {
                const next = !value;
                audioEngine.setTrackSolo(type, next);
                return next;
              })}
            >
              S
            </button>
          </div>
        </div>

        {/* ASSIGN */}
        <div className="track-header__group track-header__group--assign">
          <div className="track-header__group-label">
            Assign
          </div>

          <div className="track-header__group-buttons">
            <ToolButton
              icon="curve"
              label={hasSelectedTrackClip
                ? selectedClip.loopEnabled ? "Disable loop on selected clip" : "Enable loop on selected clip"
                : "Select a clip on this track to toggle loop"}
              disabled={!hasSelectedTrackClip}
              active={!!selectedClip?.loopEnabled && hasSelectedTrackClip}
              onClick={handleLoop}
            />

            <ToolButton
              icon="scissors"
              label={
                canSplit
                  ? "Split selected clip"
                  : "Select a clip on this track first"
              }
              disabled={!canSplit}
              onClick={handleSplit}
            />

            <ToolButton
              icon="back"
              label="Move back (not implemented yet)"
              disabled
            />

            <ToolButton
              icon="link"
              label={
                canLink
                  ? "Recombine selected clip"
                  : "Select a split clip with an available sibling"
              }
              disabled={!canLink}
              onClick={handleLink}
            />
          </div>
        </div>

        {/* MASTER */}
        <div className="track-header__group track-header__group--master">
          <div className="track-header__group-label">
            Master
          </div>

          <div className="track-header__group-buttons">
            <ToolButton icon="speaker" label="Volume (not implemented yet)" disabled />
            <ToolButton icon="master" label="Master control (not implemented yet)" disabled />
            <ToolButton icon="curve" label="Curve (not implemented yet)" disabled />
            <ToolButton icon="download" label="Download (not implemented yet)" disabled />
          </div>
        </div>
      </div>
    </header>
  );
}
