
import { audioEngine } from "./AudioEngine";
import { useTransportPosition, useTransportStore } from "../../stores/transport.store";
import "./TransportBar.css";

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);

  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function TransportBar() {
  const transport = useTransportStore();
  const currentTime = useTransportPosition();

  const progress = transport.duration > 0
    ? (currentTime / transport.duration) * 100
    : 0;

  return (
    <div className="transport-bar">
      <div className="transport-bar__controls">
        <button
          type="button"
          onClick={() => audioEngine.stop()}
          title="Stop"
        >
          ■
        </button>

        <button
          type="button"
          onClick={() => audioEngine.togglePlayback()}
          title={transport.isPlaying ? "Pause" : "Play"}
          className="transport-bar__play"
        >
          {transport.isPlaying ? "Ⅱ" : "▶"}
        </button>
      </div>

      <div className="transport-bar__timeline">
        <span>{formatTime(currentTime)}</span>

        <div className="transport-bar__progress">
          <div
            className="transport-bar__progress-fill"
            style={{ width: `${progress}%` }}
          />
        </div>

        <span>{formatTime(transport.duration)}</span>
      </div>

      <span className="transport-bar__status">
        {transport.isPlaying
          ? "PLAYING"
          : transport.isPaused
            ? "PAUSED"
            : transport.isBuffering
              ? "BUFFERING"
              : "STOPPED"}
      </span>
    </div>
  );
}
