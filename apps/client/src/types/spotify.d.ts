declare namespace Spotify {
  interface Player {
    connect(): Promise<boolean>;
    disconnect(): void;
    addListener(event: "ready", callback: (data: { device_id: string }) => void): void;
    addListener(event: "not_ready", callback: (data: { device_id: string }) => void): void;
    addListener(event: "player_state_changed", callback: (state: PlaybackState | null) => void): void;
    addListener(event: "initialization_error", callback: (data: { message: string }) => void): void;
    addListener(event: "authentication_error", callback: (data: { message: string }) => void): void;
    addListener(event: "account_error", callback: (data: { message: string }) => void): void;
    addListener(event: "playback_error", callback: (data: { message: string }) => void): void;
    removeListener(event: string, callback?: Function): void;
    getCurrentState(): Promise<PlaybackState | null>;
    setName(name: string): Promise<void>;
    getVolume(): Promise<number>;
    setVolume(volume: number): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    togglePlay(): Promise<void>;
    seek(positionMs: number): Promise<void>;
    previousTrack(): Promise<void>;
    nextTrack(): Promise<void>;
  }

  interface PlaybackState {
    context: {
      uri: string | null;
      metadata: Record<string, unknown>;
    };
    disallows: {
      pausing: boolean;
      peeking_next: boolean;
      peeking_prev: boolean;
      resuming: boolean;
      seeking: boolean;
      skipping_next: boolean;
      skipping_prev: boolean;
    };
    duration: number;
    paused: boolean;
    position: number;
    repeat_mode: number;
    shuffle: boolean;
    track_window: {
      current_track: Track;
      previous_tracks: Track[];
      next_tracks: Track[];
    };
  }

  interface Track {
    uri: string;
    id: string | null;
    type: "track" | "episode" | "ad";
    media_type: "audio" | "video";
    name: string;
    is_playable: boolean;
    album: {
      uri: string;
      name: string;
      images: { url: string; height: number; width: number }[];
    };
    artists: { uri: string; name: string }[];
  }

  interface PlayerConstructorOptions {
    name: string;
    getOAuthToken: (cb: (token: string) => void) => void;
    volume?: number;
  }

  // eslint-disable-next-line @typescript-eslint/no-redeclare
  var Player: {
    new (options: PlayerConstructorOptions): Player;
  };
}
