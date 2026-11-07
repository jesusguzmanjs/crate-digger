"use strict";
(() => {
  // src/api/normalize.ts
  var addedTime = (i) => {
    const t = i?.addedAt ? Date.parse(i.addedAt) : NaN;
    return Number.isFinite(t) ? t : -Infinity;
  };
  function normalizePlaylistItems(items) {
    const trackUris = /* @__PURE__ */ new Set();
    const artistUris = /* @__PURE__ */ new Set();
    const byRecency = items.map((raw, i) => ({ raw, i })).sort((a, b) => addedTime(b.raw) - addedTime(a.raw) || a.i - b.i);
    for (const { raw } of byRecency) {
      if (!raw?.uri?.startsWith("spotify:track:") || raw.isLocal) continue;
      trackUris.add(raw.uri);
      for (const a of raw.artists ?? []) if (a?.uri?.startsWith("spotify:artist:")) artistUris.add(a.uri);
    }
    return { trackUris, artistUris };
  }
  function pathToPlaylistUri(path) {
    const m = /^\/playlist\/([A-Za-z0-9]+)\/?$/.exec(path);
    return m ? `spotify:playlist:${m[1]}` : null;
  }

  // src/api/playlist.ts
  async function getPlaylist(uri) {
    const api = Spicetify.Platform.PlaylistAPI;
    const [metadata, contents] = await Promise.all([api.getMetadata(uri), api.getContents(uri)]);
    const { trackUris, artistUris } = normalizePlaylistItems(contents?.items ?? []);
    return { name: metadata?.name ?? "Playlist", editable: !!metadata?.canAdd, trackUris, artistUris };
  }
  async function addTrack(playlistUri, trackUri) {
    await Spicetify.Platform.PlaylistAPI.add(playlistUri, [trackUri], { after: "end" });
  }
  function currentPlaylistUri() {
    return pathToPlaylistUri(Spicetify.Platform.History.location.pathname);
  }

  // src/domain/dedupe.ts
  function mergeUnique(existing, incoming, exclude) {
    const seen = new Set(existing.map((t) => t.uri));
    const out = [...existing];
    for (const t of incoming) {
      if (exclude.has(t.uri) || seen.has(t.uri)) continue;
      seen.add(t.uri);
      out.push(t);
    }
    return out;
  }

  // src/store/sessions.ts
  var sessions = /* @__PURE__ */ new Map();
  var listeners = /* @__PURE__ */ new Map();
  function getSession(uri) {
    return sessions.get(uri);
  }
  function createSession(init, filters) {
    const s2 = {
      ...init,
      tracks: [],
      seen: /* @__PURE__ */ new Set(),
      meta: /* @__PURE__ */ new Map(),
      added: /* @__PURE__ */ new Set(),
      adding: /* @__PURE__ */ new Set(),
      filters,
      scrollTop: 0,
      loading: false,
      exhausted: false
    };
    sessions.set(init.playlistUri, s2);
    notify(init.playlistUri);
    return s2;
  }
  function updateSession(uri, patch) {
    const s2 = sessions.get(uri);
    if (!s2) return;
    const p = typeof patch === "function" ? patch(s2) : patch;
    sessions.set(uri, { ...s2, ...p });
    notify(uri);
  }
  function subscribe(uri, fn) {
    let set2 = listeners.get(uri);
    if (!set2) listeners.set(uri, set2 = /* @__PURE__ */ new Set());
    set2.add(fn);
    return () => set2.delete(fn);
  }
  function notify(uri) {
    listeners.get(uri)?.forEach((fn) => fn());
  }
  function rememberScroll(uri, scrollTop) {
    const s2 = sessions.get(uri);
    if (s2) s2.scrollTop = scrollTop;
  }
  function resetSession(uri) {
    updateSession(uri, { tracks: [], seen: /* @__PURE__ */ new Set(), meta: /* @__PURE__ */ new Map(), exhausted: false, error: void 0, scrollTop: 0 });
  }
  var pendingOpens = /* @__PURE__ */ new Map();
  async function ensureSession(uri, readInit, filters) {
    const existing = sessions.get(uri);
    if (existing) return { session: existing, created: false };
    const pending2 = pendingOpens.get(uri);
    if (pending2) return { session: await pending2, created: false };
    const p = readInit().then((init) => createSession(init, filters));
    pendingOpens.set(uri, p);
    try {
      return { session: await p, created: true };
    } finally {
      pendingOpens.delete(uri);
    }
  }
  async function loadProgressive(uri, run) {
    const s2 = sessions.get(uri);
    if (!s2 || s2.loading) return;
    if (s2.playlistTrackUris.size === 0) {
      updateSession(uri, { exhausted: true });
      return;
    }
    updateSession(uri, { loading: true, error: void 0 });
    const append = (incoming) => {
      const current = sessions.get(uri);
      if (!current) return [];
      const merged = mergeUnique(current.tracks, incoming, /* @__PURE__ */ new Set([...current.playlistTrackUris, ...current.seen]));
      const fresh = merged.slice(current.tracks.length);
      if (fresh.length) updateSession(uri, { tracks: merged, seen: /* @__PURE__ */ new Set([...current.seen, ...fresh.map((t) => t.uri)]) });
      return fresh;
    };
    try {
      const { exhausted } = await run({ append, seen: () => new Set(sessions.get(uri)?.seen ?? []) });
      updateSession(uri, { exhausted });
    } catch (e) {
      updateSession(uri, { error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      updateSession(uri, { loading: false });
    }
  }
  function mergeMeta(uri, meta) {
    updateSession(uri, (s2) => ({ meta: new Map([...s2.meta, ...meta]) }));
  }
  function tryBeginAdd(uri, trackUri) {
    const s2 = sessions.get(uri);
    if (!s2 || s2.adding.has(trackUri) || s2.added.has(trackUri)) return false;
    updateSession(uri, { adding: /* @__PURE__ */ new Set([...s2.adding, trackUri]) });
    return true;
  }
  function finishAdd(uri, trackUri, ok) {
    updateSession(uri, (s2) => {
      const adding = new Set(s2.adding);
      adding.delete(trackUri);
      if (!ok) return { adding };
      return { adding, added: /* @__PURE__ */ new Set([...s2.added, trackUri]) };
    });
  }
  function refreshPlaylist(uri, info) {
    updateSession(uri, info);
  }

  // src/ui/actionBarButton.ts
  var BUTTON_ID = "crate-digger-action";
  var ACTIONS_SELECTOR = 'main [data-testid="action-bar-row-actions"]';
  var LABEL = "Crate Digger (F8)";
  var CRATE_ICON = `<svg role="img" aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g fill="none" style="fill:none"><circle cx="12" cy="12" r="10"/><path d="M14.22 5.89A6.5 6.5 0 0 1 18.11 9.78"/><path d="M9.78 18.11A6.5 6.5 0 0 1 5.89 14.22"/><circle cx="12" cy="12" r="2.5"/></g></svg>`;
  var owned = /* @__PURE__ */ new Map();
  function isOwnPlaylist(metadata) {
    return metadata?.isOwnedBySelf === true;
  }
  function ownsPlaylist(uri) {
    const cached = owned.get(uri);
    if (cached) return cached;
    const p = Promise.resolve(Spicetify.Platform.PlaylistAPI.getMetadata(uri)).then(isOwnPlaylist, () => {
      owned.delete(uri);
      return false;
    });
    owned.set(uri, p);
    return p;
  }
  function createButton(onClick) {
    const b = document.createElement("button");
    b.id = BUTTON_ID;
    b.type = "button";
    b.setAttribute("aria-label", LABEL);
    b.title = LABEL;
    b.addEventListener("click", onClick);
    return b;
  }
  function referenceButton(actions) {
    const candidates = [
      actions.nextElementSibling,
      ...[...actions.querySelectorAll("button[aria-label]:not([data-testid])")].reverse()
    ];
    return candidates.find(
      (b) => b instanceof HTMLButtonElement && b.id !== BUTTON_ID && b.getAttribute("aria-checked") !== "true" && !!b.querySelector("span svg")
    );
  }
  function styleLike(button, actions) {
    const native = referenceButton(actions);
    if (!native) {
      button.className = "crate-digger-action crate-digger-action-fallback";
      button.innerHTML = CRATE_ICON;
      return;
    }
    button.className = native.className + " crate-digger-action";
    const encoreId = native.getAttribute("data-encore-id");
    if (encoreId) button.setAttribute("data-encore-id", encoreId);
    const wrapper = native.querySelector("span");
    const nativeSvg = wrapper.querySelector("svg");
    button.innerHTML = `<span class="${wrapper.className}">${CRATE_ICON}</span>`;
    const svg = button.querySelector("svg");
    for (const attr of ["class", "style", "data-encore-id"]) {
      const v = nativeSvg.getAttribute(attr);
      if (v) svg.setAttribute(attr, v);
    }
    svg.removeAttribute("width");
    svg.removeAttribute("height");
  }
  function setActive(button, uri) {
    const on = !!getSession(uri);
    button.classList.toggle("crate-digger-active", on);
    button.setAttribute("aria-label", on ? `${LABEL} \xB7 session open` : LABEL);
    button.title = button.getAttribute("aria-label");
  }
  function registerActionBarButton(onClick) {
    const button = createButton(onClick);
    let syncing = 0;
    let watched = null;
    const watch = (uri) => {
      if (watched?.uri === uri) return;
      watched?.off();
      watched = uri ? { uri, off: subscribe(uri, () => setActive(button, uri)) } : null;
    };
    const sync = async () => {
      const run = ++syncing;
      const uri = currentPlaylistUri();
      const actions = document.querySelector(ACTIONS_SELECTOR);
      watch(uri);
      if (!uri || !actions) {
        button.remove();
        return;
      }
      const mine = await ownsPlaylist(uri);
      if (run !== syncing) return;
      if (!mine) {
        button.remove();
        return;
      }
      const target = document.querySelector(ACTIONS_SELECTOR);
      if (target && button.parentElement !== target) {
        styleLike(button, target);
        target.appendChild(button);
      }
      setActive(button, uri);
    };
    let pending2 = 0;
    const schedule = () => {
      if (pending2) return;
      pending2 = window.setTimeout(() => {
        pending2 = 0;
        void sync();
      }, 150);
    };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    Spicetify.Platform.History.listen(schedule);
    schedule();
  }

  // src/api/library.ts
  var LIKED_PAGE = 500;
  var PLAYLIST_CONCURRENCY = 8;
  function ownPlaylistUris(items) {
    const out = [];
    const walk = (list) => {
      for (const i of list ?? []) {
        if (i?.type === "playlist" && i.isOwnedBySelf && i.uri) out.push(i.uri);
        if (i?.items) walk(i.items);
      }
    };
    walk(items);
    return out;
  }
  function collect(items, into) {
    const { trackUris, artistUris } = normalizePlaylistItems(items);
    trackUris.forEach((t) => into.collectionTrackUris.add(t));
    artistUris.forEach((a) => into.collectionArtistUris.add(a));
  }
  async function loadOwnPlaylists(into) {
    const root = await Spicetify.Platform.RootlistAPI.getContents();
    const queue = ownPlaylistUris(root?.items ?? []);
    const worker = async () => {
      for (let uri = queue.shift(); uri; uri = queue.shift()) {
        try {
          const contents = await Spicetify.Platform.PlaylistAPI.getContents(uri);
          collect(contents?.items ?? [], into);
        } catch (e) {
          console.warn("[crate-digger] could not read playlist", uri, e);
        }
      }
    };
    await Promise.all(Array.from({ length: PLAYLIST_CONCURRENCY }, worker));
  }
  async function loadLiked(into) {
    for (let offset = 0; ; offset += LIKED_PAGE) {
      const page = await Spicetify.Platform.LibraryAPI.getTracks({ limit: LIKED_PAGE, offset });
      const items = page?.items ?? [];
      collect(items, into);
      if (items.length < LIKED_PAGE) break;
    }
  }
  async function loadLibraryData() {
    const data = { collectionTrackUris: /* @__PURE__ */ new Set(), collectionArtistUris: /* @__PURE__ */ new Set() };
    await Promise.all([loadOwnPlaylists(data), loadLiked(data)]);
    return data;
  }

  // src/store/library.ts
  var empty = () => ({ status: "idle", collectionTrackUris: /* @__PURE__ */ new Set(), collectionArtistUris: /* @__PURE__ */ new Set() });
  var state = empty();
  var pending = null;
  var listeners2 = /* @__PURE__ */ new Set();
  function set(next) {
    state = next;
    listeners2.forEach((fn) => fn());
  }
  function getLibrary() {
    return state;
  }
  function subscribeLibrary(fn) {
    listeners2.add(fn);
    return () => listeners2.delete(fn);
  }
  function ensureLibrary(loader) {
    if (state.status === "ready") return Promise.resolve();
    if (pending) return pending;
    set({ ...state, status: "loading" });
    pending = loader().then((data) => set({ ...data, status: "ready" })).catch((e) => {
      console.error("[crate-digger] library load failed", e);
      set({ ...state, status: "error" });
    }).finally(() => {
      pending = null;
    });
    return pending;
  }

  // src/domain/timbre.ts
  var MIN_SEGMENTS = 10;
  var MIN_PLAYLIST_FINGERPRINTS = 10;
  var THRESHOLD_PERCENTILE = 0.75;
  var SHARP_ATTACK_DB = 12;
  var SHARP_ATTACK_TIME = 0.03;
  function fingerprintFromAnalysis(a) {
    const segs = (Array.isArray(a?.segments) ? a.segments : []).filter(
      (s2) => typeof s2?.duration === "number" && Array.isArray(s2.timbre) && s2.timbre.length === 12
    );
    if (segs.length < MIN_SEGMENTS) return null;
    const total = segs.reduce((acc, s2) => acc + s2.duration, 0);
    if (!total) return null;
    const mean = Array(12).fill(0);
    const sq = Array(12).fill(0);
    for (const s2 of segs)
      for (let i = 0; i < 12; i++) {
        mean[i] += s2.timbre[i] * s2.duration;
        sq[i] += s2.timbre[i] ** 2 * s2.duration;
      }
    const std = mean.map((_, i) => Math.sqrt(Math.max(0, sq[i] / total - (mean[i] / total) ** 2)));
    for (let i = 0; i < 12; i++) mean[i] /= total;
    const sharp = segs.filter((s2) => (s2.loudness_max ?? 0) - (s2.loudness_start ?? 0) >= SHARP_ATTACK_DB && (s2.loudness_max_time ?? 1) <= SHARP_ATTACK_TIME).length / segs.length;
    const beats = Array.isArray(a?.beats) ? a.beats : [];
    const beatConf = beats.length ? beats.reduce((acc, b) => acc + (b.confidence ?? 0), 0) / beats.length : 0;
    return { timbre: [...mean, ...std], perc: [segs.length / total, sharp, beatConf] };
  }
  function zStats(rows) {
    return rows[0].map((_, i) => {
      const xs = rows.map((r) => r[i]);
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
      return { m, sd };
    });
  }
  function buildTimbreModel(playlist) {
    if (playlist.length < MIN_PLAYLIST_FINGERPRINTS) return null;
    const T = zStats(playlist.map((f) => f.timbre));
    const P = zStats(playlist.map((f) => f.perc));
    const z2 = (v, S) => v.reduce((a, x, i) => a + ((x - S[i].m) / S[i].sd) ** 2, 0) / v.length;
    const distance = (fp) => 0.5 * z2(fp.timbre, T) + 0.5 * z2(fp.perc, P);
    const own = playlist.map(distance).sort((a, b) => a - b);
    return { distance, threshold: own[Math.floor(own.length * THRESHOLD_PERCENTILE)] };
  }

  // src/api/digger.ts
  var DIG_DEFAULTS = { target: 40, block: 50, maxBlocks: 6, maxFetches: 4 };
  var PROFILE_SAMPLE = 100;
  var states = /* @__PURE__ */ new Map();
  function stateOf(playlistUri) {
    let s2 = states.get(playlistUri);
    if (!s2) states.set(playlistUri, s2 = { pool: [], analysed: /* @__PURE__ */ new Set(), ready: [], sourcesDone: false });
    return s2;
  }
  async function modelFor(s2, deps) {
    s2.model ?? (s2.model = deps.fingerprints(deps.playlistTrackUris.slice(0, PROFILE_SAMPLE)).then((m) => buildTimbreModel([...m.values()].filter((f) => !!f))).catch(() => null));
    return s2.model;
  }
  async function digMore(playlistUri, deps) {
    const s2 = stateOf(playlistUri);
    const modelPromise = modelFor(s2, deps);
    let added = 0;
    let blocks = 0;
    let fetches = 0;
    const pendingVisible = () => deps.visible(s2.pool.filter((t) => !s2.analysed.has(t.uri)));
    const take = (viable) => {
      const visible = new Set(deps.visible(viable).map((t) => t.uri));
      const show = [];
      const rest = [];
      for (const t of viable) (visible.has(t.uri) && added + show.length < deps.target ? show : rest).push(t);
      if (show.length) deps.append(show);
      added += show.length;
      return rest;
    };
    s2.ready = take(s2.ready);
    while (added < deps.target && blocks < deps.maxBlocks) {
      const eligible = pendingVisible();
      if (eligible.length < deps.block && !s2.sourcesDone && fetches < deps.maxFetches) {
        const known = /* @__PURE__ */ new Set([...deps.shownUris(), ...s2.pool.map((t) => t.uri), ...s2.analysed]);
        const incoming = await deps.fetchCandidates(known);
        fetches++;
        const fresh = incoming.filter((t) => !known.has(t.uri));
        fresh.forEach((t) => known.add(t.uri));
        if (fresh.length) s2.pool.push(...fresh);
        else s2.sourcesDone = true;
        continue;
      }
      if (!eligible.length) break;
      const model = await modelPromise;
      const batch = eligible.slice(0, deps.block);
      const fps = await deps.fingerprints(batch.map((t) => t.uri));
      batch.forEach((t) => s2.analysed.add(t.uri));
      const viable = batch.filter((t) => {
        const fp = fps.get(t.uri);
        return !model || !fp || model.distance(fp) <= model.threshold;
      });
      s2.ready.push(...take(viable));
      blocks++;
    }
    return { added, exhausted: s2.sourcesDone && pendingVisible().length === 0 && deps.visible(s2.ready).length === 0 };
  }
  function warmTimbreProfile(playlistUri, deps) {
    void modelFor(stateOf(playlistUri), deps);
  }
  function resetDigger(playlistUri) {
    const s2 = states.get(playlistUri);
    if (s2) states.set(playlistUri, { pool: [], analysed: /* @__PURE__ */ new Set(), ready: [], sourcesDone: false, model: s2.model });
  }

  // src/domain/genreFit.ts
  var FIT_PERCENTILE = 0.25;
  function normalise(v) {
    let n = 0;
    v.forEach((x) => n += x * x);
    n = Math.sqrt(n);
    if (!n) return /* @__PURE__ */ new Map();
    return new Map([...v].map(([k, x]) => [k, x / n]));
  }
  function buildProfile(lists) {
    const sum = /* @__PURE__ */ new Map();
    for (const list of lists) for (const g of list) sum.set(g.name, (sum.get(g.name) ?? 0) + g.score);
    return normalise(sum);
  }
  function similarity(profile, genres2) {
    if (!profile.size || !genres2?.length) return null;
    const v = normalise(new Map(genres2.map((g) => [g.name, g.score])));
    if (!v.size) return null;
    let s2 = 0;
    v.forEach((x, k) => s2 += x * (profile.get(k) ?? 0));
    return s2;
  }
  function fitThreshold(profile, lists) {
    const sims = lists.map((l) => similarity(profile, l)).filter((x) => x !== null).sort((a, b) => a - b);
    if (!sims.length) return null;
    return sims[Math.min(sims.length - 1, Math.floor(FIT_PERCENTILE * sims.length))];
  }
  function keepFitting(tracks, genresOf, profile, threshold) {
    if (threshold === null) return tracks;
    return tracks.filter((t) => (similarity(profile, genresOf(t.uri)) ?? -1) >= threshold);
  }
  function orderBySimilarity(tracks, genresOf, profile) {
    return tracks.map((t, i) => ({ t, i, s: similarity(profile, genresOf(t.uri)) })).sort((a, b) => (b.s ?? -1) - (a.s ?? -1) || a.i - b.i).map((x) => x.t);
  }

  // src/api/recommendations.ts
  var PER_ROUND = 50;
  var PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function standardKeyToPitch(k) {
    const m = /^([A-G])([#♯b♭]?)$/.exec(k?.trim() ?? "");
    if (!m) return void 0;
    const shift = m[2] === "#" || m[2] === "\u266F" ? 1 : m[2] === "b" || m[2] === "\u266D" ? -1 : 0;
    return (PITCH[m[1]] + shift + 12) % 12;
  }
  function parseRecommendations(raw) {
    const tracks = [];
    const v2Meta = /* @__PURE__ */ new Map();
    for (const r of Array.isArray(raw) ? raw : []) {
      if (!r?.uri?.startsWith("spotify:track:") || !r.id) continue;
      tracks.push({
        uri: r.uri,
        id: r.id,
        name: r.name ?? "",
        artists: (r.artists ?? []).map((a) => ({ uri: a.uri ?? "", name: a.name ?? "" })),
        album: { name: r.album?.name ?? "", imageUrl: r.album?.imageUrl },
        durationMs: r.duration ?? 0
      });
      const meta = {};
      if (typeof r.bpm === "number" && r.bpm > 0) meta.tempo = r.bpm;
      const pitch = r.trackKey?.standardKey ? standardKeyToPitch(r.trackKey.standardKey) : void 0;
      if (pitch !== void 0 && (r.trackKey?.mode === "major" || r.trackKey?.mode === "minor")) {
        meta.key = pitch;
        meta.mode = r.trackKey.mode === "major" ? 1 : 0;
      }
      if (Object.keys(meta).length) v2Meta.set(r.uri, meta);
    }
    return { tracks, v2Meta };
  }
  var idOf = (uri) => uri.split(":").pop();
  async function fetchRecommendationBatch(playlistUri, exclude, rounds = 5, onV2Meta) {
    const skip = new Set([...exclude].filter((u) => u.startsWith("spotify:track:")).map(idOf));
    const out = [];
    for (let i = 0; i < rounds; i++) {
      let raw;
      try {
        raw = await Spicetify.Platform.PlaylistAPI.getRecommendedTracks(playlistUri, [...skip], PER_ROUND, {
          decorateWithBpmAndKey: true
        });
      } catch (e) {
        if (i === 0) throw e;
        console.warn("[crate-digger] recommendation round failed", e);
        break;
      }
      const { tracks, v2Meta } = parseRecommendations(raw);
      const fresh = tracks.filter((t) => !skip.has(t.id));
      fresh.forEach((t) => skip.add(t.id));
      out.push(...fresh);
      if (v2Meta.size) onV2Meta?.(v2Meta);
      if (fresh.length === 0) break;
    }
    return out;
  }

  // src/api/sources.ts
  var SPCLIENT = "https://spclient.wg.spotify.com";
  var AUTOPLAY_COUNT = 100;
  var AUTOPLAY_ROUNDS = 2;
  var AUTOPLAY_PREV_MAX = 300;
  var SEED_ARTISTS = 10;
  var RELATED_PER_LOAD = 10;
  var DISCOVERED_SEEDS = 5;
  var DISCOVERED_PER_LOAD = 2;
  var DISCOVERED_MAX_TRACKS = 150;
  var CONCURRENCY = 5;
  var DISCOVERED_ON_DEF = {
    name: "queryArtistDiscoveredOn",
    operation: "query",
    sha256Hash: "71c2392e4cecf6b48b9ad1311ae08838cbdabcfd189c6bf0c66c2430b8dcfdb1",
    value: null
  };
  var isTrackUri = (u) => typeof u === "string" && u.startsWith("spotify:track:");
  var idOf2 = (uri) => uri.split(":").pop();
  function spotifyImageUrl(u) {
    if (!u) return void 0;
    return u.startsWith("spotify:image:") ? `https://i.scdn.co/image/${u.slice("spotify:image:".length)}` : u;
  }
  function parseAutoplay(raw) {
    const out = [];
    for (const t of raw?.tracks ?? []) {
      if (!isTrackUri(t?.uri)) continue;
      const m = t.metadata ?? {};
      const artistUri = t.artist_uri ?? m.artist_uri;
      out.push({
        uri: t.uri,
        id: idOf2(t.uri),
        name: m.title ?? t.name ?? "",
        artists: artistUri ? [{ uri: artistUri, name: m.artist_name ?? "" }] : [],
        album: { name: m.album_title ?? "", imageUrl: spotifyImageUrl(m.image_url) },
        durationMs: 0
      });
    }
    return out;
  }
  function parseRelatedArtists(raw) {
    const items = raw?.data?.artistUnion?.relatedContent?.relatedArtists?.items ?? [];
    return items.map((i) => i?.uri).filter((u) => typeof u === "string" && u.startsWith("spotify:artist:"));
  }
  function rankRelated(lists, exclude) {
    const count = /* @__PURE__ */ new Map();
    lists.forEach((l) => l.forEach((a) => {
      if (!exclude.has(a)) count.set(a, (count.get(a) ?? 0) + 1);
    }));
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  }
  function parseTopTracks(raw) {
    const out = [];
    for (const i of raw?.data?.artistUnion?.discography?.topTracks?.items ?? []) {
      const t = i?.track;
      if (!isTrackUri(t?.uri)) continue;
      const sources = t.albumOfTrack?.coverArt?.sources ?? [];
      out.push({
        uri: t.uri,
        id: t.id ?? idOf2(t.uri),
        name: t.name ?? "",
        artists: (t.artists?.items ?? []).map((a) => ({ uri: a?.uri ?? "", name: a?.profile?.name ?? "" })),
        album: { name: t.albumOfTrack?.name ?? "", imageUrl: sources[0]?.url },
        durationMs: t.duration?.totalMilliseconds ?? 0
      });
    }
    return out;
  }
  function parseDiscoveredOn(raw) {
    const items = raw?.data?.artistUnion?.relatedContent?.discoveredOnV2?.items ?? [];
    return items.filter((i) => i?.data?.__typename === "Playlist").map((i) => i.data.uri).filter((u) => typeof u === "string" && u.startsWith("spotify:playlist:"));
  }
  function parsePlaylistTracks(items) {
    const out = [];
    for (const i of items ?? []) {
      if (i?.type !== "track" || i.isLocal || !isTrackUri(i.uri)) continue;
      const images = i.album?.images ?? [];
      out.push({
        uri: i.uri,
        id: idOf2(i.uri),
        name: i.name ?? "",
        artists: (i.artists ?? []).map((a) => ({ uri: a?.uri ?? "", name: a?.name ?? "" })),
        album: { name: i.album?.name ?? "", imageUrl: spotifyImageUrl(images[0]?.url) },
        durationMs: i.duration?.milliseconds ?? 0
      });
    }
    return out;
  }
  var rng = Math.random;
  function shuffle(items) {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function pickSeeds(ranked, n, shuffled) {
    return (shuffled ? shuffle(ranked) : ranked).slice(0, n);
  }
  var AVOID_FRACTION = 0.5;
  var cursors = /* @__PURE__ */ new Map();
  var history = /* @__PURE__ */ new Map();
  var shuffleNext = /* @__PURE__ */ new Set();
  function cursorOf(playlistUri) {
    let c = cursors.get(playlistUri);
    if (!c) {
      const shuffled = shuffleNext.delete(playlistUri);
      const shown = [...history.get(playlistUri) ?? []];
      const avoid = new Set(shuffled ? shuffle(shown).slice(0, Math.round(shown.length * AVOID_FRACTION)) : []);
      c = { shuffled, avoid, autoplaySeen: [...avoid].map(idOf2), autoplayDone: false, related: null, discovered: null };
      cursors.set(playlistUri, c);
    }
    return c;
  }
  function recordShown(playlistUri, uris) {
    let h = history.get(playlistUri);
    if (!h) history.set(playlistUri, h = /* @__PURE__ */ new Set());
    uris.forEach((u) => h.add(u));
  }
  function avoidSet(playlistUri) {
    return cursorOf(playlistUri).avoid;
  }
  function resetExtras(playlistUri) {
    cursors.delete(playlistUri);
    shuffleNext.add(playlistUri);
  }
  async function pool(items, fn) {
    const queue = [...items];
    const out = [];
    const worker = async () => {
      for (let x = queue.shift(); x !== void 0; x = queue.shift()) {
        try {
          out.push(await fn(x));
        } catch (e) {
          console.warn("[crate-digger] source request failed", e);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return out;
  }
  async function autoplay(playlistUri, c) {
    const out = [];
    for (let i = 0; i < AUTOPLAY_ROUNDS && !c.autoplayDone; i++) {
      const prev = c.autoplaySeen.slice(-AUTOPLAY_PREV_MAX).join(",");
      const res = await Spicetify.CosmosAsync.get(
        `${SPCLIENT}/radio-apollo/v3/tracks/${playlistUri}?autoplay=true&count=${AUTOPLAY_COUNT}${prev ? `&prev_tracks=${prev}` : ""}`
      );
      const seen = new Set(c.autoplaySeen);
      const fresh = parseAutoplay(res).filter((t) => !seen.has(t.id));
      fresh.forEach((t) => c.autoplaySeen.push(t.id));
      out.push(...fresh);
      if (!fresh.length) c.autoplayDone = true;
    }
    return out;
  }
  async function relatedTopTracks(seeds, exclude, c) {
    const G = Spicetify.GraphQL;
    if (!c.related) {
      const lists2 = await pool(
        seeds,
        async (a) => parseRelatedArtists(await G.Request(G.Definitions.queryArtistRelated, { uri: a, locale: "" }))
      );
      const ranked = rankRelated(lists2, exclude);
      c.related = c.shuffled ? shuffle(ranked) : ranked;
    }
    const next = c.related.splice(0, RELATED_PER_LOAD);
    const lists = await pool(
      next,
      async (a) => parseTopTracks(await G.Request(G.Definitions.queryArtistOverview, { uri: a, locale: "", includePrerelease: false }))
    );
    return lists.flat();
  }
  async function discoveredOn(playlistUri, seeds, c) {
    if (!c.discovered) {
      const lists2 = await pool(
        seeds.slice(0, DISCOVERED_SEEDS),
        async (a) => parseDiscoveredOn(await Spicetify.GraphQL.Request(DISCOVERED_ON_DEF, { uri: a, locale: "" }))
      );
      const seen = /* @__PURE__ */ new Set([playlistUri]);
      const merged = [];
      for (let i = 0; lists2.some((l) => i < l.length); i++)
        for (const l of lists2) if (l[i] && !seen.has(l[i])) {
          seen.add(l[i]);
          merged.push(l[i]);
        }
      c.discovered = c.shuffled ? shuffle(merged) : merged;
    }
    const next = c.discovered.splice(0, DISCOVERED_PER_LOAD);
    const lists = await pool(
      next,
      async (pl) => parsePlaylistTracks((await Spicetify.Platform.PlaylistAPI.getContents(pl))?.items ?? []).slice(0, DISCOVERED_MAX_TRACKS)
    );
    return lists.flat();
  }
  async function rankedPlaylistArtists(playlistUri) {
    const items = (await Spicetify.Platform.PlaylistAPI.getContents(playlistUri))?.items ?? [];
    const freq = /* @__PURE__ */ new Map();
    for (const t of parsePlaylistTracks(items)) for (const a of t.artists) if (a.uri) freq.set(a.uri, (freq.get(a.uri) ?? 0) + 1);
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  }
  function extrasExhausted(playlistUri) {
    const c = cursors.get(playlistUri);
    return !!c && c.autoplayDone && c.related?.length === 0 && c.discovered?.length === 0;
  }
  async function fetchExtras(playlistUri, excludeArtists) {
    const c = cursorOf(playlistUri);
    const ranked = await rankedPlaylistArtists(playlistUri).catch(() => []);
    const seeds = pickSeeds(ranked, SEED_ARTISTS, c.shuffled);
    const parts = await Promise.allSettled([
      autoplay(playlistUri, c),
      relatedTopTracks(seeds, excludeArtists, c),
      discoveredOn(playlistUri, seeds, c)
    ]);
    return parts.flatMap((p) => {
      if (p.status === "fulfilled") return p.value;
      console.warn("[crate-digger] extra source failed", p.reason);
      return [];
    });
  }

  // src/domain/concepts.ts
  var GENRE_TYPE = 1;
  function toBytes(raw) {
    if (!raw) return new Uint8Array();
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (typeof raw.length === "number") return new Uint8Array(raw);
    return new Uint8Array(Object.values(raw));
  }
  var decoder = new TextDecoder();
  function parseConcepts(raw) {
    const b = toBytes(raw);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let pos = 0;
    const varint = () => {
      let val = 0;
      let shift = 0;
      while (pos < b.length) {
        const c = b[pos++];
        val += (c & 127) * 2 ** shift;
        if (!(c & 128)) return val;
        shift += 7;
        if (shift > 35) break;
      }
      return -1;
    };
    const skip = (wire, end) => {
      if (wire === 0) return varint() >= 0;
      if (wire === 1) pos += 8;
      else if (wire === 2) {
        const l = varint();
        if (l < 0) return false;
        pos += l;
      } else if (wire === 5) pos += 4;
      else return false;
      return pos <= end;
    };
    const out = [];
    while (pos < b.length) {
      const tag = varint();
      if (tag <= 0) break;
      if (tag >>> 3 !== 1 || (tag & 7) !== 2) {
        if (!skip(tag & 7, b.length)) break;
        continue;
      }
      const len = varint();
      if (len < 0 || pos + len > b.length) break;
      const end = pos + len;
      let name = "";
      let score = 0;
      let types;
      let ok = true;
      while (pos < end) {
        const sub = varint();
        if (sub <= 0) {
          ok = false;
          break;
        }
        const field = sub >>> 3;
        const wire = sub & 7;
        if (field === 1 && wire === 2) {
          const l = varint();
          if (l < 0 || pos + l > end) {
            ok = false;
            break;
          }
          name = decoder.decode(b.subarray(pos, pos + l));
          pos += l;
        } else if (field === 3 && wire === 2) {
          const l = varint();
          if (l < 0 || pos + l > end) {
            ok = false;
            break;
          }
          types = [...b.subarray(pos, pos + l)];
          pos += l;
        } else if (field === 2 && wire === 5 && pos + 4 <= end) {
          score = view.getFloat32(pos, true);
          pos += 4;
        } else if (!skip(wire, end)) {
          ok = false;
          break;
        }
      }
      pos = end;
      name = name.toLowerCase().trim();
      if (ok && name && !name.startsWith("spotify:")) out.push(types ? { name, score, types } : { name, score });
    }
    return out.sort((a, b2) => b2.score - a.score);
  }
  function onlyGenres(genres2) {
    return (genres2 ?? []).filter((g) => !g.types || g.types.includes(GENRE_TYPE));
  }
  function formatGenres(genres2, n = 3) {
    const list = onlyGenres(genres2);
    if (!list.length) return "\u2014";
    return list.slice(0, n).map((g) => g.name).join(" \xB7 ");
  }

  // src/api/genres.ts
  var SERVICE_ID = "spotify.mdata_esperanto.proto.MetadataService";
  var TRACK_CONCEPTS = 6;
  var BATCH = 500;
  var client = null;
  function findService(id) {
    const w = window;
    const chunk = w.rspackChunk ?? w.webpackChunkclient_web ?? w.rspackChunkclient_web;
    if (!chunk?.push) return void 0;
    let req = null;
    try {
      const ret = chunk.push([[Symbol()], {}, (r) => {
        req = r;
        return r;
      }]);
      if (!req && typeof ret === "function") req = ret;
    } catch {
      return void 0;
    }
    if (!req?.m) return void 0;
    for (const key of Object.keys(req.m)) {
      try {
        const found = Object.values(req(key) ?? {}).find((c) => c?.SERVICE_ID === id);
        if (found) return found;
      } catch {
      }
    }
    return void 0;
  }
  function getClient() {
    if (client) return client;
    try {
      const Service = findService(SERVICE_ID);
      const P = Spicetify.Platform;
      const transport = P?.ProductStateAPI?.productStateApi?.transport ?? P?.Transport ?? P?.PlayerAPI?._queue?._client?._transport;
      if (Service && transport) client = new Service(transport);
    } catch (e) {
      console.warn("[crate-digger] MetadataService unavailable", e);
    }
    return client;
  }
  async function fetchGenres(uris) {
    const c = getClient();
    if (!c) return null;
    const out = /* @__PURE__ */ new Map();
    let anyOk = false;
    for (let i = 0; i < uris.length; i += BATCH) {
      const batch = uris.slice(i, i + BATCH);
      try {
        const res = await c.fetch({ extensionQuery: [{ extensionKind: TRACK_CONCEPTS, entityUri: batch }] });
        const ext = res?.extension?.find((e) => e.extensionKind === TRACK_CONCEPTS) ?? res?.extension?.[0];
        for (const item of ext?.entityExtension ?? []) {
          if (item?.entityUri) out.set(item.entityUri, parseConcepts(item.extensionData?.value));
        }
        batch.forEach((u) => {
          if (!out.has(u)) out.set(u, []);
        });
        anyOk = true;
      } catch (e) {
        console.warn("[crate-digger] track genres failed", e);
      }
    }
    return anyOk ? out : null;
  }

  // src/api/trackMeta.ts
  var SPCLIENT_FEATURES = "https://spclient.wg.spotify.com/audio-attributes/v1/audio-features";
  var WEB_FEATURES = "https://api.spotify.com/v1/audio-features";
  var FEATURE_BATCH = 50;
  var PLAYCOUNT_CONCURRENCY = 6;
  var PLAYCOUNT_FLUSH = 20;
  var features = /* @__PURE__ */ new Map();
  var v2 = /* @__PURE__ */ new Map();
  var playcounts = /* @__PURE__ */ new Map();
  var trackInfo = /* @__PURE__ */ new Map();
  var featuresFetched = /* @__PURE__ */ new Set();
  var genres = /* @__PURE__ */ new Map();
  function primeV2Meta(meta) {
    meta.forEach((m, uri) => v2.set(uri, m));
  }
  var idOf3 = (uri) => uri.split(":").pop();
  async function fetchFeatureBatch(uris) {
    const ids = uris.map(idOf3).join(",");
    for (const base of [SPCLIENT_FEATURES, WEB_FEATURES]) {
      try {
        const res = await Spicetify.CosmosAsync.get(`${base}?ids=${ids}`);
        if (Array.isArray(res?.audio_features)) return res.audio_features;
      } catch (e) {
        console.warn(`[crate-digger] audio-features failed (${base})`, e);
      }
    }
    return null;
  }
  async function loadFeatures(uris, onBatch) {
    const missing = uris.filter((u) => !featuresFetched.has(u));
    for (let i = 0; i < missing.length; i += FEATURE_BATCH) {
      const batch = missing.slice(i, i + FEATURE_BATCH);
      const rows = await fetchFeatureBatch(batch);
      if (!rows) continue;
      for (const f of rows) {
        const uri = f?.uri ?? (f?.id ? `spotify:track:${f.id}` : void 0);
        if (!uri || !f) continue;
        const m = {};
        if (typeof f.key === "number" && f.key >= 0) m.key = f.key;
        if (f.mode === 0 || f.mode === 1) m.mode = f.mode;
        if (typeof f.tempo === "number" && f.tempo > 0) m.tempo = f.tempo;
        if (typeof f.energy === "number") m.energy = f.energy;
        features.set(uri, m);
      }
      batch.forEach((u) => featuresFetched.add(u));
      onBatch(batch);
    }
  }
  async function loadPlaycounts(uris, onBatch) {
    const queue = uris.filter((u) => !playcounts.has(u));
    let done = [];
    const flush = () => {
      if (done.length) onBatch(done);
      done = [];
    };
    const worker = async () => {
      for (let uri = queue.shift(); uri; uri = queue.shift()) {
        try {
          const r = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.getTrack, { uri });
          const t = r?.data?.trackUnion;
          const n = Number(t?.playcount);
          playcounts.set(uri, Number.isFinite(n) ? n : void 0);
          const info = {};
          const ms = Number(t?.duration?.totalMilliseconds);
          if (Number.isFinite(ms) && ms > 0) info.durationMs = ms;
          const date = t?.albumOfTrack?.date;
          if (typeof date?.isoString === "string")
            info.released = { iso: date.isoString, precision: ["YEAR", "MONTH", "DAY"].includes(date.precision) ? date.precision : "DAY" };
          trackInfo.set(uri, info);
          done.push(uri);
          if (done.length >= PLAYCOUNT_FLUSH) flush();
        } catch {
        }
      }
    };
    await Promise.all(Array.from({ length: PLAYCOUNT_CONCURRENCY }, worker));
    flush();
  }
  async function loadGenres(uris, onBatch) {
    const cached = uris.filter((u) => genres.has(u));
    if (cached.length) onBatch(cached);
    const missing = uris.filter((u) => !genres.has(u));
    if (!missing.length) return;
    const got = await fetchGenres(missing);
    if (!got) return;
    got.forEach((g, uri) => genres.set(uri, g));
    onBatch(missing.filter((u) => got.has(u)));
  }
  async function getGenres(uris) {
    await loadGenres(uris, () => {
    }).catch(() => {
    });
    return (uri) => genres.get(uri);
  }
  function compose(uri) {
    const out = {};
    const pc = playcounts.get(uri);
    if (pc !== void 0) out.playcount = pc;
    Object.assign(out, trackInfo.get(uri));
    const g = genres.get(uri);
    if (g) out.genres = g;
    Object.assign(out, features.get(uri));
    const pref = v2.get(uri);
    if (pref?.tempo !== void 0) out.tempo = pref.tempo;
    if (pref?.key !== void 0 && pref.mode !== void 0) {
      out.key = pref.key;
      out.mode = pref.mode;
    }
    return out;
  }
  async function getTrackMeta(uris, onPartial) {
    const emit = (batch) => onPartial?.(new Map(batch.map((u) => [u, compose(u)])));
    await Promise.all([loadFeatures(uris, emit), loadPlaycounts(uris, emit), loadGenres(uris, emit)]);
    const all = new Map(uris.map((u) => [u, compose(u)]));
    return all;
  }

  // src/api/mixedBatch.ts
  var BASE_ROUNDS = 5;
  var MAX_EXTRA_PAGES = 3;
  async function fetchMixedBatch(playlistUri, skip, ctx, onV2Meta) {
    const avoid = avoidSet(playlistUri);
    const baseSkip = avoid.size ? /* @__PURE__ */ new Set([...skip, ...avoid]) : skip;
    const [baseRes, exclude] = await Promise.all([
      fetchRecommendationBatch(playlistUri, baseSkip, BASE_ROUNDS, onV2Meta).then(
        (t) => ({ ok: true, tracks: t }),
        (error) => ({ ok: false, error })
      ),
      ctx.excludeArtists().catch(() => /* @__PURE__ */ new Set())
    ]);
    const baseTracks = baseRes.ok ? baseRes.tracks : [];
    const taken = /* @__PURE__ */ new Set([...baseSkip, ...ctx.playlistTrackUris, ...baseTracks.map((t) => t.uri)]);
    let lookup = await getGenres([...ctx.playlistTrackUris, ...baseTracks.map((t) => t.uri)]);
    const playlistGenres = [...ctx.playlistTrackUris].map((u) => lookup(u) ?? []);
    const profile = buildProfile(playlistGenres);
    const threshold = fitThreshold(profile, playlistGenres);
    const kept = [];
    for (let page = 0; page < MAX_EXTRA_PAGES; page++) {
      const fresh = (await fetchExtras(playlistUri, exclude)).filter((t) => {
        if (taken.has(t.uri)) return false;
        taken.add(t.uri);
        return true;
      });
      lookup = await getGenres(fresh.map((t) => t.uri));
      kept.push(...keepFitting(fresh, lookup, profile, threshold));
      if (baseTracks.length || kept.length || extrasExhausted(playlistUri)) break;
    }
    const all = [...baseTracks, ...kept];
    if (!all.length && !baseRes.ok) throw baseRes.error;
    const ordered = orderBySimilarity(all, lookup, profile);
    recordShown(playlistUri, ordered.map((t) => t.uri));
    return ordered;
  }

  // src/api/timbre.ts
  var ANALYSIS = "https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis";
  var CONCURRENCY2 = 6;
  var cache = /* @__PURE__ */ new Map();
  async function getFingerprints(uris) {
    const queue = [...new Set(uris)].filter((u) => !cache.has(u));
    const worker = async () => {
      for (let uri = queue.shift(); uri; uri = queue.shift()) {
        try {
          const a = await Spicetify.CosmosAsync.get(`${ANALYSIS}/${uri.split(":").pop()}`);
          cache.set(uri, fingerprintFromAnalysis(a));
        } catch (e) {
          console.warn("[crate-digger] audio analysis failed", uri, e);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY2 }, worker));
    return new Map(uris.filter((u) => cache.has(u)).map((u) => [u, cache.get(u)]));
  }

  // src/domain/filters.ts
  var artistKey = (t) => t.artists.map((a) => a.uri).sort().join("|");
  function applyFilters(tracks, f, ctx) {
    const seenArtists = /* @__PURE__ */ new Set();
    return tracks.filter((t) => {
      if (ctx.playlistTrackUris.has(t.uri)) return false;
      if (f.hidePlaylistArtists && t.artists.some((a) => ctx.playlistArtistUris.has(a.uri))) return false;
      if (f.hideCollectionTracks && ctx.collectionTrackUris.has(t.uri)) return false;
      if (f.hideCollectionArtists && t.artists.some((a) => ctx.collectionArtistUris.has(a.uri))) return false;
      if (f.oneTrackPerArtist) {
        const key = artistKey(t);
        if (seenArtists.has(key)) return false;
        seenArtists.add(key);
      }
      return true;
    });
  }
  var ALL_OPTIONS_OFF = {
    hidePlaylistArtists: false,
    hideCollectionTracks: false,
    hideCollectionArtists: false,
    oneTrackPerArtist: false
  };
  function availableTracks(tracks, ctx) {
    return applyFilters(tracks, ALL_OPTIONS_OFF, ctx);
  }

  // src/domain/types.ts
  var DEFAULT_FILTERS = {
    hidePlaylistArtists: true,
    hideCollectionTracks: true,
    hideCollectionArtists: false,
    oneTrackPerArtist: false
  };

  // src/store/filterPrefs.ts
  var KEY = "crate-digger:filters";
  var LEGACY_KEY = "playlist-recomender:filters";
  function loadFilterPrefs() {
    try {
      const raw = Spicetify.LocalStorage.get(KEY) ?? Spicetify.LocalStorage.get(LEGACY_KEY);
      if (!raw) return DEFAULT_FILTERS;
      const saved = JSON.parse(raw);
      const pick = (k) => typeof saved?.[k] === "boolean" ? saved[k] : DEFAULT_FILTERS[k];
      return {
        hidePlaylistArtists: pick("hidePlaylistArtists"),
        hideCollectionTracks: pick("hideCollectionTracks"),
        hideCollectionArtists: pick("hideCollectionArtists"),
        oneTrackPerArtist: pick("oneTrackPerArtist")
      };
    } catch {
      return DEFAULT_FILTERS;
    }
  }
  function saveFilterPrefs(f) {
    try {
      Spicetify.LocalStorage.set(KEY, JSON.stringify(f));
    } catch {
    }
  }

  // src/domain/columns.ts
  var COLUMNS = [
    { id: "album", label: "Album", size: { min: 120, weight: 1.5 } },
    { id: "genres", label: "Genres", size: { min: 170, weight: 2.5 } },
    { id: "released", label: "Released", size: { fixed: 100 } },
    { id: "plays", label: "Plays", size: { fixed: 116 }, numeric: true },
    { id: "key", label: "Key", size: { fixed: 112 }, numeric: true },
    { id: "bpm", label: "BPM", size: { fixed: 60 }, numeric: true },
    { id: "duration", label: "Duration", size: { fixed: 72 }, numeric: true }
  ];
  var ADD_SIZE = { fixed: 44 };
  var COVER_SIZE = { fixed: 52 };
  var TITLE_SIZE = { min: 200, weight: 3 };
  var DEFAULT_COLUMNS = ["album", "genres", "plays", "key", "bpm"];
  var KNOWN = new Set(COLUMNS.map((c) => c.id));
  var isColumnId = (x) => typeof x === "string" && KNOWN.has(x);
  function visibleColumns(ids) {
    const on = new Set(ids);
    return COLUMNS.filter((c) => on.has(c.id));
  }
  function layoutWidths(total, sizes) {
    const out = sizes.map((s2) => "fixed" in s2 ? s2.fixed : 0);
    let left = total - out.reduce((a, b) => a + b, 0);
    let flex = sizes.map((s2, i) => i).filter((i) => !("fixed" in sizes[i]));
    const spec = (i) => sizes[i];
    for (; ; ) {
      const weight2 = flex.reduce((a, i) => a + spec(i).weight, 0);
      const pinned = flex.filter((i) => left * spec(i).weight / weight2 < spec(i).min);
      if (!pinned.length) break;
      pinned.forEach((i) => {
        out[i] = spec(i).min;
        left -= spec(i).min;
      });
      flex = flex.filter((i) => !pinned.includes(i));
      if (!flex.length) return out;
    }
    const weight = flex.reduce((a, i) => a + spec(i).weight, 0);
    let used = 0;
    flex.forEach((i, k) => {
      out[i] = k === flex.length - 1 ? left - used : Math.floor(left * spec(i).weight / weight);
      used += out[i];
    });
    return out;
  }

  // src/domain/keys.ts
  var SEEK_MS = 1e4;
  var SHORTCUT_LEGEND = [
    { keys: "\u2190 / \u2192", action: "Seek back / forward 10 s" },
    { keys: "\u2191 / \u2193", action: "Move through the list" },
    { keys: "Enter", action: "Play / pause the selected track" },
    { keys: "A", action: "Add the selected track" }
  ];
  var TEXT_INPUTS = /* @__PURE__ */ new Set(["text", "search", "email", "number", "password", "url", "tel"]);
  function typingIn(target) {
    const t = target;
    if (!t) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName?.toUpperCase();
    return tag === "TEXTAREA" || tag === "SELECT" || tag === "INPUT" && TEXT_INPUTS.has((t.type ?? "text").toLowerCase());
  }
  function activatable(target) {
    const tag = target?.tagName?.toUpperCase();
    return tag === "BUTTON" || tag === "INPUT" || tag === "A";
  }
  function keyAction(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return null;
    if (typingIn(e.target)) return null;
    switch (e.key) {
      case "ArrowLeft":
        return "seekBack";
      case "ArrowRight":
        return "seekForward";
      case "ArrowUp":
        return "up";
      case "ArrowDown":
        return "down";
      case "Enter":
        return activatable(e.target) ? null : "play";
      // a focused button/checkbox handles its own Enter
      case "a":
      case "A":
        return "add";
      default:
        return null;
    }
  }
  function moveSelection(current, delta, count) {
    if (count <= 0) return -1;
    if (current < 0) return delta > 0 ? 0 : count - 1;
    return Math.max(0, Math.min(count - 1, current + delta));
  }
  function scrollToShow(o) {
    const top = o.headerHeight + o.index * o.rowHeight;
    const bottom = top + o.rowHeight;
    if (top - o.headerHeight < o.scrollTop) return top - o.headerHeight;
    if (bottom > o.scrollTop + o.viewport) return bottom - o.viewport;
    return o.scrollTop;
  }

  // src/domain/virtual.ts
  var FALLBACK_VIEWPORT = 1e3;
  function windowRange(i) {
    const viewport = i.viewport > 0 ? i.viewport : FALLBACK_VIEWPORT;
    const y = Math.max(0, i.scrollTop - i.headerHeight);
    const start = Math.min(i.count, Math.max(0, Math.floor(y / i.rowHeight) - i.overscan));
    const end = Math.min(i.count, Math.ceil((y + viewport) / i.rowHeight) + i.overscan);
    return { start, end: Math.max(start, end) };
  }

  // src/store/columnPrefs.ts
  var KEY2 = "crate-digger:columns";
  var LEGACY_KEY2 = "playlist-recomender:columns";
  var columns = null;
  var listeners3 = /* @__PURE__ */ new Set();
  function load() {
    try {
      const raw = Spicetify.LocalStorage.get(KEY2) ?? Spicetify.LocalStorage.get(LEGACY_KEY2);
      if (!raw) return DEFAULT_COLUMNS;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved)) return DEFAULT_COLUMNS;
      return saved.flatMap((id) => id === "features" ? ["key", "bpm"] : [id]).filter(isColumnId);
    } catch {
      return DEFAULT_COLUMNS;
    }
  }
  function getColumns() {
    return columns ?? (columns = load());
  }
  function subscribeColumns(fn) {
    listeners3.add(fn);
    return () => listeners3.delete(fn);
  }
  function toggleColumn(id) {
    const cur = getColumns();
    columns = cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id];
    try {
      Spicetify.LocalStorage.set(KEY2, JSON.stringify(columns));
    } catch {
    }
    listeners3.forEach((fn) => fn());
  }

  // src/domain/format.ts
  var MISSING = "\u2014";
  function toOpenKey(key, mode) {
    if (key === void 0 || key < 0 || key > 11 || mode !== 0 && mode !== 1) return MISSING;
    if (mode === 1) return `${7 * key % 12 + 1}d`;
    return `${7 * ((key + 3) % 12) % 12 + 1}m`;
  }
  var KEY_NOTATIONS = [
    { id: "musical", label: "Musical", example: "Am / C\u266F" },
    { id: "camelot", label: "Camelot", example: "8A / 3B" },
    { id: "openkey", label: "Open Key", example: "1m / 8d" }
  ];
  var MAJOR_NAMES = ["C", "D\u266D", "D", "E\u266D", "E", "F", "F\u266F", "G", "A\u266D", "A", "B\u266D", "B"];
  var MINOR_NAMES = ["Cm", "C\u266Fm", "Dm", "E\u266Dm", "Em", "Fm", "F\u266Fm", "Gm", "G\u266Fm", "Am", "B\u266Dm", "Bm"];
  function formatKey(key, mode, notation) {
    if (key === void 0 || key < 0 || key > 11 || mode !== 0 && mode !== 1) return MISSING;
    if (notation === "musical") return mode === 1 ? MAJOR_NAMES[key] : MINOR_NAMES[key];
    const open = toOpenKey(key, mode);
    if (notation === "openkey") return open;
    const n = (parseInt(open, 10) + 6) % 12 + 1;
    return `${n}${mode === 1 ? "B" : "A"}`;
  }
  function formatBpm(tempo) {
    return tempo && tempo > 0 ? String(Math.round(tempo)) : MISSING;
  }
  function formatPlays(n) {
    return n === void 0 ? MISSING : n.toLocaleString("en-US");
  }
  function formatDuration(ms) {
    if (!ms || ms < 0) return MISSING;
    const total = Math.round(ms / 1e3);
    const h = Math.floor(total / 3600);
    const m = Math.floor(total % 3600 / 60);
    const s2 = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s2}` : `${m}:${s2}`;
  }
  var DATE_FORMATS = {
    DAY: { day: "numeric", month: "short", year: "numeric" },
    MONTH: { month: "short", year: "numeric" },
    YEAR: { year: "numeric" }
  };
  function formatReleased(r) {
    if (!r) return MISSING;
    const d = new Date(r.iso);
    if (Number.isNaN(d.getTime())) return MISSING;
    return new Intl.DateTimeFormat("en-US", { ...DATE_FORMATS[r.precision] ?? DATE_FORMATS.DAY, timeZone: "UTC" }).format(d);
  }

  // src/store/keyNotationPref.ts
  var KEY3 = "crate-digger:keyNotation";
  var DEFAULT = "openkey";
  var IDS = KEY_NOTATIONS.map((n) => n.id);
  var value = null;
  var listeners4 = /* @__PURE__ */ new Set();
  function load2() {
    try {
      const raw = Spicetify.LocalStorage.get(KEY3);
      return IDS.includes(raw) ? raw : DEFAULT;
    } catch {
      return DEFAULT;
    }
  }
  function getKeyNotation() {
    return value ?? (value = load2());
  }
  function subscribeKeyNotation(fn) {
    listeners4.add(fn);
    return () => listeners4.delete(fn);
  }
  function setKeyNotation(n) {
    value = n;
    try {
      Spicetify.LocalStorage.set(KEY3, n);
    } catch {
    }
    listeners4.forEach((fn) => fn());
  }
  function cycleKeyNotation() {
    setKeyNotation(IDS[(IDS.indexOf(getKeyNotation()) + 1) % IDS.length]);
  }

  // src/store/nowPlaying.ts
  var snapshot = null;
  var listening = false;
  var listeners5 = /* @__PURE__ */ new Set();
  function read() {
    const d = Spicetify.Player?.data;
    return { uri: d?.item?.uri, paused: !!d?.isPaused };
  }
  function refresh() {
    const next = read();
    if (snapshot && next.uri === snapshot.uri && next.paused === snapshot.paused) return;
    snapshot = next;
    listeners5.forEach((fn) => fn());
  }
  function listen() {
    if (listening) return;
    listening = true;
    const P = Spicetify.Player;
    P?.addEventListener?.("songchange", refresh);
    P?.addEventListener?.("onplaypause", refresh);
  }
  function getNowPlaying() {
    listen();
    return snapshot ?? (snapshot = read());
  }
  function subscribeNowPlaying(fn) {
    listen();
    listeners5.add(fn);
    return () => listeners5.delete(fn);
  }
  function playState(now, uri) {
    if (!now.uri || now.uri !== uri) return null;
    return now.paused ? "paused" : "playing";
  }

  // src/store/shortcutPrefs.ts
  var KEY4 = "crate-digger:shortcuts";
  var enabled = null;
  var listeners6 = /* @__PURE__ */ new Set();
  function load3() {
    try {
      const raw = Spicetify.LocalStorage.get(KEY4);
      if (!raw) return true;
      const v = JSON.parse(raw);
      return typeof v?.enabled === "boolean" ? v.enabled : true;
    } catch {
      return true;
    }
  }
  function shortcutsEnabled() {
    return enabled ?? (enabled = load3());
  }
  function subscribeShortcutPrefs(fn) {
    listeners6.add(fn);
    return () => listeners6.delete(fn);
  }
  function setShortcutsEnabled(on) {
    enabled = on;
    try {
      Spicetify.LocalStorage.set(KEY4, JSON.stringify({ enabled: on }));
    } catch {
    }
    listeners6.forEach((fn) => fn());
  }

  // src/ui/addToPlaylist.ts
  async function addToPlaylist(playlistUri, trackUri) {
    if (!tryBeginAdd(playlistUri, trackUri)) return;
    try {
      await addTrack(playlistUri, trackUri);
      finishAdd(playlistUri, trackUri, true);
    } catch (e) {
      console.error("[crate-digger] add failed", e);
      finishAdd(playlistUri, trackUri, false);
      Spicetify.showNotification("Couldn't add the track", true);
    }
  }

  // src/ui/react.ts
  var R = () => Spicetify.React;

  // src/ui/MenuButton.tsx
  function MenuButton(props) {
    const { useEffect, useRef, useState } = R();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
      if (!open) return;
      const onDown = (e) => {
        if (ref.current && !ref.current.contains(e.target)) setOpen(false);
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
        }
      };
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("keydown", onKey, true);
      return () => {
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
      };
    }, [open]);
    return /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-columns", ref }, /* @__PURE__ */ Spicetify.React.createElement(
      "button",
      {
        className: "prr-columns-btn" + (open ? " prr-columns-btn-open" : ""),
        "aria-haspopup": "true",
        "aria-expanded": open,
        title: props.title,
        onClick: () => setOpen(!open)
      },
      props.icon,
      props.label
    ), open && /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-columns-menu", role: "menu" }, props.children));
  }

  // src/ui/ColumnsMenu.tsx
  function ColumnsMenu({ visible, keyNotation }) {
    return /* @__PURE__ */ Spicetify.React.createElement(
      MenuButton,
      {
        label: "Columns",
        title: "Choose columns",
        icon: /* @__PURE__ */ Spicetify.React.createElement("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }, /* @__PURE__ */ Spicetify.React.createElement("rect", { x: "1.75", y: "2.75", width: "12.5", height: "10.5", rx: "1.5", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }), /* @__PURE__ */ Spicetify.React.createElement("path", { d: "M6 3v10M10 3v10", stroke: "currentColor", strokeWidth: "1.5" }))
      },
      /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-columns-fixed" }, "Title and add are always shown"),
      COLUMNS.map((c) => /* @__PURE__ */ Spicetify.React.createElement("label", { key: c.id, className: "prr-check prr-columns-item", role: "menuitemcheckbox", "aria-checked": visible.includes(c.id) }, /* @__PURE__ */ Spicetify.React.createElement("input", { type: "checkbox", checked: visible.includes(c.id), onChange: () => toggleColumn(c.id) }), c.label)),
      /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-columns-fixed prr-columns-section" }, "Key notation"),
      KEY_NOTATIONS.map((n) => /* @__PURE__ */ Spicetify.React.createElement("label", { key: n.id, className: "prr-check prr-columns-item", role: "menuitemradio", "aria-checked": keyNotation === n.id }, /* @__PURE__ */ Spicetify.React.createElement("input", { type: "radio", name: "crate-digger-key-notation", checked: keyNotation === n.id, onChange: () => setKeyNotation(n.id) }), n.label, /* @__PURE__ */ Spicetify.React.createElement("span", { className: "prr-columns-hint" }, n.example)))
    );
  }

  // src/ui/ShortcutsMenu.tsx
  function ShortcutsMenu({ enabled: enabled2 }) {
    return /* @__PURE__ */ Spicetify.React.createElement(
      MenuButton,
      {
        label: "Shortcuts",
        title: "Keyboard shortcuts",
        icon: /* @__PURE__ */ Spicetify.React.createElement("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }, /* @__PURE__ */ Spicetify.React.createElement("rect", { x: "1.25", y: "3.75", width: "13.5", height: "8.5", rx: "1.5", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }), /* @__PURE__ */ Spicetify.React.createElement("path", { d: "M4 6.5h1M7.5 6.5h1M11 6.5h1M4.5 9.5h7", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }))
      },
      /* @__PURE__ */ Spicetify.React.createElement("label", { className: "prr-check prr-columns-item", role: "menuitemcheckbox", "aria-checked": enabled2 }, /* @__PURE__ */ Spicetify.React.createElement("input", { type: "checkbox", checked: enabled2, onChange: (e) => setShortcutsEnabled(e.currentTarget.checked) }), "Keyboard shortcuts"),
      /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-shortcuts-legend" + (enabled2 ? "" : " prr-shortcuts-off") }, SHORTCUT_LEGEND.map((s2) => /* @__PURE__ */ Spicetify.React.createElement("div", { key: s2.keys, className: "prr-shortcut" }, /* @__PURE__ */ Spicetify.React.createElement("kbd", null, s2.keys), /* @__PURE__ */ Spicetify.React.createElement("span", null, s2.action))))
    );
  }

  // src/ui/FiltersBar.tsx
  function FiltersBar({ uri, filters }) {
    const set2 = (patch) => {
      const next = { ...filters, ...patch };
      updateSession(uri, { filters: next });
      saveFilterPrefs(next);
    };
    return /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-filters" }, /* @__PURE__ */ Spicetify.React.createElement("label", { className: "prr-check" }, /* @__PURE__ */ Spicetify.React.createElement(
      "input",
      {
        type: "checkbox",
        checked: filters.hidePlaylistArtists,
        onChange: (e) => set2({ hidePlaylistArtists: e.currentTarget.checked })
      }
    ), "Hide artists in this playlist"), /* @__PURE__ */ Spicetify.React.createElement("label", { className: "prr-check" }, /* @__PURE__ */ Spicetify.React.createElement(
      "input",
      {
        type: "checkbox",
        checked: filters.hideCollectionTracks,
        onChange: (e) => set2({ hideCollectionTracks: e.currentTarget.checked })
      }
    ), "Hide tracks in my library"), /* @__PURE__ */ Spicetify.React.createElement("label", { className: "prr-check" }, /* @__PURE__ */ Spicetify.React.createElement(
      "input",
      {
        type: "checkbox",
        checked: filters.hideCollectionArtists,
        onChange: (e) => set2({ hideCollectionArtists: e.currentTarget.checked })
      }
    ), "Hide artists in my library"), /* @__PURE__ */ Spicetify.React.createElement("label", { className: "prr-check", title: "A collaboration counts as its own artist" }, /* @__PURE__ */ Spicetify.React.createElement(
      "input",
      {
        type: "checkbox",
        checked: filters.oneTrackPerArtist,
        onChange: (e) => set2({ oneTrackPerArtist: e.currentTarget.checked })
      }
    ), "One track per artist"));
  }

  // src/ui/TrackRow.tsx
  var CELLS = {
    album: (t) => ({ text: t.album.name }),
    genres: (_t, m) => ({
      text: formatGenres(m?.genres),
      title: onlyGenres(m?.genres).map((g) => `${g.name} ${Math.round(g.score * 100)}%`).join("\n") || void 0
    }),
    released: (_t, m) => ({ text: formatReleased(m?.released) }),
    plays: (_t, m) => ({ text: formatPlays(m?.playcount) }),
    key: (_t, m, n) => ({ text: formatKey(m?.key, m?.mode, n) }),
    bpm: (_t, m) => ({ text: formatBpm(m?.tempo) }),
    duration: (t, m) => ({ text: formatDuration(m?.durationMs ?? t.durationMs) })
  };
  function AddIcon({ state: state2 }) {
    if (state2 === "added")
      return /* @__PURE__ */ Spicetify.React.createElement("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }, /* @__PURE__ */ Spicetify.React.createElement("circle", { cx: "8", cy: "8", r: "8", fill: "currentColor" }), /* @__PURE__ */ Spicetify.React.createElement("path", { d: "M4.6 8.3l2.3 2.3 4.5-4.8", fill: "none", stroke: "var(--prr-check-mark, #000)", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round" }));
    if (state2 === "adding")
      return /* @__PURE__ */ Spicetify.React.createElement("svg", { viewBox: "0 0 16 16", "aria-hidden": "true", className: "prr-spin" }, /* @__PURE__ */ Spicetify.React.createElement("circle", { cx: "8", cy: "8", r: "6.5", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeDasharray: "28 13", strokeLinecap: "round" }));
    return /* @__PURE__ */ Spicetify.React.createElement("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }, /* @__PURE__ */ Spicetify.React.createElement("circle", { cx: "8", cy: "8", r: "7.25", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }), /* @__PURE__ */ Spicetify.React.createElement("path", { d: "M8 4.75v6.5M4.75 8h6.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }));
  }
  function TrackRowImpl({ uri, track, columns: columns2, meta, editable, added, adding, playState: playState2, selected, onSelect, keyNotation }) {
    const state2 = added ? "added" : adding ? "adding" : "add";
    const label = !editable ? "Read-only playlist" : added ? "Added to the playlist" : adding ? "Adding\u2026" : "Add to the playlist";
    return /* @__PURE__ */ Spicetify.React.createElement(
      "tr",
      {
        className: "prr-row" + (added ? " prr-row-added" : "") + (playState2 ? ` prr-row-current prr-row-${playState2}` : "") + (selected ? " prr-row-selected" : ""),
        "aria-selected": selected,
        title: playState2 === "playing" ? "Click to pause" : playState2 === "paused" ? "Click to resume" : "Click to play",
        onClick: () => {
          onSelect(track.uri);
          if (playState2) Spicetify.Player.togglePlay();
          else void Spicetify.Player.playUri(track.uri);
        }
      },
      /* @__PURE__ */ Spicetify.React.createElement("td", { className: "prr-action" }, /* @__PURE__ */ Spicetify.React.createElement(
        "button",
        {
          className: "prr-add prr-add-" + state2,
          title: label,
          "aria-label": label,
          disabled: !editable || added || adding,
          onClick: (e) => {
            e.stopPropagation();
            onSelect(track.uri);
            void addToPlaylist(uri, track.uri);
          }
        },
        /* @__PURE__ */ Spicetify.React.createElement(AddIcon, { state: state2 })
      )),
      /* @__PURE__ */ Spicetify.React.createElement("td", null, /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-cover-wrap" }, track.album.imageUrl ? /* @__PURE__ */ Spicetify.React.createElement("img", { className: "prr-cover", src: track.album.imageUrl, alt: "", loading: "lazy", decoding: "async" }) : /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-cover" }), playState2 && /* @__PURE__ */ Spicetify.React.createElement("span", { className: "prr-eq", "aria-label": playState2 === "playing" ? "Playing" : "Paused" }, /* @__PURE__ */ Spicetify.React.createElement("i", null), /* @__PURE__ */ Spicetify.React.createElement("i", null), /* @__PURE__ */ Spicetify.React.createElement("i", null)))),
      /* @__PURE__ */ Spicetify.React.createElement("td", null, /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-name" }, track.name), /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-sub" }, track.artists.map((a) => a.name).join(", "))),
      columns2.map((c) => {
        const cell = CELLS[c.id](track, meta, keyNotation);
        return /* @__PURE__ */ Spicetify.React.createElement("td", { key: c.id, className: "prr-sub" + (c.numeric ? " prr-num" : ""), title: cell.title }, cell.text);
      })
    );
  }
  var memoRow = null;
  function TrackRow(props) {
    memoRow ?? (memoRow = Spicetify.React.memo(TrackRowImpl));
    return Spicetify.React.createElement(memoRow, props);
  }

  // src/ui/styles.css
  var s = document.createElement("style");
  s.id = "crate-digger-css";
  s.textContent = `/* Widen Spicetify's popup only when it hosts this extension. */\r
.spicetify-popup-container:has(.prr-root) {\r
  width: min(1150px, 92vw) !important;\r
}\r
\r
.prr-root {\r
  display: flex;\r
  flex-direction: column;\r
  gap: 12px;\r
  width: 100%;\r
  min-width: 0;\r
  color: var(--spice-text);\r
}\r
\r
.prr-warning {\r
  padding: 8px 12px;\r
  border-radius: 6px;\r
  background: rgba(var(--spice-rgb-notification-error, 233, 20, 41), 0.15);\r
  font-size: 13px;\r
}\r
\r
.prr-filters {\r
  display: flex;\r
  flex-wrap: wrap;\r
  align-items: center;\r
  gap: 8px 20px;\r
  font-size: 13px;\r
}\r
.prr-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }\r
\r
.prr-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }\r
.prr-counter { font-size: 12px; color: var(--spice-subtext); }\r
\r
.prr-columns { position: relative; }\r
.prr-columns-btn {\r
  display: inline-flex;\r
  align-items: center;\r
  gap: 6px;\r
  padding: 4px 10px;\r
  border: 0;\r
  border-radius: 999px;\r
  background: transparent;\r
  color: var(--spice-subtext);\r
  font-size: 12px;\r
  cursor: pointer;\r
}\r
.prr-columns-btn svg { width: 14px; height: 14px; }\r
.prr-columns-btn:hover, .prr-columns-btn-open { color: var(--spice-text); background: rgba(var(--spice-rgb-text, 255, 255, 255), 0.07); }\r
.prr-columns-menu {\r
  position: absolute;\r
  right: 0;\r
  top: calc(100% + 4px);\r
  z-index: 5;\r
  display: flex;\r
  flex-direction: column;\r
  gap: 2px;\r
  min-width: 220px;\r
  padding: 6px;\r
  border-radius: 6px;\r
  background: var(--spice-card, #282828);\r
  box-shadow: 0 16px 24px rgba(0, 0, 0, 0.3), 0 6px 8px rgba(0, 0, 0, 0.2);\r
  font-size: 13px;\r
}\r
.prr-columns-fixed { padding: 6px 8px; font-size: 11px; color: var(--spice-subtext); }\r
.prr-columns-item { padding: 6px 8px; border-radius: 4px; }\r
.prr-columns-item:hover { background: rgba(var(--spice-rgb-text, 255, 255, 255), 0.07); }\r
\r
.prr-list {\r
  max-height: 60vh;\r
  overflow-y: auto;\r
  /* Reserve the scrollbar's room up front so the measured width doesn't change when rows arrive. */\r
  scrollbar-gutter: stable;\r
}\r
.prr-empty { padding: 24px; text-align: center; color: var(--spice-subtext); }\r
\r
.prr-table {\r
  min-width: 100%;\r
  table-layout: fixed;\r
  border-collapse: separate;\r
  border-spacing: 0;\r
}\r
.prr-table th {\r
  position: sticky;\r
  top: 0;\r
  z-index: 1;\r
  padding: 8px;\r
  background: var(--spice-player, #181818); /* same as Spicetify's popup background */\r
  border-bottom: 1px solid rgba(var(--spice-rgb-text, 255, 255, 255), 0.1);\r
  color: var(--spice-subtext);\r
  font-size: 12px;\r
  font-weight: 400;\r
  text-align: left;\r
  white-space: nowrap;\r
  overflow: hidden;\r
  text-overflow: ellipsis;\r
}\r
.prr-table th.prr-num { text-align: right; }\r
.prr-table td {\r
  padding: 6px 8px;\r
  vertical-align: middle;\r
  white-space: nowrap;\r
  overflow: hidden;\r
  text-overflow: ellipsis;\r
}\r
.prr-table td.prr-action { padding: 0 0 0 4px; }\r
.prr-table td.prr-action + td { padding-left: 4px; padding-right: 4px; }\r
/* Fixed heights: the list is virtualised (ROW_HEIGHT / HEADER_HEIGHT in RecommenderModal.tsx). */\r
.prr-row { cursor: pointer; height: 52px; }\r
.prr-table th { height: 34px; box-sizing: border-box; }\r
.prr-spacer td { padding: 0; border: 0; }\r
.prr-row td:first-child { border-radius: 4px 0 0 4px; }\r
.prr-row td:last-child { border-radius: 0 4px 4px 0; }\r
.prr-row:hover td { background: rgba(var(--spice-rgb-text, 255, 255, 255), 0.07); }\r
.prr-cover { display: block; width: 40px; height: 40px; border-radius: 3px; object-fit: cover; background: var(--spice-card); }\r
.prr-action { text-align: center; overflow: visible; }\r
\r
.prr-add {\r
  display: inline-flex;\r
  align-items: center;\r
  justify-content: center;\r
  width: 32px;\r
  height: 32px;\r
  padding: 0;\r
  border: 0;\r
  border-radius: 50%;\r
  background: transparent;\r
  color: var(--spice-subtext);\r
  cursor: pointer;\r
  vertical-align: middle;\r
}\r
.prr-add svg { width: 18px; height: 18px; display: block; }\r
.prr-row:hover .prr-add-add:not(:disabled) { color: var(--spice-text); }\r
.prr-add-add:not(:disabled):hover { color: var(--spice-text); transform: scale(1.08); }\r
.prr-add-added { color: var(--spice-button, #1ed760); cursor: default; }\r
.prr-add-adding { color: var(--spice-text); cursor: default; }\r
.prr-add:disabled.prr-add-add { opacity: 0.35; cursor: default; }\r
.prr-add:focus-visible { outline: 2px solid var(--spice-text); outline-offset: 1px; }\r
.prr-spin { animation: prr-spin 0.9s linear infinite; }\r
@keyframes prr-spin { to { transform: rotate(360deg); } }\r
.prr-row-added td:not(.prr-action) { opacity: 0.55; }\r
.prr-name, .prr-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\r
.prr-name { font-size: 14px; }\r
.prr-sub { font-size: 13px; color: var(--spice-subtext); }\r
.prr-num { text-align: right; font-variant-numeric: tabular-nums; }\r
\r
.prr-btn {\r
  padding: 6px 16px;\r
  border-radius: 999px;\r
  border: 1px solid var(--spice-subtext);\r
  background: transparent;\r
  color: var(--spice-text);\r
  font-weight: 700;\r
  font-size: 13px;\r
  cursor: pointer;\r
}\r
.prr-btn:hover:not(:disabled) { border-color: var(--spice-text); transform: scale(1.03); }\r
.prr-btn:disabled { opacity: 0.5; cursor: default; }\r
.prr-btn-secondary { border-color: transparent; color: var(--spice-subtext); }\r
\r
.prr-footer { display: flex; justify-content: flex-end; gap: 12px; }\r
\r
/* Action-bar button: copies the native button classes; this is only the fallback if none is found. */\r
.crate-digger-action-fallback {\r
  display: inline-flex;\r
  align-items: center;\r
  justify-content: center;\r
  width: 32px;\r
  height: 56px;\r
  padding: 0;\r
  border: 0;\r
  background: transparent;\r
  color: var(--spice-subtext);\r
  cursor: pointer;\r
}\r
.crate-digger-action-fallback:hover { color: var(--spice-text); transform: scale(1.04); }\r
\r
/* Playlist with an open Crate Digger session: green + dot, like Spotify's active shuffle. */\r
.crate-digger-action.crate-digger-active { color: var(--text-bright-accent, #1ed760); position: relative; }\r
.crate-digger-action.crate-digger-active:hover { color: var(--text-bright-accent, #1ed760); filter: brightness(1.12); }\r
.crate-digger-action.crate-digger-active::after {\r
  content: "";\r
  position: absolute;\r
  left: 50%;\r
  bottom: -8px;\r
  width: 4px;\r
  height: 4px;\r
  border-radius: 50%;\r
  background: currentColor;\r
  transform: translateX(-50%);\r
}\r
\r
/* Track Spotify is playing: green title + equalizer over the cover (bars still while paused). */\r
.prr-cover-wrap { position: relative; width: 40px; height: 40px; }\r
.prr-row-current .prr-name { color: var(--text-bright-accent, #1ed760); }\r
.prr-eq {\r
  position: absolute;\r
  inset: 0;\r
  display: flex;\r
  align-items: flex-end;\r
  justify-content: center;\r
  gap: 3px;\r
  padding-bottom: 11px;\r
  border-radius: 3px;\r
  background: rgba(0, 0, 0, 0.55);\r
}\r
.prr-eq i {\r
  display: block;\r
  width: 3px;\r
  height: 14px;\r
  border-radius: 1px;\r
  background: var(--text-bright-accent, #1ed760);\r
  transform-origin: bottom;\r
  transform: scaleY(0.45);\r
}\r
.prr-eq i:nth-child(2) { transform: scaleY(0.8); }\r
.prr-eq i:nth-child(3) { transform: scaleY(0.6); }\r
.prr-row-playing .prr-eq i { animation: prr-eq 0.9s ease-in-out infinite alternate; }\r
.prr-row-playing .prr-eq i:nth-child(2) { animation-duration: 0.7s; animation-delay: -0.3s; }\r
.prr-row-playing .prr-eq i:nth-child(3) { animation-duration: 1.1s; animation-delay: -0.6s; }\r
@keyframes prr-eq { from { transform: scaleY(0.25); } to { transform: scaleY(1); } }\r
@media (prefers-reduced-motion: reduce) { .prr-row-playing .prr-eq i { animation: none; } }\r
\r
/* Keyboard selection (\u2191/\u2193): like hover, but it stays. */\r
.prr-row-selected td { background: rgba(var(--spice-rgb-text, 255, 255, 255), 0.12); }\r
.prr-row-selected:hover td { background: rgba(var(--spice-rgb-text, 255, 255, 255), 0.14); }\r
.prr-row-selected td:first-child { box-shadow: inset 2px 0 0 var(--spice-text, #fff); }\r
\r
.prr-toolbar-actions { display: flex; align-items: center; gap: 4px; }\r
.prr-shortcuts-legend { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px 4px; }\r
.prr-shortcuts-off { opacity: 0.45; }\r
.prr-shortcut { display: flex; align-items: baseline; gap: 10px; font-size: 12px; color: var(--spice-subtext); }\r
.prr-shortcut kbd {\r
  flex: 0 0 auto;\r
  min-width: 52px;\r
  padding: 1px 6px;\r
  border: 1px solid rgba(var(--spice-rgb-text, 255, 255, 255), 0.25);\r
  border-radius: 4px;\r
  font: inherit;\r
  font-size: 11px;\r
  color: var(--spice-text);\r
  text-align: center;\r
}\r
.prr-columns-menu:has(.prr-shortcuts-legend) { min-width: 300px; }\r
.prr-shortcut span { white-space: nowrap; }\r
\r
/* Key column header switches the notation. */\r
.prr-th-btn {\r
  padding: 0;\r
  border: 0;\r
  background: none;\r
  color: inherit;\r
  font: inherit;\r
  cursor: pointer;\r
  white-space: nowrap;\r
}\r
.prr-th-btn:hover { color: var(--spice-text); text-decoration: underline; }\r
.prr-columns-section { margin-top: 4px; border-top: 1px solid rgba(var(--spice-rgb-text, 255, 255, 255), 0.1); padding-top: 10px; }\r
.prr-columns-hint { margin-left: auto; padding-left: 12px; font-size: 11px; color: var(--spice-subtext); }\r
`;
  document.head.appendChild(s);

  // src/ui/RecommenderModal.tsx
  var ROW_HEIGHT = 52;
  var HEADER_HEIGHT = 34;
  var OVERSCAN = 10;
  function RecommenderModal({ uri }) {
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = R();
    const sub = useCallback((fn) => subscribe(uri, fn), [uri]);
    const s2 = useSyncExternalStore(sub, () => getSession(uri));
    const library = useSyncExternalStore(subscribeLibrary, getLibrary);
    const columnIds = useSyncExternalStore(subscribeColumns, getColumns);
    const now = useSyncExternalStore(subscribeNowPlaying, getNowPlaying);
    const keyNotation = useSyncExternalStore(subscribeKeyNotation, getKeyNotation);
    const columns2 = useMemo(() => visibleColumns(columnIds), [columnIds]);
    const listRef = useRef(null);
    const [tableWidth, setTableWidth] = useState(0);
    const [viewport, setViewport] = useState(0);
    const [scrollTop, setScrollTop] = useState(() => getSession(uri)?.scrollTop ?? 0);
    const widths = layoutWidths(tableWidth || 1e3, [ADD_SIZE, COVER_SIZE, TITLE_SIZE, ...columns2.map((c) => c.size)]);
    const shortcutsOn = useSyncExternalStore(subscribeShortcutPrefs, shortcutsEnabled);
    const [selected, setSelected] = useState(null);
    const onSelect = useCallback((trackUri) => setSelected(trackUri), []);
    const latest = useRef(null);
    useEffect(() => {
      if (!shortcutsOn) return;
      const onKey = (e) => {
        const action = keyAction(e);
        const L = latest.current;
        const el = listRef.current;
        if (!action || !L || !el) return;
        e.preventDefault();
        e.stopPropagation();
        if (action === "seekBack") Spicetify.Player.skipBack(SEEK_MS);
        else if (action === "seekForward") Spicetify.Player.skipForward(SEEK_MS);
        else if (action === "up" || action === "down") {
          const current = L.visible.findIndex((t) => t.uri === L.selected);
          const index = moveSelection(current, action === "down" ? 1 : -1, L.visible.length);
          if (index < 0) return;
          setSelected(L.visible[index].uri);
          el.scrollTop = scrollToShow({ index, scrollTop: el.scrollTop, viewport: el.clientHeight, rowHeight: ROW_HEIGHT, headerHeight: HEADER_HEIGHT });
        } else {
          const t = L.visible.find((x) => x.uri === L.selected);
          if (!t) return;
          if (action === "play") {
            if (L.nowUri === t.uri) Spicetify.Player.togglePlay();
            else void Spicetify.Player.playUri(t.uri);
          } else if (action === "add" && L.editable) void addToPlaylist(uri, t.uri);
        }
      };
      document.addEventListener("keydown", onKey, true);
      return () => document.removeEventListener("keydown", onKey, true);
    }, [shortcutsOn, uri]);
    useEffect(() => {
      const el = listRef.current;
      if (!el) return;
      const update = () => {
        setTableWidth(el.clientWidth);
        setViewport(el.clientHeight);
      };
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);
    useEffect(() => {
      const el = listRef.current;
      if (!el) return;
      const onScroll = () => {
        rememberScroll(uri, el.scrollTop);
        setScrollTop(
          (prev) => Math.floor(prev / ROW_HEIGHT) === Math.floor(el.scrollTop / ROW_HEIGHT) ? prev : el.scrollTop
        );
      };
      el.addEventListener("scroll", onScroll, { passive: true });
      const target = getSession(uri)?.scrollTop ?? 0;
      let frames = 0;
      let raf = 0;
      const tick = () => {
        if (el.isConnected && el.clientHeight > 0) el.scrollTop = target;
        if (el.scrollTop !== target && frames++ < 30) raf = requestAnimationFrame(tick);
      };
      if (target) tick();
      return () => {
        cancelAnimationFrame(raf);
        el.removeEventListener("scroll", onScroll);
      };
    }, [uri]);
    if (!s2) return null;
    const ctx = {
      playlistTrackUris: s2.playlistTrackUris,
      playlistArtistUris: s2.playlistArtistUris,
      collectionTrackUris: library.collectionTrackUris,
      collectionArtistUris: library.collectionArtistUris
    };
    const visible = applyFilters(s2.tracks, s2.filters, ctx);
    latest.current = { visible, selected, editable: s2.editable, nowUri: now.uri };
    const range = windowRange({
      scrollTop,
      viewport,
      rowHeight: ROW_HEIGHT,
      headerHeight: HEADER_HEIGHT,
      count: visible.length,
      overscan: OVERSCAN
    });
    const available = availableTracks(s2.tracks, ctx).length;
    const firstLoad = s2.loading && s2.tracks.length === 0;
    const libraryNote = library.status === "loading" ? " \xB7 reading your library\u2026" : library.status === "error" ? " \xB7 couldn't read your library" : "";
    return /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-root" }, !s2.editable && /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-warning" }, "Read-only: you can't add tracks to this playlist"), /* @__PURE__ */ Spicetify.React.createElement(FiltersBar, { uri, filters: s2.filters }), /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-toolbar" }, /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-counter" }, visible.length, " shown / ", available, " loaded", libraryNote), /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-toolbar-actions" }, /* @__PURE__ */ Spicetify.React.createElement(ShortcutsMenu, { enabled: shortcutsOn }), /* @__PURE__ */ Spicetify.React.createElement(ColumnsMenu, { visible: columnIds, keyNotation }))), /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-list", ref: listRef }, firstLoad && /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-empty" }, "Loading recommendations\u2026"), !s2.loading && s2.tracks.length === 0 && /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-empty" }, s2.error ? `Error: ${s2.error}` : "No recommendations for this playlist"), s2.tracks.length > 0 && visible.length === 0 && /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-empty" }, "No track matches the filters"), visible.length > 0 && /* @__PURE__ */ Spicetify.React.createElement("table", { className: "prr-table", style: { width: widths.reduce((a, b) => a + b, 0) } }, /* @__PURE__ */ Spicetify.React.createElement("colgroup", null, /* @__PURE__ */ Spicetify.React.createElement("col", { style: { width: widths[0] } }), /* @__PURE__ */ Spicetify.React.createElement("col", { style: { width: widths[1] } }), /* @__PURE__ */ Spicetify.React.createElement("col", { style: { width: widths[2] } }), columns2.map((c, i) => /* @__PURE__ */ Spicetify.React.createElement("col", { key: c.id, style: { width: widths[3 + i] } }))), /* @__PURE__ */ Spicetify.React.createElement("thead", null, /* @__PURE__ */ Spicetify.React.createElement("tr", null, /* @__PURE__ */ Spicetify.React.createElement("th", { "aria-label": "Add" }), /* @__PURE__ */ Spicetify.React.createElement("th", { colSpan: 2 }, "Title"), columns2.map((c) => /* @__PURE__ */ Spicetify.React.createElement("th", { key: c.id, className: c.numeric ? "prr-num" : void 0 }, c.id === "key" ? (
      // Click to switch notation (Musical → Camelot → Open Key)
      /* @__PURE__ */ Spicetify.React.createElement("button", { className: "prr-th-btn", title: "Click to change the key notation", onClick: cycleKeyNotation }, "Key \xB7 ", KEY_NOTATIONS.find((n) => n.id === keyNotation)?.label)
    ) : c.label)))), /* @__PURE__ */ Spicetify.React.createElement("tbody", null, range.start > 0 && /* @__PURE__ */ Spicetify.React.createElement("tr", { className: "prr-spacer", "aria-hidden": "true", style: { height: range.start * ROW_HEIGHT } }, /* @__PURE__ */ Spicetify.React.createElement("td", { colSpan: widths.length })), visible.slice(range.start, range.end).map((t) => /* @__PURE__ */ Spicetify.React.createElement(
      TrackRow,
      {
        key: t.uri,
        uri,
        track: t,
        columns: columns2,
        meta: s2.meta.get(t.uri),
        editable: s2.editable,
        added: s2.added.has(t.uri),
        adding: s2.adding.has(t.uri),
        playState: playState(now, t.uri),
        selected: t.uri === selected,
        onSelect,
        keyNotation
      }
    )), range.end < visible.length && /* @__PURE__ */ Spicetify.React.createElement("tr", { className: "prr-spacer", "aria-hidden": "true", style: { height: (visible.length - range.end) * ROW_HEIGHT } }, /* @__PURE__ */ Spicetify.React.createElement("td", { colSpan: widths.length }))))), /* @__PURE__ */ Spicetify.React.createElement("div", { className: "prr-footer" }, /* @__PURE__ */ Spicetify.React.createElement(
      "button",
      {
        className: "prr-btn prr-btn-secondary",
        disabled: s2.loading,
        onClick: () => {
          resetSession(uri);
          resetExtras(uri);
          resetDigger(uri);
          void startLoad(uri);
        }
      },
      "Restart"
    ), /* @__PURE__ */ Spicetify.React.createElement("button", { className: "prr-btn", disabled: s2.loading || s2.exhausted, onClick: () => void startLoad(uri) }, s2.loading ? "Loading\u2026" : s2.exhausted ? "No more tracks" : "Load more")));
  }

  // src/ui/openRecommender.tsx
  async function excludedArtists(uri) {
    const s2 = getSession(uri);
    const out = new Set(s2?.playlistArtistUris ?? []);
    if (s2?.filters.hideCollectionArtists) {
      await ensureLibrary(loadLibraryData);
      getLibrary().collectionArtistUris.forEach((a) => out.add(a));
    }
    return out;
  }
  function visibleWithFilters(uri, candidates) {
    const s2 = getSession(uri);
    if (!s2 || !candidates.length) return [];
    const lib = getLibrary();
    const shown = applyFilters([...s2.tracks, ...candidates], s2.filters, {
      playlistTrackUris: s2.playlistTrackUris,
      playlistArtistUris: s2.playlistArtistUris,
      collectionTrackUris: lib.collectionTrackUris,
      collectionArtistUris: lib.collectionArtistUris
    });
    const wanted = new Set(candidates.map((t) => t.uri));
    return shown.filter((t) => wanted.has(t.uri));
  }
  async function startLoad(uri) {
    const onV2Meta = (m) => {
      primeV2Meta(m);
      mergeMeta(uri, m);
    };
    try {
      warmTimbreProfile(uri, { fingerprints: getFingerprints, playlistTrackUris: [...getSession(uri)?.playlistTrackUris ?? []] });
      await ensureLibrary(loadLibraryData);
      await loadProgressive(
        uri,
        ({ append, seen }) => digMore(uri, {
          ...DIG_DEFAULTS,
          playlistTrackUris: [...getSession(uri)?.playlistTrackUris ?? []],
          fetchCandidates: (skip) => fetchMixedBatch(
            uri,
            skip,
            { playlistTrackUris: getSession(uri)?.playlistTrackUris ?? /* @__PURE__ */ new Set(), excludeArtists: () => excludedArtists(uri) },
            onV2Meta
          ),
          fingerprints: getFingerprints,
          visible: (candidates) => visibleWithFilters(uri, candidates),
          append: (tracks) => {
            const fresh = append(tracks);
            if (fresh.length) void getTrackMeta(fresh.map((t) => t.uri), (partial) => mergeMeta(uri, partial));
          },
          shownUris: seen
        })
      );
    } catch (e) {
      console.error("[crate-digger] load failed", e);
      Spicetify.showNotification("Couldn't load recommendations", true);
    }
  }
  async function readSessionInit(uri) {
    const info = await getPlaylist(uri);
    return {
      playlistUri: uri,
      playlistName: info.name,
      editable: info.editable,
      playlistTrackUris: info.trackUris,
      playlistArtistUris: info.artistUris
    };
  }
  async function openRecommender(uri) {
    void ensureLibrary(loadLibraryData);
    let session;
    try {
      const r = await ensureSession(uri, () => readSessionInit(uri), loadFilterPrefs());
      session = r.session;
      if (r.created) void startLoad(uri);
      else
        void readSessionInit(uri).then(({ playlistUri: _, ...info }) => refreshPlaylist(uri, info)).catch((e) => console.warn("[crate-digger] could not refresh playlist", e));
    } catch (e) {
      console.error("[crate-digger] could not read playlist", e);
      Spicetify.showNotification("Couldn't read the playlist", true);
      return;
    }
    Spicetify.PopupModal.display({
      title: `Crate Digger \xB7 ${session.playlistName}`,
      content: /* @__PURE__ */ Spicetify.React.createElement(RecommenderModal, { uri }),
      isLarge: true
    });
  }

  // src/ui/shortcut.ts
  function isShortcut(e) {
    return e.key === "F8" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && !e.repeat;
  }
  function registerShortcut(onTrigger) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (!isShortcut(e)) return;
        e.preventDefault();
        onTrigger();
      },
      true
    );
  }

  // src/index.tsx
  var LABEL2 = "Crate Digger";
  async function waitForSpicetify() {
    while (!globalThis.Spicetify?.Player || !Spicetify.Platform?.PlaylistAPI || !Spicetify.Platform?.History || !Spicetify.PopupModal || !Spicetify.React) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  function openForCurrentPlaylist() {
    const uri = currentPlaylistUri();
    if (!uri) {
      Spicetify.showNotification("Open a playlist first");
      return;
    }
    void openRecommender(uri);
  }
  function toggleRecommender() {
    if (document.querySelector(".prr-root")) Spicetify.PopupModal.hide();
    else openForCurrentPlaylist();
  }
  async function main() {
    await waitForSpicetify();
    registerShortcut(toggleRecommender);
    registerActionBarButton(openForCurrentPlaylist);
    if (Spicetify.ContextMenu?.Item) {
      new Spicetify.ContextMenu.Item(
        LABEL2,
        ([uri]) => void openRecommender(uri),
        (uris) => uris.length === 1 && Spicetify.URI.isPlaylistV1OrV2(uris[0])
      ).register();
    } else {
      console.warn("[crate-digger] Spicetify.ContextMenu.Item not available");
    }
  }
  main();
})();
