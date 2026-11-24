

import { GridBackground } from "./GridBackground";
import { TrackHeader, type TrackType } from "./TrackHeader";
import { ArrangementGrid } from "./ArrangementGrid";

import "./SongCanvas.css";
import "./TrackHeader.css";

const trackTypes: TrackType[] = [
  "drums",
  "bass",
  "other",
  "vocals",
];

export function SongCanvas() {
  return (
    <section className="song-canvas">
      <GridBackground />

      <div className="song-canvas__content">
        {/* Fixed track headers */}
        <div className="song-canvas__tracks">
          {trackTypes.map((type) => (
            <TrackHeader key={type} type={type} />
          ))}
        </div>

        <div className="arrangement-scroll">
          <div className="arrangement-scroll__content">
            <ArrangementGrid />
          </div>
        </div>
      </div>
    </section>
  );
}

