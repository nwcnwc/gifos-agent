"""A 24/7 channel from Python: host a broadcast room and play a playlist of video files to its Stage, forever.
Viewers watch at the room's broadcast link (or its gifos.tv listing) and see each film marked Prerecorded.

    pip install gifos-agent
    npm install -g @gifos-app/agent        # the seat it drives (Node 22+), 0.4.0 or later
    GIFOS_HOST_PASSWORD=... python3 tv_channel.py <room> <playlist.json> [--listed URL] [--credentials pass.gif]
        [--state ./state] [--site https://gifos.app] [--name "My TV (Sam's channel)"]

playlist.json: [{"file": "films/one.webm", "title": "One"}, ...] (paths relative to the playlist file). Long files
(several films joined into one "reel") give the smoothest channel: each new file costs viewers a second or two of quiet.

It keeps its place in <state>/position.json, writes <state>/health.json every few seconds (for a watchdog), joins again
when GifOS releases a new version, and exits non-zero when it cannot keep the broadcast going: run it under a supervisor
that restarts it (systemd Restart=always, a shell loop).
"""
import argparse
import asyncio
import json
import os
import sys
import time
import urllib.request

from gifos_agent import join, MeetingError


def log(ev, **o):
    print(json.dumps(dict(t=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), ev=ev, **o)), flush=True)


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    with open(path + ".tmp", "w") as f:
        json.dump(obj, f)
    os.replace(path + ".tmp", path)


def site_latest(site):
    """The live GifOS release (version.json "latest"), or None when the site does not answer."""
    try:
        with urllib.request.urlopen(site + "/version.json?ts=%d" % time.time(), timeout=20) as r:
            return json.load(r).get("latest")
    except Exception:
        return None


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("room")
    ap.add_argument("playlist")
    ap.add_argument("--listed")
    ap.add_argument("--credentials")
    ap.add_argument("--state", default="state")
    ap.add_argument("--site", default="https://gifos.app")
    ap.add_argument("--name", default="My TV (a GifOS channel)")
    a = ap.parse_args()
    password = os.environ.get("GIFOS_HOST_PASSWORD", "")
    if not password:
        sys.exit("set GIFOS_HOST_PASSWORD to the room's host password")
    site, state = a.site.rstrip("/"), os.path.abspath(a.state)
    os.makedirs(state, exist_ok=True)
    pos_file, health_file = os.path.join(state, "position.json"), os.path.join(state, "health.json")

    def playlist():
        base = os.path.dirname(os.path.abspath(a.playlist))
        out = []
        for c in read_json(a.playlist, []):
            p = os.path.join(base, c["file"])
            if os.path.exists(p):
                out.append(dict(c, path=p))
        return out

    async def host_room():
        meet = await join(site + "/cast#room=" + a.room, name=a.name, voice=False,
                          host_password=password,              # this seat is the room's host
                          listed=a.listed,                     # keep the room's gifos.tv listing live while it hosts
                          credentials=a.credentials,           # a pass or subscription file
                          profile=os.path.join(state, "profile"))
        log("joined", link=meet.link)
        return meet

    meet = await host_room()
    release = site_latest(site)
    checked = hosted = time.time()
    i = read_json(pos_file, {}).get("i", -1)
    resume, fails, tries = None, 0, 0
    while True:
        items = playlist()
        if not items:
            raise SystemExit("the playlist names no file that exists")
        if resume and resume["i"] < len(items):
            i, start_at = resume["i"], resume["pos"]
        else:
            i, start_at = (i + 1) % len(items), 0
        resume, clip = None, items[i]
        try:
            film = await meet.stage_play(clip["path"], start_at=start_at, clear=True)
        except MeetingError as e:
            log("play.fail", i=i, file=clip["file"], m=str(e))
            fails += 1
            if fails >= 5 or meet.closed:
                raise
            await asyncio.sleep(5)
            continue
        fails = 0
        write_json(pos_file, {"i": i, "file": clip["file"]})
        log("play", i=i, file=clip["file"], title=clip.get("title"), len=round(film["len"]), startAt=start_at)
        while not film["ended"].done():
            write_json(health_file, {"t": time.time(), "i": i, "file": clip["file"]})
            await asyncio.wait([film["ended"]], timeout=5)
            # The seat must stay in the room as its host. Out of it for two minutes: exit; the supervisor starts afresh.
            try:
                st = await meet.state() if not meet.closed else None
            except MeetingError:
                st = None
            if st and st.get("joined") and (st.get("me") or {}).get("admin"):
                hosted = time.time()
            elif time.time() - hosted > 120:
                raise SystemExit("not hosting the room")
            # A new GifOS release: leave and join again, so the seat runs the release fresh viewers get.
            if time.time() - checked > 300:
                checked = time.time()
                now = site_latest(site)
                if now and release and now != release:
                    log("site.update", to=now)
                    release = now
                    await meet.leave()
                    meet = await host_room()
                    hosted = time.time()
        end = film["ended"].result()
        log("played", i=i, file=clip["file"], pos=round(end.get("pos") or 0), len=round(end.get("len") or 0),
            why=end.get("why"), skips=end.get("skips"))
        # Stopped well before its end (a reload, a bad spot in the file): go on a little past it, up to 5 times in a row.
        tries = tries + 1 if end.get("early") else 0
        if end.get("early") and tries <= 5:
            resume = {"i": i, "pos": (end.get("pos") or 0) + 3 * tries}


if __name__ == "__main__":
    asyncio.run(main())
