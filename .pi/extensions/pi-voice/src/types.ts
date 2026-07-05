/**
 * Shared types for the pi-voice extension.
 *
 * pi-voice is speech-to-text only: it records audio and transcribes it.
 * There is no playback path, so AudioBackends tracks only the recorder.
 */

/** Audio backend detection result */
export interface AudioBackends {
  /** Can record audio */
  canRecord: boolean;
  /** Which recorder command to use */
  recorder: AudioRecorder | null;
}

export interface AudioRecorder {
  cmd: string;
  args: (outputPath: string, duration?: number) => string[];
  ext: string; // output file extension
}

/** Extension settings persisted to session */
export interface VoiceSettings {
  /** OpenRouter model for STT (audio-capable) */
  sttModel: string;
  /** Max recording duration in seconds */
  maxRecordSeconds: number;
  /** Input audio language hint */
  language: string;
}

/** Default settings */
export const DEFAULT_SETTINGS: VoiceSettings = {
  sttModel: "openai/whisper-large-v3",
  maxRecordSeconds: 60,
  language: "en",
};

/** Recording state */
export interface RecordingState {
  startTime: number;
  outputPath: string;
  process: ReturnType<typeof import("child_process").spawn> | null;
  /** Did user manually stop, or did it hit duration/exit? */
  manuallyStopped: boolean;
  /** Called when the process exits (natural, signal, or error) */
  onExit?: (signal: NodeJS.Signals | null, code: number | null) => void;
}