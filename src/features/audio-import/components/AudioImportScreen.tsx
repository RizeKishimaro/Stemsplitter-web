
import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import "./AudioImportScreen.css";

type AudioImportScreenProps = {
  onAudioLoaded: (file: File, audioBuffer: AudioBuffer) => void;
};

const SUPPORTED_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".flac",
  ".ogg",
  ".oga",
  ".m4a",
  ".aac",
  ".opus",
  ".webm",
  ".aif",
  ".aiff",
];

function isAudioFile(file: File) {
  const name = file.name.toLowerCase();

  return (
    file.type.startsWith("audio/") ||
    SUPPORTED_EXTENSIONS.some((extension) =>
      name.endsWith(extension),
    )
  );
}

export function AudioImportScreen({
  onAudioLoaded,
}: AudioImportScreenProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  async function importAudio(file?: File) {
    if (!file) return;

    setError("");

    if (!isAudioFile(file)) {
      setError("Unsupported file. Please select an audio file.");
      return;
    }

    setIsLoading(true);

    let context: AudioContext | undefined;

    try {
      const arrayBuffer = await file.arrayBuffer();

      context = new AudioContext();

      const audioBuffer = await context.decodeAudioData(arrayBuffer);

      onAudioLoaded(file, audioBuffer);
    } catch (err) {
      console.error("[Audio Import]", err);

      setError(
        "Could not decode this audio file. Try another format or file.",
      );
    } finally {
      await context?.close();
      setIsLoading(false);

      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    void importAudio(event.target.files?.[0]);
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();

    dragCounter.current += 1;
    setIsDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();

    dragCounter.current -= 1;

    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();

    event.dataTransfer.dropEffect = "copy";
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();

    dragCounter.current = 0;
    setIsDragging(false);

    void importAudio(event.dataTransfer.files?.[0]);
  }

  return (
    <section
      className={`audio-import ${isDragging ? "audio-import--dragging" : ""
        }`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        className="audio-import__input"
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.opus,.aif,.aiff"
        onChange={handleFileChange}
        tabIndex={-1}
      />

      <div className="audio-import__content">
        <div className="audio-import__heading">
          {isDragging ? (
            <>
              Drop your song
              <br />
              here
            </>
          ) : isLoading ? (
            <>
              Preparing your
              <br />
              song...
            </>
          ) : (
            <>
              Drop a
              <br />
              song here
            </>
          )}
        </div>

        <span className="audio-import__separator">or</span>

        <button
          className="audio-import__button"
          type="button"
          disabled={isLoading}
          onClick={() => inputRef.current?.click()}
        >
          {isLoading ? "Importing..." : "Import Song"}
        </button>

        {error && (
          <p className="audio-import__error" role="alert">
            {error}
          </p>
        )}

        <p className="audio-import__formats">
          WAV · MP3 · FLAC · OGG · M4A · AAC
        </p>
      </div>
    </section>
  );
}

