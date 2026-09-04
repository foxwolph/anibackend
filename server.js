const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

app.use(cors());
app.use(express.json());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MEGAPLAY = 'https://megaplay.buzz';

const anilistClient = axios.create({
  baseURL: 'https://graphql.anilist.co',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

// ══════════════════════════════════════════════════════════════
// CACHE
// ══════════════════════════════════════════════════════════════
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (!e || e.expiresAt < Date.now()) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data, ttlMs = 300000) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
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

// Probe episode count by testing successive episodes
async function probeEpisodeCount(anilistId, maxEps = 500) {
  const ck = `probe:${anilistId}`;
  const c = cacheGet(ck);
  if (c !== null) return c;

  let lastValid = 0;
  // Binary search would be faster, but for now just probe forward
  for (let ep = 1; ep <= maxEps; ep++) {
    try {
      const streamUrl = `${MEGAPLAY}/stream/ani/${anilistId}/${ep}/sub`;
      const pageRes = await axios.get(streamUrl, {
        headers: { 'User-Agent': UA, Referer: `${MEGAPLAY}/` },
        timeout: 5000,
      });
      const hasFile = /<title>File \d+/.test(pageRes.data);
      if (hasFile) {
        lastValid = ep;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  cacheSet(ck, lastValid, 86400000);
  return lastValid;
}

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '3.0.0', source: 'megaplay' });
});

// Search AniList
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    const results = await searchAnilist(q);
    return res.json({ query: q, count: results.length, results, source: 'anilist' });
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
    if (anilistId) {
      alInfo = await getAnilistInfo(parseInt(anilistId));
      if (!alInfo) return res.status(404).json({ error: 'Anime not found on AniList' });
    }

    const id = alInfo?.anilistId ?? parseInt(anilistId);
    const totalEps = alInfo?.totalEpisodes;

    // If AniList doesn't have episode count, probe from megaplay
    let episodeCount = totalEps;
    if (!episodeCount) {
      episodeCount = await probeEpisodeCount(id);
    }

    if (!episodeCount) return res.status(404).json({ error: 'No episodes found on streaming source' });

    const episodes = [];
    for (let i = 1; i <= episodeCount; i++) {
      episodes.push({ num: i, title: `Episode ${i}`, thumbnail: alInfo?.coverImage || null });
    }

    return res.json({
      anilistId: alInfo?.anilistId ?? parseInt(anilistId) ?? null,
      malId: alInfo?.malId ?? (malId ? parseInt(malId) : null),
      title: alInfo?.title ?? 'Unknown',
      coverImage: alInfo?.coverImage || null,
      episodeCount,
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
    if (!id) return res.status(400).json({ error: 'anilistId is required for streaming' });

    const stream = await getStreamFromMegaplay(id, epNum, type);
    if (!stream) return res.status(502).json({ error: 'Stream extraction failed' });

    let title = null;
    if (anilistId) {
      const alInfo = await getAnilistInfo(parseInt(anilistId));
      title = alInfo?.title;
    }

    return res.json({
      anilistId: id,
      malId: malId ? parseInt(malId) : null,
      title,
      episode: epNum,
      type,
      source: 'megaplay',
      m3u8: stream.m3u8,
      subtitles: stream.subtitles,
      intro: stream.intro,
      outro: stream.outro,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Stream fetch failed', detail: String(e) });
  }
});

// HLS proxy
app.get('/api/proxy/hls', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });

  try {
    const ref = req.query.ref || `${MEGAPLAY}/`;
    const upstream = await axios.get(url, {
      responseType: 'text',
      timeout: 15000,
      headers: { 'User-Agent': UA, Referer: ref, Origin: new URL(ref).origin },
    });

    let body = upstream.data;
    const contentType = upstream.headers['content-type'] ?? '';

    if (url.includes('.m3u8') || contentType.includes('mpegurl')) {
      const base = url.substring(0, url.lastIndexOf('/') + 1);
      const proxyBase = `${req.protocol}://${req.get('host')}/api/proxy/hls`;
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

    res.setHeader('Content-Type', contentType || 'application/octet-stream');
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
