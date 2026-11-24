import "./GridBackground.css";
import gridLines from "../assets/grid-lines.svg";
import gridCrosses from "../assets/grid-crosses.svg";

export function GridBackground() {
  return (
    <div className="grid-background" aria-hidden="true">
      <img
        className="grid-background__lines"
        src={gridLines}
        alt=""
        draggable={false}
      />

      <img
        className="grid-background__crosses"
        src={gridCrosses}
        alt=""
        draggable={false}
      />
    </div>
  );
}
