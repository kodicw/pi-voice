/**
 * Shared types for the pi-voice extension.
 */

/** Audio backend detection result */
export interface AudioBackends {
  /** Can record audio */
  canRecord: boolean;
  /** Can play audio */
  canPlay: boolean;
  /** Which recorder command to use */
  recorder: AudioRecorder | null;
  /** Which player command to use */
  player: AudioPlayer | null;
  /** Has espeak-ng for TTS */
  hasEspeak: boolean;
  /** Has piper for neural TTS */
  hasPiper: boolean;
}

export interface AudioRecorder {
  cmd: string;
  args: (outputPath: string, duration?: number) => string[];
  ext: string; // output file extension
}

export interface AudioPlayer {
  cmd: string;
  args: (filePath: string) => string[];
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
