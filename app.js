const CONFIG = globalThis.SPOTIFY_LITE_CONFIG || {};
const CLIENT_ID = String(CONFIG.clientId || "").trim();
const REDIRECT_URI = String(CONFIG.redirectUri || "http://127.0.0.1:43821/callback");
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-recently-played",
  "user-top-read",
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "ugc-image-upload"
];

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const loginView = $("#login-view");
const appView = $("#app-view");
const results = $("#results");
let player = null;
let deviceId = null;
let localDeviceId = null;
let currentState = null;
let progressTimer = null;
let homeCollections = null;
let currentRenderedTracks = [];
let shuffleMode = localStorage.getItem("spotify_shuffle_mode") || "off";
let repeatMode = "off";
let deviceActivated = false;
let currentProfile = null;
let stateUpdatedAt = 0;
let lastPlayback = (() => { try { return JSON.parse(localStorage.getItem("spotify_last_playback") || "null"); } catch { return null; } })();
let activePlaybackQueue = lastPlayback?.queue || [];
const savedVolume = Math.max(0, Math.min(100, Number(localStorage.getItem("spotify_volume") ?? 55)));
let usageTimer = null;
let activePlaylist = null;
let pendingPlaylistCover = null;
let contextPlaylist = null;
let searchTimer = null;
let searchSequence = 0;
const playlistCache = new Map();
const SCOPE_VERSION = "5";
localStorage.removeItem("spotify_dj_history");

window.addEventListener("wheel", (event) => {
  if (event.ctrlKey) event.preventDefault();
}, { passive: false, capture: true });

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && ["+", "-", "=", "0"].includes(event.key)) event.preventDefault();
}, { capture: true });

window.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function beginLogin() {
  if (!CLIENT_ID) throw new Error("Ajoute ton Client ID Spotify dans config.js avant de te connecter.");
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  sessionStorage.setItem("spotify_verifier", verifier);
  sessionStorage.setItem("spotify_state", state);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: base64Url(await sha256(verifier)),
    state,
    scope: SCOPES.join(" ")
  });
  location.assign(`https://accounts.spotify.com/authorize?${params}`);
}

async function exchangeCode(code) {
  const verifier = sessionStorage.getItem("spotify_verifier");
  if (!verifier) throw new Error("Session de connexion expirée. Recommence la connexion.");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier })
  });
  if (!response.ok) throw new Error("Spotify a refusé la connexion.");
  saveTokens(await response.json());
  localStorage.setItem("spotify_scope_version", SCOPE_VERSION);
  sessionStorage.removeItem("spotify_verifier");
  sessionStorage.removeItem("spotify_state");
  history.replaceState({}, "", "/");
}

function saveTokens(data) {
  const previous = JSON.parse(localStorage.getItem("spotify_tokens") || "{}");
  localStorage.setItem("spotify_tokens", JSON.stringify({
    access_token: data.access_token,
    refresh_token: data.refresh_token || previous.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000 - 30_000
  }));
}

async function refreshAccessToken() {
  const tokens = JSON.parse(localStorage.getItem("spotify_tokens") || "null");
  if (!tokens?.refresh_token) return null;
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: tokens.refresh_token })
  });
  if (!response.ok) return null;
  const refreshed = await response.json();
  saveTokens(refreshed);
  return refreshed.access_token;
}

async function getToken() {
  const tokens = JSON.parse(localStorage.getItem("spotify_tokens") || "null");
  if (!tokens) return null;
  if (tokens.expires_at > Date.now()) return tokens.access_token;
  return refreshAccessToken();
}

async function spotify(path, options = {}, retry = true) {
  const token = await getToken();
  if (!token) throw new Error("Connexion expirée");
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers }
  });
  if (response.status === 401 && retry && await refreshAccessToken()) return spotify(path, options, false);
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`Erreur Spotify (${response.status})`);
  const text = await response.text();
  if (!text.trim()) return null;
  if (!response.headers.get("content-type")?.includes("application/json")) return null;
  try { return JSON.parse(text); }
  catch { return null; }
}

function formatTime(ms = 0) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function spotifyEntityId(value) {
  const raw = typeof value === "string" ? value : value?.id || value?.uri;
  if (!raw) return null;
  if (raw.includes(":")) return raw.split(":").filter(Boolean).pop();
  const match = raw.match(/open\.spotify\.com\/(?:album|artist|track|playlist)\/([^?/#]+)/);
  return match?.[1] || raw;
}

function markTrackElement(element, track) {
  if (!element || !track?.uri) return;
  element.dataset.trackUri = track.uri;
  element.classList.toggle("is-current-track", currentState?.track_window?.current_track?.uri === track.uri);
}

function updatePlayingHighlights(uri) {
  document.querySelectorAll("[data-track-uri]").forEach((element) =>
    element.classList.toggle("is-current-track", element.dataset.trackUri === uri)
  );
}

function savePlaybackSnapshot() {
  if (!currentState) return;
  const track = currentState.track_window.current_track;
  const elapsed = currentState.paused ? 0 : Date.now() - stateUpdatedAt;
  lastPlayback = {
    uri: track.uri,
    name: track.name,
    artists: track.artists.map((artist) => artist.name).join(", "),
    album: track.album.name,
    cover: track.album.images?.[0]?.url || "",
    position: Math.min(currentState.position + elapsed, currentState.duration),
    duration: currentState.duration,
    paused: currentState.paused,
    album_id: track.album?.id || track.album?.uri?.split(":").pop() || null,
    artists_data: (track.artists || []).map((artist) => ({ id: artist.id || artist.uri?.split(":").pop(), name: artist.name })),
    queue: activePlaybackQueue,
    saved_at: Date.now()
  };
  localStorage.setItem("spotify_last_playback", JSON.stringify(lastPlayback));
}

function renderPlayerArtists(artists, fallback = "Artiste inconnu") {
  const container = $("#track-artist");
  container.replaceChildren();
  const available = (artists || []).filter((artist) => artist?.name);
  if (!available.length) {
    container.textContent = fallback;
    return;
  }
  available.forEach((artist, index) => {
    if (index) container.append(document.createTextNode(", "));
    const artistId = spotifyEntityId(artist);
    if (!artistId) return container.append(document.createTextNode(artist.name));
    const link = document.createElement("button");
    link.textContent = artist.name;
    link.title = `Ouvrir la page de ${artist.name}`;
    link.addEventListener("click", () => loadArtistPage(artistId));
    container.append(link);
  });
}

function showLastPlayback() {
  if (!lastPlayback) return;
  $("#track-title").textContent = lastPlayback.name;
  renderPlayerArtists(lastPlayback.artists_data, lastPlayback.artists);
  $("#elapsed").textContent = formatTime(lastPlayback.position);
  $("#duration").textContent = formatTime(lastPlayback.duration);
  $("#progress").value = lastPlayback.duration ? lastPlayback.position / lastPlayback.duration * 100 : 0;
  $("#cover").hidden = !lastPlayback.cover;
  $("#cover-placeholder").hidden = Boolean(lastPlayback.cover);
  if (lastPlayback.cover) $("#cover").src = lastPlayback.cover;
}

async function restoreLastPlayback() {
  if (!lastPlayback?.uri || !localDeviceId) return;
  deviceId = localDeviceId;
  await player.activateElement();
  let position = lastPlayback.position || 0;
  if (position >= lastPlayback.duration - 1000) position = 0;
  const queue = lastPlayback.queue?.length ? lastPlayback.queue : [lastPlayback.uri];
  activePlaybackQueue = queue;
  await spotify(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: "PUT",
    body: JSON.stringify({ uris: queue, offset: { uri: lastPlayback.uri }, position_ms: Math.max(0, Math.floor(position)) })
  });
  await spotify(`/me/player/shuffle?state=${shuffleMode === "normal"}&device_id=${encodeURIComponent(deviceId)}`, { method: "PUT" });
  deviceActivated = true;
}

function renderTracks(tracks, emptyMessage = "Aucun morceau trouvé.") {
  $("#section-kicker").hidden = false;
  $("#section-title").hidden = false;
  $("#discovery").hidden = true;
  results.hidden = false;
  results.replaceChildren();
  currentRenderedTracks = tracks.filter((track) => track?.uri);
  if (!tracks.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = emptyMessage;
    results.append(empty);
    return;
  }
  for (const track of tracks) {
    if (!track?.uri) continue;
    const row = document.createElement("article");
    row.className = "track";
    markTrackElement(row, track);
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Lire ${track.name}`);
    const image = document.createElement("img");
    image.src = track.album?.images?.at(-1)?.url || "";
    image.alt = "";
    const artwork = document.createElement("div");
    artwork.className = "track-artwork";
    const coverPlay = document.createElement("button");
    coverPlay.className = "track-cover-play";
    coverPlay.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5v13l10-6.5z"/></svg>';
    coverPlay.title = `Lire ${track.name}`;
    coverPlay.setAttribute("aria-label", coverPlay.title);
    coverPlay.addEventListener("click", (event) => { event.stopPropagation(); playUri(track.uri); });
    artwork.append(image, coverPlay);
    const copy = document.createElement("div");
    copy.className = "track-copy";
    const title = document.createElement("button");
    title.className = "track-title-link";
    title.textContent = track.name;
    const artist = document.createElement("span");
    artist.className = "track-artist-links";
    if (track.artists?.length) track.artists.forEach((item, index) => {
      if (index) artist.append(document.createTextNode(", "));
      const link = document.createElement("button");
      link.textContent = item.name;
      link.addEventListener("click", (event) => { event.stopPropagation(); loadArtistPage(item.id); });
      artist.append(link);
    });
    else artist.textContent = "Artiste inconnu";
    title.addEventListener("click", (event) => { event.stopPropagation(); if (track.album?.id) openHomeAlbum(track.album); });
    copy.append(title, artist);
    const album = document.createElement("span");
    album.className = "album";
    album.textContent = track.album?.name || "";
    const duration = document.createElement("span");
    duration.className = "track-duration";
    duration.textContent = formatTime(track.duration_ms);
    row.append(artwork, copy, album, duration);
    const play = () => playUri(track.uri);
    row.addEventListener("click", play);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") play(); });
    results.append(row);
  }
}

function prepareList(kicker, title) {
  $("#section-kicker").textContent = kicker;
  $("#section-title").textContent = title;
  $("#discovery").hidden = true;
  results.hidden = false;
  results.className = "track-list";
  results.innerHTML = '<p class="empty-state">Chargement…</p>';
}

async function loadLikedTracks() {
  prepareList("BIBLIOTHÈQUE", "Titres likés");
  const data = await spotify("/me/tracks?limit=50");
  renderTracks((data.items || []).map((entry) => entry.item ?? entry.track).filter(Boolean), "Aucun titre liké.");
}

async function loadAlbums() {
  prepareList("BIBLIOTHÈQUE", "Albums enregistrés");
  const data = await spotify("/me/albums?limit=30");
  const albums = (data.items || []).map((entry) => entry.item ?? entry.album).filter(Boolean);
  results.replaceChildren();
  results.className = "album-grid";
  if (!albums.length) return renderTracks([], "Aucun album enregistré.");
  for (const album of albums) {
    const card = document.createElement("button");
    card.className = "album-card";
    const image = document.createElement("img");
    image.src = album.images?.[0]?.url || "";
    image.alt = "";
    const title = document.createElement("strong");
    title.textContent = album.name;
    const artist = document.createElement("span");
    artist.textContent = album.artists?.map((item) => item.name).join(", ") || "Artiste inconnu";
    card.append(image, title, artist);
    card.addEventListener("click", async () => {
      prepareList("ALBUM", album.name);
      try {
        const data = await spotify(`/albums/${album.id}/tracks?limit=50`);
        renderTracks((data.items || []).map((track) => ({ ...track, album })), "Cet album ne contient aucun titre disponible.");
      } catch (error) { renderTracks([], error.message); }
    });
    results.append(card);
  }
}

async function loadQueue() {
  prepareList("LECTURE", "File d’attente");
  const data = await spotify("/me/player/queue");
  renderTracks((data?.queue || []).filter((item) => item?.type === "track"), "La file d’attente est vide.");
}

function queueRow(track, current = false) {
  const row = document.createElement("div");
  row.className = `queue-row${current ? " current" : ""}`;
  markTrackElement(row, track);
  const image = document.createElement("img");
  image.src = track.album?.images?.at(-1)?.url || "";
  image.alt = "";
  const artwork = document.createElement("span");
  artwork.className = "ranked-track-artwork queue-track-artwork";
  const play = document.createElement("button");
  play.className = "ranked-cover-play";
  play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5v13l10-6.5z"/></svg>';
  play.title = `Lire ${track.name}`;
  play.setAttribute("aria-label", play.title);
  play.addEventListener("click", (event) => { event.stopPropagation(); playUri(track.uri); });
  artwork.append(image, play);
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = track.name;
  const artist = document.createElement("span");
  artist.textContent = track.artists?.map((item) => item.name).join(", ") || "Artiste inconnu";
  copy.append(title, artist);
  row.append(artwork, copy);
  return row;
}

function queueGroup(title, tracks, current = false) {
  const group = document.createElement("section");
  group.className = "queue-group";
  const heading = document.createElement("h3");
  heading.textContent = title;
  group.append(heading);
  tracks.forEach((track) => group.append(queueRow(track, current)));
  return group;
}

async function loadQueuePanel(mode = "queue") {
  const content = $("#queue-panel-content");
  content.innerHTML = '<p class="empty-state">Chargement…</p>';
  $("#queue-tab").classList.toggle("active", mode === "queue");
  $("#recent-tab").classList.toggle("active", mode === "recent");
  $("#queue-tab").setAttribute("aria-selected", String(mode === "queue"));
  $("#recent-tab").setAttribute("aria-selected", String(mode === "recent"));
  try {
    if (mode === "recent") {
      const data = await spotify("/me/player/recently-played?limit=30");
      const tracks = uniqueTracks((data.items || []).map((entry) => entry.track).filter(Boolean));
      content.replaceChildren(queueGroup("Écoutés récemment", tracks));
      return;
    }
    const data = await spotify("/me/player/queue");
    const current = data?.currently_playing || currentState?.track_window?.current_track;
    const upcoming = (data?.queue || []).filter((item) => item?.type === "track");
    content.replaceChildren();
    if (current) content.append(queueGroup("Titre en cours de lecture", [current], true));
    if (upcoming.length) content.append(queueGroup("À suivre", upcoming));
    if (!current && !upcoming.length) content.innerHTML = '<p class="empty-state">La file d’attente est vide.</p>';
  } catch (error) { content.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`; }
}

async function loadRecent() {
  prepareList("HISTORIQUE", "Contenu récent");
  const data = await spotify("/me/player/recently-played?limit=50");
  renderTracks((data.items || []).map((entry) => entry.track).filter(Boolean), "Aucune écoute récente.");
}

function cropImage(file, width, height, quality = 0.86, maxBytes = Infinity) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith("image/")) return reject(new Error("Choisis un fichier image."));
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const sourceWidth = width / scale;
      const sourceHeight = height / scale;
      const sourceX = (image.naturalWidth - sourceWidth) / 2;
      const sourceY = (image.naturalHeight - sourceHeight) / 2;
      canvas.getContext("2d").drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
      URL.revokeObjectURL(image.src);
      let output = canvas.toDataURL("image/jpeg", quality);
      while ((output.length - output.indexOf(",") - 1) * .75 > maxBytes && quality > .38) {
        quality -= .08;
        output = canvas.toDataURL("image/jpeg", quality);
      }
      resolve(output);
    };
    image.onerror = () => reject(new Error("Cette image ne peut pas être ouverte."));
    image.src = URL.createObjectURL(file);
  });
}

function updateHeaderAvatar(imageUrl) {
  if (!imageUrl) return;
  $("#profile-avatar").src = imageUrl;
  $("#profile-avatar").hidden = false;
  $("#profile-initials").hidden = true;
}

async function loadProfile() {
  if (!currentProfile) return;
  $("#section-kicker").hidden = true;
  $("#section-title").hidden = true;
  results.hidden = true;
  const discovery = $("#discovery");
  discovery.hidden = false;
  discovery.replaceChildren();

  const [artistsResult, tracksResult, playlistsResult] = await Promise.allSettled([
    spotify("/me/top/artists?time_range=short_term&limit=8"),
    spotify("/me/top/tracks?time_range=short_term&limit=10"),
    spotify("/me/playlists?limit=1")
  ]);
  const artists = artistsResult.status === "fulfilled" ? artistsResult.value.items || [] : [];
  const tracks = tracksResult.status === "fulfilled" ? tracksResult.value.items || [] : [];
  const playlistCount = playlistsResult.status === "fulfilled" ? playlistsResult.value.total || 0 : 0;

  const view = document.createElement("div");
  view.className = "profile-view";
  const hero = document.createElement("section");
  hero.className = "profile-hero";
  const customAvatar = localStorage.getItem("spotify_custom_avatar");
  const customBanner = localStorage.getItem("spotify_custom_banner");
  if (customBanner) hero.style.backgroundImage = `linear-gradient(180deg, rgba(10, 8, 9, .08), rgba(10, 8, 9, .72)), url("${customBanner}")`;
  const avatarUrl = customAvatar || currentProfile.images?.[0]?.url;
  const avatar = avatarUrl ? document.createElement("img") : document.createElement("div");
  if (avatarUrl) { avatar.src = avatarUrl; avatar.alt = "Photo de profil"; }
  else { avatar.className = "profile-avatar-fallback"; avatar.textContent = (currentProfile.display_name || "S").charAt(0).toLocaleUpperCase(); }
  const avatarEdit = document.createElement("button");
  avatarEdit.type = "button";
  avatarEdit.className = "profile-avatar-edit";
  avatarEdit.title = "Changer la photo de profil";
  const avatarBadge = document.createElement("span");
  avatarBadge.textContent = "Modifier";
  avatarEdit.append(avatar, avatarBadge);
  const avatarPicker = document.createElement("input");
  avatarPicker.type = "file";
  avatarPicker.accept = "image/png,image/jpeg,image/webp";
  avatarPicker.hidden = true;
  avatarEdit.addEventListener("click", () => avatarPicker.click());
  avatarPicker.addEventListener("change", async () => {
    try {
      const image = await cropImage(avatarPicker.files?.[0], 512, 512, .9);
      localStorage.setItem("spotify_custom_avatar", image);
      updateHeaderAvatar(image);
      await loadProfile();
    } catch (error) { setStatus(error.message); }
  });
  const bannerPicker = document.createElement("input");
  bannerPicker.type = "file";
  bannerPicker.accept = "image/png,image/jpeg,image/webp";
  bannerPicker.hidden = true;
  const bannerEdit = document.createElement("button");
  bannerEdit.type = "button";
  bannerEdit.className = "profile-banner-edit";
  bannerEdit.textContent = "Changer la bannière";
  bannerEdit.addEventListener("click", () => bannerPicker.click());
  bannerPicker.addEventListener("change", async () => {
    try {
      const image = await cropImage(bannerPicker.files?.[0], 1600, 560, .84);
      localStorage.setItem("spotify_custom_banner", image);
      await loadProfile();
    } catch (error) { setStatus(error.message); }
  });
  const heroCopy = document.createElement("div");
  heroCopy.className = "profile-hero-copy";
  const label = document.createElement("p");
  label.textContent = "Profil";
  const name = document.createElement("h1");
  name.textContent = currentProfile.display_name || "Compte Spotify";
  const stats = document.createElement("span");
  stats.textContent = `${playlistCount} playlist${playlistCount > 1 ? "s" : ""} accessible${playlistCount > 1 ? "s" : ""}`;
  heroCopy.append(label, name, stats);
  hero.append(avatarEdit, heroCopy, bannerEdit, avatarPicker, bannerPicker);

  const artistSection = document.createElement("section");
  artistSection.className = "profile-section";
  const artistTitle = document.createElement("h2");
  artistTitle.textContent = "Top artistes du mois";
  const artistNote = document.createElement("p");
  artistNote.textContent = "Visible uniquement par vous";
  const artistGrid = document.createElement("div");
  artistGrid.className = "artist-grid";
  for (const artist of artists) {
    const card = document.createElement("button");
    card.className = "artist-card";
    const imageUrl = artist.images?.[0]?.url;
    const image = imageUrl ? document.createElement("img") : document.createElement("div");
    if (imageUrl) { image.src = imageUrl; image.alt = ""; }
    else { image.className = "artist-image-fallback"; image.textContent = artist.name.charAt(0); }
    const artistName = document.createElement("strong");
    artistName.textContent = artist.name;
    const type = document.createElement("span");
    type.textContent = "Artiste";
    card.append(image, artistName, type);
    card.addEventListener("click", () => loadArtistPage(artist.id));
    artistGrid.append(card);
  }
  artistSection.append(artistTitle, artistNote, artistGrid);

  const tracksSection = document.createElement("section");
  tracksSection.className = "profile-section";
  const tracksTitle = document.createElement("h2");
  tracksTitle.textContent = "Top titres du mois";
  const tracksNote = document.createElement("p");
  tracksNote.textContent = "Visible uniquement par vous";
  const trackList = document.createElement("div");
  trackList.className = "profile-tracks";
  tracks.forEach((track, index) => {
    const row = document.createElement("div");
    row.className = "profile-track";
    markTrackElement(row, track);
    const rank = document.createElement("span");
    rank.textContent = String(index + 1);
    const cover = document.createElement("img");
    cover.src = track.album?.images?.at(-1)?.url || "";
    cover.alt = "";
    const artwork = document.createElement("span");
    artwork.className = "ranked-track-artwork";
    const coverPlay = document.createElement("button");
    coverPlay.className = "ranked-cover-play";
    coverPlay.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5v13l10-6.5z"/></svg>';
    coverPlay.title = `Lire ${track.name}`;
    coverPlay.setAttribute("aria-label", coverPlay.title);
    coverPlay.addEventListener("click", (event) => { event.stopPropagation(); playUri(track.uri); });
    artwork.append(cover, coverPlay);
    const copy = document.createElement("div");
    copy.className = "track-copy";
    const title = document.createElement("button");
    title.className = "track-title-link";
    title.textContent = track.name;
    const artist = document.createElement("span");
    artist.className = "track-artist-links";
    track.artists.forEach((item, index) => {
      if (index) artist.append(document.createTextNode(", "));
      const link = document.createElement("button");
      link.textContent = item.name;
      link.addEventListener("click", () => loadArtistPage(item.id));
      artist.append(link);
    });
    title.addEventListener("click", () => track.album?.id && openHomeAlbum(track.album));
    copy.append(title, artist);
    row.append(rank, artwork, copy);
    trackList.append(row);
  });
  tracksSection.append(tracksTitle, tracksNote, trackList);
  view.append(hero, artistSection, tracksSection);
  discovery.append(view);
}

function artistTrackRow(track, index) {
  const row = document.createElement("div");
  row.className = "artist-track-row";
  markTrackElement(row, track);
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const rank = document.createElement("span");
  rank.textContent = String(index + 1);
  const cover = document.createElement("img");
  cover.src = track.album?.images?.at(-1)?.url || track.album?.images?.[0]?.url || "";
  cover.alt = "";
  const artwork = document.createElement("span");
  artwork.className = "ranked-track-artwork";
  const coverPlay = document.createElement("button");
  coverPlay.className = "ranked-cover-play";
  coverPlay.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5v13l10-6.5z"/></svg>';
  coverPlay.title = `Lire ${track.name}`;
  coverPlay.setAttribute("aria-label", coverPlay.title);
  coverPlay.addEventListener("click", (event) => { event.stopPropagation(); playUri(track.uri); });
  artwork.append(cover, coverPlay);
  const copy = document.createElement("span");
  const title = document.createElement("button");
  title.className = "track-title-link";
  title.textContent = track.name;
  const details = document.createElement("small");
  details.className = "track-artist-links";
  if (track.artists?.length) track.artists.forEach((item, artistIndex) => {
    if (artistIndex) details.append(document.createTextNode(", "));
    const link = document.createElement("button");
    link.textContent = item.name;
    link.addEventListener("click", (event) => { event.stopPropagation(); loadArtistPage(item.id); });
    details.append(link);
  });
  title.addEventListener("click", (event) => { event.stopPropagation(); if (track.album?.id) openHomeAlbum(track.album); });
  copy.append(title, details);
  const duration = document.createElement("span");
  duration.textContent = formatTime(track.duration_ms);
  row.append(rank, artwork, copy, duration);
  row.addEventListener("click", () => playUri(track.uri));
  row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") playUri(track.uri); });
  return row;
}

function addedDateLabel(value) {
  if (!value) return "—";
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000));
  if (days === 0) return "aujourd’hui";
  if (days === 1) return "hier";
  if (days < 7) return `il y a ${days} jours`;
  if (days < 35) { const weeks = Math.floor(days / 7); return `il y a ${weeks} semaine${weeks > 1 ? "s" : ""}`; }
  if (days < 365) { const months = Math.floor(days / 30); return `il y a ${months} mois`; }
  const years = Math.floor(days / 365);
  return `il y a ${years} an${years > 1 ? "s" : ""}`;
}

function playlistTrackRow(entry, index) {
  const track = entry.item ?? entry.track;
  const row = document.createElement("div");
  row.className = "playlist-entry-row";
  markTrackElement(row, track);
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const rank = document.createElement("span");
  rank.textContent = String(index + 1);
  const titleCell = document.createElement("span");
  titleCell.className = "playlist-entry-title";
  const cover = document.createElement("img");
  cover.src = track.album?.images?.at(-1)?.url || track.album?.images?.[0]?.url || "";
  cover.alt = "";
  const artwork = document.createElement("span");
  artwork.className = "ranked-track-artwork playlist-track-artwork";
  const coverPlay = document.createElement("button");
  coverPlay.className = "ranked-cover-play";
  coverPlay.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5v13l10-6.5z"/></svg>';
  coverPlay.title = `Lire ${track.name}`;
  coverPlay.setAttribute("aria-label", coverPlay.title);
  coverPlay.addEventListener("click", (event) => { event.stopPropagation(); playUri(track.uri); });
  artwork.append(cover, coverPlay);
  const copy = document.createElement("span");
  const title = document.createElement("button");
  title.className = "track-title-link";
  title.textContent = track.name;
  title.addEventListener("click", (event) => { event.stopPropagation(); if (track.album?.id) openHomeAlbum(track.album); });
  const artists = document.createElement("small");
  artists.className = "track-artist-links";
  (track.artists || []).forEach((artist, artistIndex) => {
    if (artistIndex) artists.append(document.createTextNode(", "));
    const link = document.createElement("button");
    link.textContent = artist.name;
    link.addEventListener("click", (event) => { event.stopPropagation(); loadArtistPage(artist.id); });
    artists.append(link);
  });
  copy.append(title, artists);
  titleCell.append(artwork, copy);
  const album = document.createElement("button");
  album.className = "playlist-entry-album";
  album.textContent = track.album?.name || "—";
  album.addEventListener("click", (event) => { event.stopPropagation(); if (track.album?.id) openHomeAlbum(track.album); });
  const added = document.createElement("span");
  added.className = "playlist-entry-added";
  added.textContent = addedDateLabel(entry.added_at);
  added.title = entry.added_at ? new Date(entry.added_at).toLocaleDateString("fr-FR") : "Date indisponible";
  const duration = document.createElement("span");
  duration.className = "playlist-entry-duration";
  duration.textContent = formatTime(track.duration_ms);
  row.append(rank, titleCell, album, added, duration);
  row.addEventListener("click", () => playUri(track.uri));
  row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") playUri(track.uri); });
  return row;
}

async function loadArtistPage(artistId, pushHistory = true) {
  artistId = spotifyEntityId(artistId);
  if (!artistId) return;
  if (pushHistory) history.pushState({ view: "artist", artistId }, "", `#artist-${artistId}`);
  $("#section-kicker").hidden = true;
  $("#section-title").hidden = true;
  results.hidden = true;
  const discovery = $("#discovery");
  discovery.hidden = false;
  discovery.innerHTML = '<p class="empty-state">Chargement de l’artiste…</p>';
  try {
    let artist = await spotify(`/artists/${encodeURIComponent(artistId)}`);
    if (!artist.images?.[0]?.url) {
      const artistSearch = await spotify(`/search?type=artist&limit=10&q=${encodeURIComponent(artist.name)}`).catch(() => ({ artists: { items: [] } }));
      const catalogArtist = (artistSearch.artists?.items || []).find((item) => item?.id === artist.id)
        || (artistSearch.artists?.items || []).find((item) => item?.name?.toLocaleLowerCase() === artist.name.toLocaleLowerCase());
      if (catalogArtist?.images?.length) artist = { ...artist, images: catalogArtist.images };
    }
    const [albumsResult, tracksResult, likedResult, relatedResult, playlistsResult] = await Promise.all([
      collectSpotifyPages(`/artists/${encodeURIComponent(artistId)}/albums?include_groups=album,single&limit=10`).catch(() => ({ items: [] })),
      spotify(`/search?type=track&limit=10&q=${encodeURIComponent(`artist:${artist.name}`)}`).catch(() => ({ tracks: { items: [] } })),
      spotify("/me/tracks?limit=50").catch(() => ({ items: [] })),
      spotify(`/artists/${encodeURIComponent(artistId)}/related-artists`).catch(() => ({ artists: [] })),
      spotify(`/search?type=playlist&limit=10&q=${encodeURIComponent(artist.name)}`).catch(() => ({ playlists: { items: [] } }))
    ]);
    const tracks = (tracksResult.tracks?.items || []).filter((track) => track?.uri && track.artists?.some((item) => item.id === artist.id));
    let albums = uniqueAlbums([
      ...(albumsResult.items || []).filter(Boolean),
      ...tracks.map((track) => track.album).filter(Boolean)
    ]);
    if (!(albumsResult.items || []).length) {
      let searchAlbums = await collectSpotifyPages(
        `/search?type=album&limit=10&q=${encodeURIComponent(`artist:"${artist.name}"`)}`,
        (data) => data.albums
      ).catch(() => ({ items: [] }));
      if (!searchAlbums.items.length) {
        searchAlbums = await collectSpotifyPages(
          `/search?type=album&limit=10&q=${encodeURIComponent(artist.name)}`,
          (data) => data.albums,
          8
        ).catch(() => ({ items: [] }));
      }
      albums = uniqueAlbums([
        ...albums,
        ...(searchAlbums.items || []).filter((album) =>
          album?.artists?.some((item) => item.id === artist.id || item.name?.toLocaleLowerCase() === artist.name.toLocaleLowerCase())
        )
      ]);
    }
    const likedTracks = (likedResult.items || []).map((entry) => entry.track).filter((track) => track?.artists?.some((item) => item.id === artist.id));
    let relatedArtists = (relatedResult.artists || []).filter(Boolean).slice(0, 8);
    if (!relatedArtists.length && artist.genres?.[0]) {
      const genreResult = await spotify(`/search?type=artist&limit=12&q=${encodeURIComponent(`genre:${artist.genres[0]}`)}`).catch(() => ({ artists: { items: [] } }));
      relatedArtists = (genreResult.artists?.items || []).filter((item) => item?.id && item.id !== artist.id).slice(0, 8);
    }
    if (!relatedArtists.length) {
      const personalArtists = await spotify("/me/top/artists?time_range=medium_term&limit=20").catch(() => ({ items: [] }));
      relatedArtists = (personalArtists.items || []).filter((item) => item?.id && item.id !== artist.id).slice(0, 8);
    }
    const artistPlaylists = (playlistsResult.playlists?.items || []).filter(Boolean).slice(0, 8);
    currentRenderedTracks = tracks;

    const page = document.createElement("div");
    page.className = "artist-page";
    const hero = document.createElement("section");
    hero.className = "artist-page-hero";
    const heroImages = [...new Set([
      ...(artist.images || []).map((image) => image.url),
      ...tracks.flatMap((track) => (track.album?.images || []).map((image) => image.url))
    ].filter(Boolean))];
    if (heroImages.length) {
      const heroArtwork = document.createElement("img");
      heroArtwork.className = "artist-page-hero-image";
      heroArtwork.alt = "";
      let heroImageIndex = 0;
      heroArtwork.src = heroImages[heroImageIndex];
      heroArtwork.addEventListener("error", () => {
        heroImageIndex += 1;
        if (heroImages[heroImageIndex]) heroArtwork.src = heroImages[heroImageIndex];
        else heroArtwork.remove();
      });
      hero.append(heroArtwork);
    }
    const heroCopy = document.createElement("div");
    heroCopy.className = "artist-page-copy";
    const verified = document.createElement("span");
    verified.textContent = "● ARTISTE SPOTIFY";
    const name = document.createElement("h1");
    name.textContent = artist.name;
    const genres = document.createElement("p");
    genres.textContent = artist.genres?.slice(0, 3).join(" · ") || "Découvre ses titres et ses albums";
    const actions = document.createElement("div");
    const play = document.createElement("button");
    play.className = "artist-main-play";
    play.textContent = "▶";
    play.title = `Lire ${artist.name}`;
    play.addEventListener("click", () => tracks.length && playTrackList(tracks));
    const shuffleArtist = document.createElement("button");
    shuffleArtist.className = "artist-shuffle-play";
    shuffleArtist.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 3.5h4v4M20.2 3.8l-5.1 5.1c-1.1 1.1-2.1 1.6-3.6 1.6H9.8M3.5 6.5h2.2c1.4 0 2.4.5 3.5 1.5l5.9 7.1c1.1 1.1 2.1 1.5 3.6 1.5h1.8M16.5 12.5l4 4-4 4M3.5 17.5h2.2c1.5 0 2.5-.5 3.6-1.6l1-1"/></svg>';
    shuffleArtist.title = `Écouter ${artist.name} en aléatoire`;
    shuffleArtist.setAttribute("aria-label", shuffleArtist.title);
    shuffleArtist.addEventListener("click", () => tracks.length && playTrackList(shuffled(tracks)));
    actions.append(play, shuffleArtist);
    heroCopy.append(verified, name, genres);
    heroCopy.append(actions);
    hero.append(heroCopy);

    const popular = document.createElement("section");
    popular.className = "artist-page-section";
    popular.innerHTML = "<h2>Titres populaires</h2>";
    const trackList = document.createElement("div");
    trackList.className = "artist-page-tracks";
    tracks.forEach((track, index) => trackList.append(artistTrackRow(track, index)));
    if (!tracks.length) trackList.innerHTML = '<p class="empty-state">Aucun titre disponible.</p>';
    popular.append(trackList);

    const popularLayout = document.createElement("div");
    popularLayout.className = "artist-popular-layout";
    popularLayout.append(popular);
    if (likedTracks.length) {
      const liked = document.createElement("aside");
      liked.className = "artist-liked-card";
      const likedTitle = document.createElement("h2");
      likedTitle.textContent = "Vous avez liké";
      const likedCover = document.createElement("img");
      likedCover.src = likedTracks[0].album?.images?.[0]?.url || artist.images?.[0]?.url || "";
      likedCover.alt = "";
      const likedCopy = document.createElement("div");
      const likedCount = document.createElement("strong");
      likedCount.textContent = `${likedTracks.length} titre${likedTracks.length > 1 ? "s" : ""}`;
      const likedBy = document.createElement("span");
      likedBy.textContent = `Par ${artist.name}`;
      likedCopy.append(likedCount, likedBy);
      liked.append(likedTitle, likedCover, likedCopy);
      liked.addEventListener("click", () => playTrackList(likedTracks));
      popularLayout.append(liked);
    }
    page.append(hero, popularLayout);

    if (albums.length) {
      const discography = document.createElement("section");
      discography.className = "artist-page-section artist-discography";
      const discographyTitle = document.createElement("h2");
      discographyTitle.textContent = "Discographie";
      const filters = document.createElement("div");
      filters.className = "artist-discography-filters";
      const albumRow = document.createElement("div");
      albumRow.className = "home-card-row";
      const renderAlbums = (mode) => {
        const visible = mode === "all" ? albums : albums.filter((album) => mode === "album" ? (album.album_group || album.album_type) === "album" : (album.album_group || album.album_type) !== "album");
        albumRow.replaceChildren(...visible.map((album) => homeMediaCard(album.name, `${album.release_date?.slice(0, 4) || ""} · ${(album.album_group || album.album_type) === "album" ? "Album" : "Single"}`, album.images?.[0]?.url, () => openHomeAlbum(album))));
        filters.querySelectorAll("button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
      };
      [["all", "Sorties populaires"], ["album", "Albums"], ["single", "Singles et EP"]].forEach(([mode, label]) => {
        const button = document.createElement("button");
        button.dataset.mode = mode;
        button.textContent = label;
        button.addEventListener("click", () => renderAlbums(mode));
        filters.append(button);
      });
      discography.append(discographyTitle, filters, albumRow);
      page.append(discography);
      renderAlbums("all");
    }
    if (artistPlaylists.length) page.append(homeShelf(`Avec ${artist.name}`, "", artistPlaylists.map((playlist) => homeMediaCard(playlist.name, playlist.owner?.display_name || "Playlist", playlist.images?.[0]?.url, () => openHomePlaylist(playlist)))));
    if (relatedArtists.length) {
      const related = document.createElement("section");
      related.className = "artist-page-section";
      related.innerHTML = "<h2>Tu pourrais aussi aimer</h2>";
      const grid = document.createElement("div");
      grid.className = "artist-grid";
      relatedArtists.forEach((item) => {
        const card = document.createElement("button");
        card.className = "artist-card";
        const image = item.images?.[0]?.url ? document.createElement("img") : document.createElement("div");
        if (item.images?.[0]?.url) { image.src = item.images[0].url; image.alt = ""; } else { image.className = "artist-image-fallback"; image.textContent = item.name.charAt(0); }
        const label = document.createElement("strong"); label.textContent = item.name;
        const type = document.createElement("span"); type.textContent = "Artiste";
        card.append(image, label, type);
        card.addEventListener("click", () => loadArtistPage(item.id));
        grid.append(card);
      });
      related.append(grid);
      page.append(related);
    }
    discovery.replaceChildren(page);
  } catch (error) {
    discovery.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  }
}

function uniqueAlbums(albums) {
  const seen = new Set();
  return albums.filter((album) => album?.id && !seen.has(album.id) && seen.add(album.id));
}

function uniqueTracks(...groups) {
  const seen = new Set();
  return groups.flat().filter((track) => track?.uri && !seen.has(track.uri) && seen.add(track.uri));
}

async function collectSpotifyPages(path, getPage = (data) => data, maxPages = 20) {
  const items = [];
  let nextPath = path;
  for (let pageIndex = 0; nextPath && pageIndex < maxPages; pageIndex += 1) {
    const data = await spotify(nextPath);
    const page = getPage(data) || {};
    items.push(...(page.items || []).filter(Boolean));
    if (!page.next) break;
    const nextUrl = new URL(page.next);
    nextPath = `${nextUrl.pathname.replace(/^\/v1/, "")}${nextUrl.search}`;
  }
  return { items };
}

function scoreFavorites(topTracks, recentTracks, savedTracks) {
  const scores = new Map();
  const tracks = new Map();
  const add = (track, score) => {
    if (!track?.uri) return;
    tracks.set(track.uri, track);
    scores.set(track.uri, (scores.get(track.uri) || 0) + score);
  };
  topTracks.forEach((track, index) => add(track, 80 - index));
  recentTracks.forEach((track, index) => add(track, 55 - Math.floor(index / 2)));
  savedTracks.forEach((track, index) => add(track, 35 - Math.floor(index / 4)));
  return [...tracks.values()].sort((a, b) => scores.get(b.uri) - scores.get(a.uri)).slice(0, 30);
}

async function getHomeCollections() {
  if (homeCollections) return homeCollections;
  const responses = await Promise.allSettled([
    spotify("/me/top/tracks?time_range=short_term&limit=50"),
    spotify("/me/player/recently-played?limit=50"),
    spotify("/me/tracks?limit=50")
  ]);
  const [top, recent, saved] = responses.map((response) => response.status === "fulfilled" ? response.value : { items: [] });
  const topTracks = top.items || [];
  const recentTracks = (recent.items || []).map((entry) => entry.track).filter(Boolean);
  const savedTracks = (saved.items || []).map((entry) => entry.track).filter(Boolean);
  const recentUris = new Set(recentTracks.slice(0, 25).map((track) => track.uri));
  const replay = uniqueTracks(savedTracks.filter((track) => !recentUris.has(track.uri)), topTracks.slice(20), recentTracks.slice(25));
  const pool = uniqueTracks(savedTracks, topTracks, recentTracks);
  const automatic = pool.filter((_, index) => index % 3 === 0).concat(pool.filter((_, index) => index % 3 === 1)).slice(0, 40);
  homeCollections = { favorites: scoreFavorites(topTracks, recentTracks, savedTracks), replay, automatic, pool, recent: uniqueTracks(recentTracks).slice(0, 16) };
  return homeCollections;
}



function openCollection(title, tracks) {
  prepareList("POUR TOI", title);
  currentRenderedTracks = uniqueTracks(tracks);
  renderTracks(currentRenderedTracks);
}

function homeArtwork(url) {
  if (url) {
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    image.loading = "lazy";
    return image;
  }
  const fallback = document.createElement("div");
  fallback.className = "home-image-fallback";
  return fallback;
}

function homeQuick(title, imageUrl, action) {
  const button = document.createElement("button");
  button.className = "home-quick";
  const label = document.createElement("strong");
  label.textContent = title;
  button.append(homeArtwork(imageUrl), label);
  button.addEventListener("click", action);
  return button;
}

function homeMediaCard(title, subtitle, imageUrl, action) {
  const button = document.createElement("button");
  button.className = "home-media-card";
  const label = document.createElement("strong");
  label.textContent = title;
  const note = document.createElement("span");
  note.textContent = subtitle;
  button.append(homeArtwork(imageUrl), label, note);
  button.addEventListener("click", action);
  return button;
}

function homeTrackCard(track) {
  const card = document.createElement("article");
  card.className = "home-media-card home-track-card";
  markTrackElement(card, track);
  const artwork = document.createElement("div");
  artwork.className = "home-track-artwork";
  const cover = document.createElement("button");
  cover.className = "home-track-cover";
  cover.title = `Ouvrir l’album ${track.album?.name || ""}`;
  cover.append(homeArtwork(track.album?.images?.[0]?.url));
  cover.addEventListener("click", () => track.album && openHomeAlbum(track.album));
  const play = document.createElement("button");
  play.className = "home-track-play";
  play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5v13l10-6.5z"/></svg>';
  play.title = `Lire ${track.name}`;
  play.setAttribute("aria-label", play.title);
  play.addEventListener("click", () => playUri(track.uri));
  artwork.append(cover, play);
  const title = document.createElement("button");
  title.className = "home-track-title";
  title.textContent = track.name;
  title.addEventListener("click", () => track.album && openHomeAlbum(track.album));
  const artists = document.createElement("span");
  artists.className = "home-track-artists";
  (track.artists || []).forEach((artist, index) => {
    if (index) artists.append(document.createTextNode(", "));
    const link = document.createElement("button");
    link.textContent = artist.name;
    link.addEventListener("click", () => loadArtistPage(artist.id));
    artists.append(link);
  });
  card.append(artwork, title, artists);
  return card;
}

function homeShelf(title, subtitle, cards) {
  const section = document.createElement("section");
  section.className = "home-shelf";
  const head = document.createElement("div");
  head.className = "home-shelf-head";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const note = document.createElement("span");
  note.textContent = subtitle;
  head.append(heading, note);
  const row = document.createElement("div");
  row.className = "home-card-row";
  cards.forEach((card) => row.append(card));
  section.append(head, row);
  return section;
}

async function openHomePlaylist(playlist) {
  if (!playlist?.id) return;
  playlistCache.set(playlist.id, playlist);
  await loadPlaylistPage(playlist.id, true, playlist);
}

async function loadPlaylistPage(playlistId, pushHistory = true, playlistSeed = null) {
  $("#section-kicker").hidden = true;
  $("#section-title").hidden = true;
  results.hidden = true;
  const discovery = $("#discovery");
  discovery.hidden = false;
  discovery.innerHTML = '<p class="empty-state">Chargement de la playlist…</p>';
  try {
    const cachedPlaylist = playlistSeed || playlistCache.get(playlistId) || null;
    const [playlistResult, itemsResult] = await Promise.allSettled([
      spotify(`/playlists/${encodeURIComponent(playlistId)}`),
      spotify(`/playlists/${encodeURIComponent(playlistId)}/items?limit=50`)
    ]);
    const playlist = playlistResult.status === "fulfilled" ? playlistResult.value : cachedPlaylist;
    if (!playlist) throw playlistResult.reason || new Error("Cette playlist n'est pas accessible.");
    playlistCache.set(playlistId, playlist);
    let itemsData = itemsResult.status === "fulfilled" ? itemsResult.value : null;
    if (!itemsData) {
      try { itemsData = await spotify(`/playlists/${encodeURIComponent(playlistId)}/tracks?limit=50`); }
      catch { itemsData = { items: [] }; }
    }
    const entrySources = [itemsData?.items, playlist?.tracks?.items, playlist?.items?.items];
    const entries = entrySources.find((items) => Array.isArray(items) && items.length) || [];
    const tracks = entries.map((entry) => entry.item ?? entry.track).filter((item) => item?.type === "track" && item.uri);
    activePlaylist = playlist;
    currentRenderedTracks = tracks;
    if (pushHistory) history.pushState({ view: "playlist", playlistId }, "", `#playlist-${playlistId}`);

    const page = document.createElement("div");
    page.className = "playlist-page";
    const hero = document.createElement("section");
    hero.className = "playlist-page-hero";
    const coverUrl = playlist.images?.[0]?.url || tracks[0]?.album?.images?.[0]?.url;
    const cover = coverUrl ? document.createElement("img") : document.createElement("div");
    if (coverUrl) { cover.src = coverUrl; cover.alt = "Pochette de la playlist"; }
    else cover.className = "playlist-page-cover-fallback";
    const copy = document.createElement("div");
    copy.className = "playlist-page-copy";
    const type = document.createElement("span");
    type.textContent = playlist.public ? "Playlist publique" : "Playlist privée";
    const title = document.createElement("h1");
    title.textContent = playlist.name;
    const description = document.createElement("p");
    description.textContent = playlist.description || "";
    const stats = document.createElement("strong");
    const minutes = Math.round(tracks.reduce((sum, track) => sum + (track.duration_ms || 0), 0) / 60000);
    const totalTracks = playlist.items?.total ?? playlist.tracks?.total ?? tracks.length;
    stats.textContent = `${playlist.owner?.display_name || currentProfile?.display_name || "Spotify"} · ${totalTracks} titre${totalTracks > 1 ? "s" : ""}${minutes ? ` · ${minutes} min` : ""}`;
    copy.append(type, title, description, stats);
    hero.append(cover, copy);

    const controls = document.createElement("div");
    controls.className = "playlist-page-controls";
    const play = document.createElement("button");
    play.className = "playlist-page-play";
    play.textContent = "▶";
    play.title = "Lire la playlist";
    play.addEventListener("click", () => tracks.length ? playTrackList(tracks) : playSpotifyContext(playlist.uri || `spotify:playlist:${playlistId}`));
    const shuffle = document.createElement("button");
    shuffle.className = "playlist-page-icon";
    shuffle.textContent = "⤨";
    shuffle.title = "Lecture aléatoire";
    shuffle.addEventListener("click", () => tracks.length ? playTrackList(shuffled(tracks)) : playSpotifyContext(playlist.uri || `spotify:playlist:${playlistId}`, true));
    controls.append(play, shuffle);
    const isOwner = playlist.owner?.id === currentProfile?.id || playlist.owner?.account_id === currentProfile?.account_id;
    const more = document.createElement("button");
    more.className = "playlist-more-button";
    more.textContent = "•••";
    more.title = "Options de la playlist";
    more.setAttribute("aria-label", "Options de la playlist");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = more.getBoundingClientRect();
      openPlaylistContextMenu({
        preventDefault() {},
        stopPropagation() {},
        clientX: rect.right,
        clientY: rect.bottom + 5
      }, playlist);
    });
    controls.append(more);

    const tools = document.createElement("div");
    tools.className = "playlist-tools";
    if (isOwner) {
      const add = document.createElement("button");
      add.className = "playlist-tool-button";
      add.textContent = "＋ Ajouter";
      add.addEventListener("click", () => {
        activePlaylist = playlist;
        $("#add-playlist-track-results").replaceChildren();
        $("#add-playlist-track-dialog").showModal();
        setTimeout(() => $("#add-playlist-track-query").focus(), 40);
      });
      const edit = document.createElement("button");
      edit.className = "playlist-tool-button";
      edit.textContent = "✎ Nom et informations";
      edit.addEventListener("click", () => openPlaylistEditor(playlist));
      tools.append(add, edit);
    }
    const mix = document.createElement("button");
    mix.className = "playlist-tool-button";
    mix.textContent = "↭ Mixer";
    mix.addEventListener("click", () => tracks.length && playTrackList(shuffled(tracks)));
    tools.append(mix);

    const listTools = document.createElement("div");
    listTools.className = "playlist-list-tools";
    const filter = document.createElement("input");
    filter.className = "playlist-filter-input";
    filter.placeholder = "Rechercher dans la playlist";
    const sort = document.createElement("button");
    sort.className = "playlist-sort-button";
    sort.textContent = "Tri personnalisé  ☷";
    const sortMenu = document.createElement("div");
    sortMenu.className = "playlist-sort-menu";
    sortMenu.hidden = true;
    const list = document.createElement("section");
    list.className = "playlist-page-list";
    let sortMode = "custom";
    let compact = false;
    const renderPlaylistList = () => {
      const query = filter.value.trim().toLocaleLowerCase();
      let visible = entries.filter((entry) => {
        const track = entry.item ?? entry.track;
        return track?.type === "track" && (!query || `${track.name} ${track.album?.name || ""} ${track.artists?.map((item) => item.name).join(" ") || ""}`.toLocaleLowerCase().includes(query));
      });
      const value = (entry) => entry.item ?? entry.track;
      if (sortMode === "title") visible.sort((a, b) => value(a).name.localeCompare(value(b).name));
      if (sortMode === "artist") visible.sort((a, b) => (value(a).artists?.[0]?.name || "").localeCompare(value(b).artists?.[0]?.name || ""));
      if (sortMode === "album") visible.sort((a, b) => (value(a).album?.name || "").localeCompare(value(b).album?.name || ""));
      if (sortMode === "recent") visible.sort((a, b) => String(b.added_at || "").localeCompare(String(a.added_at || "")));
      if (sortMode === "duration") visible.sort((a, b) => (value(a).duration_ms || 0) - (value(b).duration_ms || 0));
      list.classList.toggle("compact", compact);
      list.innerHTML = '<div class="playlist-table-head"><span>#</span><span>Titre</span><span>Album</span><span>Date d’ajout</span><span>Durée</span></div>';
      visible.forEach((entry, index) => list.append(playlistTrackRow(entry, index)));
      if (!visible.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state playlist-protected-note";
        empty.textContent = entries.length ? "Aucun titre ne correspond à ce filtre." : "Spotify protège le détail de cette playlist, mais tu peux quand même la lancer avec les boutons ci-dessus.";
        list.append(empty);
      }
    };
    const sortChoices = [["custom", "Tri personnalisé"], ["title", "Titre"], ["artist", "Artiste"], ["album", "Album"], ["recent", "Ajoutés récemment"], ["duration", "Durée"]];
    sortChoices.forEach(([value, label]) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => { sortMode = value; sort.textContent = `${label}  ☷`; sortMenu.hidden = true; renderPlaylistList(); });
      sortMenu.append(button);
    });
    sortMenu.append(contextSeparator());
    [[false, "☷  Liste"], [true, "☰  Compact"]].forEach(([value, label]) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => { compact = value; sortMenu.hidden = true; renderPlaylistList(); });
      sortMenu.append(button);
    });
    filter.addEventListener("input", renderPlaylistList);
    sort.addEventListener("click", () => { sortMenu.hidden = !sortMenu.hidden; });
    listTools.append(filter, sort, sortMenu);
    tools.append(listTools);
    renderPlaylistList();
    page.append(hero, controls, tools, list);
    discovery.replaceChildren(page);
  } catch (error) {
    discovery.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  }
}

function openPlaylistEditor(playlist) {
  activePlaylist = playlist;
  pendingPlaylistCover = null;
  $("#edit-playlist-name").value = playlist.name || "";
  $("#edit-playlist-description").value = playlist.description || "";
  $("#edit-playlist-public").checked = Boolean(playlist.public);
  $("#edit-playlist-cover-preview").src = playlist.images?.[0]?.url || "/assets/spotify-lite-512.png";
  $("#edit-playlist-error").textContent = "";
  $("#edit-playlist-dialog").showModal();
}

async function loadSidebarLibrary() {
  const container = $("#sidebar-playlists");
  container.innerHTML = "<p>Chargement…</p>";
  const data = await spotify("/me/playlists?limit=40");
  const pinned = new Set(JSON.parse(localStorage.getItem("spotify_pinned_playlists") || "[]"));
  const playlists = (data.items || []).filter(Boolean).sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
  container.replaceChildren();

  const liked = document.createElement("button");
  liked.className = "sidebar-playlist";
  const likedCover = document.createElement("div");
  likedCover.className = "sidebar-playlist-fallback liked-tracks-cover";
  likedCover.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5S3.5 15.4 3.5 8.8A4.3 4.3 0 0 1 12 7.7a4.3 4.3 0 0 1 8.5 1.1c0 6.6-8.5 11.7-8.5 11.7z"/></svg>';
  const likedCopy = document.createElement("span");
  likedCopy.innerHTML = `<strong>Titres likés</strong><small>Playlist · ${escapeHtml(currentProfile?.display_name || "Spotify")}</small>`;
  liked.append(likedCover, likedCopy);
  liked.addEventListener("click", loadLikedTracks);
  container.append(liked);

  for (const playlist of playlists) {
    const button = document.createElement("button");
    button.className = "sidebar-playlist";
    button.dataset.libraryName = playlist.name.toLocaleLowerCase();
    const imageUrl = playlist.images?.[0]?.url;
    const image = imageUrl ? document.createElement("img") : document.createElement("div");
    if (imageUrl) { image.src = imageUrl; image.alt = ""; }
    else image.className = "sidebar-playlist-fallback";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = playlist.name;
    const details = document.createElement("small");
    details.textContent = `Playlist · ${playlist.owner?.display_name || currentProfile?.display_name || "Spotify"}`;
    copy.append(title, details);
    button.append(image, copy);
    button.addEventListener("click", () => openHomePlaylist(playlist));
    button.addEventListener("contextmenu", (event) => openPlaylistContextMenu(event, playlist));
    container.append(button);
  }
}

function contextAction(icon, label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  const symbol = document.createElement("span");
  symbol.textContent = icon;
  const text = document.createElement("span");
  text.textContent = label;
  button.append(symbol, text);
  button.addEventListener("click", async () => {
    closePlaylistContextMenu();
    try { await action(); } catch (error) { setStatus(error.message); }
  });
  return button;
}

function contextSeparator() {
  return document.createElement("hr");
}

function closePlaylistContextMenu() {
  $("#playlist-context-menu").hidden = true;
  contextPlaylist = null;
}

function openPlaylistContextMenu(event, playlist) {
  event.preventDefault();
  event.stopPropagation();
  contextPlaylist = playlist;
  const menu = $("#playlist-context-menu");
  const owner = playlist.owner?.id === currentProfile?.id || playlist.owner?.account_id === currentProfile?.account_id;
  const pinned = new Set(JSON.parse(localStorage.getItem("spotify_pinned_playlists") || "[]"));
  menu.replaceChildren(
    contextAction("▶", "Lire la playlist", async () => {
      const data = await spotify(`/playlists/${playlist.id}/items?limit=50`);
      await playTrackList((data.items || []).map((entry) => entry.item ?? entry.track).filter(Boolean));
    }),
    contextAction("☷", "Ajouter à la file d’attente", async () => {
      const data = await spotify(`/playlists/${playlist.id}/items?limit=20`);
      const tracks = (data.items || []).map((entry) => entry.item ?? entry.track).filter((track) => track?.uri);
      for (const track of tracks) await spotify(`/me/player/queue?uri=${encodeURIComponent(track.uri)}${deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : ""}`, { method: "POST" });
      setStatus(`${tracks.length} titres ajoutés à la file d’attente`);
    }),
    contextAction("▣", "Afficher la playlist", () => loadPlaylistPage(playlist.id)),
    contextSeparator(),
    ...(owner ? [
      contextAction("✎", "Modifier les informations", () => openPlaylistEditor(playlist)),
      contextAction("＋", "Ajouter les titres affichés", async () => {
        const uris = uniqueTracks(currentRenderedTracks).map((track) => track.uri).slice(0, 100);
        if (!uris.length) throw new Error("Aucun titre affiché à ajouter.");
        await spotify(`/playlists/${playlist.id}/items`, { method: "POST", body: JSON.stringify({ uris }) });
        setStatus(`${uris.length} titres ajoutés à « ${playlist.name} »`);
      }),
      contextAction(playlist.public ? "◉" : "○", playlist.public ? "Rendre privée" : "Rendre publique", async () => {
        await spotify(`/playlists/${playlist.id}`, { method: "PUT", body: JSON.stringify({ public: !playlist.public }) });
        loadSidebarLibrary().catch(() => {});
      }),
      contextSeparator()
    ] : []),
    contextAction("⌖", pinned.has(playlist.id) ? "Désépingler la playlist" : "Épingler la playlist", () => {
      if (pinned.has(playlist.id)) pinned.delete(playlist.id); else pinned.add(playlist.id);
      localStorage.setItem("spotify_pinned_playlists", JSON.stringify([...pinned]));
      return loadSidebarLibrary();
    }),
    contextAction("↗", "Partager", async () => {
      const url = playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`;
      await navigator.clipboard.writeText(url);
      setStatus("Lien de la playlist copié");
    })
  );
  menu.hidden = false;
  const left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8);
  const top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

async function openHomeAlbum(album) {
  prepareList("ALBUM", album.name);
  try {
    const albumId = spotifyEntityId(album);
    if (!albumId) throw new Error("Album indisponible");
    const data = await spotify(`/albums/${encodeURIComponent(albumId)}/tracks?limit=50`);
    renderTracks((data.items || []).map((track) => ({ ...track, album })));
  } catch (error) { renderTracks([], error.message); }
}

async function loadHome() {
  $("#section-kicker").hidden = false;
  $("#section-title").hidden = false;
  $("#section-kicker").textContent = "ACCUEIL";
  const firstName = currentProfile?.display_name?.trim().split(/\s+/)[0];
  $("#section-title").textContent = firstName ? `Bonjour, ${firstName}` : "Bonjour";
  currentRenderedTracks = [];
  results.hidden = true;
  const discovery = $("#discovery");
  discovery.hidden = false;
  discovery.innerHTML = '<p class="empty-state">Préparation de ton accueil…</p>';

  const [collections, playlistsResult, albumsResult] = await Promise.all([
    getHomeCollections(),
    spotify("/me/playlists?limit=8").catch(() => ({ items: [] })),
    spotify("/me/albums?limit=8").catch(() => ({ items: [] }))
  ]);
  const playlists = (playlistsResult.items || []).filter(Boolean);
  const albums = (albumsResult.items || []).map((entry) => entry.item ?? entry.album).filter(Boolean);

  const quick = document.createElement("div");
  quick.className = "home-quick-grid";
  quick.append(homeQuick("Titres likés", collections.favorites[0]?.album?.images?.[0]?.url, () => loadLikedTracks()));
  playlists.slice(0, 6).forEach((playlist) => {
    const card = homeQuick(playlist.name, playlist.images?.[0]?.url, () => openHomePlaylist(playlist));
    card.addEventListener("contextmenu", (event) => openPlaylistContextMenu(event, playlist));
    quick.append(card);
  });

  const mixes = [
    homeMediaCard("Tes favoris du moment", "Selon tes écoutes récentes", collections.favorites[0]?.album?.images?.[0]?.url, () => openCollection("Tes favoris du moment", collections.favorites)),
    homeMediaCard("À réécouter", "Des titres laissés de côté", collections.replay[0]?.album?.images?.[0]?.url, () => openCollection("À réécouter", collections.replay)),
    homeMediaCard("Mix automatique", "Un mélange de ta bibliothèque", collections.automatic[0]?.album?.images?.[0]?.url, () => openCollection("Mix automatique", collections.automatic))
  ];
  const mixShelf = homeShelf(`Conçu pour ${firstName || "toi"}`, "Mis à jour selon tes écoutes", mixes);

  const recentCards = collections.recent.map((track) => homeTrackCard(track));
  const recentShelf = homeShelf("Écoutés récemment", "Ton historique récent", recentCards);

  const playlistCards = playlists.map((playlist) => {
    const card = homeMediaCard(
      playlist.name,
      `${playlist.items?.total ?? playlist.tracks?.total ?? 0} titres`,
      playlist.images?.[0]?.url,
      () => openHomePlaylist(playlist)
    );
    card.addEventListener("contextmenu", (event) => openPlaylistContextMenu(event, playlist));
    return card;
  });
  const albumCards = albums.map((album) => homeMediaCard(
    album.name,
    album.artists?.map((artist) => artist.name).join(", ") || "Album",
    album.images?.[0]?.url,
    () => openHomeAlbum(album)
  ));

  const parts = [quick];
  if (recentCards.length) parts.push(recentShelf);
  parts.push(mixShelf);
  if (playlistCards.length) parts.push(homeShelf("Tes playlists", "Ta bibliothèque", playlistCards));
  if (albumCards.length) parts.push(homeShelf("Albums enregistrés", "À retrouver facilement", albumCards));
  discovery.replaceChildren(...parts);
}

async function loadPlaylists() {
  $("#section-kicker").textContent = "BIBLIOTHÈQUE";
  $("#section-title").textContent = "Mes playlists";
  $("#discovery").hidden = true;
  results.hidden = false;
  results.innerHTML = '<p class="empty-state">Chargement…</p>';
  const data = await spotify("/me/playlists?limit=30");
  results.replaceChildren();
  for (const playlist of data.items.filter(Boolean)) {
    const row = document.createElement("article");
    row.className = "track";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    const image = document.createElement("img");
    image.src = playlist.images?.at(-1)?.url || "";
    image.alt = "";
    const copy = document.createElement("div");
    copy.className = "track-copy";
    const title = document.createElement("strong");
    title.textContent = playlist.name;
    const count = document.createElement("span");
    const itemCount = playlist.items?.total ?? playlist.tracks?.total;
    count.textContent = Number.isFinite(itemCount)
      ? `${itemCount} titre${itemCount > 1 ? "s" : ""}`
      : "Playlist Spotify";
    copy.append(title, count);
    const owner = document.createElement("span");
    owner.className = "album";
    owner.textContent = playlist.owner?.display_name || "Spotify";
    const arrow = document.createElement("span");
    arrow.className = "track-duration";
    arrow.textContent = "›";
    row.append(image, copy, owner, arrow);
    const open = () => loadPlaylistPage(playlist.id);
    row.addEventListener("click", open);
    row.addEventListener("contextmenu", (event) => openPlaylistContextMenu(event, playlist));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") open(); });
    results.append(row);
  }
}

async function playUri(uri) {
  if (!deviceId) return setStatus("Lecteur pas encore prêt");
  if (deviceId === localDeviceId) await player.activateElement();
  let sourceTracks = uniqueTracks(currentRenderedTracks);
  if (shuffleMode === "recommended") {
    const collections = await getHomeCollections();
    sourceTracks = shuffled(uniqueTracks(sourceTracks, collections.favorites, collections.replay));
  }
  const available = sourceTracks.map((track) => track.uri).slice(0, 50);
  activePlaybackQueue = available.includes(uri) ? available : [uri];
  const body = activePlaybackQueue.length > 1 ? { uris: activePlaybackQueue, offset: { uri } } : { uris: [uri] };
  await spotify(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, { method: "PUT", body: JSON.stringify(body) });
  await spotify(`/me/player/shuffle?state=${shuffleMode === "normal"}&device_id=${encodeURIComponent(deviceId)}`, { method: "PUT" });
  deviceActivated = true;
}

async function ensureActiveDevice() {
  if (!deviceId) throw new Error("Lecteur pas encore prêt");
  if (deviceId === localDeviceId) await player.activateElement();
  if (!deviceActivated) {
    await spotify("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [deviceId] }) });
    deviceActivated = true;
  }
}

async function playTrackList(tracks) {
  const uris = uniqueTracks(tracks).map((track) => track.uri).slice(0, 50);
  if (!uris.length || !deviceId) return setStatus("Aucun titre disponible pour ce mélange");
  if (deviceId === localDeviceId) await player.activateElement();
  activePlaybackQueue = uris;
  await spotify(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, { method: "PUT", body: JSON.stringify({ uris }) });
  await spotify(`/me/player/shuffle?state=${shuffleMode === "normal"}&device_id=${encodeURIComponent(deviceId)}`, { method: "PUT" });
  deviceActivated = true;
}

async function playSpotifyContext(contextUri, shuffle = false) {
  if (!contextUri || !deviceId) return setStatus("Lecteur pas encore prêt");
  await ensureActiveDevice();
  await spotify(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: "PUT",
    body: JSON.stringify({ context_uri: contextUri })
  });
  await spotify(`/me/player/shuffle?state=${shuffle}&device_id=${encodeURIComponent(deviceId)}`, { method: "PUT" });
  deviceActivated = true;
}

function shuffled(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const target = random[0] % (index + 1);
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function setStatus(message) { $("#connection-status").textContent = message; }

function refreshLocalPlayerState() {
  if (deviceId !== localDeviceId || !player) return;
  setTimeout(async () => {
    const state = await player.getCurrentState();
    if (state) updatePlayer(state);
  }, 350);
}

async function loadDevices() {
  const list = $("#devices-list");
  list.innerHTML = '<p class="empty-state">Recherche des appareils…</p>';
  try {
    const data = await spotify("/me/player/devices");
    list.replaceChildren();
    const devices = data?.devices || [];
    if (!devices.length) {
      list.innerHTML = '<p class="empty-state">Aucun appareil Spotify Connect disponible.</p>';
      return;
    }
    for (const device of devices) {
      const button = document.createElement("button");
      button.className = `device-item${device.is_active || device.id === deviceId ? " active" : ""}`;
      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = device.name;
      const type = document.createElement("span");
      type.textContent = `${device.type}${device.is_active ? " · Actif" : ""}`;
      copy.append(name, type);
      const marker = document.createElement("span");
      marker.textContent = device.id === localDeviceId ? "Cet appareil" : "Choisir";
      button.append(copy, marker);
      button.addEventListener("click", async () => {
        deviceId = device.id;
        deviceActivated = false;
        try {
          await ensureActiveDevice();
          setStatus(`Lecture sur ${device.name}`);
          $("#devices-dialog").close();
        } catch (error) { setStatus(error.message); }
      });
      list.append(button);
    }
  } catch (error) { list.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`; }
}

function updatePlayer(state) {
  currentState = state;
  if (!state) return;
  stateUpdatedAt = Date.now();
  const track = state.track_window.current_track;
  updatePlayingHighlights(track.uri);
  $("#track-title").textContent = track.name;
  renderPlayerArtists(track.artists);
  $("#play-button").classList.toggle("is-playing", !state.paused);
  $("#elapsed").textContent = formatTime(state.position);
  $("#duration").textContent = formatTime(state.duration);
  $("#progress").value = state.duration ? state.position / state.duration * 100 : 0;
  updateShuffleButton();
  if (Number.isInteger(state.repeat_mode)) {
    repeatMode = ["off", "context", "track"][state.repeat_mode] || "off";
    updateRepeatButton();
  }
  const coverUrl = track.album.images?.[0]?.url;
  $("#cover").hidden = !coverUrl;
  $("#cover-placeholder").hidden = Boolean(coverUrl);
  if (coverUrl) $("#cover").src = coverUrl;
  savePlaybackSnapshot();
  if ("mediaSession" in navigator && "MediaMetadata" in window) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: track.artists.map((artist) => artist.name).join(", "),
      album: track.album.name,
      artwork: track.album.images.map((image) => ({ src: image.url, sizes: image.width && image.height ? `${image.width}x${image.height}` : undefined }))
    });
    navigator.mediaSession.playbackState = state.paused ? "paused" : "playing";
  }
  clearInterval(progressTimer);
  if (!state.paused) {
    const startedAt = Date.now() - state.position;
    progressTimer = setInterval(() => {
      if (!currentState) return;
      const position = Math.min(Date.now() - startedAt, currentState.duration);
      $("#elapsed").textContent = formatTime(position);
      $("#progress").value = position / currentState.duration * 100;
    }, 1000);
  }
}

async function initPlayer() {
  const token = await getToken();
  if (!token) return showLogin();
  if (!window.Spotify) {
    window.onSpotifyWebPlaybackSDKReady = initPlayer;
    return;
  }
  player = new Spotify.Player({ name: "Spotify Lite", getOAuthToken: async (callback) => callback(await getToken()), volume: savedVolume / 100 });
  player.addListener("ready", ({ device_id }) => {
    localDeviceId = device_id;
    if (!deviceId) deviceId = device_id;
    deviceActivated = false;
    setStatus("");
    if (lastPlayback && !lastPlayback.paused) restoreLastPlayback().catch((error) => setStatus(error.message));
  });
  player.addListener("not_ready", () => { deviceActivated = false; setStatus("Lecteur hors connexion"); });
  player.addListener("player_state_changed", updatePlayer);
  player.addListener("authentication_error", () => setStatus("Connexion Spotify expirée"));
  player.addListener("account_error", () => setStatus("Spotify Premium requis"));
  player.addListener("playback_error", ({ message }) => setStatus(message || "Lecture impossible"));
  await player.connect();
}

async function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  const profile = await spotify("/me");
  currentProfile = profile;
  $("#profile-initials").textContent = (profile.display_name || "S").trim().charAt(0).toLocaleUpperCase();
  const avatar = localStorage.getItem("spotify_custom_avatar") || profile.images?.[0]?.url;
  $("#profile-avatar").hidden = !avatar;
  $("#profile-initials").hidden = Boolean(avatar);
  if (avatar) $("#profile-avatar").src = avatar;
  showLastPlayback();
  loadSidebarLibrary().catch(() => { $("#sidebar-playlists").innerHTML = "<p>Bibliothèque indisponible.</p>"; });
  await loadHome();
  await initPlayer();
}

function showLogin(message = "") {
  appView.hidden = true;
  loginView.hidden = false;
  $("#login-error").textContent = message;
}

$("#login-button").addEventListener("click", () => beginLogin().catch((error) => showLogin(error.message)));
function logout() {
  player?.disconnect();
  localStorage.removeItem("spotify_tokens");
  localStorage.removeItem("spotify_scope_version");
  showLogin();
}
function closeProfileMenu() {
  $("#profile-menu").hidden = true;
  $("#profile-button").setAttribute("aria-expanded", "false");
}
$("#profile-button").addEventListener("click", () => {
  const opening = $("#profile-menu").hidden;
  $("#profile-menu").hidden = !opening;
  $("#profile-button").setAttribute("aria-expanded", String(opening));
});
$("#recent-menu-button").addEventListener("click", async () => {
  closeProfileMenu();
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  try { await loadRecent(); } catch (error) { renderTracks([], error.message); }
});
function requestUsage() {
  if (window.chrome?.webview) window.chrome.webview.postMessage("get-system-usage");
  else $("#usage-note").textContent = "Disponible dans l'application Windows.";
}
function closeUsage() {
  clearInterval(usageTimer);
  usageTimer = null;
  if ($("#usage-dialog").open) $("#usage-dialog").close();
}
$("#usage-menu-button").addEventListener("click", () => {
  closeProfileMenu();
  $("#usage-dialog").showModal();
  requestUsage();
  usageTimer = setInterval(requestUsage, 2000);
});
$("#close-usage").addEventListener("click", closeUsage);
window.chrome?.webview?.addEventListener("message", (event) => {
  const usage = event.data;
  if (!usage || usage.type !== "system-usage") return;
  $("#usage-cpu").textContent = `${usage.cpu.toFixed(1)} %`;
  $("#usage-memory").textContent = usage.memoryMb >= 1024 ? `${(usage.memoryMb / 1024).toFixed(2)} Go` : `${Math.round(usage.memoryMb)} Mo`;
  $("#usage-processes").textContent = String(usage.processes);
  $("#usage-note").textContent = "Actualisation automatique toutes les 2 secondes.";
});
$("#profile-menu-link").addEventListener("click", async () => {
  closeProfileMenu();
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  try { await loadProfile(); } catch (error) { renderTracks([], error.message); }
});
$("#menu-logout-button").addEventListener("click", () => { closeProfileMenu(); logout(); });
document.addEventListener("click", (event) => {
  if (!$("#profile-menu").hidden && !$("#profile-menu").contains(event.target) && !$("#profile-button").contains(event.target)) closeProfileMenu();
  if (!$("#playlist-context-menu").hidden && !$("#playlist-context-menu").contains(event.target)) closePlaylistContextMenu();
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeProfileMenu(); closeQueuePanel(); closePlaylistContextMenu(); } });
window.addEventListener("blur", closePlaylistContextMenu);
$("#devices-button").addEventListener("click", () => { $("#devices-dialog").showModal(); loadDevices(); });
$("#close-devices").addEventListener("click", () => $("#devices-dialog").close());
function playlistTracksToAdd() {
  const seen = new Set();
  return currentRenderedTracks.filter((track) => track?.uri?.startsWith("spotify:track:") && !seen.has(track.uri) && seen.add(track.uri));
}
$("#create-playlist-button").addEventListener("click", () => {
  const tracks = playlistTracksToAdd();
  $("#playlist-track-count").textContent = tracks.length
    ? `${tracks.length} titre${tracks.length > 1 ? "s" : ""} actuellement affiché${tracks.length > 1 ? "s" : ""}`
    : "Aucun titre actuellement affiché";
  $("#playlist-add-current").disabled = tracks.length === 0;
  $("#playlist-add-current").checked = tracks.length > 0;
  $("#playlist-create-error").textContent = "";
  $("#create-playlist-dialog").showModal();
  setTimeout(() => $("#playlist-name").focus(), 50);
});
$("#close-create-playlist").addEventListener("click", () => $("#create-playlist-dialog").close());
$("#close-edit-playlist").addEventListener("click", () => $("#edit-playlist-dialog").close());
$("#close-add-playlist-track").addEventListener("click", () => $("#add-playlist-track-dialog").close());
$("#add-playlist-track-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const container = $("#add-playlist-track-results");
  container.innerHTML = '<p class="empty-state">Recherche…</p>';
  try {
    const data = await spotify(`/search?type=track&limit=12&q=${encodeURIComponent($("#add-playlist-track-query").value.trim())}`);
    container.replaceChildren();
    for (const track of data.tracks?.items || []) {
      const row = document.createElement("button");
      row.className = "playlist-add-result";
      const image = document.createElement("img");
      image.src = track.album?.images?.at(-1)?.url || "";
      image.alt = "";
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = track.name;
      const artist = document.createElement("small");
      artist.textContent = track.artists?.map((item) => item.name).join(", ") || "";
      copy.append(title, artist);
      const action = document.createElement("span");
      action.textContent = "Ajouter";
      row.append(image, copy, action);
      row.addEventListener("click", async () => {
        if (!activePlaylist?.id) return;
        row.disabled = true;
        await spotify(`/playlists/${activePlaylist.id}/items`, { method: "POST", body: JSON.stringify({ uris: [track.uri] }) });
        action.textContent = "Ajouté ✓";
        loadSidebarLibrary().catch(() => {});
      });
      container.append(row);
    }
  } catch (error) { container.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`; }
});
$("#edit-playlist-cover-button").addEventListener("click", () => $("#edit-playlist-cover-input").click());
$("#edit-playlist-cover-input").addEventListener("change", async (event) => {
  try {
    pendingPlaylistCover = await cropImage(event.target.files?.[0], 512, 512, .88, 250000);
    $("#edit-playlist-cover-preview").src = pendingPlaylistCover;
  } catch (error) { $("#edit-playlist-error").textContent = error.message; }
});
$("#edit-playlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activePlaylist?.id) return;
  const submit = $("#edit-playlist-submit");
  submit.disabled = true;
  submit.textContent = "Enregistrement…";
  $("#edit-playlist-error").textContent = "";
  try {
    await spotify(`/playlists/${encodeURIComponent(activePlaylist.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        name: $("#edit-playlist-name").value.trim(),
        description: $("#edit-playlist-description").value.trim(),
        public: $("#edit-playlist-public").checked
      })
    });
    if (pendingPlaylistCover) {
      await spotify(`/playlists/${encodeURIComponent(activePlaylist.id)}/images`, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: pendingPlaylistCover.split(",")[1]
      });
    }
    const playlistId = activePlaylist.id;
    $("#edit-playlist-dialog").close();
    await loadPlaylistPage(playlistId, false);
    loadSidebarLibrary().catch(() => {});
  } catch (error) {
    $("#edit-playlist-error").textContent = error.message.includes("403")
      ? "Spotify refuse la modification. Vérifie que cette playlist t’appartient et reconnecte-toi."
      : error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "Enregistrer";
  }
});
$("#show-all-playlists").addEventListener("click", loadPlaylists);
$("#create-playlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = $("#playlist-submit");
  const errorView = $("#playlist-create-error");
  const name = $("#playlist-name").value.trim();
  if (!name) return;
  submit.disabled = true;
  submit.textContent = "Création…";
  errorView.textContent = "";
  try {
    const playlist = await spotify("/me/playlists", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: $("#playlist-description").value.trim(),
        public: $("#playlist-public").checked
      })
    });
    const tracks = $("#playlist-add-current").checked ? playlistTracksToAdd() : [];
    for (let index = 0; index < tracks.length; index += 100) {
      await spotify(`/playlists/${encodeURIComponent(playlist.id)}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: tracks.slice(index, index + 100).map((track) => track.uri) })
      });
    }
    $("#create-playlist-dialog").close();
    $("#create-playlist-form").reset();
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === "playlists"));
    loadSidebarLibrary().catch(() => {});
    await loadPlaylists();
    setStatus(`Playlist « ${name} » créée sur Spotify`);
  } catch (error) {
    errorView.textContent = error.message.includes("403")
      ? "Autorisation refusée. Déconnecte-toi puis reconnecte-toi une fois."
      : error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "Créer la playlist";
  }
});
document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", async () => {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
  try {
    if (button.dataset.view === "playlists") await loadPlaylists();
    else if (button.dataset.view === "liked") await loadLikedTracks();
    else if (button.dataset.view === "albums") await loadAlbums();
    else if (button.dataset.view === "queue") await loadQueue();
    else await loadHome();
  }
  catch (error) { renderTracks([], error.message); }
}));
async function runLiveSearch(query) {
  query = query.trim();
  if (!query) return loadHome();
  const requestId = ++searchSequence;
  $("#section-kicker").hidden = true;
  $("#section-title").hidden = true;
  results.hidden = true;
  const discovery = $("#discovery");
  discovery.hidden = false;
  discovery.innerHTML = '<p class="empty-state">Recherche…</p>';
  try {
    const data = await spotify(`/search?type=artist,track,album,playlist&limit=10&q=${encodeURIComponent(query)}`);
    if (requestId !== searchSequence) return;
    const artists = (data.artists?.items || []).filter(Boolean);
    const tracks = (data.tracks?.items || []).filter((track) => track?.uri);
    const albums = (data.albums?.items || []).filter(Boolean);
    const playlists = (data.playlists?.items || []).filter(Boolean);
    currentRenderedTracks = tracks;
    const page = document.createElement("div");
    page.className = "search-results-page";
    const chips = document.createElement("div");
    chips.className = "search-chips";
    [["all", "Tout"], ["artists", "Artistes"], ["tracks", "Titres"], ["playlists", "Playlists"], ["albums", "Albums"]].forEach(([kind, label], index) => {
      const chip = document.createElement("button");
      chip.textContent = label;
      chip.classList.toggle("active", index === 0);
      chip.addEventListener("click", () => {
        chips.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === chip));
        page.querySelectorAll("[data-search-kind]").forEach((section) => { section.hidden = kind !== "all" && section.dataset.searchKind !== kind; });
      });
      chips.append(chip);
    });
    page.append(chips);

    if (artists.length) {
      const artistSection = document.createElement("section");
      artistSection.className = "search-best-artist";
      artistSection.dataset.searchKind = "artists";
      const artist = artists[0];
      const image = artist.images?.[0]?.url ? document.createElement("img") : document.createElement("div");
      if (artist.images?.[0]?.url) { image.src = artist.images[0].url; image.alt = ""; }
      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = artist.name;
      const type = document.createElement("span");
      type.textContent = "Artiste";
      copy.append(name, type);
      artistSection.tabIndex = 0;
      artistSection.setAttribute("role", "button");
      artistSection.setAttribute("aria-label", `Ouvrir la page de ${artist.name}`);
      const openArtist = () => loadArtistPage(artist.id);
      artistSection.addEventListener("click", openArtist);
      artistSection.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") openArtist(); });
      artistSection.append(image, copy);
      page.append(artistSection);
    }

    if (tracks.length) {
      const trackSection = document.createElement("section");
      trackSection.className = "search-result-section";
      trackSection.dataset.searchKind = "tracks";
      trackSection.innerHTML = "<h2>Titres</h2>";
      const list = document.createElement("div");
      list.className = "artist-page-tracks";
      tracks.forEach((track, index) => list.append(artistTrackRow(track, index)));
      trackSection.append(list);
      page.append(trackSection);
    }

    if (playlists.length) {
      const cards = playlists.map((playlist) => {
        const card = homeMediaCard(playlist.name, `Playlist · ${playlist.owner?.display_name || "Spotify"}`, playlist.images?.[0]?.url, () => openHomePlaylist(playlist));
        card.addEventListener("contextmenu", (event) => openPlaylistContextMenu(event, playlist));
        return card;
      });
      const section = homeShelf("Playlists", "", cards);
      section.dataset.searchKind = "playlists";
      page.append(section);
    }
    if (albums.length) {
      const section = homeShelf("Albums", "", albums.map((album) => homeMediaCard(album.name, album.artists?.map((item) => item.name).join(", ") || "Album", album.images?.[0]?.url, () => openHomeAlbum(album))));
      section.dataset.searchKind = "albums";
      page.append(section);
    }
    if (!artists.length && !tracks.length && !playlists.length && !albums.length) page.innerHTML += '<p class="empty-state">Aucun résultat.</p>';
    discovery.replaceChildren(page);
  } catch (error) {
    if (requestId === searchSequence) discovery.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  }
}

$("#search-form").addEventListener("submit", (event) => { event.preventDefault(); runLiveSearch($("#search-input").value); });
$("#search-input").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  const query = event.target.value;
  searchTimer = setTimeout(() => runLiveSearch(query), query.trim() ? 320 : 180);
});
$("#play-button").addEventListener("click", async () => {
  try {
    if (!currentState && lastPlayback) {
      await restoreLastPlayback();
      return;
    }
    await ensureActiveDevice();
    if (!currentState) return setStatus("Choisis d’abord un morceau");
    await spotify(currentState.paused ? "/me/player/play" : "/me/player/pause", { method: "PUT" });
  } catch (error) { setStatus(error.message); }
});
function currentTrackMetadata() {
  return currentState?.track_window?.current_track || null;
}
function openCurrentAlbum() {
  const track = currentTrackMetadata();
  const albumId = spotifyEntityId(track?.album) || spotifyEntityId(lastPlayback?.album_id);
  if (!albumId) return;
  openHomeAlbum(track?.album || { id: albumId, name: lastPlayback?.album || "Album", images: lastPlayback?.cover ? [{ url: lastPlayback.cover }] : [] });
}
$("#track-title").classList.add("interactive-meta");
$("#cover").classList.add("interactive-meta");
$("#track-title").addEventListener("click", openCurrentAlbum);
$("#cover").addEventListener("click", openCurrentAlbum);
$("#previous-button").addEventListener("click", async () => {
  try {
    await ensureActiveDevice();
    await spotify(`/me/player/previous?device_id=${encodeURIComponent(deviceId)}`, { method: "POST" });
    refreshLocalPlayerState();
  } catch (error) { setStatus(error.message); }
});
$("#next-button").addEventListener("click", async () => {
  try {
    await ensureActiveDevice();
    await spotify(`/me/player/next?device_id=${encodeURIComponent(deviceId)}`, { method: "POST" });
    refreshLocalPlayerState();
  } catch (error) { setStatus(error.message); }
});
function updateShuffleButton() {
  const button = $("#shuffle-button");
  button.classList.toggle("active", shuffleMode === "normal");
  button.classList.toggle("recommended", shuffleMode === "recommended");
  button.title = shuffleMode === "normal" ? "Aléatoire normal" : shuffleMode === "recommended" ? "Aléatoire recommandé" : "Aléatoire désactivé";
  button.setAttribute("aria-label", button.title);
}

$("#shuffle-button").addEventListener("click", async () => {
  const previous = shuffleMode;
  shuffleMode = shuffleMode === "off" ? "normal" : shuffleMode === "normal" ? "recommended" : "off";
  localStorage.setItem("spotify_shuffle_mode", shuffleMode);
  updateShuffleButton();
  try {
    if (deviceId) {
      await ensureActiveDevice();
      await spotify(`/me/player/shuffle?state=${shuffleMode === "normal"}&device_id=${encodeURIComponent(deviceId)}`, { method: "PUT" });
    }
    if (shuffleMode === "recommended") {
      const collections = await getHomeCollections();
      const base = currentRenderedTracks.length ? currentRenderedTracks : collections.automatic;
      const recommended = shuffled(uniqueTracks(base, collections.favorites, collections.replay)).slice(0, 50);
      openCollection("Aléatoire recommandé", recommended);
      if (deviceId) await playTrackList(recommended);
    }
    setStatus($("#shuffle-button").title);
  } catch (error) {
    shuffleMode = previous;
    localStorage.setItem("spotify_shuffle_mode", shuffleMode);
    updateShuffleButton();
    setStatus(error.message);
  }
});

function updateRepeatButton() {
  const button = $("#repeat-button");
  button.classList.toggle("active", repeatMode !== "off");
  if (repeatMode === "track") button.dataset.label = "1";
  else if (repeatMode === "context") button.dataset.label = "∞";
  else delete button.dataset.label;
  button.title = repeatMode === "track" ? "Répéter ce titre" : repeatMode === "context" ? "Répéter la sélection" : "Répétition désactivée";
}

$("#repeat-button").addEventListener("click", async () => {
  if (!deviceId) return setStatus("Lecteur pas encore prêt");
  const previous = repeatMode;
  repeatMode = repeatMode === "off" ? "context" : repeatMode === "context" ? "track" : "off";
  try {
    await ensureActiveDevice();
    await spotify(`/me/player/repeat?state=${repeatMode}&device_id=${encodeURIComponent(deviceId)}`, { method: "PUT" });
    updateRepeatButton();
    setStatus($("#repeat-button").title);
  } catch (error) {
    repeatMode = previous;
    updateRepeatButton();
    setStatus(error.message);
  }
});

function closeQueuePanel() {
  $("#queue-panel").hidden = true;
  $("#queue-button").classList.remove("active");
}
$("#queue-button").addEventListener("click", () => {
  const opening = $("#queue-panel").hidden;
  if (!opening) return closeQueuePanel();
  $("#queue-panel").hidden = false;
  $("#queue-button").classList.add("active");
  loadQueuePanel("queue");
});
$("#close-queue").addEventListener("click", closeQueuePanel);
$("#queue-tab").addEventListener("click", () => loadQueuePanel("queue"));
$("#recent-tab").addEventListener("click", () => loadQueuePanel("recent"));
$("#mini-button").addEventListener("click", () => {
  const enabled = document.body.classList.toggle("mini-mode");
  $("#mini-button").textContent = enabled ? "▣" : "◱";
  $("#mini-button").title = enabled ? "Agrandir" : "Mini-lecteur";
  $("#mini-button").setAttribute("aria-label", $("#mini-button").title);
  $("#menu-mini-toggle").checked = enabled;
  localStorage.setItem("spotify_mini_mode", enabled ? "1" : "0");
});
$("#menu-mini-toggle").addEventListener("change", () => { closeProfileMenu(); $("#mini-button").click(); });
function applyVolume(value) {
  const volume = Math.max(0, Math.min(100, Number(value)));
  $("#volume").value = String(volume);
  localStorage.setItem("spotify_volume", String(volume));
  player?.setVolume(volume / 100);
}
$("#volume").addEventListener("input", (event) => applyVolume(event.target.value));
$("#volume").addEventListener("wheel", (event) => {
  event.preventDefault();
  const direction = event.deltaY < 0 ? 1 : -1;
  const nextVolume = Math.max(0, Math.min(100, Number(event.currentTarget.value) + direction * 5));
  event.currentTarget.value = String(nextVolume);
  applyVolume(nextVolume);
}, { passive: false });
$("#progress").addEventListener("change", (event) => { if (currentState) player?.seek(currentState.duration * Number(event.target.value) / 100); });

document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  const actions = {
    Space: "#play-button",
    ArrowLeft: "#previous-button",
    ArrowRight: "#next-button",
    KeyS: "#shuffle-button",
    KeyR: "#repeat-button",
    KeyM: "#mini-button"
  };
  const selector = actions[event.code];
  if (!selector || event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  $(selector).click();
});

document.addEventListener("wheel", (event) => {
  const row = event.target.closest?.(".home-card-row");
  if (!row || row.scrollWidth <= row.clientWidth || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
  event.preventDefault();
  row.scrollBy({ left: event.deltaY * 1.15, behavior: "smooth" });
}, { passive: false });

window.addEventListener("popstate", (event) => {
  if (event.state?.view === "artist" && event.state.artistId) loadArtistPage(event.state.artistId, false);
  else if (event.state?.view === "playlist" && event.state.playlistId) loadPlaylistPage(event.state.playlistId, false);
  else if (currentProfile) loadProfile().catch((error) => setStatus(error.message));
});

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => $("#play-button").click());
  navigator.mediaSession.setActionHandler("pause", () => $("#play-button").click());
  navigator.mediaSession.setActionHandler("previoustrack", () => $("#previous-button").click());
  navigator.mediaSession.setActionHandler("nexttrack", () => $("#next-button").click());
}

async function start() {
  try {
    if (!CLIENT_ID || CLIENT_ID === "YOUR_SPOTIFY_CLIENT_ID") {
      showLogin("Copie config.example.js vers config.js, puis ajoute ton Client ID Spotify.");
      return;
    }
    updateShuffleButton();
    $("#volume").value = String(savedVolume);
    if (localStorage.getItem("spotify_mini_mode") === "1") {
      document.body.classList.add("mini-mode");
      $("#mini-button").textContent = "▣";
      $("#mini-button").title = "Agrandir";
      $("#mini-button").setAttribute("aria-label", "Agrandir");
      $("#menu-mini-toggle").checked = true;
    }
    const params = new URLSearchParams(location.search);
    if (params.has("error")) throw new Error("Connexion Spotify annulée.");
    if (params.has("code")) {
      if (params.get("state") !== sessionStorage.getItem("spotify_state")) throw new Error("Connexion non valide. Réessaie.");
      await exchangeCode(params.get("code"));
    }
    if (await getToken() && localStorage.getItem("spotify_scope_version") !== SCOPE_VERSION) {
      localStorage.removeItem("spotify_tokens");
      showLogin("Reconnecte-toi une fois pour activer les sélections personnalisées.");
      return;
    }
    if (await getToken()) await showApp(); else showLogin();
  } catch (error) {
    if (error.message === "Connexion expirée") localStorage.removeItem("spotify_tokens");
    showLogin(error.message);
  }
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
setInterval(() => fetch("/heartbeat", { cache: "no-store" }).catch(() => {}), 5000);
window.addEventListener("beforeunload", savePlaybackSnapshot);
start();
