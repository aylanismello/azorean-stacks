#!/usr/bin/env python3
"""Sync Segundo Sol Sessions episode source playlists into PicoDrops.

Current supported source:
- Spotify public playlist URL/id via open.spotify.com embed metadata (auth-free fallback)
- SoundCloud, Bandcamp, and YouTube tracks/playlists via yt-dlp JSON

Usage:
  python3 ~/.hermes/scripts/segundo_sol_sessions_sync.py 1 --spotify-url 'https://open.spotify.com/playlist/...'
  python3 ~/.hermes/scripts/segundo_sol_sessions_sync.py 1 --soundcloud-url 'https://soundcloud.com/.../sets/...'
  python3 ~/.hermes/scripts/segundo_sol_sessions_sync.py 1 --source-url 'https://bandcamp.com/...'
  python3 ~/.hermes/scripts/segundo_sol_sessions_sync.py 1 --download

Download behavior:
- Before downloading, search the rest of ~/Music/PicoDrops for an already-existing MP3.
- Only copy an existing file when it is a strong match: exact title filename match
  (or legacy normalized `Artist - Title` filename match) plus duration within tolerance when Spotify
  duration is known.
- The manifest records whether each track was copied, already existed, downloaded, pending, or failed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib
import json
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

PICODROPS = Path.home() / "Music/PicoDrops"
REKORDBOX_ROOT = PICODROPS / "rekordbox"
METADATA_ROOT = PICODROPS / "_metadata"
ROOT = REKORDBOX_ROOT / "segundo_sol_sessions"
REGISTRY = METADATA_ROOT / "segundo_sol_sessions" / "_registry" / "sessions-registry.json"
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".flac", ".wav", ".aiff", ".aif", ".ogg", ".opus"}


def spotify_id(value: str) -> str:
    m = re.search(r"playlist/([A-Za-z0-9]+)", value) or re.search(r"spotify:playlist:([A-Za-z0-9]+)", value)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9]+", value):
        return value
    raise SystemExit(f"could not parse Spotify playlist id from {value!r}")


def fetch_spotify_embed(playlist_url_or_id: str) -> dict:
    pid = spotify_id(playlist_url_or_id)
    url = f"https://open.spotify.com/embed/playlist/{pid}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8")
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html)
    if not m:
        raise SystemExit("Spotify embed did not expose __NEXT_DATA__")
    data = json.loads(m.group(1))
    entity = data["props"]["pageProps"]["state"]["data"]["entity"]
    tracks = []
    for i, t in enumerate(entity.get("trackList", []), 1):
        tracks.append({
            "position": i,
            "artist": (t.get("subtitle") or "").replace("\xa0", " "),
            "title": t.get("title"),
            "spotify_uri": t.get("uri"),
            "duration_ms": t.get("duration"),
            "source": "spotify_embed_trackList",
            "audio_preview_url": (t.get("audioPreview") or {}).get("url"),
        })
    return {
        "playlist_name": entity.get("name"),
        "playlist_id": entity.get("id"),
        "owner": entity.get("subtitle"),
        "tracks": tracks,
    }


def safe_name(s: str) -> str:
    s = unicodedata.normalize("NFC", s or "")
    return re.sub(r"[/:\\]+", "-", s).strip()


def split_source_artist_title(raw_title: str | None, uploader: str | None = None) -> tuple[str | None, str]:
    """Return clean artist/title. For SoundCloud, prefer explicit `Artist - Title` over uploader.

    SoundCloud uploaders are often just upload accounts/reposters. If the source title says
    `TNGHT - Higher Ground`, the artist is TNGHT, not the uploader `Boyflo 06`.
    """
    title = safe_name(unicodedata.normalize("NFC", raw_title or "Untitled"))
    title = re.sub(r"^\s*\d{1,3}\s*[-._]\s*", "", title)
    title = re.sub(r"\s*\[[A-Za-z0-9_-]{8,}\]\s*$", "", title)
    for junk in ["[OFFICIAL AUDIO]", "[Official Audio]", "(Official Audio)", "(Official Video)", "(Video)", "[HQ Audio]"]:
        title = title.replace(junk, "")
    title = re.sub(r"\s+", " ", title).strip(" .-_") or "Untitled"
    if " - " in title:
        first, rest = title.split(" - ", 1)
        if 1 <= len(first.strip()) <= 45 and rest.strip():
            return first.strip(), rest.strip()
    return (uploader or None), title


def visible_title(title: str | None) -> str:
    return split_source_artist_title(title)[1]


def retag_mp3(path: Path, title: str, artist: str | None = None) -> None:
    if not path.exists() or path.suffix.casefold() != ".mp3":
        return
    tmp = path.with_name(path.stem + ".retag.tmp.mp3")
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(path), "-map", "0", "-c", "copy", "-id3v2_version", "3", "-metadata", f"title={title}"]
    if artist:
        cmd += ["-metadata", f"artist={artist}"]
    cmd.append(str(tmp))
    proc = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode == 0 and tmp.exists():
        tmp.replace(path)
    elif tmp.exists():
        tmp.unlink()


def fetch_soundcloud_playlist(soundcloud_url: str) -> dict:
    proc = subprocess.run(["yt-dlp", "-J", soundcloud_url], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if proc.returncode != 0:
        raise SystemExit(proc.stderr[-1200:] or "yt-dlp failed reading SoundCloud playlist")
    data = json.loads(proc.stdout)
    entries = []
    for i, e in enumerate(data.get("entries") or [], 1):
        src_url = e.get("webpage_url") or e.get("url")
        raw_title = e.get("title")
        uploader = e.get("uploader") or e.get("channel") or ""
        # Some playlist JSON entries are skeletal; fetch the item once so we don't write Untitled.mp3.
        if (not raw_title or raw_title == "Untitled") and src_url:
            one = subprocess.run(["yt-dlp", "-J", "--no-playlist", src_url], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90)
            if one.returncode == 0:
                try:
                    full = json.loads(one.stdout)
                    raw_title = full.get("title") or raw_title
                    uploader = full.get("uploader") or full.get("channel") or uploader
                    src_url = full.get("webpage_url") or src_url
                    e = {**e, **full}
                except Exception:
                    pass
        artist, title = split_source_artist_title(raw_title, uploader)
        entries.append({
            "position": i,
            "artist": artist,
            "title": title,
            "source_title": raw_title,
            "source_url": src_url,
            "duration_seconds_expected": e.get("duration"),
            "source": "soundcloud_yt_dlp_playlist",
        })
    return {"playlist_name": data.get("title"), "playlist_url": soundcloud_url, "owner": data.get("uploader") or data.get("channel"), "tracks": entries}


def source_kind_for_url(source_url: str) -> str:
    host = urllib.parse.urlparse(source_url).hostname or ""
    if "soundcloud.com" in host:
        return "soundcloud"
    if "bandcamp.com" in host:
        return "bandcamp"
    if "youtube.com" in host or "youtu.be" in host:
        return "youtube"
    raise SystemExit("unsupported Segundo Sol source")


def fetch_generic_source(source_url: str) -> dict:
    proc = subprocess.run(["yt-dlp", "-J", source_url], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if proc.returncode != 0:
        raise SystemExit(proc.stderr[-1200:] or "yt-dlp failed reading source")
    data = json.loads(proc.stdout)
    raw_entries = data.get("entries") or [data]
    entries = []
    for i, entry in enumerate(raw_entries, 1):
        if not entry:
            continue
        raw_title = entry.get("title") or "Untitled"
        uploader = entry.get("artist") or entry.get("uploader") or entry.get("channel") or ""
        artist, title = split_source_artist_title(raw_title, uploader)
        webpage_url = entry.get("webpage_url") or entry.get("original_url") or entry.get("url")
        if webpage_url and not str(webpage_url).startswith("http"):
            webpage_url = source_url
        entries.append({
            "position": i,
            "artist": artist,
            "title": title,
            "source_title": raw_title,
            "source_url": webpage_url or source_url,
            "duration_seconds_expected": entry.get("duration"),
            "source": f"{source_kind_for_url(source_url)}_yt_dlp",
        })
    return {
        "playlist_name": data.get("playlist_title") or data.get("title"),
        "playlist_url": source_url,
        "owner": data.get("uploader") or data.get("channel") or data.get("artist"),
        "tracks": entries,
    }


def norm(s: str | None) -> str:
    s = (s or "").casefold()
    s = re.sub(r"\([^)]*\)|\[[^]]*\]", " ", s)
    s = s.replace("&", " and ")
    s = re.sub(r"\b(feat|ft|featuring|with|prod|remaster(?:ed)?|explicit|audio|official|video|hd)\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def duration_seconds(path: Path) -> float | None:
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
        if proc.returncode != 0:
            return None
        return float(json.loads(proc.stdout).get("format", {}).get("duration"))
    except Exception:
        return None


def estimate_bpm(path: Path) -> float | None:
    """Read an embedded BPM tag or estimate tempo from the local audio file."""
    try:
        probe = subprocess.run(
            [
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_entries", "format_tags=TBPM,bpm,BPM", str(path),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
        tags = json.loads(probe.stdout or "{}").get("format", {}).get("tags", {})
        tagged = tags.get("TBPM") or tags.get("bpm") or tags.get("BPM")
        if tagged is not None:
            value = float(tagged)
            if 30 <= value <= 300:
                return round(value, 1)
    except Exception:
        pass

    try:
        librosa = importlib.import_module("librosa")
        samples, sample_rate = librosa.load(str(path), sr=22050, mono=True, duration=600)
        tempo, _ = librosa.beat.beat_track(y=samples, sr=sample_rate)
        if hasattr(tempo, "reshape"):
            tempo = tempo.reshape(-1)[0]
        value = float(tempo)
        while value and value < 70:
            value *= 2
        while value > 180:
            value /= 2
        return round(value, 1) if 30 <= value <= 300 else None
    except Exception:
        return None


def duration_ok(candidate: Path, spotify_duration_ms: int | None) -> tuple[bool, float | None, float | None]:
    if not spotify_duration_ms:
        return True, None, None
    want = spotify_duration_ms / 1000
    got = duration_seconds(candidate)
    if got is None:
        return False, None, want
    # strict enough to avoid full DJ mixes / wrong uploads, loose enough for intros/silence/transcodes
    tolerance = max(5, want * 0.04)
    return abs(got - want) <= tolerance, got, want


def existing_match(track: dict, target: Path) -> dict | None:
    artist = track.get("artist") or ""
    title = track.get("title") or ""
    wanted_full = norm(f"{artist} - {title}")
    wanted_title = norm(title)
    candidates = []
    if not PICODROPS.exists():
        return None
    for p in PICODROPS.rglob("*"):
        if not p.is_file() or p.suffix.casefold() not in AUDIO_EXTS:
            continue
        if p.resolve() == target.resolve() or ROOT in p.parents:
            continue
        stem = norm(p.stem)
        score = 0
        reason = None
        if stem == wanted_full or wanted_full in stem:
            score = 100
            reason = "normalized artist-title filename match"
        elif wanted_title and len(wanted_title) >= 8 and stem == wanted_title:
            score = 88
            reason = "normalized title filename match"
        elif wanted_title and len(wanted_title) >= 8 and wanted_title in stem and any(part and part in stem for part in norm(artist).split()[:2]):
            score = 90
            reason = "title plus artist token filename match"
        if score:
            ok, got, want = duration_ok(p, track.get("duration_ms"))
            if ok:
                candidates.append({"path": p, "score": score, "reason": reason, "duration_seconds": got, "spotify_duration_seconds": want})
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c["score"], -len(str(c["path"]))), reverse=True)
    best = candidates[0]
    return {
        "source_path": str(best["path"]),
        "match_reason": best["reason"],
        "match_score": best["score"],
        "duration_seconds": best["duration_seconds"],
        "spotify_duration_seconds": best["spotify_duration_seconds"],
    }


def copy_existing(track: dict, target: Path) -> dict | None:
    match = existing_match(track, target)
    if not match:
        return None
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(match["source_path"], target)
    match["copied_to"] = str(target)
    return match


def write_episode(
    episode: int,
    spotify_url: str | None,
    soundcloud_url: str | None,
    source_url: str | None,
    download: bool,
    fast: bool = False,
) -> dict:
    folder = ROOT / f"segundo_sol_session_#{episode}"
    meta_folder = METADATA_ROOT / "segundo_sol_sessions" / f"Segundo Sol Sessions #{episode}"
    folder.mkdir(parents=True, exist_ok=True)
    meta_folder.mkdir(parents=True, exist_ok=True)
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).isoformat()

    if source_url:
        meta = fetch_generic_source(source_url)
        source_kind = source_kind_for_url(source_url)
    elif soundcloud_url:
        meta = fetch_soundcloud_playlist(soundcloud_url)
        source_kind = "soundcloud"
    elif spotify_url:
        meta = fetch_spotify_embed(spotify_url)
        source_kind = "spotify"
    else:
        existing_path = meta_folder / "spotify-tracks.json"
        if not existing_path.exists():
            existing_path = folder / "spotify-tracks.json"  # legacy fallback
        existing = json.loads(existing_path.read_text())
        meta = {"playlist_name": existing.get("playlist_name"), "playlist_id": existing.get("playlist_id"), "owner": existing.get("owner"), "tracks": existing.get("tracks", [])}
        spotify_url = existing.get("playlist_url")
        source_kind = "spotify"

    tracks_doc = {
        "episode": episode,
        "playlist_name": meta["playlist_name"],
        "playlist_id": meta.get("playlist_id"),
        "playlist_url": spotify_url or soundcloud_url or source_url,
        "owner": meta["owner"],
        "fetched_at": now,
        "source_kind": source_kind,
        "tracks": meta["tracks"],
    }
    tracks_json = f"{source_kind}-tracks.json"
    manifest_json = f"{source_kind}-manifest.json"
    (meta_folder / tracks_json).write_text(json.dumps(tracks_doc, indent=2, ensure_ascii=False))

    downloads = []
    for tr in meta["tracks"]:
        title = visible_title(tr.get("title"))
        artist = tr.get("artist")
        stem = f"{artist} - {title}" if artist else title
        fn = safe_name(f"{stem}.mp3")
        path = folder / fn
        spotify_uri = tr.get("spotify_uri")
        source_url = tr.get("source_url")
        if not source_url and spotify_uri and str(spotify_uri).startswith("spotify:track:"):
            source_url = f"https://open.spotify.com/track/{str(spotify_uri).split(':')[-1]}"
        item = {"position": tr["position"], "artist": artist, "title": title, "source_title": tr.get("source_title"), "spotify_uri": spotify_uri, "source_url": source_url, "file_path": str(path)}
        if path.exists():
            item["status"] = "exists"
            retag_mp3(path, title, tr.get("artist"))
        elif download:
            copied = None if fast else copy_existing({**tr, "title": title}, path)
            if copied:
                item.update({"status": "copied_existing", "existing_match": copied})
                retag_mp3(path, title, tr.get("artist"))
            else:
                q = tr.get("source_url") or f"ytsearch1:{tr.get('artist','')} - {title} audio"
                cmd = [
                    "yt-dlp", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
                    "--embed-thumbnail", "--add-metadata", "--match-filter", "duration < 900", "--no-playlist",
                    "--extractor-args", "youtube:player_client=mweb",
                    "--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
                    "-o", str(folder / f"{safe_name(stem)}.%(ext)s"), q,
                ]
                proc = subprocess.run(
                    cmd,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    timeout=600,
                )
                if path.exists() and proc.returncode == 0:
                    ok, got, want = duration_ok(path, tr.get("duration_ms"))
                    if ok:
                        item["status"] = "downloaded"
                        retag_mp3(path, title, tr.get("artist"))
                    else:
                        item["status"] = "failed_wrong_duration"
                        item["duration_seconds"] = got
                        item["spotify_duration_seconds"] = want
                        item["download_output_tail"] = proc.stdout[-1200:]
                        path.unlink(missing_ok=True)
                else:
                    item["status"] = "failed"
                    item["download_output_tail"] = proc.stdout[-1200:]
        else:
            match = existing_match({**tr, "title": title}, path)
            item["status"] = "copy_available" if match else "pending"
            if match:
                item["existing_match"] = match
        if path.exists() and not fast:
            bpm = estimate_bpm(path)
            if bpm is not None:
                item["bpm"] = bpm
                item["bpm_source"] = "embedded_tag_or_local_audio_analysis"
        downloads.append(item)
    (meta_folder / manifest_json).write_text(json.dumps({"episode": episode, "updated_at": now, "source_kind": source_kind, "downloads": downloads}, indent=2, ensure_ascii=False))

    registry = {"convention": "Segundo Sol Sessions #x", "root": str(ROOT), "episodes": {}}
    if REGISTRY.exists():
        registry = json.loads(REGISTRY.read_text())
    registry.setdefault("episodes", {})[str(episode)] = {
        "folder": str(folder),
        "spotify_playlist_url": spotify_url or registry.get("episodes", {}).get(str(episode), {}).get("spotify_playlist_url"),
        "spotify_playlist_name": meta["playlist_name"] if source_kind == "spotify" else registry.get("episodes", {}).get(str(episode), {}).get("spotify_playlist_name"),
        "spotify_playlist_id": meta.get("playlist_id") if source_kind == "spotify" else registry.get("episodes", {}).get(str(episode), {}).get("spotify_playlist_id"),
        "soundcloud_playlist_url": soundcloud_url or registry.get("episodes", {}).get(str(episode), {}).get("soundcloud_playlist_url") or f"https://soundcloud.com/pico-846780123/sets/segundo-sol-sessions-{episode}",
        "soundcloud_search_query": f"segundo sol sessions #{episode}",
        "last_verified_at": now,
        f"{source_kind}_track_count": len(meta["tracks"]),
    }
    REGISTRY.write_text(json.dumps(registry, indent=2, ensure_ascii=False))
    counts = {s: sum(1 for d in downloads if d["status"] == s) for s in sorted(set(d["status"] for d in downloads))}
    copied = [d for d in downloads if d["status"] in {"copied_existing", "copy_available"}]
    return {"episode": episode, "source_kind": source_kind, "folder": str(folder), "tracks": len(meta["tracks"]), "downloads": counts, "existing_matches": copied, "items": downloads}


def normalize_picodrops_now() -> None:
    """Safety check after this workflow writes files; not a recurring cron workaround."""
    helper = Path.home() / ".hermes/scripts/picodrops_unicode_nfc_normalize.py"
    if helper.exists():
        subprocess.run([sys.executable, str(helper)], text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)


def regenerate_rekordbox_xml() -> None:
    script = Path.home() / ".hermes/scripts/picodrops_generate_rekordbox_xml.py"
    if script.exists():
        subprocess.run([sys.executable, str(script)], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=240)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("episode", type=int, nargs="?")
    ap.add_argument("--spotify-url")
    ap.add_argument("--soundcloud-url")
    ap.add_argument("--source-url")
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--fast", action="store_true", help="Skip library scan, BPM analysis, and catalog maintenance")
    ap.add_argument("--analyze-file")
    args = ap.parse_args()
    if args.analyze_file:
        path = Path(args.analyze_file).expanduser()
        print(json.dumps({"file": str(path), "bpm": estimate_bpm(path)}))
        return
    if args.episode is None:
        ap.error("episode is required unless --analyze-file is used")
    result = write_episode(args.episode, args.spotify_url, args.soundcloud_url, args.source_url, args.download, args.fast)
    if not args.fast:
        normalize_picodrops_now()
        regenerate_rekordbox_xml()
    print(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
