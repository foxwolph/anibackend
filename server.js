const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

app.use(cors());
app.use(express.json());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MEGAPLAY = 'https://megaplay.buzz';
const FLIKHUB = 'https://api.flikhub.net';
const JIKAN = 'https://api.jikan.moe/v4';
const KITSU = 'https://kitsu.io/api/edge';

const anilistClient = axios.create({
  baseURL: 'https://graphql.anilist.co',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});
const jikanClient = axios.create({
  baseURL: JIKAN,
  timeout: 10000,
  headers: { 'User-Agent': UA },
});
const kitsuClient = axios.create({
  baseURL: KITSU,
  timeout: 10000,
  headers: { Accept: 'application/vnd.api+json' },
});

// ══════════════════════════════════════════════════════════════
// CACHE
// ══════════════════════════════════════════════════════════════
const cache = new Map();
const MAX_CACHE_SIZE = 500;
function cacheGet(key) {
  const e = cache.get(key);
  if (!e || e.expiresAt < Date.now()) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data, ttlMs = 300000) {
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// Extract the direct CDN playlist URL from a provider proxy wrapper
// (e.g. https://proxy.flikhub.net/m3u8-proxy?url=<direct>&headers=...).
// Proxy hosts often block datacenter IPs, so server-side consumers
// (ffmpeg, axios) must fetch the direct URL instead.
function unwrapProxyUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'proxy.flikhub.net' && u.pathname.startsWith('/m3u8-proxy')) {
      const inner = u.searchParams.get('url');
      if (inner && /^https?:\/\//i.test(inner)) return inner;
    }
  } catch { /* fall through and return the original */ }
  return url;
}

const IMAGE_SEGMENT_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'image']);

function segmentLooksLikeMedia(uri) {
  const path = (uri.split('?')[0].split('#')[0] || '').toLowerCase();
  const dot = path.lastIndexOf('.');
  if (dot < 0) return true; // extensionless URIs can't be judged; assume media
  return !IMAGE_SEGMENT_EXT.has(path.substring(dot + 1));
}

// Best-effort check that an HLS playlist (master or media) ultimately
// references at least one real media segment. Resolves one master->variant
// level. Returns true when undecidable so callers can still try ffmpeg.
async function playlistHasMediaSegments(playlistUrl, playlistText, ref) {
  const lines = playlistText.split('\n').map(l => l.trim());
  const uris = lines.filter(l => l && !l.startsWith('#'));
  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF:'));
  if (!isMaster) {
    if (uris.length === 0) return true;
    return uris.some(segmentLooksLikeMedia);
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const next = lines[i + 1];
    if (!next || next.startsWith('#')) continue;
    const variantUrl = next.startsWith('http') ? next : new URL(next, playlistUrl).toString();
    const variantRes = await axios.get(variantUrl, {
      responseType: 'text',
      timeout: 15000,
      maxContentLength: 4 * 1024 * 1024,
      headers: { 'User-Agent': UA, Referer: ref, Origin: new URL(ref).origin },
    });
    const variantText = typeof variantRes.data === 'string' ? variantRes.data : '';
    const variantUris = variantText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (variantUris.length === 0) continue;
    return variantUris.some(segmentLooksLikeMedia);
  }
  return true;
}

// ══════════════════════════════════════════════════════════════
// ANILIST
// ══════════════════════════════════════════════════════════════
async function getAnilistInfo(anilistId) {
  const ck = `al:${anilistId}`;
  const c = cacheGet(ck);
  if (c) return c;

  const query = `query ($id: Int) {
    Media(id: $id, type: ANIME) { id idMal title { romaji english } episodes coverImage { large } }
  }`;
  const res = await anilistClient.post('', { query, variables: { id: anilistId } });
  const m = res.data?.data?.Media;
  if (!m) return null;
  const result = {
    anilistId: m.id,
    malId: m.idMal,
    title: m.title?.english || m.title?.romaji || 'Unknown',
    altTitle: m.title?.english && m.title?.romaji && m.title?.english !== m.title?.romaji ? m.title?.romaji : null,
    totalEpisodes: m.episodes,
    coverImage: m.coverImage?.large || null,
  };
  cacheSet(ck, result, 86400000);
  return result;
}

async function searchAnilist(query) {
  const ck = `alsearch:${query.toLowerCase().trim()}`;
  const c = cacheGet(ck);
  if (c) return c;

  const gql = `query ($search: String) {
    Page(page: 1, perPage: 10) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id idMal episodes
        title { romaji english }
        coverImage { large medium }
        status format
      }

  }`;
  const res = await anilistClient.post('', { query: gql, variables: { search: query } });
  const list = res.data?.data?.Page?.media ?? [];
  const results = list.map(m => ({
    id: m.id,
    malId: m.idMal ?? null,
    title: m.title?.english ?? m.title?.romaji,
    coverImage: m.coverImage?.large ?? m.coverImage?.medium ?? '',
    episodes: m.episodes ?? null,
    status: m.status,
    format: m.format,
  }));
  cacheSet(ck, results, 300000);
  return results;
}

async function getAnilistInfoByMalId(malId) {
  const ck = `al-mal:${malId}`;
  const c = cacheGet(ck);
  if (c) return c;
  const query = `query ($idMal: Int) {
    Media(idMal: $idMal, type: ANIME) { id idMal title { romaji english } episodes coverImage { large } }
  }`;
  const res = await anilistClient.post('', { query, variables: { idMal: malId } });
  const m = res.data?.data?.Media;
  if (!m) return null;
  const result = {
    anilistId: m.id, malId: m.idMal, title: m.title?.english || m.title?.romaji || 'Unknown',
    altTitle: m.title?.english && m.title?.romaji && m.title?.english !== m.title.romaji ? m.title.romaji : null,
    totalEpisodes: m.episodes, coverImage: m.coverImage?.large || null,
  };
  cacheSet(ck, result, 86400000);
  return result;
}

async function getJikanInfo(malId) {
  const ck = `jikan:${malId}`;
  const c = cacheGet(ck);
  if (c) return c;
  const res = await jikanClient.get(`/anime/${malId}/full`);
  const a = res.data?.data;
  if (!a) return null;
  const result = {
    anilistId: null, malId: a.mal_id, title: a.title_english || a.title || 'Unknown',
    altTitle: a.title_english && a.title ? a.title : null, totalEpisodes: a.episodes,
    coverImage: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || null,
  };
  cacheSet(ck, result, 86400000);
  return result;
}

async function searchJikan(query) {
  const ck = `jikan-search:${query.toLowerCase().trim()}`;
  const c = cacheGet(ck);
  if (c) return c;
  const res = await jikanClient.get('/anime', { params: { q: query, limit: 10, sfw: true } });
  const results = (res.data?.data || []).map(a => ({
    id: a.mal_id ?? null, malId: a.mal_id ?? null, title: a.title_english || a.title,
    coverImage: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
    episodes: a.episodes ?? null, status: a.status, format: a.type,
  }));
  cacheSet(ck, results, 300000);
  return results;
}

async function searchKitsu(query) {
  const ck = `kitsu-search:${query.toLowerCase().trim()}`;
  const c = cacheGet(ck);
  if (c) return c;

  const res = await kitsuClient.get('/anime', {
    params: {
      'filter[text]': query,
      'page[limit]': 10,
      include: 'mappings',
    },
  });
  const included = new Map((res.data?.included || []).map(item => [item.id, item]));
  const results = (res.data?.data || []).map(anime => {
    const mappingIds = anime.relationships?.mappings?.data || [];
    const malMapping = mappingIds
      .map(mapping => included.get(mapping.id))
      .find(mapping => mapping?.attributes?.externalSite === 'myanimelist/anime');
    const attributes = anime.attributes || {};
    return {
      id: malMapping?.attributes?.externalId ? parseInt(malMapping.attributes.externalId, 10) : null,
      malId: malMapping?.attributes?.externalId ? parseInt(malMapping.attributes.externalId, 10) : null,
      title: attributes.titles?.en || attributes.canonicalTitle || 'Unknown',
      coverImage: attributes.posterImage?.large || attributes.posterImage?.original || '',
      episodes: attributes.episodeCount ?? null,
      status: attributes.status === 'current' ? 'RELEASING' : attributes.status,
      format: attributes.subtype || 'TV',
    };
  }).filter(result => result.malId);
  cacheSet(ck, results, 300000);
  return results;
}

// ══════════════════════════════════════════════════════════════
// MEGAPLAY: Stream extraction via AniList ID
// ══════════════════════════════════════════════════════════════
async function getStreamFromMegaplay(anilistId, episode, language = 'sub') {
  const ck = `stream:${anilistId}:${episode}:${language}`;
  const c = cacheGet(ck);
  if (c) return c;

  try {
    // Step 1: Fetch the embed page to get the file ID
    const streamUrl = `${MEGAPLAY}/stream/ani/${anilistId}/${episode}/${language}`;
    const pageRes = await axios.get(streamUrl, {
      headers: { 'User-Agent': UA, Referer: `${MEGAPLAY}/` },
      timeout: 10000,
    });

    const fileIdMatch = pageRes.data.match(/<title>File (\d+)/);
    if (!fileIdMatch) return null;
    const fileId = fileIdMatch[1];

    // Step 2: Call getSources to get the actual M3U8 URL
    const srcRes = await axios.get(`${MEGAPLAY}/stream/getSources?id=${fileId}`, {
      headers: {
        'User-Agent': UA,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: streamUrl,
      },
      timeout: 8000,
    });

    const data = srcRes.data;
    const m3u8 = data?.sources?.file;
    if (!m3u8) return null;

    const subtitles = (data.tracks || [])
      .filter(t => t?.file)
      .map(t => ({
        lang: t.label ?? 'Unknown',
        url: t.file,
        default: Boolean(t.default),
        kind: t.kind || 'captions',
      }));

    const result = {
      m3u8,
      subtitles,
      intro: data.intro || null,
      outro: data.outro || null,
    };

    cacheSet(ck, result, 300000);
    return result;
  } catch (e) {
    console.error(`[megaplay] Error anilistId=${anilistId} ep=${episode}:`, e.message);
    return null;
  }

}

async function getStreamFromFlikHub(malId, episode, language = 'sub') {
  const ck = `flikhub:${malId}:${episode}:${language}`;
  const c = cacheGet(ck);
  if (c) return c;
  try {
    const res = await axios.get(`${FLIKHUB}/megaplay`, {
      params: { mal: malId, ep: episode, type: language },
      headers: { 'User-Agent': UA },
      timeout: 12000,
    });
    const data = res.data;
    const m3u8 = data?.m3u8 || data?.sources?.file || data?.file;
    if (!m3u8) return null;
    const result = {
      m3u8,
      proxiedUrl: data.proxiedUrl || null,
      referer: 'https://megaplay.buzz/',
      subtitles: (data.tracks || data.subtitles || []).filter(t => t?.file || t?.url).map(t => ({
        lang: t.label || t.lang || 'Unknown', url: t.file || t.url,
        default: Boolean(t.default), kind: t.kind || 'captions',
      })),
      intro: data.intro || null, outro: data.outro || null,
    };
    cacheSet(ck, result, 300000);
    return result;
  } catch (e) {
    console.error(`[flikhub] Error malId=${malId} ep=${episode}:`, e.message);
    return null;
  }
}

// Probe if dub is available for an anime (test first episode)
async function probeDubAvailability(anilistId) {
  const ck = `dub:${anilistId}`;
  const c = cacheGet(ck);
  if (c !== null) return c;

  try {
    const streamUrl = `${MEGAPLAY}/stream/ani/${anilistId}/1/dub`;
    const pageRes = await axios.get(streamUrl, {
      headers: { 'User-Agent': UA, Referer: `${MEGAPLAY}/` },
      timeout: 5000,
    });
    const hasFile = /<title>File \d+/.test(pageRes.data);
    cacheSet(ck, hasFile, 86400000);
    return hasFile;
  } catch {
    cacheSet(ck, false, 86400000);
    return false;
  }
}

// Probe episode count using binary search
async function probeEpisodeCount(anilistId, maxEps = 1500) {
  const ck = `probe:${anilistId}`;
  const c = cacheGet(ck);
  if (c !== null) return c;

  async function hasEpisode(ep) {
    try {
      const streamUrl = `${MEGAPLAY}/stream/ani/${anilistId}/${ep}/sub`;
      const pageRes = await axios.get(streamUrl, {
        headers: { 'User-Agent': UA, Referer: `${MEGAPLAY}/` },
        timeout: 5000,
      });
      return /<title>File \d+/.test(pageRes.data);
    } catch {
      return false;
    }
  }

  // First check if episode 1 exists
  if (!(await hasEpisode(1))) {
    cacheSet(ck, 0, 86400000);
    return 0;
  }

  // Find upper bound by doubling
  let low = 1;
  let high = 1;
  while (high <= maxEps && await hasEpisode(high)) {
    low = high;
    high *= 2;
  }
  high = Math.min(high, maxEps);

  // Binary search between low and high
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (await hasEpisode(mid)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  cacheSet(ck, low, 86400000);
  return low;
}

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/', (_req, res) => {
  res.json({ status: 'ok', version: '3.0.0' });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '3.0.0', source: 'flikhub', catalog: ['anilist', 'jikan', 'kitsu'] });
});

// Search AniList
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    try {
      const results = await searchAnilist(q);
      return res.json({ query: q, count: results.length, results, source: 'anilist' });
    } catch (anilistError) {
      console.error('[anilist] Search failed, using Jikan:', anilistError.message);
      try {
        const results = await searchJikan(q);
        return res.json({ query: q, count: results.length, results, source: 'jikan' });
      } catch (jikanError) {
        console.error('[jikan] Search failed, using Kitsu:', jikanError.message);
        const results = await searchKitsu(q);
        return res.json({ query: q, count: results.length, results, source: 'kitsu' });
      }
    }
  } catch (e) {
    return res.status(500).json({ error: 'Search failed', detail: e?.message });
  }
});

// Get anime info + episode list
app.get('/api/info', async (req, res) => {
  const { anilistId, malId } = req.query;
  if (!anilistId && !malId) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=' });
  try {
    let alInfo = null;
    let jikanInfo = null;
    if (anilistId) {
      alInfo = await getAnilistInfo(parseInt(anilistId));
      if (!alInfo) return res.status(404).json({ error: 'Anime not found on AniList' });
    } else if (malId) {
      const parsedMalId = parseInt(malId);
      try { alInfo = await getAnilistInfoByMalId(parsedMalId); } catch (e) {
        console.error('[anilist] MAL lookup failed, using Jikan:', e.message);
      }
      if (!alInfo) jikanInfo = await getJikanInfo(parsedMalId);
      if (!alInfo && !jikanInfo) return res.status(404).json({ error: 'Anime not found' });
    }

    const id = alInfo?.anilistId ?? (anilistId ? parseInt(anilistId) : null);
    const info = alInfo || jikanInfo;
    const totalEps = info?.totalEpisodes;

    let episodeCount = totalEps;
    // Always probe if AniList count is missing, 0, or suspiciously low (< 200)
    // This catches shows like One Piece where AniList reports wrong count
    if (id && (!episodeCount || episodeCount < 200)) {
      const probedCount = await probeEpisodeCount(id, 1500);
      if (probedCount > (episodeCount || 0)) {
        episodeCount = probedCount;
      }
    }

    if (!episodeCount) return res.status(404).json({ error: 'No episodes found on streaming source' });

    const hasDub = id ? await probeDubAvailability(id) : false;

    const episodes = [];
    for (let i = 1; i <= episodeCount; i++) {
      episodes.push({ num: i, title: `Episode ${i}`, thumbnail: info?.coverImage || null });
    }

    return res.json({
      anilistId: info?.anilistId ?? (anilistId ? parseInt(anilistId) : null),
      malId: info?.malId ?? (malId ? parseInt(malId) : null),
      title: info?.title ?? 'Unknown',
      coverImage: info?.coverImage || null,
      episodeCount,
      hasDub,
      episodes,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// Watch: resolve stream
app.get('/api/watch', async (req, res) => {
  const { anilistId, malId, ep, type = 'sub' } = req.query;
  if (!ep) return res.status(400).json({ error: 'Missing ?ep=' });
  if (!anilistId && !malId) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=' });
  const epNum = parseInt(ep);
  if (isNaN(epNum)) return res.status(400).json({ error: '?ep must be a number' });

  try {
    const id = anilistId ? parseInt(anilistId) : null;
    let mal = malId ? parseInt(malId) : null;
    let info = null;
    if (id || mal) {
      try {
        info = id ? await getAnilistInfo(id) : await getAnilistInfoByMalId(mal);
        if (!mal) mal = info?.malId || null;
      } catch (e) {
        console.error('[anilist] Info lookup failed:', e.message);
      }
    }
    if (!id && !mal) return res.status(400).json({ error: 'A valid anilistId or malId is required for streaming' });

    let stream = mal ? await getStreamFromFlikHub(mal, epNum, type) : null;
    let source = 'flikhub';
    if (!stream && id) {
      stream = await getStreamFromMegaplay(id, epNum, type);
      source = 'megaplay';
    }
    if (!stream) return res.status(502).json({ error: 'Stream extraction failed' });

    if (!info && mal) {
      try { info = await getJikanInfo(mal); } catch { /* title is optional */ }
    }

    return res.json({
      anilistId: id || info?.anilistId || null,
      malId: mal || info?.malId || null,
      title: info?.title || null,
      episode: epNum,
      type,
      source,
      m3u8: stream.m3u8,
      proxiedUrl: stream.proxiedUrl || null,
      // Direct CDN playlist (unwrapped). Clients can route this through
      // /api/proxy/hls as a fallback when the provider proxy URL is blocked.
      directM3u8: unwrapProxyUrl(stream.proxiedUrl || stream.m3u8 || '') || null,
      referer: stream.referer || null,
      subtitles: stream.subtitles,
      intro: stream.intro,
      outro: stream.outro,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Stream fetch failed', detail: String(e) });
  }
});

// Convert one HLS stream to a single MPEG-TS file for native background downloads.
app.get('/api/download/hls', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Missing or invalid ?url=' });
  }

  let ref = `${MEGAPLAY}/`;
  try {
    ref = req.query.ref ? new URL(req.query.ref).toString() : ref;
  } catch {
    return res.status(400).json({ error: 'Invalid referrer' });
  }

  // flikhub m3u8-proxy blocks datacenter IPs (403), which makes ffmpeg exit
  // with zero output while we already sent 200 headers. Unwrap to the direct
  // CDN playlist URL so ffmpeg fetches the stream itself.
  const inputUrl = unwrapProxyUrl(url);

  // Pre-probe the playlist before sending 200 headers: if the upstream is
  // unreachable we can still return a proper JSON error instead of an
  // empty 200 body that clients can only detect via a size guard.
  let probeText = '';
  try {
    const probe = await axios.get(inputUrl, {
      responseType: 'text',
      timeout: 15000,
      maxContentLength: 2 * 1024 * 1024,
      headers: { 'User-Agent': UA, Referer: ref, Origin: new URL(ref).origin },
    });
    probeText = typeof probe.data === 'string' ? probe.data : '';
  } catch (e) {
    console.error('HLS download probe failed:', inputUrl, e.message);
    return res.status(502).json({ error: 'Upstream playlist unreachable', detail: e?.message });
  }

  // Guard against poisoned playlists whose segments are ad images (e.g.
  // signed tiktokcdn .image URLs) instead of media: ffmpeg would exit with
  // zero output after we already sent 200 headers. Fail fast as JSON so
  // clients can fall back to another source.
  try {
    const hasMedia = await playlistHasMediaSegments(inputUrl, probeText, ref);
    if (!hasMedia) {
      console.error('HLS download has no media segments:', inputUrl);
      return res.status(502).json({ error: 'Playlist contains no downloadable media segments' });
    }
  } catch (e) {
    console.error('HLS download media check failed:', inputUrl, e.message);
    // Continue and let ffmpeg try; the byte guard below still applies.
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Content-Disposition', 'attachment; filename="episode.ts"');
  res.setHeader('Cache-Control', 'no-store');

  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-user_agent', UA,
    '-headers', `Referer: ${ref}\r\nOrigin: ${new URL(ref).origin}\r\n`,
    '-i', inputUrl,
    '-map', '0',
    '-c', 'copy',
    '-f', 'mpegts',
    'pipe:1',
  ]);

  let bytesOut = 0;
  ffmpeg.stdout.on('data', (chunk) => { bytesOut += chunk.length; });
  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on('data', data => console.error('HLS download ffmpeg:', data.toString().trim()));
  ffmpeg.on('error', error => {
    console.error('HLS download process failed:', error);
    if (!res.headersSent) res.status(502).json({ error: 'HLS conversion failed' });
    else res.destroy(error);
  });
  ffmpeg.on('close', code => {
    console.log(`HLS download ffmpeg exited code=${code} bytes=${bytesOut} url=${inputUrl}`);
    if (code !== 0 && !res.destroyed) res.destroy(new Error(`ffmpeg exited with ${code}`));
  });
  req.on('close', () => {
    if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
  });
});

// HLS proxy
app.get('/api/proxy/hls', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });

  try {
    const ref = req.query.ref || `${MEGAPLAY}/`;
    const isM3u8 = url.includes('.m3u8') || (req.query.type || '').includes('mpegurl');

    const upstream = await axios.get(url, {
      responseType: isM3u8 ? 'text' : 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': UA, Referer: ref, Origin: new URL(ref).origin },
    });

    let body = upstream.data;
    const contentType = upstream.headers['content-type'] ?? '';

    if (isM3u8 || contentType.includes('mpegurl')) {
      if (typeof body !== 'string') body = body.toString('utf-8');
      const base = url.substring(0, url.lastIndexOf('/') + 1);
      const proxyBase = `https://${req.get('host')}/api/proxy/hls`;
      body = body.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          if (trimmed.includes('URI=')) {
            return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
              const full = uri.startsWith('http') ? uri : base + uri;
              return `URI="${proxyBase}?url=${encodeURIComponent(full)}&ref=${encodeURIComponent(ref)}"`;
            });
          }
          return trimmed;
        }
        const full = trimmed.startsWith('http') ? trimmed : base + trimmed;
        return `${proxyBase}?url=${encodeURIComponent(full)}&ref=${encodeURIComponent(ref)}`;
      }).join('\n');
    }

    res.setHeader(
      'Content-Type',
      isM3u8 ? 'application/vnd.apple.mpegurl' : (contentType || 'application/octet-stream')
    );
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.send(body);
  } catch (e) {
    return res.status(502).json({ error: 'Proxy failed', detail: e?.message });
  }
});

app.listen(PORT, () => {
  console.log(`AniPiece backend v3 (megaplay) running on port ${PORT}`);
});
