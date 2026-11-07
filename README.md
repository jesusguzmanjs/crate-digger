# Crate Digger

A [Spicetify](https://spicetify.app) extension for digging up new tracks for a playlist without pressing
"Refresh" twenty times. It opens a popup over the playlist with hundreds of recommendations that sound like it,
and lets you add them straight to that same playlist.

![Crate Digger](preview.png)

## What it does

- **Far more recommendations.** Mixes the playlist's own recommendations with Spotify's autoplay, top tracks
  of related artists and playlists your artists were discovered on. **Load more** keeps digging.
- **Filtered by genre and by sound.** Extra sources only get in if their genres resemble the playlist's; then
  every candidate is compared with the playlist by **timbre and punch** (from Spotify's audio analysis). Each
  **Load more** searches until 40 tracks pass your filters and sound like the playlist — the profile follows the
  playlist's 100 most recently added tracks, so it keeps up with the direction it's taking.
- **Filters based on your account.** Hide artists already in the playlist, tracks you already have (your
  playlists and liked songs), artists you already have, or show one track per artist (a collaboration counts as
  its own artist). Tracks already in the playlist never show up.
- **Track data.** Genres (with their confidence on hover), plays, key, BPM, release date and duration. Pick the
  columns you want under **Columns**; widths adapt to the space. Keys can be shown as **Musical** (Am), **Camelot**
  (8A) or **Open Key** (1m) — click the Key column header to switch.
- **Built for DJ-style digging.** The playing track is highlighted, and keyboard shortcuts let you seek, move
  through the list, play and add without touching the mouse.
- **State is kept.** Close and reopen the popup: loaded tracks, filters and scroll position are still there.
  The button turns green on playlists with an open session.
- **Restart shuffles.** Every **Restart** brings different tracks instead of the same ones again.

## Install

You need the Spotify desktop app with [Spicetify installed](https://spicetify.app/docs/getting-started).

### From the Spicetify Marketplace

Open **Marketplace** in Spotify, search for **Crate Digger** and install it.

### Manually

1. Download [`crate-digger.js`](crate-digger.js).
2. Copy it into Spicetify's extensions folder:
   - **Windows:** `%APPDATA%\spicetify\Extensions`
   - **macOS / Linux:** `~/.config/spicetify/Extensions`

   Not sure where it is? `spicetify path userdata` prints Spicetify's folder; extensions go in its
   `Extensions` subfolder.
3. Enable it and apply:

   ```bash
   spicetify config extensions crate-digger.js
   spicetify apply
   ```

Spotify restarts and, on your playlists, a new button (a vinyl record) shows up next to shuffle and download.

### Update

Replace `crate-digger.js` in the extensions folder with the new version and run `spicetify apply`.

### Uninstall

```bash
spicetify config extensions crate-digger.js-
spicetify apply
```

## Usage

1. Open a playlist in Spotify.
2. Press **F8**, click the **Crate Digger** button next to the play button (on playlists you own), or
   right-click the playlist → **Crate Digger**.
3. Click a row to listen; **+** adds it to the playlist (only on playlists you can edit).
4. **Load more** to keep digging, **Restart** to start over with different tracks.

**Keyboard shortcuts** (while the popup is open; switch them on/off in the **Shortcuts** menu):

| Key | Action |
|---|---|
| **← / →** | Seek back / forward 10 s |
| **↑ / ↓** | Move through the list |
| **Enter** | Play / pause the selected track |
| **A** | Add the selected track to the playlist |

The first time you open it after starting Spotify it takes a few seconds: it reads your library to know which
tracks and artists you already have. Nothing is sent outside Spotify.

## Troubleshooting

- **Spotify updated and the extension is gone.** Spotify updates remove Spicetify. Run `spicetify backup apply`.
- **Some column is empty or fewer tracks show up.** The extension relies on Spotify's internal APIs, which can
  change with an update. Whatever fails shows as "—" and the rest keeps working.


## Credits

Reading Spotify's native track genres, and the key/BPM/energy data, were inspired by
[Sort Play](https://github.com/hoeci/sort-play) (MIT).

## License

[MIT](LICENSE)
