"use client";

import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";

interface SpotifyContextType {
  connected: boolean;
  loading: boolean;
  deviceId: string | null;
  player: Spotify.Player | null;
  accessToken: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  playUri: (uri: string) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  playerState: Spotify.PlaybackState | null;
}

const SpotifyContext = createContext<SpotifyContextType>({
  connected: false,
  loading: true,
  deviceId: null,
  player: null,
  accessToken: null,
  connect: () => {},
  disconnect: async () => {},
  playUri: async () => {},
  pause: async () => {},
  resume: async () => {},
  seek: async () => {},
  playerState: null,
});

export function useSpotify() {
  return useContext(SpotifyContext);
}

// Extend window for Spotify SDK
declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: typeof Spotify;
  }
}

export function SpotifyProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [playerState, setPlayerState] = useState<Spotify.PlaybackState | null>(null);
  const playerRef = useRef<Spotify.Player | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Fetch/refresh the access token from our API
  const fetchToken = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch("/api/spotify/token");
      const data = await res.json();
      if (data.connected && data.access_token) {
        setAccessToken(data.access_token);
        setConnected(true);

        // Schedule next refresh 60s before expiry
        const msUntilExpiry = data.expires_at - Date.now() - 60_000;
        if (msUntilExpiry > 0) {
          clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = setTimeout(() => fetchToken(), msUntilExpiry);
        }

        return data.access_token;
      } else {
        setConnected(false);
        setAccessToken(null);
        return null;
      }
    } catch {
      setConnected(false);
      setAccessToken(null);
      return null;
    }
  }, []);

  // Initialize SDK when we have a token
  const initPlayer = useCallback((token: string) => {
    if (playerRef.current) return;
    if (!window.Spotify) return;

    const player = new window.Spotify.Player({
      name: "The Stacks",
      getOAuthToken: async (cb) => {
        // Always fetch fresh token
        const freshToken = await fetchToken();
        cb(freshToken || token);
      },
      volume: 0.8,
    });

    player.addListener("ready", ({ device_id }) => {
      setDeviceId(device_id);
    });

    player.addListener("not_ready", () => {
      setDeviceId(null);
    });

    player.addListener("player_state_changed", (state) => {
      setPlayerState(state);
    });

    player.addListener("initialization_error", ({ message }) => {
      console.error("Spotify init error:", message);
    });

    player.addListener("authentication_error", ({ message }) => {
      console.error("Spotify auth error:", message);
      setConnected(false);
    });

    player.addListener("account_error", ({ message }) => {
      console.error("Spotify account error:", message);
    });

    player.connect();
    playerRef.current = player;
  }, [fetchToken]);

  // Load SDK script
  const loadSDK = useCallback(() => {
    if (document.getElementById("spotify-sdk")) return;

    window.onSpotifyWebPlaybackSDKReady = () => {
      // SDK is ready — if we have a token, init the player
      if (accessToken) {
        initPlayer(accessToken);
      }
    };

    const script = document.createElement("script");
    script.id = "spotify-sdk";
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);
  }, [accessToken, initPlayer]);

  // On mount: check if Spotify is connected
  useEffect(() => {
    fetchToken().then((token) => {
      setLoading(false);
      if (token) {
        loadSDK();
      }
    });

    return () => {
      clearTimeout(refreshTimerRef.current);
      playerRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When token becomes available and SDK is loaded, init player
  useEffect(() => {
    if (accessToken && window.Spotify && !playerRef.current) {
      initPlayer(accessToken);
    }
  }, [accessToken, initPlayer]);

  const connect = useCallback(() => {
    window.location.href = "/api/spotify/login";
  }, []);

  const disconnect = useCallback(async () => {
    playerRef.current?.disconnect();
    playerRef.current = null;
    setDeviceId(null);
    setConnected(false);
    setAccessToken(null);
    setPlayerState(null);
    clearTimeout(refreshTimerRef.current);
    await fetch("/api/spotify/logout", { method: "POST" });
  }, []);

  const playUri = useCallback(async (spotifyUri: string) => {
    if (!deviceId || !accessToken) return;

    // Convert URL to URI if needed
    let uri = spotifyUri;
    if (uri.includes("open.spotify.com")) {
      try {
        const url = new URL(uri);
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) {
          uri = `spotify:${parts[0]}:${parts[1]}`;
        }
      } catch {}
    }

    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: [uri] }),
    });
  }, [deviceId, accessToken]);

  const pause = useCallback(async () => {
    await playerRef.current?.pause();
  }, []);

  const resume = useCallback(async () => {
    await playerRef.current?.resume();
  }, []);

  const seek = useCallback(async (positionMs: number) => {
    await playerRef.current?.seek(positionMs);
  }, []);

  return (
    <SpotifyContext.Provider
      value={{
        connected,
        loading,
        deviceId,
        player: playerRef.current,
        accessToken,
        connect,
        disconnect,
        playUri,
        pause,
        resume,
        seek,
        playerState,
      }}
    >
      {children}
    </SpotifyContext.Provider>
  );
}
