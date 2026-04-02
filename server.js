const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { getVideoDurationInSeconds } = require('get-video-duration');
const http = require('http');
const { Server } = require("socket.io");
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const {
    buildTmdbQueryCandidates,
    findExternalSubtitleMatches,
    humanizeSubtitleLanguage,
    normalizeForComparison,
    pickBestTmdbSearchResult,
    pickMovieCollectionPart,
    reconcileProgressEntries,
    resolveMediaPath
} = require('./lib/media-utils');
require('dotenv').config();

// Rate limiting for external access
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const API_RATE_LIMIT_MAX_REQUESTS = 300;
const VIDEO_RATE_LIMIT_MAX_REQUESTS = 2500;
const PENDING_PLAY_TIMEOUT_MS = 18000;
const SNAPSHOT_FALLBACK_AGE_MS = 15000;
const SNAPSHOT_LEADER_RESPONSE_GRACE_MS = 450;

// --- FFmpeg Path Configuration ---
// If you installed FFmpeg to a different location, update this path.
// Ensure you use double backslashes (\\) in the path.
const ffmpegPath = process.env.FFMPEG_PATH || path.join(__dirname, 'FFMPEG', 'bin', 'ffmpeg.exe');
const ffprobePath = process.env.FFPROBE_PATH || path.join(__dirname, 'FFMPEG', 'bin', 'ffprobe.exe');
try {
    fs.accessSync(ffmpegPath);
    fs.accessSync(ffprobePath);
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
} catch (error) {
    console.warn(
        `FFmpeg not found at "${ffmpegPath}". Set FFMPEG_PATH/FFPROBE_PATH or place FFmpeg in "${path.join(__dirname, 'FFMPEG', 'bin')}".`
    );
}
// --- End Configuration ---

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingInterval: 10000,
    pingTimeout: 20000,
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1e6
});

app.set('trust proxy', true);

// Rate limiting middleware
const createRateLimit = (maxRequests) => (req, res, next) => {
    const clientIp = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
    const now = Date.now();
    const scope = `${clientIp}:${maxRequests}`;
    
    // Clean up old entries
    for (const [ip, data] of rateLimitMap.entries()) {
        if (now - data.windowStart > RATE_LIMIT_WINDOW) {
            rateLimitMap.delete(ip);
        }
    }
    
    // Check current IP
    if (!rateLimitMap.has(scope)) {
        rateLimitMap.set(scope, { windowStart: now, requests: 1 });
        return next();
    }
    
    const ipData = rateLimitMap.get(scope);
    if (now - ipData.windowStart > RATE_LIMIT_WINDOW) {
        // Reset window
        ipData.windowStart = now;
        ipData.requests = 1;
        return next();
    }
    
    if (ipData.requests >= maxRequests) {
        console.log(`[SECURITY] Rate limit exceeded for IP: ${clientIp} (limit: ${maxRequests}/min)`);
        return res.status(429).json({ error: 'Too many requests' });
    }
    
    ipData.requests++;
    next();
};

// Security middleware
app.use((req, res, next) => {
    // Add security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Log external access attempts
    const isExternal = !req.ip?.includes('127.0.0.1') && !req.ip?.includes('localhost') && !req.ip?.includes('::1');
    if (isExternal) {
        console.log(`[EXTERNAL ACCESS] ${req.method} ${req.url} from ${req.ip}`);
    }
    
    next();
});

// Apply rate limiting to video routes and API endpoints
app.use('/videos', createRateLimit(VIDEO_RATE_LIMIT_MAX_REQUESTS));
app.use('/api', createRateLimit(API_RATE_LIMIT_MAX_REQUESTS));

// Body parser for JSON requests
app.use(express.json({ limit: '1mb' }));

const port = Number(process.env.PORT) || 8000;
const progressFilePath = process.env.PROGRESS_FILE_PATH || path.join(__dirname, 'progress.json');
const cacheDirectory = process.env.CACHE_DIRECTORY || path.join(__dirname, '.cache');
const thumbnailsDirectory = path.join(cacheDirectory, 'thumbnails');
const subtitlesCacheDirectory = path.join(cacheDirectory, 'subtitles');
const folderThumbnailsDirectory = path.join(cacheDirectory, 'folder-thumbnails');
const tmdbCacheDirectory = path.join(cacheDirectory, 'tmdb');
const thumbnailOverridesPath = path.join(cacheDirectory, 'thumbnail-overrides.json');
const metadataOverridesPath = path.join(cacheDirectory, 'metadata-overrides.json');
const roomPersistencePath = path.join(cacheDirectory, 'room-state.json');
const telemetryPersistencePath = path.join(cacheDirectory, 'telemetry-events.json');

const roomLeaders = {};
const roomStates = {};
const sharedRooms = new Map();
const probeCache = new Map();
const thumbnailGenerationQueue = new Map();
const PROBE_CACHE_TTL_MS = Number(process.env.PROBE_CACHE_TTL_MS) || 5 * 60 * 1000;
const durationCache = new Map();
const DURATION_CACHE_TTL_MS = Number(process.env.DURATION_CACHE_TTL_MS) || 30 * 60 * 1000;
const PROGRESS_FLUSH_DEBOUNCE_MS = Number(process.env.PROGRESS_FLUSH_DEBOUNCE_MS) || 250;
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 12 * 60 * 60 * 1000;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
let progressCache = null;
let progressCacheLoadPromise = null;
let progressFlushTimer = null;
let progressFlushPromise = null;
let progressDirty = false;
let thumbnailOverridesCache = null;
let metadataOverridesCache = null;
let roomStatePersistTimer = null;
let roomStatePersistPromise = null;
let telemetryPersistTimer = null;
let telemetryPersistPromise = null;
const searchIndexState = { entries: null, builtAt: 0, promise: null };
const homepageResponseCache = { payload: null, expiresAt: 0, promise: null };
const directoryResponseCache = new Map();
const playbackTelemetry = [];
const pendingSnapshotFallbacks = new Map();

const TMDB_CACHE_TTL_MS = Number(process.env.TMDB_CACHE_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
const TMDB_PINNED_CACHE_TTL_MS = Number(process.env.TMDB_PINNED_CACHE_TTL_MS) || 30 * 24 * 60 * 60 * 1000;
const TMDB_MISS_CACHE_TTL_MS = Number(process.env.TMDB_MISS_CACHE_TTL_MS) || 24 * 60 * 60 * 1000;
const TMDB_CACHE_VERSION = 'v3';
const SEARCH_INDEX_TTL_MS = Number(process.env.SEARCH_INDEX_TTL_MS) || 2 * 60 * 1000;
const LIBRARY_RESPONSE_CACHE_TTL_MS = Number(process.env.LIBRARY_RESPONSE_CACHE_TTL_MS) || 15 * 1000;
const ROOM_STATE_PERSIST_DEBOUNCE_MS = Number(process.env.ROOM_STATE_PERSIST_DEBOUNCE_MS) || 300;
const TELEMETRY_PERSIST_DEBOUNCE_MS = Number(process.env.TELEMETRY_PERSIST_DEBOUNCE_MS) || 500;
const TELEMETRY_MAX_EVENTS = Number(process.env.TELEMETRY_MAX_EVENTS) || 500;

const IGNORED_ROOT_FOLDERS = ['movies', 'series', 'anime'];
const SEASON_PATTERN = /^season \d+(-\d+)?$/i;
const DIRECT_MEDIA_EXTENSIONS = new Set([
    '.mp4',
    '.m4v',
    '.webm',
    '.srt',
    '.vtt',
    '.ass',
    '.ssa',
    '.sub',
    '.jpg',
    '.jpeg',
    '.png',
    '.webp'
]);

// Natural sorting function for episode numbers
function naturalSort(a, b) {
    // Handle numeric comparison within strings
    const aName = typeof a === 'string' ? a : a.name;
    const bName = typeof b === 'string' ? b : b.name;
    
    return aName.localeCompare(bName, undefined, {
        numeric: true,
        sensitivity: 'base'
    });
}

function invalidateLibraryCaches({ search = false, homepage = true, directories = true } = {}) {
    if (search) {
        searchIndexState.entries = null;
        searchIndexState.builtAt = 0;
        searchIndexState.promise = null;
    }

    if (homepage) {
        homepageResponseCache.payload = null;
        homepageResponseCache.expiresAt = 0;
        homepageResponseCache.promise = null;
    }

    if (directories) {
        directoryResponseCache.clear();
    }
}

function snapshotPersistableRoomState() {
    return {
        sharedRooms: [...sharedRooms.values()].map((room) => ({
            roomCode: room.roomCode,
            roomKey: room.roomKey,
            videoFile: room.videoFile,
            createdAt: room.createdAt,
            lastUsedAt: room.lastUsedAt
        })),
        roomSnapshots: Object.entries(roomStates).map(([roomKey, state]) => ({
            roomKey,
            syncSnapshot: state?.syncSnapshot || null,
            lastPartnerDisconnectAt: state?.lastPartnerDisconnectAt || 0
        }))
    };
}

async function flushPersistedRoomState() {
    if (roomStatePersistTimer) {
        clearTimeout(roomStatePersistTimer);
        roomStatePersistTimer = null;
    }

    const payload = snapshotPersistableRoomState();
    roomStatePersistPromise = fsp.writeFile(roomPersistencePath, JSON.stringify(payload, null, 2), 'utf8')
        .finally(() => {
            roomStatePersistPromise = null;
        });

    await roomStatePersistPromise;
}

function scheduleRoomStatePersist() {
    if (roomStatePersistTimer) {
        clearTimeout(roomStatePersistTimer);
    }

    roomStatePersistTimer = setTimeout(() => {
        void flushPersistedRoomState().catch((error) => {
            console.error('Failed to persist room state:', error);
        });
    }, ROOM_STATE_PERSIST_DEBOUNCE_MS);
}

async function hydratePersistedRoomState() {
    try {
        const raw = await fsp.readFile(roomPersistencePath, 'utf8');
        const persisted = JSON.parse(raw);

        for (const room of persisted?.sharedRooms || []) {
            if (!room?.roomCode || !room?.roomKey || !room?.videoFile) {
                continue;
            }
            sharedRooms.set(String(room.roomCode).trim().toUpperCase(), {
                roomCode: String(room.roomCode).trim().toUpperCase(),
                roomKey: room.roomKey,
                videoFile: room.videoFile,
                createdAt: Number(room.createdAt) || Date.now(),
                lastUsedAt: Number(room.lastUsedAt) || Date.now()
            });
        }

        for (const roomSnapshot of persisted?.roomSnapshots || []) {
            if (!roomSnapshot?.roomKey) {
                continue;
            }
            roomStates[roomSnapshot.roomKey] = {
                pendingAction: null,
                pendingActionTimer: null,
                clients: {},
                lastPartnerDisconnectAt: Number(roomSnapshot.lastPartnerDisconnectAt) || 0,
                syncSnapshot: roomSnapshot.syncSnapshot || null
            };
        }
    } catch (error) {
        // No persisted room state yet.
    }
}

function summarizeTelemetry() {
    const counts = {};
    for (const event of playbackTelemetry) {
        counts[event.type] = (counts[event.type] || 0) + 1;
    }

    return {
        totalEvents: playbackTelemetry.length,
        counts,
        recent: playbackTelemetry.slice(-50).reverse()
    };
}

function recordPlaybackTelemetry(event = {}) {
    const normalizedEvent = {
        type: String(event.type || 'unknown').trim() || 'unknown',
        detail: String(event.detail || '').trim(),
        roomCode: String(event.roomCode || '').trim() || null,
        videoFile: String(event.videoFile || '').trim() || null,
        seekId: String(event.seekId || '').trim() || null,
        source: String(event.source || '').trim() || null,
        playbackMode: String(event.playbackMode || '').trim() || null,
        driftMs: Number.isFinite(Number(event.driftMs)) ? Number(event.driftMs) : null,
        timestamp: Number(event.timestamp) || Date.now()
    };
    playbackTelemetry.push(normalizedEvent);
    if (playbackTelemetry.length > TELEMETRY_MAX_EVENTS) {
        playbackTelemetry.splice(0, playbackTelemetry.length - TELEMETRY_MAX_EVENTS);
    }

    if (telemetryPersistTimer) {
        clearTimeout(telemetryPersistTimer);
    }

    telemetryPersistTimer = setTimeout(() => {
        telemetryPersistPromise = fsp.writeFile(telemetryPersistencePath, JSON.stringify(playbackTelemetry, null, 2), 'utf8')
            .catch((error) => {
                console.error('Failed to persist playback telemetry:', error);
            })
            .finally(() => {
                telemetryPersistPromise = null;
            });
    }, TELEMETRY_PERSIST_DEBOUNCE_MS);
}

async function hydrateTelemetry() {
    try {
        const raw = await fsp.readFile(telemetryPersistencePath, 'utf8');
        const persisted = JSON.parse(raw);
        if (Array.isArray(persisted)) {
            playbackTelemetry.push(...persisted.slice(-TELEMETRY_MAX_EVENTS));
        }
    } catch (error) {
        // No persisted telemetry yet.
    }
}

function getDirectoryCacheEntry(relativePath) {
    const key = String(relativePath || '');
    const entry = directoryResponseCache.get(key);
    if (!entry) {
        return null;
    }

    if (entry.payload && entry.expiresAt > Date.now()) {
        return entry;
    }

    if (!entry.promise) {
        directoryResponseCache.delete(key);
        return null;
    }

    return entry;
}

async function runQueuedJob(queueMap, queueKey, job) {
    const normalizedKey = String(queueKey || '').toLowerCase();
    if (queueMap.has(normalizedKey)) {
        return queueMap.get(normalizedKey);
    }

    const queuedPromise = Promise.resolve()
        .then(job)
        .finally(() => {
            if (queueMap.get(normalizedKey) === queuedPromise) {
                queueMap.delete(normalizedKey);
            }
        });

    queueMap.set(normalizedKey, queuedPromise);
    return queuedPromise;
}

async function ensureThumbnailFile(sourcePath, thumbnailPath, options = {}) {
    if (fs.existsSync(thumbnailPath)) {
        return thumbnailPath;
    }

    await runQueuedJob(thumbnailGenerationQueue, thumbnailPath, async () => {
        if (fs.existsSync(thumbnailPath)) {
            return;
        }
        await generateThumbnail(sourcePath, thumbnailPath, options);
    });

    return thumbnailPath;
}

function getTmdbCacheTtl(cacheEntry) {
    if (cacheEntry?.kind === 'pinned') {
        return TMDB_PINNED_CACHE_TTL_MS;
    }
    if (cacheEntry?.kind === 'miss') {
        return TMDB_MISS_CACHE_TTL_MS;
    }
    return TMDB_CACHE_TTL_MS;
}

async function writeTmdbCacheEntry(cachePath, data, kind = 'success') {
    await fsp.writeFile(cachePath, JSON.stringify({
        savedAt: Date.now(),
        kind,
        data
    }, null, 2), 'utf8').catch(() => {});
}

async function buildSearchIndex() {
    const allVideoFiles = await findVideoFiles(videosDirectory);
    return allVideoFiles
        .map((file) => file.replace(/\\/g, '/'))
        .sort(naturalSort)
        .map((relativePath) => {
            const baseName = path.basename(relativePath);
            const directoryName = path.dirname(relativePath).replace(/\\/g, '/');
            const episodeMeta = extractEpisodeMetadata(baseName);
            const seriesPath = directoryName === '.' ? '' : path.dirname(directoryName).replace(/\\/g, '/');

            return {
                relativePath,
                baseName,
                directoryName,
                seriesPath: seriesPath === '.' ? '' : seriesPath,
                episodeMeta,
                normalizedPath: normalizeForComparison(relativePath),
                normalizedName: normalizeForComparison(baseName),
                normalizedDirectory: normalizeForComparison(directoryName),
                normalizedSeriesPath: normalizeForComparison(seriesPath)
            };
        });
}

async function getSearchIndex() {
    const now = Date.now();
    if (searchIndexState.entries && (now - searchIndexState.builtAt) < SEARCH_INDEX_TTL_MS) {
        return searchIndexState.entries;
    }

    if (searchIndexState.promise) {
        return searchIndexState.promise;
    }

    searchIndexState.promise = buildSearchIndex()
        .then((entries) => {
            searchIndexState.entries = entries;
            searchIndexState.builtAt = Date.now();
            return entries;
        })
        .finally(() => {
            searchIndexState.promise = null;
        });

    return searchIndexState.promise;
}

function scoreSearchEntry(entry, normalizedQuery, queryTokens = []) {
    let score = 0;

    if (entry.normalizedName === normalizedQuery) score += 5000;
    if (entry.normalizedPath === normalizedQuery) score += 4200;
    if (entry.normalizedSeriesPath === normalizedQuery) score += 3800;

    if (entry.normalizedName.includes(normalizedQuery)) score += 2600;
    if (entry.normalizedSeriesPath.includes(normalizedQuery)) score += 1800;
    if (entry.normalizedPath.includes(normalizedQuery)) score += 1500;
    if (entry.normalizedDirectory.includes(normalizedQuery)) score += 1100;

    if (entry.episodeMeta?.seasonNumber != null && entry.episodeMeta?.episodeNumber != null) {
        const seasonEpisode = `s${entry.episodeMeta.seasonNumber}e${entry.episodeMeta.episodeNumber}`;
        const altSeasonEpisode = `${entry.episodeMeta.seasonNumber}x${entry.episodeMeta.episodeNumber}`;
        if (normalizedQuery === seasonEpisode || normalizedQuery === altSeasonEpisode) {
            score += 2200;
        }
    }

    if (queryTokens.length > 0) {
        const nameTokens = new Set(entry.normalizedName.split(' ').filter(Boolean));
        const pathTokens = new Set(entry.normalizedPath.split(' ').filter(Boolean));
        const overlap = queryTokens.filter((token) => nameTokens.has(token) || pathTokens.has(token)).length;
        score += overlap * 320;
        if (overlap === queryTokens.length) {
            score += 900;
        }
    }

    return score;
}

// Create cache and thumbnails directories if they don't exist
if (!fs.existsSync(cacheDirectory)) fs.mkdirSync(cacheDirectory);
if (!fs.existsSync(thumbnailsDirectory)) fs.mkdirSync(thumbnailsDirectory);
if (!fs.existsSync(subtitlesCacheDirectory)) fs.mkdirSync(subtitlesCacheDirectory);
if (!fs.existsSync(folderThumbnailsDirectory)) fs.mkdirSync(folderThumbnailsDirectory);
if (!fs.existsSync(tmdbCacheDirectory)) fs.mkdirSync(tmdbCacheDirectory);

const videosDirectory = process.env.VIDEOS_DIRECTORY || 'E:\\Media';
const publicDirectory = path.join(__dirname, 'public');
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OPENSUBTITLES_API_BASE = 'https://api.opensubtitles.com/api/v1';
const OPENSUBTITLES_API_KEY = String(process.env.OPENSUBTITLES_API_KEY || '').trim();
const OPENSUBTITLES_USERNAME = String(process.env.OPENSUBTITLES_USERNAME || '').trim();
const OPENSUBTITLES_PASSWORD = String(process.env.OPENSUBTITLES_PASSWORD || '').trim();
const OPENSUBTITLES_USER_AGENT = String(process.env.OPENSUBTITLES_USER_AGENT || 'TogetherVideo v1').trim();
let openSubtitlesSession = {
    token: null,
    expiresAt: 0
};

void Promise.all([
    hydratePersistedRoomState(),
    hydrateTelemetry()
]);

function getResolvedMediaOrThrow(requestedPath, { mustExist = true, errorCode = 404 } = {}) {
    const resolvedMedia = resolveMediaPath(videosDirectory, requestedPath, { mustExist });
    if (!resolvedMedia) {
        const error = new Error(mustExist ? 'Media not found' : 'Forbidden');
        error.statusCode = errorCode;
        throw error;
    }
    return resolvedMedia;
}

function ffprobeAsync(videoFullPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoFullPath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(metadata);
        });
    });
}

function createCacheHash(value) {
    return crypto.createHash('md5').update(String(value)).digest('hex');
}

function openSubtitlesConfigured() {
    return Boolean(OPENSUBTITLES_API_KEY && OPENSUBTITLES_USERNAME && OPENSUBTITLES_PASSWORD);
}

function buildOpenSubtitlesHeaders({ authorized = false } = {}) {
    const headers = {
        'Api-Key': OPENSUBTITLES_API_KEY,
        'User-Agent': OPENSUBTITLES_USER_AGENT
    };
    if (authorized && openSubtitlesSession.token) {
        headers.Authorization = `Bearer ${openSubtitlesSession.token}`;
    }
    return headers;
}

async function getOpenSubtitlesToken(forceRefresh = false) {
    if (!openSubtitlesConfigured()) {
        throw new Error('Automatic subtitle download is not configured');
    }

    if (!forceRefresh && openSubtitlesSession.token && Date.now() < openSubtitlesSession.expiresAt) {
        return openSubtitlesSession.token;
    }

    const response = await axios.post(`${OPENSUBTITLES_API_BASE}/login`, {
        username: OPENSUBTITLES_USERNAME,
        password: OPENSUBTITLES_PASSWORD
    }, {
        headers: {
            ...buildOpenSubtitlesHeaders(),
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });

    const token = String(response.data?.token || '').trim();
    if (!token) {
        throw new Error('OpenSubtitles login did not return a token');
    }

    openSubtitlesSession = {
        token,
        expiresAt: Date.now() + (45 * 60 * 1000)
    };

    return token;
}

function cleanSubtitleQueryTitle(title = '') {
    return String(title || '')
        .replace(/\.[^.]+$/g, '')
        .replace(/\b(2160p|1080p|720p|480p|web[ -]?dl|webrip|bluray|brrip|ddp\d(?:\.\d)?|dd\d(?:\.\d)?|aac(?:\d(?:\.\d)?)?|x264|x265|h\.?264|h\.?265|hevc|proper|repack|amzn|nf|dsnp|max|atvp|flux|rawr)\b/ig, ' ')
        .replace(/[._]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getAutomaticSubtitleCacheInfo(videoRelativePath) {
    const hash = createCacheHash(`auto-subtitle:v1:${videoRelativePath}`);
    const fileName = `${hash}.srt`;
    const filePath = path.join(subtitlesCacheDirectory, fileName);
    return {
        fileName,
        filePath,
        url: `/subtitles/${fileName}`
    };
}

async function getCachedAutomaticSubtitleEntry(videoRelativePath) {
    const cacheInfo = getAutomaticSubtitleCacheInfo(videoRelativePath);
    try {
        await fsp.access(cacheInfo.filePath);
        return {
            lang: 'English (Auto)',
            meta: 'Previously downloaded for this episode',
            source: 'auto',
            url: cacheInfo.url
        };
    } catch (error) {
        return null;
    }
}

async function buildAutomaticSubtitleContext(videoRelativePath) {
    const normalizedVideoPath = String(videoRelativePath || '').replace(/\\/g, '/');
    const isMovie = normalizedVideoPath.toLowerCase().startsWith('movies/');
    const episodeMeta = extractEpisodeMetadata(path.basename(normalizedVideoPath));
    let lookupPath = path.dirname(normalizedVideoPath).replace(/\\/g, '/');

    if (!isMovie && /season/i.test(path.basename(lookupPath))) {
        lookupPath = path.dirname(lookupPath).replace(/\\/g, '/');
    }

    const tmdbInfo = await getTmdbInfo(lookupPath, isMovie ? 'movie' : 'tv').catch(() => null);
    const baseTitle = cleanSubtitleQueryTitle(
        tmdbInfo?.matchedTitle ||
        tmdbInfo?.name ||
        path.basename(lookupPath) ||
        path.basename(normalizedVideoPath, path.extname(normalizedVideoPath))
    );

    return {
        type: isMovie ? 'movie' : 'episode',
        title: baseTitle,
        tmdbId: Number(tmdbInfo?.tmdbId) || null,
        seasonNumber: episodeMeta.seasonNumber,
        episodeNumber: episodeMeta.episodeNumber,
        videoRelativePath: normalizedVideoPath
    };
}

function pickBestAutomaticSubtitle(results = [], context = {}) {
    const normalizedTitle = normalizeForComparison(context.title || '');
    const scored = results.map((item) => {
        const attributes = item?.attributes || {};
        const feature = attributes.feature_details || {};
        const files = Array.isArray(attributes.files) ? attributes.files : [];
        const file = files.find((entry) => entry?.file_id) || files[0];
        const descriptor = normalizeForComparison([
            attributes.release,
            attributes.file_name,
            feature.movie_name,
            feature.title
        ].filter(Boolean).join(' '));

        let score = Number(attributes.download_count) || 0;
        if (String(attributes.language || '').toLowerCase().startsWith('en')) score += 400;
        if (!attributes.hearing_impaired) score += 40;
        if (context.tmdbId && Number(feature.tmdb_id || attributes.tmdb_id) === context.tmdbId) score += 500;
        if (descriptor.includes(normalizedTitle)) score += 160;
        if (context.type === 'episode') {
            if (Number(feature.season_number) === context.seasonNumber) score += 600;
            if (Number(feature.episode_number) === context.episodeNumber) score += 900;
        }

        return {
            score,
            attributes,
            fileId: Number(file?.file_id) || null
        };
    }).filter((item) => item.fileId);

    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
}

async function searchAutomaticSubtitle(context) {
    const token = await getOpenSubtitlesToken();
    const params = {
        languages: 'en',
        order_by: 'download_count',
        order_direction: 'desc',
        query: context.title
    };

    if (context.type === 'movie') {
        params.type = 'movie';
    } else {
        params.type = 'episode';
        if (context.seasonNumber != null) params.season_number = context.seasonNumber;
        if (context.episodeNumber != null) params.episode_number = context.episodeNumber;
    }
    if (context.tmdbId) {
        params.tmdb_id = context.tmdbId;
    }

    const response = await axios.get(`${OPENSUBTITLES_API_BASE}/subtitles`, {
        headers: {
            ...buildOpenSubtitlesHeaders({ authorized: true }),
            Authorization: `Bearer ${token}`
        },
        params,
        timeout: 15000
    });

    const bestMatch = pickBestAutomaticSubtitle(response.data?.data || [], context);
    if (!bestMatch) {
        throw new Error('No matching English subtitles were found for this episode');
    }

    return bestMatch;
}

async function downloadAutomaticSubtitle(fileId) {
    let token = await getOpenSubtitlesToken();

    try {
        const response = await axios.post(`${OPENSUBTITLES_API_BASE}/download`, {
            file_id: fileId,
            sub_format: 'srt'
        }, {
            headers: {
                ...buildOpenSubtitlesHeaders({ authorized: true }),
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        const link = String(response.data?.link || '').trim();
        if (!link) {
            throw new Error('Subtitle provider did not return a download link');
        }

        const subtitleResponse = await axios.get(link, {
            responseType: 'text',
            timeout: 20000
        });

        if (typeof subtitleResponse.data !== 'string' || !subtitleResponse.data.trim()) {
            throw new Error('Downloaded subtitle file was empty');
        }

        return subtitleResponse.data;
    } catch (error) {
        if (error.response?.status === 401) {
            token = await getOpenSubtitlesToken(true);
            const retry = await axios.post(`${OPENSUBTITLES_API_BASE}/download`, {
                file_id: fileId,
                sub_format: 'srt'
            }, {
                headers: {
                    ...buildOpenSubtitlesHeaders({ authorized: true }),
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            });
            const link = String(retry.data?.link || '').trim();
            if (!link) {
                throw new Error('Subtitle provider did not return a download link');
            }
            const subtitleResponse = await axios.get(link, {
                responseType: 'text',
                timeout: 20000
            });
            if (typeof subtitleResponse.data !== 'string' || !subtitleResponse.data.trim()) {
                throw new Error('Downloaded subtitle file was empty');
            }
            return subtitleResponse.data;
        }

        throw error;
    }
}

async function readThumbnailOverrides() {
    if (thumbnailOverridesCache) {
        return thumbnailOverridesCache;
    }

    try {
        const raw = await fsp.readFile(thumbnailOverridesPath, 'utf8');
        thumbnailOverridesCache = JSON.parse(raw);
    } catch (error) {
        thumbnailOverridesCache = {};
    }

    return thumbnailOverridesCache;
}

async function writeThumbnailOverrides(overrides) {
    thumbnailOverridesCache = overrides;
    await fsp.writeFile(thumbnailOverridesPath, JSON.stringify(overrides, null, 2), 'utf8');
    invalidateLibraryCaches();
}

async function readMetadataOverrides() {
    if (metadataOverridesCache) {
        return metadataOverridesCache;
    }

    try {
        const raw = await fsp.readFile(metadataOverridesPath, 'utf8');
        metadataOverridesCache = JSON.parse(raw);
    } catch (error) {
        metadataOverridesCache = {};
    }

    return metadataOverridesCache;
}

async function writeMetadataOverrides(overrides) {
    metadataOverridesCache = overrides;
    await fsp.writeFile(metadataOverridesPath, JSON.stringify(overrides, null, 2), 'utf8');
    invalidateLibraryCaches();
}

function normalizeSeriesPath(relativePath = '') {
    const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized || normalized === '.') {
        return '';
    }
    const dirName = path.basename(normalized);
    if (SEASON_PATTERN.test(dirName)) {
        const parent = path.dirname(normalized).replace(/\\/g, '/');
        return parent === '.' ? normalized : parent;
    }
    return normalized;
}

async function getThumbnailOverride(relativePath) {
    const normalized = normalizeSeriesPath(relativePath);
    if (!normalized) {
        return null;
    }
    const overrides = await readThumbnailOverrides();
    return overrides[normalized] || null;
}

async function setThumbnailOverride(relativePath, override) {
    const normalized = normalizeSeriesPath(relativePath);
    if (!normalized) {
        return;
    }
    const overrides = await readThumbnailOverrides();
    if (override) {
        overrides[normalized] = {
            ...override,
            updatedAt: Date.now()
        };
    } else {
        delete overrides[normalized];
    }
    await writeThumbnailOverrides(overrides);
}

async function getMetadataOverride(relativePath) {
    const normalized = normalizeSeriesPath(relativePath);
    if (!normalized) {
        return null;
    }

    const overrides = await readMetadataOverrides();
    return overrides[normalized] || null;
}

async function setMetadataOverride(relativePath, override) {
    const normalized = normalizeSeriesPath(relativePath);
    if (!normalized) {
        return;
    }

    const overrides = await readMetadataOverrides();
    if (override) {
        overrides[normalized] = {
            ...override,
            updatedAt: Date.now(),
            locked: true
        };
    } else {
        delete overrides[normalized];
    }
    await writeMetadataOverrides(overrides);
}

async function applyThumbnailOverride(relativePath, target) {
    const override = await getThumbnailOverride(relativePath);
    if (!override?.url || !target) {
        return target;
    }
    target.posterUrl = override.url;
    target.thumbnailUrl = override.url;
    target.thumbnailOverride = override;
    return target;
}

async function applyMetadataOverride(relativePath, target) {
    const override = await getMetadataOverride(relativePath);
    if (!override || !target) {
        return target;
    }

    return Object.assign(target, override, {
        metadataOverride: override
    });
}

async function clearTmdbCacheForPath(relativePath) {
    const normalized = normalizeSeriesPath(relativePath);
    if (!normalized) {
        return;
    }

    const cachePaths = [
        path.join(tmdbCacheDirectory, `${createCacheHash(`${TMDB_CACHE_VERSION}:tv:${normalized}`)}.json`),
        path.join(tmdbCacheDirectory, `${createCacheHash(`${TMDB_CACHE_VERSION}:movie:${normalized}`)}.json`)
    ];

    await Promise.all(cachePaths.map(cachePath => fsp.rm(cachePath, { force: true }).catch(() => {})));
}

function classifyVideoMetadata(metadata, videoRelativePath) {
    const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
    const audioTracks = metadata.streams
        .filter(stream => stream.codec_type === 'audio')
        .map((stream, order) => {
            const language = humanizeSubtitleLanguage(stream.tags?.language, `Track ${order + 1}`);
            const title = String(stream.tags?.title || '').trim();
            const codec = String(stream.codec_name || 'unknown').toUpperCase();
            const channelLabel = Number(stream.channels) > 0 ? `${stream.channels}ch` : null;
            const labelParts = [language];
            if (title && title.toLowerCase() !== language.toLowerCase()) {
                labelParts.push(title);
            }
            if (channelLabel) {
                labelParts.push(channelLabel);
            }
            labelParts.push(codec);

            return {
                index: stream.index,
                order,
                language,
                title: title || null,
                codec: stream.codec_name || 'unknown',
                channels: Number(stream.channels) || null,
                isDefault: Boolean(stream.disposition?.default),
                label: labelParts.filter(Boolean).join(' • ')
            };
        });
    const audioStream = metadata.streams.find(stream => stream.codec_type === 'audio');
    const isProblematic = Boolean(
        videoStream && (
            videoStream.codec_name === 'hevc' ||
            videoRelativePath.endsWith('.mkv') ||
            (audioStream && !['aac', 'mp3'].includes(audioStream.codec_name))
        )
    );

    return {
        metadata,
        videoStream,
        audioStream,
        audioTracks,
        isProblematic,
        duration: Number(metadata.format?.duration || 0),
        bitrateKbps: Math.round((Number(metadata.format?.bit_rate || videoStream?.bit_rate || 0) || 0) / 1000),
        width: Number(videoStream?.width || 0) || 0,
        height: Number(videoStream?.height || 0) || 0
    };
}

async function getCachedProbeResult(videoFullPath, videoRelativePath) {
    const cacheKey = videoFullPath.toLowerCase();
    const fileStats = await fsp.stat(videoFullPath);
    const existingEntry = probeCache.get(cacheKey);

    if (existingEntry) {
        const cacheIsFresh = (Date.now() - existingEntry.cachedAt) < PROBE_CACHE_TTL_MS;
        if (existingEntry.mtimeMs === fileStats.mtimeMs && cacheIsFresh) {
            if (existingEntry.promise) {
                return existingEntry.promise;
            }
            return existingEntry.result;
        }
    }

    const probePromise = ffprobeAsync(videoFullPath)
        .then(metadata => {
            const result = classifyVideoMetadata(metadata, videoRelativePath);
            probeCache.set(cacheKey, {
                cachedAt: Date.now(),
                mtimeMs: fileStats.mtimeMs,
                result
            });
            return result;
        })
        .catch(error => {
            probeCache.delete(cacheKey);
            throw error;
        });

    probeCache.set(cacheKey, {
        cachedAt: Date.now(),
        mtimeMs: fileStats.mtimeMs,
        promise: probePromise
    });

    return probePromise;
}

async function getCachedVideoDuration(videoFullPath) {
    const cacheKey = videoFullPath.toLowerCase();
    const fileStats = await fsp.stat(videoFullPath);
    const existingEntry = durationCache.get(cacheKey);

    if (existingEntry) {
        const cacheIsFresh = (Date.now() - existingEntry.cachedAt) < DURATION_CACHE_TTL_MS;
        if (existingEntry.mtimeMs === fileStats.mtimeMs && cacheIsFresh) {
            if (existingEntry.promise) {
                return existingEntry.promise;
            }
            return existingEntry.duration;
        }
    }

    const durationPromise = getVideoDurationInSeconds(videoFullPath)
        .then(duration => {
            durationCache.set(cacheKey, {
                cachedAt: Date.now(),
                mtimeMs: fileStats.mtimeMs,
                duration
            });
            return duration;
        })
        .catch(error => {
            durationCache.delete(cacheKey);
            throw error;
        });

    durationCache.set(cacheKey, {
        cachedAt: Date.now(),
        mtimeMs: fileStats.mtimeMs,
        promise: durationPromise
    });

    return durationPromise;
}

// Serve frontend assets without persistent browser caching so UI changes appear immediately.
app.use(express.static(publicDirectory, {
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

// --- Smart Transcoding Middleware for HEVC ---
// This middleware intercepts requests for video files. It checks if the video is
// encoded in HEVC (H.265). If it is, it transcodes the video on-the-fly to
// the browser-compatible H.264 format. Otherwise, it passes the request to the
// standard static file server. This provides compatibility for difficult formats
// without sacrificing performance for standard files.

// Cloudflare tunnel video streaming optimization middleware
const cloudflareVideoMiddleware = (req, res, next) => {
    // Check if request is coming through Cloudflare tunnel
    const cfHeaders = req.headers['cf-ray'] || req.headers['cf-connecting-ip'] || 
                     req.headers['cf-visitor'] || req.headers['x-forwarded-for'];
    const isCloudflare = !!cfHeaders;
    
    if (isCloudflare && req.path.includes('/videos/')) {
        console.log(`[CLOUDFLARE] Video request via tunnel detected: ${req.path}`);
        
        // Force HTTP/1.1 for video streaming to prevent HTTP/2 stream cancellation
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        
        // Add Cloudflare-specific headers for better streaming
        res.setHeader('CF-Cache-Status', 'BYPASS');
        res.setHeader('CF-Worker', 'togethervideo');
        
        // Prevent HTTP/2 server push which can cause issues
        res.setHeader('X-No-Push', '1');
        
        // Enhanced error handling for stream cancellation
        const originalWrite = res.write;
        const originalEnd = res.end;
        
        res.write = function(chunk, encoding) {
            try {
                return originalWrite.call(this, chunk, encoding);
            } catch (error) {
                if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
                    console.log(`[CLOUDFLARE] Client disconnected during streaming: ${req.path}`);
                    return false;
                }
                throw error;
            }
        };
        
        res.end = function(chunk, encoding) {
            try {
                return originalEnd.call(this, chunk, encoding);
            } catch (error) {
                if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
                    console.log(`[CLOUDFLARE] Stream ended - client disconnected: ${req.path}`);
                    return;
                }
                throw error;
            }
        };
    }
    
    next();
};

// Apply Cloudflare middleware before video routes
app.use('/videos', cloudflareVideoMiddleware);

app.use('/videos/:videoPath(*)', (req, res, next) => {
    const videoRelativePath = req.params.videoPath;
    const decodedRelativePath = decodeURIComponent(videoRelativePath);
    let resolvedMedia = null;

    try {
        resolvedMedia = getResolvedMediaOrThrow(decodedRelativePath);
    } catch (error) {
        const statusCode = error.statusCode || 404;
        console.error(`[ERROR] Invalid video path requested: ${decodedRelativePath}`);
        return res.status(statusCode).end();
    }

    const videoFullPath = resolvedMedia.fullPath;
    const canonicalRelativePath = resolvedMedia.relativePath;
    const fileExtension = path.extname(videoFullPath).toLowerCase();

    console.log(`[REQUEST] Received request for: ${canonicalRelativePath}`);
    console.log(`[REQUEST] User-Agent: ${req.get('User-Agent')}`);
    console.log(`[REQUEST] Query params: ${JSON.stringify(req.query)}`);
    console.log(`[PATH] Full constructed path: ${videoFullPath}`);

    const parsedSeekTime = Number.parseFloat(String(req.query.t || '0'));
    const seekTime = Number.isFinite(parsedSeekTime) && parsedSeekTime > 0 ? parsedSeekTime : 0;
    const isSeekRequest = seekTime > 0;
    const quality = String(req.query.quality || 'auto').toLowerCase();
    const playbackMode = String(req.query.mode || 'auto').toLowerCase();
    const allowDirectPassthrough =
        DIRECT_MEDIA_EXTENSIONS.has(fileExtension) &&
        !isSeekRequest &&
        quality === 'auto' &&
        playbackMode !== 'compatibility' &&
        playbackMode !== 'data-saver';

    if (allowDirectPassthrough) {
        console.log(`[STATIC] Direct file passthrough for: ${canonicalRelativePath}`);
        return res.sendFile(videoFullPath);
    }
    
    console.log('[PROBE] Probing file with ffprobe...');
    getCachedProbeResult(videoFullPath, canonicalRelativePath)
        .then(({ videoStream, audioStream, audioTracks, isProblematic }) => {
            console.log(`[PROBE_SUCCESS] ffprobe successful for: ${canonicalRelativePath}`);
            console.log(`[CODEC_INFO] Video: ${videoStream?.codec_name || 'unknown'}, Audio: ${audioStream?.codec_name || 'unknown'}, Problematic: ${isProblematic}`);

            const requestedAudioIndex = Number.parseInt(String(req.query.audio || ''), 10);
            const forceOriginal = playbackMode === 'original';
            const forceCompatibility = playbackMode === 'compatibility' || playbackMode === 'data-saver';
            const needsTranscoding = isSeekRequest || (!forceOriginal && (isProblematic || forceCompatibility));

            if (needsTranscoding) {
                if (isProblematic) {
                    console.log(`[TRANSCODE] Problematic video detected: ${canonicalRelativePath}`);
                } else if (isSeekRequest) {
                    console.log(`[TRANSCODE] Seek request detected for: ${canonicalRelativePath} at ${seekTime}s`);
                }

                const userAgent = req.get('User-Agent') || '';
                const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
                const isAppleMobile = /iPhone|iPad|iPod/i.test(userAgent);

                console.log(`[MOBILE] Mobile detected: ${isMobile}`);

                if (seekTime > 0) {
                    console.log(`[SEEK] Received seek request via query parameter. Starting stream at ${seekTime}s.`);
                }
                if (quality !== 'auto') {
                    console.log(`[QUALITY] Transcoding to ${quality}`);
                }

                res.status(200).contentType('video/mp4');
                res.setHeader('Accept-Ranges', 'none');
                res.setHeader('Transfer-Encoding', 'chunked');

                const cfHeaders = req.headers['cf-ray'] || req.headers['cf-connecting-ip'];
                const isCloudflare = !!cfHeaders;

                if (isCloudflare) {
                    console.log(`[CLOUDFLARE] Transcoding via tunnel for: ${canonicalRelativePath}`);
                    res.setHeader('X-Cloudflare-Buffer', 'small');
                    res.setHeader('X-Accel-Buffering', 'no');
                }

                const movFlags = isAppleMobile
                    ? '-movflags frag_keyframe+empty_moov'
                    : '-movflags frag_keyframe+empty_moov+default_base_moof+frag_discont';

                const ffmpegCommand = ffmpeg(videoFullPath)
                    .inputOptions([`-ss ${seekTime}`])
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .outputOptions([
                        '-preset ultrafast',
                        '-tune zerolatency',
                        movFlags,
                        '-pix_fmt yuv420p',
                        '-frag_duration 2000000',
                        '-min_frag_duration 1000000',
                        '-max_muxing_queue_size 1024',
                        '-avoid_negative_ts make_zero',
                        ...(isMobile ? [
                            '-profile:v baseline',
                            '-level 3.0',
                            '-maxrate 2M',
                            '-bufsize 4M'
                        ] : []),
                        ...(isAppleMobile ? [
                            '-tag:v avc1'
                        ] : []),
                        ...(isCloudflare ? [
                            '-write_tmcd 0',
                            '-max_interleave_delta 500000',
                            '-flush_packets 1'
                        ] : [])
                    ])
                    .format('mp4');

                const selectedAudioTrack = audioTracks.find(track => track.index === requestedAudioIndex) || audioTracks.find(track => track.isDefault) || audioTracks[0];
                if (selectedAudioTrack) {
                    ffmpegCommand.outputOptions([
                        '-map 0:v:0',
                        `-map 0:${selectedAudioTrack.index}`
                    ]);
                }

                const qualityMap = {
                    '1080p': '1080',
                    '720p': '720',
                    '480p': '480'
                };

                const requestedQuality = qualityMap[quality]
                    ? quality
                    : playbackMode === 'data-saver'
                        ? '480p'
                        : playbackMode === 'compatibility'
                            ? '720p'
                            : 'auto';

                if (qualityMap[requestedQuality]) {
                    ffmpegCommand.videoFilter(`scale=-2:${qualityMap[requestedQuality]}`);
                }

                ffmpegCommand.on('start', (commandLine) => {
                        console.log(`[FFMPEG] Spawned ffmpeg with command: ${commandLine}`);
                        console.log(`[FFMPEG] Mobile optimizations: ${isMobile ? 'enabled' : 'disabled'}`);
                    })
                    .on('progress', (progress) => {
                        if (progress.timemark && parseInt(progress.timemark.split(':')[2]) % 10 === 0) {
                            console.log(`[FFMPEG] Progress: ${progress.timemark}`);
                        }
                    })
                    .on('error', (err, stdout, stderr) => {
                        const isExpectedKill = err.message.includes('SIGKILL') || err.message.includes('pipe:0');
                        const isConnectionError = err.message.includes('EPIPE') ||
                                                err.message.includes('ECONNRESET') ||
                                                err.message.includes('connection reset') ||
                                                err.message.includes('write after end') ||
                                                err.message.includes('Broken pipe');

                        if (isExpectedKill) {
                            console.log(`[FFMPEG] Process killed as expected (client disconnected/seeked).`);
                        } else if (isConnectionError && isCloudflare) {
                            console.log(`[CLOUDFLARE] Stream cancelled by client via tunnel: ${canonicalRelativePath}`);
                            return;
                        } else if (isConnectionError) {
                            console.log(`[CONNECTION] Client disconnected during transcoding: ${canonicalRelativePath}`);
                            return;
                        } else {
                            console.error(`[FFMPEG ERROR] Transcoding error for ${canonicalRelativePath}:`, err.message);
                            console.error(`[FFMPEG ERROR] Mobile: ${isMobile}, Quality: ${quality}, SeekTime: ${seekTime}, Cloudflare: ${isCloudflare}`);
                            if (stderr) {
                                const lastLines = stderr.split('\n').slice(-5).join('\n');
                                console.error('[FFMPEG STDERR (last 5 lines)]:', lastLines);
                            }

                            if (!res.headersSent) {
                                res.status(500).json({
                                    error: 'Video transcoding failed',
                                    message: 'This video format is not supported for transcoding. Try playing it directly.',
                                    fallbackUrl: `/videos/${canonicalRelativePath}`,
                                    originalError: err.message,
                                    isCloudflare: isCloudflare
                                });
                            }
                        }
                    });

                ffmpegCommand.pipe(res, { end: true });

                req.on('close', () => {
                    console.log(`[REQUEST] Client disconnected from: ${canonicalRelativePath}`);
                    ffmpegCommand.kill('SIGKILL');
                });

                if (isMobile) {
                    res.set({
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache',
                        'Expires': '0'
                    });
                }

                return;
            }

            if (req.query['cf-stream'] && !isSeekRequest) {
                console.log(`[CLOUDFLARE] Direct stream request for standard video: ${canonicalRelativePath}`);
                delete req.query['cf-stream'];
                delete req.query['cf-cache'];
            }

            console.log(`[STATIC] Standard file detected. Sending file directly.`);
            res.sendFile(videoFullPath);
        })
        .catch(err => {
            console.error(`[PROBE_ERROR] ffprobe failed for ${canonicalRelativePath}:`, err.message);
            next();
        });
});

// The standard static server for all non-problematic videos.
app.use('/videos', express.static(videosDirectory));
app.use('/thumbnails', express.static(thumbnailsDirectory));
app.use('/subtitles', express.static(subtitlesCacheDirectory));
app.use('/folder-thumbnails', express.static(folderThumbnailsDirectory));

app.post('/api/rooms', (req, res) => {
    try {
        const resolvedMedia = getResolvedMediaOrThrow(req.body?.videoFile);
        const sharedRoom = createSharedRoom(resolvedMedia.relativePath);

        res.json({
            roomCode: sharedRoom.roomCode,
            videoFile: sharedRoom.videoFile,
            roomUrl: `/player.html?video=${encodeURIComponent(sharedRoom.videoFile)}&room=${encodeURIComponent(sharedRoom.roomCode)}`,
            shareUrl: `/player.html?video=${encodeURIComponent(sharedRoom.videoFile)}&room=${encodeURIComponent(sharedRoom.roomCode)}`,
            expiresInMs: ROOM_TTL_MS
        });
    } catch (error) {
        const statusCode = error.statusCode || 400;
        res.status(statusCode).json({ error: error.message || 'Unable to create room' });
    }
});

app.get('/api/rooms/:roomCode', (req, res) => {
    const sharedRoom = getSharedRoom(req.params.roomCode);
    if (!sharedRoom) {
        return res.status(404).json({ error: 'Room not found or expired' });
    }

    res.json({
        roomCode: sharedRoom.roomCode,
        videoFile: sharedRoom.videoFile,
        shareUrl: `/player.html?video=${encodeURIComponent(sharedRoom.videoFile)}&room=${encodeURIComponent(sharedRoom.roomCode)}`,
        expiresInMs: Math.max(0, ROOM_TTL_MS - (Date.now() - sharedRoom.createdAt))
    });
});

app.get('/api/diagnostics/rooms', (req, res) => {
    cleanupExpiredSharedRooms();

    const sharedRoomsList = [...sharedRooms.values()].map((room) =>
        summarizeRoomDiagnostics(room.roomKey, {
            roomCode: room.roomCode,
            videoFile: room.videoFile,
            createdAt: room.createdAt,
            lastUsedAt: room.lastUsedAt,
            expiresInMs: Math.max(0, ROOM_TTL_MS - (Date.now() - room.lastUsedAt))
        })
    );
    const sharedRoomKeys = new Set(sharedRoomsList.map((room) => room.roomKey));
    const directRoomsList = Object.keys(roomStates)
        .filter((roomKey) => !sharedRoomKeys.has(roomKey) && getRoomClientCount(roomKey) > 0)
        .map((roomKey) => summarizeRoomDiagnostics(roomKey));

    res.json({
        generatedAt: Date.now(),
        sharedRooms: sharedRoomsList,
        directRooms: directRoomsList
    });
});

app.get('/api/telemetry/summary', (req, res) => {
    res.json({
        generatedAt: Date.now(),
        ...summarizeTelemetry()
    });
});

app.post('/api/telemetry', (req, res) => {
    recordPlaybackTelemetry(req.body || {});
    res.json({ ok: true });
});

app.get('/api/thumbnail-options', async (req, res) => {
    const requestedPath = String(req.query.path || '').trim();
    if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
    }

    const normalizedPath = normalizeSeriesPath(requestedPath);
    const resolvedDirectory = resolveMediaPath(videosDirectory, normalizedPath, { mustExist: true });
    if (!resolvedDirectory) {
        return res.status(404).json({ error: 'Series folder not found' });
    }

    try {
        const type = normalizedPath.toLowerCase().startsWith('movies') ? 'movie' : 'tv';
        const candidates = await buildDirectoryThumbnailCandidates(normalizedPath, type);
        const currentSelection = await getThumbnailOverride(normalizedPath);
        res.json({
            path: normalizedPath,
            currentSelection,
            candidates
        });
    } catch (error) {
        console.error('[THUMBNAILS] Failed to build options:', error);
        res.status(500).json({ error: 'Could not build thumbnail options' });
    }
});

app.get('/api/metadata-options', async (req, res) => {
    const requestedPath = String(req.query.path || '').trim();
    if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
    }

    const normalizedPath = normalizeSeriesPath(requestedPath);
    const resolvedDirectory = resolveMediaPath(videosDirectory, normalizedPath, { mustExist: true });
    if (!resolvedDirectory) {
        return res.status(404).json({ error: 'Series folder not found' });
    }

    try {
        const type = normalizedPath.toLowerCase().startsWith('movies') ? 'movie' : 'tv';
        const [candidates, currentSelection] = await Promise.all([
            buildTmdbMetadataCandidates(normalizedPath, type),
            getMetadataOverride(normalizedPath)
        ]);
        res.json({
            path: normalizedPath,
            currentSelection,
            candidates
        });
    } catch (error) {
        console.error('[TMDB] Failed to build metadata options:', error);
        res.status(500).json({ error: 'Could not build metadata options' });
    }
});

app.post('/api/thumbnail-selection', async (req, res) => {
    const requestedPath = String(req.body?.path || '').trim();
    const selectedUrl = String(req.body?.selectedUrl || '').trim();
    const selectedLabel = String(req.body?.selectedLabel || '').trim();
    const selectedSource = String(req.body?.selectedSource || '').trim();

    if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
    }

    const normalizedPath = normalizeSeriesPath(requestedPath);
    const resolvedDirectory = resolveMediaPath(videosDirectory, normalizedPath, { mustExist: true });
    if (!resolvedDirectory) {
        return res.status(404).json({ error: 'Series folder not found' });
    }

    try {
        if (!selectedUrl) {
            await setThumbnailOverride(normalizedPath, null);
            return res.json({ ok: true, cleared: true });
        }

        await setThumbnailOverride(normalizedPath, {
            url: selectedUrl,
            label: selectedLabel || 'Selected thumbnail',
            source: selectedSource || 'custom'
        });

        res.json({ ok: true });
    } catch (error) {
        console.error('[THUMBNAILS] Failed to save selection:', error);
        res.status(500).json({ error: 'Could not save thumbnail selection' });
    }
});

app.post('/api/metadata-selection', async (req, res) => {
    const requestedPath = String(req.body?.path || '').trim();
    const selectedCandidate = req.body?.selectedCandidate || null;

    if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
    }

    const normalizedPath = normalizeSeriesPath(requestedPath);
    const resolvedDirectory = resolveMediaPath(videosDirectory, normalizedPath, { mustExist: true });
    if (!resolvedDirectory) {
        return res.status(404).json({ error: 'Series folder not found' });
    }

    try {
        if (!selectedCandidate) {
            await setMetadataOverride(normalizedPath, null);
            await clearTmdbCacheForPath(normalizedPath);
            return res.json({ ok: true, cleared: true });
        }

        await setMetadataOverride(normalizedPath, {
            tmdbId: Number(selectedCandidate.tmdbId) || null,
            matchedTitle: String(selectedCandidate.matchedTitle || '').trim() || null,
            matchedOriginalTitle: String(selectedCandidate.matchedOriginalTitle || '').trim() || null,
            name: path.basename(normalizedPath),
            rating: Number(selectedCandidate.rating) || 0,
            description: String(selectedCandidate.description || '').trim(),
            posterUrl: String(selectedCandidate.posterUrl || '').trim() || null,
            backdropUrl: String(selectedCandidate.backdropUrl || '').trim() || null,
            year: Number(selectedCandidate.year) || null,
            source: String(selectedCandidate.source || 'tmdb-search').trim() || 'tmdb-search'
        });
        await clearTmdbCacheForPath(normalizedPath);

        res.json({ ok: true });
    } catch (error) {
        console.error('[TMDB] Failed to save metadata selection:', error);
        res.status(500).json({ error: 'Could not save metadata selection' });
    }
});

app.post('/api/metadata-refresh', async (req, res) => {
    const requestedPath = String(req.body?.path || '').trim();
    if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
    }

    const normalizedPath = normalizeSeriesPath(requestedPath);
    const resolvedDirectory = resolveMediaPath(videosDirectory, normalizedPath, { mustExist: true });
    if (!resolvedDirectory) {
        return res.status(404).json({ error: 'Series folder not found' });
    }

    try {
        await clearTmdbCacheForPath(normalizedPath);
        const type = normalizedPath.toLowerCase().startsWith('movies') ? 'movie' : 'tv';
        const tmdbInfo = await getTmdbInfo(normalizedPath, type);
        await applyThumbnailOverride(normalizedPath, tmdbInfo);
        res.json({ ok: true, tmdbInfo });
    } catch (error) {
        console.error('[TMDB] Failed to refresh metadata:', error);
        res.status(500).json({ error: 'Could not refresh metadata' });
    }
});

app.post('/api/progress/mark', async (req, res) => {
    const requestedVideoFile = String(req.body?.videoFile || '').trim();
    if (!requestedVideoFile) {
        return res.status(400).json({ error: 'Video file is required' });
    }

    try {
        const result = await markVideoProgress(requestedVideoFile, req.body?.watched);
        res.json({ ok: true, ...result });
    } catch (error) {
        const statusCode = Number(error?.statusCode) || 500;
        console.error('[PROGRESS] Failed to update video progress:', error);
        res.status(statusCode).json({ error: error.message || 'Could not update video progress' });
    }
});

app.post('/api/continue-watching/clear', async (req, res) => {
    try {
        const rawProgress = await readProgressFile();
        const nextProgress = { ...rawProgress };
        let changed = 0;

        for (const [videoFile, entry] of Object.entries(nextProgress)) {
            if (entry?.time && entry?.duration && (entry.time / entry.duration) < 0.95) {
                nextProgress[videoFile] = {
                    ...entry,
                    time: 0,
                    lastWatched: Date.now()
                };
                changed += 1;
            }
        }

        if (changed > 0) {
            progressCache = nextProgress;
            progressDirty = true;
            await scheduleProgressFlush();
        }

        res.json({ ok: true, cleared: changed });
    } catch (error) {
        console.error('[CONTINUE WATCHING] Failed to clear list:', error);
        res.status(500).json({ error: 'Could not clear continue watching' });
    }
});

app.post('/api/continue-watching/bulk-action', async (req, res) => {
    const action = String(req.body?.action || '').trim();
    const validActions = new Set(['clear', 'mark-watched', 'mark-unwatched']);
    if (!validActions.has(action)) {
        return res.status(400).json({ error: 'Invalid action' });
    }

    try {
        const rawProgress = await readProgressFile();
        const nextProgress = { ...rawProgress };
        let changed = 0;

        for (const [videoFile, entry] of Object.entries(nextProgress)) {
            if (!entry?.duration) {
                continue;
            }

            const inContinueWatching = entry.time && (entry.time / entry.duration) < 0.95;
            if (!inContinueWatching) {
                continue;
            }

            if (action === 'mark-watched') {
                nextProgress[videoFile] = {
                    ...entry,
                    time: entry.duration,
                    lastWatched: Date.now()
                };
                changed += 1;
                continue;
            }

            nextProgress[videoFile] = {
                ...entry,
                time: 0,
                lastWatched: Date.now()
            };
            changed += 1;
        }

        if (changed > 0) {
            progressCache = nextProgress;
            progressDirty = true;
            await scheduleProgressFlush();
        }

        res.json({ ok: true, action, changed });
    } catch (error) {
        console.error('[CONTINUE WATCHING] Failed bulk action:', error);
        res.status(500).json({ error: 'Could not update continue watching' });
    }
});

app.post('/api/continue-watching/series-action', async (req, res) => {
    const requestedSeriesPath = String(req.body?.seriesPath || '').trim();
    const action = String(req.body?.action || 'mark-unwatched').trim();
    if (!requestedSeriesPath) {
        return res.status(400).json({ error: 'Series path is required' });
    }
    if (!['mark-unwatched', 'mark-watched'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action' });
    }

    const resolvedSeries = resolveMediaPath(videosDirectory, requestedSeriesPath, { mustExist: true });
    if (!resolvedSeries) {
        return res.status(404).json({ error: 'Series folder not found' });
    }

    try {
        const rawProgress = await readProgressFile();
        const nextProgress = { ...rawProgress };
        const prefix = `${resolvedSeries.relativePath.replace(/\\/g, '/')}/`;
        let changed = 0;

        for (const [videoFile, entry] of Object.entries(nextProgress)) {
            if (!videoFile.startsWith(prefix) || !entry?.duration) {
                continue;
            }

            nextProgress[videoFile] = {
                ...entry,
                time: action === 'mark-watched' ? entry.duration : 0,
                lastWatched: Date.now()
            };
            changed += 1;
        }

        if (changed > 0) {
            progressCache = nextProgress;
            progressDirty = true;
            await scheduleProgressFlush();
        }

        res.json({ ok: true, action, changed, seriesPath: resolvedSeries.relativePath });
    } catch (error) {
        console.error('[CONTINUE WATCHING] Failed series action:', error);
        res.status(500).json({ error: 'Could not update series progress' });
    }
});

app.get('/api/search', async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) {
        return res.json({ query, results: [] });
    }

    try {
        const progress = await readProgressFile();
        const searchIndex = await getSearchIndex();
        const normalizedQuery = normalizeForComparison(query);
        const queryTokens = normalizedQuery.split(' ').filter(Boolean);

        const matches = searchIndex
            .map((entry) => ({
                entry,
                score: scoreSearchEntry(entry, normalizedQuery, queryTokens)
            }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score || naturalSort(a.entry.relativePath, b.entry.relativePath))
            .slice(0, 30);

        const results = await Promise.all(matches.map(async ({ entry }) => {
            const relativePath = entry.relativePath;
            const fullPath = path.join(videosDirectory, relativePath);
            const stats = await fsp.stat(fullPath);
            let durationInSeconds = 0;

            try {
                durationInSeconds = await getCachedVideoDuration(fullPath);
            } catch (error) {
                durationInSeconds = 0;
            }

            const hash = crypto.createHash('md5').update(relativePath).digest('hex');
            const thumbnailFilename = `${hash}.jpg`;
            const thumbnailPath = path.join(thumbnailsDirectory, thumbnailFilename);
            const thumbnailUrl = `/thumbnails/${thumbnailFilename}`;

            try {
                await ensureThumbnailFile(fullPath, thumbnailPath, { timestamps: ['35%'] });
            } catch (error) {
                // Ignore thumbnail failures for search results.
            }

            const episodeMeta = entry.episodeMeta || extractEpisodeMetadata(path.basename(relativePath));
            const seriesPath = entry.seriesPath || path.dirname(path.dirname(relativePath)).replace(/\\/g, '/');

            return {
                type: 'file',
                name: path.basename(relativePath),
                url: relativePath,
                duration: durationInSeconds > 0 ? formatDuration(durationInSeconds) : 'Unknown',
                durationSeconds: durationInSeconds,
                size: stats.size,
                modified: stats.mtime,
                thumbnailUrl: fs.existsSync(thumbnailPath) ? thumbnailUrl : null,
                progress: progress[relativePath]?.time || 0,
                seasonNumber: episodeMeta.seasonNumber,
                episodeNumber: episodeMeta.episodeNumber,
                seriesPath: seriesPath === '.' ? '' : seriesPath
            };
        }));

        res.json({ query, results });
    } catch (error) {
        console.error('Search failed:', error);
        res.status(500).json({ error: 'Search failed' });
    }
});

/**
 * Recursively find all video files in a directory.
 * @param {string} dir - The directory to search in.
 * @param {string} [baseDir] - The base directory for creating relative paths.
 * @returns {Promise<string[]>} A list of relative paths to video files.
 */
async function findVideoFiles(dir, baseDir = dir) {
    // This function is no longer needed as we are not scanning recursively for the main list
    // It can be removed or kept for other potential uses. For now, I'll leave it but it won't be called.
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    let videoFiles = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nestedVideos = await findVideoFiles(fullPath, baseDir);
            videoFiles = videoFiles.concat(nestedVideos);
        } else if (/\.(mp4|mkv|avi|mov)$/i.test(entry.name)) {
            videoFiles.push(path.relative(baseDir, fullPath));
        }
    }
    return videoFiles;
}

/**
 * Formats seconds into a HH:MM:SS string.
 * @param {number} totalSeconds - The total seconds to format.
 * @returns {string} The formatted time string.
 */
function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    const pad = (num) => num.toString().padStart(2, '0');

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function extractEpisodeMetadata(fileName) {
    const baseName = path.basename(fileName, path.extname(fileName));
    const match = baseName.match(/S(\d{1,2})E(\d{1,2})/i) || baseName.match(/(\d{1,2})x(\d{1,2})/i);
    if (!match) {
        return {
            seasonNumber: null,
            episodeNumber: null
        };
    }

    return {
        seasonNumber: Number.parseInt(match[1], 10),
        episodeNumber: Number.parseInt(match[2], 10)
    };
}

/**
 * Generates a thumbnail for a video file.
 * @param {string} videoPath - The full path to the video file.
 * @param {string} thumbnailPath - The full path where the thumbnail should be saved.
 * @param {{timestamps?: string[], size?: string}} [options]
 * @returns {Promise<void>}
 */
function generateThumbnail(videoPath, thumbnailPath, options = {}) {
    const timestamps = Array.isArray(options.timestamps) && options.timestamps.length > 0 ? options.timestamps : ['35%'];
    const size = options.size || '320x?';
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(new Error(`Error generating thumbnail: ${err.message}`)))
            .screenshots({
                timestamps,
                filename: path.basename(thumbnailPath),
                folder: path.dirname(thumbnailPath),
                size
            });
    });
}

async function listCandidateVideosForDirectory(relativePath) {
    const normalized = normalizeSeriesPath(relativePath);
    if (!normalized) {
        return [];
    }

    const fullPath = path.join(videosDirectory, normalized);
    const candidates = [];

    async function walk(dirPath, relativeBase) {
        const entries = await fsp.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryFullPath = path.join(dirPath, entry.name);
            const entryRelativePath = path.join(relativeBase, entry.name).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                await walk(entryFullPath, entryRelativePath);
            } else if (/\.(mp4|mkv|avi|mov)$/i.test(entry.name)) {
                candidates.push(entryRelativePath);
            }
        }
    }

    await walk(fullPath, normalized);
    return candidates.sort(naturalSort);
}

async function getBestThumbnailSourceForDirectory(relativePath) {
    const candidates = await listCandidateVideosForDirectory(relativePath);
    if (candidates.length === 0) {
        return null;
    }

    const scored = await Promise.all(candidates.slice(0, 12).map(async (candidate) => {
        const fullPath = path.join(videosDirectory, candidate);
        let duration = 0;
        try {
            duration = await getCachedVideoDuration(fullPath);
        } catch (error) {
            duration = 0;
        }
        return { candidate, duration };
    }));

    scored.sort((a, b) => (b.duration - a.duration) || naturalSort(a.candidate, b.candidate));
    return scored[0]?.candidate || candidates[0];
}

async function ensureGeneratedThumbnail(videoRelativePath, cacheBucket = 'thumbnails', variantLabel = 'default', timestamps = ['35%']) {
    const cacheDir = cacheBucket === 'folder-thumbnails' ? folderThumbnailsDirectory : thumbnailsDirectory;
    const extension = '.jpg';
    const cacheKey = createCacheHash(`${videoRelativePath}:${variantLabel}:${timestamps.join(',')}`);
    const thumbnailFilename = `${cacheKey}${extension}`;
    const thumbnailPath = path.join(cacheDir, thumbnailFilename);
    const thumbnailUrl = `/${cacheBucket}/${thumbnailFilename}`;

    await ensureThumbnailFile(path.join(videosDirectory, videoRelativePath), thumbnailPath, { timestamps });

    return { thumbnailPath, thumbnailUrl, thumbnailFilename };
}

async function buildDirectoryThumbnailCandidates(relativePath, type = 'tv') {
    const normalized = normalizeSeriesPath(relativePath);
    if (!normalized) {
        return [];
    }

    const fullPath = path.join(videosDirectory, normalized);
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (candidate) => {
        if (!candidate?.url || seen.has(candidate.url)) {
            return;
        }
        seen.add(candidate.url);
        candidates.push(candidate);
    };

    try {
        const entries = await fsp.readdir(fullPath);
        for (const entry of entries.filter(name => /^poster\.(jpg|png|webp)$/i.test(name))) {
            const relativePosterPath = path.join(normalized, entry).replace(/\\/g, '/');
            pushCandidate({
                id: `manual:${entry}`,
                label: `Manual poster (${entry})`,
                url: `/videos/${relativePosterPath}`,
                source: 'manual'
            });
        }
    } catch (error) {
        // Ignore manual poster read failures.
    }

    const tmdbData = await getTmdbInfo(normalized, type);
    if (tmdbData?.posterUrl) {
        pushCandidate({
            id: 'tmdb:poster',
            label: 'TMDB poster',
            url: tmdbData.posterUrl,
            source: 'tmdb'
        });
    }
    if (tmdbData?.backdropUrl) {
        pushCandidate({
            id: 'tmdb:backdrop',
            label: 'TMDB backdrop',
            url: tmdbData.backdropUrl,
            source: 'tmdb'
        });
    }

    const bestSource = await getBestThumbnailSourceForDirectory(normalized);
    if (bestSource) {
        const generatedVariants = [
            { id: 'generated:early', label: 'Episode frame 15%', timestamps: ['15%'] },
            { id: 'generated:middle', label: 'Episode frame 35%', timestamps: ['35%'] },
            { id: 'generated:late', label: 'Episode frame 55%', timestamps: ['55%'] }
        ];

        for (const variant of generatedVariants) {
            try {
                const generated = await ensureGeneratedThumbnail(bestSource, 'folder-thumbnails', `${normalized}:${variant.id}`, variant.timestamps);
                pushCandidate({
                    id: variant.id,
                    label: variant.label,
                    url: generated.thumbnailUrl,
                    source: 'generated',
                    videoFile: bestSource
                });
            } catch (error) {
                console.error(`[THUMBNAILS] Failed to build candidate ${variant.id} for ${normalized}:`, error.message);
            }
        }
    }

    return candidates;
}

app.post('/api/subtitles/auto', async (req, res) => {
    const requestedVideoPath = String(req.body?.video || '').trim();
    if (!requestedVideoPath) {
        return res.status(400).json({ error: 'Video path is required.' });
    }

    let resolvedMedia;
    try {
        resolvedMedia = getResolvedMediaOrThrow(requestedVideoPath);
    } catch (error) {
        return res.status(error.statusCode || 404).json({ error: 'Video file not found' });
    }

    const videoRelativePath = resolvedMedia.relativePath;
    const cachedSubtitle = await getCachedAutomaticSubtitleEntry(videoRelativePath);
    if (cachedSubtitle) {
        return res.json({ subtitle: cachedSubtitle, cached: true });
    }

    if (!openSubtitlesConfigured()) {
        return res.status(503).json({
            error: 'Automatic subtitle download is not configured on this server. Set OPENSUBTITLES_API_KEY, OPENSUBTITLES_USERNAME and OPENSUBTITLES_PASSWORD first.'
        });
    }

    try {
        const context = await buildAutomaticSubtitleContext(videoRelativePath);
        if (context.type === 'episode' && (context.seasonNumber == null || context.episodeNumber == null)) {
            return res.status(400).json({ error: 'Could not detect season and episode from this filename.' });
        }

        const bestMatch = await searchAutomaticSubtitle(context);
        const subtitleContents = await downloadAutomaticSubtitle(bestMatch.fileId);
        const cacheInfo = getAutomaticSubtitleCacheInfo(videoRelativePath);

        await fsp.writeFile(cacheInfo.filePath, subtitleContents, 'utf8');

        return res.json({
            subtitle: {
                lang: 'English (Auto)',
                meta: 'Downloaded automatically for this episode',
                source: 'auto',
                url: cacheInfo.url
            }
        });
    } catch (error) {
        const providerMessage = error.response?.data?.errors?.[0]?.detail
            || error.response?.data?.message
            || error.message
            || 'Automatic subtitle lookup failed';
        console.error('[AUTO_SUBTITLES]', providerMessage);
        return res.status(502).json({ error: providerMessage });
    }
});

// API endpoint to automatically extract and serve subtitles
app.get('/api/subtitles', async (req, res) => {
    const requestedVideoPath = req.query.video || '';
    console.log(`[SUBTITLES] Request received for: ${requestedVideoPath}`);
    
    if (!requestedVideoPath) {
        console.log(`[SUBTITLES] Error: No video path provided`);
        return res.status(400).json({ error: 'Video path is required.' });
    }

    let resolvedMedia;
    try {
        resolvedMedia = getResolvedMediaOrThrow(requestedVideoPath);
    } catch (error) {
        return res.status(error.statusCode || 404).json({ error: 'Video file not found' });
    }

    const videoRelativePath = resolvedMedia.relativePath;
    const videoFullPath = resolvedMedia.fullPath;
    const resolvedPath = path.resolve(videoFullPath);
    console.log(`[SUBTITLES] Full video path: ${videoFullPath}`);
    console.log(`[SUBTITLES] Resolved path: ${resolvedPath}`);

    try {
        const cachedAutomaticSubtitle = await getCachedAutomaticSubtitleEntry(videoRelativePath);
        console.log(`[SUBTITLES] Probing video file with ffprobe...`);
        const { metadata } = await getCachedProbeResult(videoFullPath, videoRelativePath);

        console.log(`[SUBTITLES] ffprobe successful, analyzing streams...`);
        console.log(`[SUBTITLES] Total streams found: ${metadata.streams.length}`);
        metadata.streams.forEach((stream, index) => {
            console.log(`[SUBTITLES] Stream ${index}: type=${stream.codec_type}, codec=${stream.codec_name}`);
        });
        const subtitleStreams = metadata.streams.filter(s => s.codec_type === 'subtitle');
        console.log(`[SUBTITLES] Found ${subtitleStreams.length} subtitle streams`);
        
        if (subtitleStreams.length === 0) {
            console.log(`[SUBTITLES] No embedded subtitle streams found in video`);
            console.log(`[SUBTITLES] Video format: ${metadata.format.format_name}`);
            console.log(`[SUBTITLES] Total duration: ${metadata.format.duration}s`);
            
            // Check for external subtitle files
            console.log(`[SUBTITLES] Checking for external subtitle files...`);
            const videoDir = path.dirname(videoFullPath);
            const videoBaseName = path.basename(videoRelativePath, path.extname(videoRelativePath));
            
            try {
                const dirFiles = await fsp.readdir(videoDir);
                console.log(`[SUBTITLES] Found ${dirFiles.length} files in directory`);
                const externalSubtitles = findExternalSubtitleMatches(videoRelativePath, dirFiles)
                    .map(match => ({
                        lang: match.lang,
                        url: `/videos/${path.join(path.dirname(videoRelativePath), match.fileName).replace(/\\/g, '/')}`,
                        isExternal: true
                    }));

                if (externalSubtitles.length > 0) {
                    console.log(`[SUBTITLES] Found ${externalSubtitles.length} external subtitle files`);
                    return res.json({
                        subtitles: cachedAutomaticSubtitle ? [cachedAutomaticSubtitle, ...externalSubtitles] : externalSubtitles,
                        message: 'External subtitles found'
                    });
                }
                
            } catch (dirError) {
                console.error(`[SUBTITLES] Error reading directory for external subtitles:`, dirError.message);
            }
            
            console.log(`[SUBTITLES] No embedded or external subtitles found`);
            return res.json({
                subtitles: cachedAutomaticSubtitle ? [cachedAutomaticSubtitle] : [],
                message: cachedAutomaticSubtitle ? 'Cached automatic subtitle found' : 'No subtitles found'
            });
        }

        // Log subtitle stream details
        subtitleStreams.forEach((stream, index) => {
            console.log(`[SUBTITLES] Stream ${index}: codec=${stream.codec_name}, index=${stream.index}, lang=${stream.tags?.language || 'unknown'}`);
        });
        
        const preparedSubtitles = subtitleStreams.map(stream => {
            const streamIndex = stream.index;
            const lang = humanizeSubtitleLanguage(stream.tags?.language, `Track ${streamIndex}`);
            const hash = crypto.createHash('md5').update(`${videoRelativePath}-${streamIndex}`).digest('hex');
            const subtitleFilename = `${hash}.vtt`;
            const subtitleCachePath = path.join(subtitlesCacheDirectory, subtitleFilename);
            const subtitleUrl = `/subtitles/${subtitleFilename}`;
            return { lang, url: subtitleUrl, streamIndex, subtitleCachePath, subtitleFilename };
        });

        const extractAndCache = (sub) => {
            return new Promise((resolve, reject) => {
                // If it's already cached, resolve immediately.
                if (fs.existsSync(sub.subtitleCachePath)) {
                    console.log(`[SUBTITLES] Using cached subtitle: ${sub.subtitleFilename}`);
                    return resolve();
                }
                
                console.log(`[SUBTITLES] Extracting subtitle stream ${sub.streamIndex} to ${sub.subtitleFilename}...`);
                console.log(`[SUBTITLES] Source codec: ${metadata.streams[sub.streamIndex].codec_name}`);
                
                // If not cached, extract it.
                const command = ffmpeg(videoFullPath)
                    .outputOptions([
                        `-map 0:${sub.streamIndex}`,
                        '-c:s webvtt',
                        '-avoid_negative_ts make_zero'  // Fix timing issues
                    ])
                    .output(sub.subtitleCachePath)
                    .on('start', (commandLine) => {
                        console.log(`[SUBTITLES] FFmpeg command: ${commandLine}`);
                    })
                    .on('end', () => {
                        clearTimeout(extractionTimeout);
                        console.log(`[SUBTITLES] Successfully extracted subtitle stream ${sub.streamIndex}`);
                        
                        // Verify the file was created and has content
                        if (fs.existsSync(sub.subtitleCachePath)) {
                            const stats = fs.statSync(sub.subtitleCachePath);
                            console.log(`[SUBTITLES] Generated file size: ${stats.size} bytes`);
                            if (stats.size > 0) {
                                resolve();
                            } else {
                                console.error(`[SUBTITLES] Generated subtitle file is empty`);
                                reject(new Error('Generated subtitle file is empty'));
                            }
                        } else {
                            console.error(`[SUBTITLES] Generated subtitle file does not exist`);
                            reject(new Error('Generated subtitle file does not exist'));
                        }
                    })
                    .on('error', (err) => {
                         clearTimeout(extractionTimeout);
                         console.error(`[SUBTITLES] ffmpeg extraction error for ${videoRelativePath} stream ${sub.streamIndex}:`, err.message);
                         console.error(`[SUBTITLES] FFmpeg stderr:`, err.stack);
                         reject(err);
                    });
                
                // Set a timeout for extraction
                const extractionTimeout = setTimeout(() => {
                    console.warn(`[SUBTITLES] Extraction timeout for stream ${sub.streamIndex}, killing process`);
                    command.kill('SIGKILL');
                    reject(new Error('Subtitle extraction timeout'));
                }, 30000); // 30 second timeout
                
                command.run();
            });
        };

        console.log(`[SUBTITLES] Preparing ${preparedSubtitles.length} subtitle tracks...`);
        
        // Wait for the first subtitle track to be ready (if it isn't already cached).
        if (preparedSubtitles.length > 0) {
            console.log(`[SUBTITLES] Extracting first subtitle track: ${preparedSubtitles[0].lang}`);
            try {
                await extractAndCache(preparedSubtitles[0]);
                console.log(`[SUBTITLES] First subtitle track ready`);
            } catch (err) {
                console.error(`[SUBTITLES] Failed to extract first subtitle track:`, err.message);
                // If the first track fails, still return the list but mark the error
                console.log(`[SUBTITLES] Continuing with remaining tracks despite first track failure`);
            }
        }
        
        // Respond to the client immediately with the full list.
        // The first track should be available (unless extraction failed).
        console.log(`[SUBTITLES] Sending response with ${preparedSubtitles.length} subtitle tracks`);
        const responseSubtitles = preparedSubtitles.map(s => ({ lang: s.lang, url: s.url }));
        res.json({
            subtitles: cachedAutomaticSubtitle ? [cachedAutomaticSubtitle, ...responseSubtitles] : responseSubtitles
        });
        
        // Trigger the extraction for the remaining tracks in the background.
        // We start from the second track (index 1) and don't await them.
        for (let i = 1; i < preparedSubtitles.length; i++) {
            console.log(`[SUBTITLES] Starting background extraction for track ${i}: ${preparedSubtitles[i].lang}`);
            extractAndCache(preparedSubtitles[i]).catch(err => {
                console.error(`[SUBTITLES] Background subtitle extraction for ${preparedSubtitles[i].lang} failed:`, err.message);
            });
        }

    } catch (err) {
        console.error(`[SUBTITLES] Error processing subtitles for ${videoRelativePath}:`, err.message);
        console.error(`[SUBTITLES] Full error:`, err);
        res.status(500).json({ error: `Could not process subtitles: ${err.message}` });
    }
});

app.get('/api/video-info', async (req, res) => {
    const requestedVideoPath = req.query.video;
    if (!requestedVideoPath) {
        return res.status(400).json({ error: 'Video path required' });
    }
    let resolvedMedia;
    try {
        resolvedMedia = getResolvedMediaOrThrow(requestedVideoPath);
    } catch (error) {
        return res.status(error.statusCode || 404).json({ error: 'Video not found' });
    }
    const videoRelativePath = resolvedMedia.relativePath;
    const videoFullPath = resolvedMedia.fullPath;
    
    try {
        getCachedProbeResult(videoFullPath, videoRelativePath)
            .then(({ duration, isProblematic, videoStream, audioStream, audioTracks, bitrateKbps, width, height }) => {
                res.json({
                    duration,
                    isProblematic,
                    bitrateKbps,
                    width,
                    height,
                    videoCodec: videoStream?.codec_name || 'unknown',
                    audioCodec: audioStream?.codec_name || 'unknown',
                    audioTracks: audioTracks || [],
                    supportedFormats: ['mp4', 'webm'],
                    transcodingAvailable: fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)
                });
            })
            .catch(() => {
                res.status(500).json({ error: 'Could not probe video file.' });
            });
    } catch (e) {
        res.status(500).json({ error: 'Server error while getting video info.' });
    }
});

// New endpoint to check client video format support
app.post('/api/check-video-support', (req, res) => {
    const { userAgent, supportedCodecs } = req.body;
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent || '');
    
    // Basic capability detection based on user agent
    let capabilities = {
        h264: true,  // Almost universally supported
        hevc: false, // Limited support
        vp9: true,   // Good modern browser support  
        av1: false,  // Limited support
        aac: true,   // Almost universally supported
        mp3: true    // Almost universally supported
    };
    
    // Mobile devices typically have more limited codec support
    if (isMobile) {
        capabilities.vp9 = false; // Many mobile devices don't support VP9
        capabilities.hevc = /iPhone|iPad/.test(userAgent || ''); // Only iOS supports HEVC well
    }
    
    // Override with client-provided codec support if available
    if (supportedCodecs) {
        capabilities = { ...capabilities, ...supportedCodecs };
    }
    
    res.json({
        capabilities: capabilities,
        isMobile: isMobile,
        recommendation: isMobile ? 'Use transcoding for compatibility' : 'Try direct playback first'
    });
});

// Helper function to extract episode number from filename
function extractEpisodeNumber(videoFile) {
    const filename = path.basename(videoFile);
    
    // Try various episode patterns
    const patterns = [
        /[Ee](\d+)/,           // E01, e01
        /[Ss]\d+[Ee](\d+)/,    // S01E01
        /(\d+)x\d+/,           // 1x01 (season x episode)
        /(?:Episode|Ep)\.?\s*(\d+)/i,  // Episode 01, Ep 01
        /(?:^|\s)(\d+)(?:\s|$)/       // standalone number
    ];
    
    for (const pattern of patterns) {
        const match = filename.match(pattern);
        if (match) {
            return parseInt(match[1], 10);
        }
    }
    
    // Fallback: return 0 if no episode number found
    return 0;
}

app.get('/api/recently-watched', async (req, res) => {
    try {
        const rawProgress = await readProgressFile();
        const { progress, changed } = reconcileProgressEntries(rawProgress, videosDirectory);
        if (changed) {
            await writeProgressFile(progress);
        }
        const allProgress = Object.entries(progress).map(([videoFile, data]) => ({
            videoFile,
            ...data
        }));

        const partiallyWatched = allProgress
            .filter(item => item.time && item.duration && (item.time / item.duration) < 0.95)
            .sort((a, b) => b.lastWatched - a.lastWatched);

        // Group by series (parent directory) and keep only the latest episode per series
        const seriesMap = new Map();
        
        for (const item of partiallyWatched) {
            const seriesPath = path.dirname(item.videoFile);
            const episodeNumber = extractEpisodeNumber(item.videoFile);
            
            if (!seriesMap.has(seriesPath)) {
                seriesMap.set(seriesPath, item);
            } else {
                const existingItem = seriesMap.get(seriesPath);
                const existingEpisodeNumber = extractEpisodeNumber(existingItem.videoFile);
                
                // Keep the episode with higher episode number, or if equal, the most recently watched
                if (episodeNumber > existingEpisodeNumber || 
                    (episodeNumber === existingEpisodeNumber && item.lastWatched > existingItem.lastWatched)) {
                    seriesMap.set(seriesPath, item);
                }
            }
        }
        
        // Convert back to array and limit results
        const filteredWatched = Array.from(seriesMap.values())
            .sort((a, b) => b.lastWatched - a.lastWatched)
            .slice(0, 15);
            
        console.log(`[CONTINUE WATCHING] Filtered ${partiallyWatched.length} episodes down to ${filteredWatched.length} (latest per series)`);
        if (filteredWatched.length > 0) {
            console.log(`[CONTINUE WATCHING] Sample episodes:`, filteredWatched.slice(0, 3).map(item => ({
                file: path.basename(item.videoFile),
                series: path.dirname(item.videoFile),
                episode: extractEpisodeNumber(item.videoFile)
            })));
        }

        const result = [];
        for (const item of filteredWatched) {
            try {
                const videoFullPath = path.join(videosDirectory, item.videoFile);
                if (!fs.existsSync(videoFullPath)) continue; // Skip if file was deleted

                // Basic info for the episode itself
                const episodeName = path.basename(item.videoFile, path.extname(item.videoFile));
                const episodeThumbnailHash = crypto.createHash('md5').update(item.videoFile).digest('hex');
                const episodeThumbnailFilename = `${episodeThumbnailHash}.jpg`;
                const episodeThumbnailPath = path.join(thumbnailsDirectory, episodeThumbnailFilename);
                const episodeThumbnailUrl = `/thumbnails/${episodeThumbnailFilename}`;

                if (!fs.existsSync(episodeThumbnailPath)) {
                    await generateThumbnail(videoFullPath, episodeThumbnailPath, { timestamps: ['35%'] });
                }

                // Get info for the parent folder (the series/movie)
                let seriesDirRelativePath = path.dirname(item.videoFile);
                let seriesPosterUrl = null;
                let displayName = episodeName;
                let year = null;
                let rating = null;
                let seasonNumber = null;
                let episodeNumber = null;

                // Parse season and episode from filename with improved patterns
                const filenameForParsing = path.basename(item.videoFile);
                
                // Check directory structure to determine season
                let detectedSeason = 1; // Default season
                const pathParts = item.videoFile.split(/[\/\\]/);
                for (const part of pathParts) {
                    const seasonMatch = part.match(/[Ss]eason[\s\._-]*(\d+)/i) || part.match(/[Ss](\d+)/i);
                    if (seasonMatch) {
                        detectedSeason = parseInt(seasonMatch[1], 10);
                        break;
                    }
                }
                
                // More specific patterns first, less specific later
                let match = filenameForParsing.match(/S(\d{1,2})E(\d{1,2})/i) ||                                      // S01E01, S10E80
                           filenameForParsing.match(/Season[\s\._-]*(\d+)[\s\._-]*Episode[\s\._-]*(\d+)/i) ||          // Season 1 Episode 1
                           filenameForParsing.match(/S(\d+)[\s\._-]+E(\d+)/i) ||                                        // S1 E1 (with separator)
                           filenameForParsing.match(/(\d{1,2})x(\d{1,2})/i);                                           // 1x01
                
                // If no standard pattern found, try episode number at start (like "01. Title.mkv")
                if (!match) {
                    const episodeOnlyMatch = filenameForParsing.match(/^(\d{1,3})[\.\s\-]/);
                    if (episodeOnlyMatch) {
                        const episodeNum = parseInt(episodeOnlyMatch[1], 10);
                        // Create a fake match array to work with existing code
                        match = [null, detectedSeason, episodeNum];
                    }
                }
                if (match) {
                    seasonNumber = parseInt(match[1], 10);
                    episodeNumber = parseInt(match[2], 10);
                    // Clean up the name by removing episode numbers and other junk
                    displayName = episodeName
                        .replace(/S\d{1,2}E\d{1,2}/i, '')                                           // Remove S01E01 pattern
                        .replace(/\d{1,2}x\d{1,2}/i, '')                                            // Remove 1x01 pattern
                        .replace(/^(\d{1,3})[\.\s\-_]+/i, '')                                       // Remove episode number at start: "01. " or "19 "
                        .replace(/[\.\s\-_]+(\d{1,3})[\.\s\-_]/i, ' ')                              // Remove episode number in middle
                        .replace(/\b(1080p|720p|480p|h264|x265|hevc|bluray|webrip|aac|5\.1)\b/ig, '') // Remove quality indicators
                        .replace(/[._\[\]\(\)]/g, ' ')                                              // Replace special chars with spaces
                        .replace(/\s+/g, ' ')                                                       // Collapse multiple spaces
                        .trim();                                                                    // Remove leading/trailing spaces
                }

                let finalSeriesName = null;
                if (seriesDirRelativePath && seriesDirRelativePath !== '.') {
                    let seriesName = path.basename(seriesDirRelativePath);
                    const dirFullPath_original = path.join(videosDirectory, seriesDirRelativePath);
                    
                    // If the parent folder appears to be a season folder, go up one level to find the actual series folder.
                    if (/season/i.test(seriesName)) {
                         const grandParentPath = path.dirname(seriesDirRelativePath);
                         // Ensure we don't go up from a root category like 'Series' or 'Movies'
                         if (grandParentPath && grandParentPath !== '.') {
                             seriesDirRelativePath = grandParentPath;
                             seriesName = path.basename(seriesDirRelativePath);
                         }
                    }

                    const episodeOnlyName = path.basename(item.videoFile, path.extname(item.videoFile));
                    // The displayName is already cleaned. We just need to set the series name for the card's main title.
                    finalSeriesName = seriesName; 

                    const dirFullPath_series = path.join(videosDirectory, seriesDirRelativePath);

                    // --- Find Series Poster ---
                    // 1. Manual poster (poster.jpg/png) in the series directory
                    try {
                        const posterFiles = await fsp.readdir(dirFullPath_series);
                        const posterFileName = posterFiles.find(f => /^poster\.(jpg|png)$/i.test(f));
                        if (posterFileName) {
                            const posterPath = path.join(seriesDirRelativePath, posterFileName).replace(/\\/g, '/');
                            seriesPosterUrl = `/videos/${posterPath}`;
                        }
                    } catch (e) { /* ignore */ }

                    // 2. TMDB, using the determined series name
                    if (!seriesPosterUrl) {
                        const isMoviePath = seriesDirRelativePath.toLowerCase().startsWith('movies');
                        const tmdbData = await getTmdbInfo(seriesDirRelativePath, isMoviePath ? 'movie' : 'tv');
                        if (tmdbData) {
                            if (tmdbData.posterUrl) seriesPosterUrl = tmdbData.posterUrl;
                            if (tmdbData.year) year = tmdbData.year;
                            if (tmdbData.rating) rating = tmdbData.rating;
                        }
                    }

                    // 3. Generated thumbnail from first video in folder (fallback, using the series dir)
                    if (!seriesPosterUrl) {
                         try {
                            const subDirEntries = await fsp.readdir(dirFullPath_series);
                            const bestThumbnailSource = await getBestThumbnailSourceForDirectory(seriesDirRelativePath);
                            if (bestThumbnailSource) {
                                const generated = await ensureGeneratedThumbnail(bestThumbnailSource, 'folder-thumbnails', `${seriesDirRelativePath}:default`, ['35%']);
                                seriesPosterUrl = generated.thumbnailUrl;
                            }
                        } catch (e) { /* ignore */ }
                    }

                    const thumbnailOverride = await getThumbnailOverride(seriesDirRelativePath);
                    if (thumbnailOverride?.url) {
                        seriesPosterUrl = thumbnailOverride.url;
                    }
                }

                result.push({
                    name: finalSeriesName || displayName, // Use series name, fallback to episode name
                    episodeName: displayName,
                    seasonNumber,
                    episodeNumber,
                    duration: formatDuration(item.duration),
                    durationSeconds: item.duration,
                    url: item.videoFile,
                    seriesPath: seriesDirRelativePath && seriesDirRelativePath !== '.' ? seriesDirRelativePath : null, // Path to series directory
                    thumbnailUrl: seriesPosterUrl || episodeThumbnailUrl, // Prioritize series poster
                    progress: item.time,
                    year: year,
                    rating: rating
                });
            } catch (e) {
                console.error(`Could not process recently watched item ${item.videoFile}:`, e);
            }
        }
        res.json(result);
    } catch (error) {
        console.error('Error fetching recently watched:', error);
        res.status(500).json({ error: 'Could not fetch recently watched videos.' });
    }
});

// Helper function to get details for an entry in a directory.
async function getEntryDetails(entry, relativePath, progress, isMoviePath) {
    const entryPath = path.join(relativePath, entry.name).replace(/\\/g, '/');
    const fullPath = path.join(videosDirectory, entryPath);
    const itemInfo = { name: entry.name, url: entryPath };

    try {
        if (entry.isDirectory()) {
            const dirFullPath = path.join(videosDirectory, entryPath);
            itemInfo.type = 'directory';

            // If it's a directory, check if it contains a single season folder
            try {
                const subEntries = await fsp.readdir(dirFullPath, { withFileTypes: true });
                const subDirs = subEntries.filter(e => e.isDirectory());
                const videoFilesInRoot = subEntries.some(e => e.isFile() && /\.(mp4|mkv|avi|mov)$/i.test(e.name));

                if (subDirs.length === 1 && !videoFilesInRoot && SEASON_PATTERN.test(subDirs[0].name)) {
                    // It's a series with a single season folder, so we modify the link to go directly into it.
                    itemInfo.url = path.join(entryPath, subDirs[0].name).replace(/\\/g, '/');
                }
            } catch (e) { /* ignore errors reading sub-dir */ }

            try {
                const posterFiles = await fsp.readdir(dirFullPath);
                const posterFileName = posterFiles.find(f => /^poster\.(jpg|png)$/i.test(f));
                if (posterFileName) {
                    const posterRelativePath = path.join(entryPath, posterFileName).replace(/\\/g, '/');
                    itemInfo.posterUrl = `/videos/${posterRelativePath}`;
                }
            } catch (e) { /* ignore */ }

            if (!itemInfo.posterUrl) {
                const isIgnored = SEASON_PATTERN.test(entry.name) || (!relativePath && IGNORED_ROOT_FOLDERS.includes(entry.name.toLowerCase()));
                if (!isIgnored) {
                    const tmdbData = await getTmdbInfo(entryPath, isMoviePath ? 'movie' : 'tv');
                    Object.assign(itemInfo, tmdbData);
                }
            }
            
            if (!itemInfo.posterUrl) {
                 try {
                    const bestThumbnailSource = await getBestThumbnailSourceForDirectory(entryPath);
                    if (bestThumbnailSource) {
                        const generated = await ensureGeneratedThumbnail(bestThumbnailSource, 'folder-thumbnails', `${entryPath}:default`, ['35%']);
                        itemInfo.posterUrl = generated.thumbnailUrl;
                    }
                } catch (e) { /* ignore */ }
            }
            await applyThumbnailOverride(entryPath, itemInfo);
        } else {
            itemInfo.type = 'file';
            const hash = crypto.createHash('md5').update(entryPath).digest('hex');
            const thumbnailFilename = `${hash}.jpg`;
            const thumbnailPath = path.join(thumbnailsDirectory, thumbnailFilename);
            itemInfo.thumbnailUrl = `/thumbnails/${thumbnailFilename}`;

            if (!fs.existsSync(thumbnailPath)) {
                try {
                    await generateThumbnail(fullPath, thumbnailPath, { timestamps: ['35%'] });
                } catch (thumbError) {
                    console.error(thumbError.message);
                }
            }
            
            const stats = await fsp.stat(fullPath);
            const durationInSeconds = await getCachedVideoDuration(fullPath);
            const fileProgress = progress[entryPath];

            itemInfo.duration = formatDuration(durationInSeconds);
            itemInfo.durationSeconds = durationInSeconds;
            itemInfo.size = stats.size;
            itemInfo.progress = fileProgress ? fileProgress.time : 0;
            itemInfo.year = new Date(stats.mtime).getFullYear(); // Fallback to file modification year
        }
        return itemInfo;
    } catch (error) {
        console.error(`Could not get info for ${entry.name}:`, error);
        return { name: entry.name, error: true };
    }
}

app.get('/api/homepage-content', async (req, res) => {
    const categories = ['Series', 'Anime', 'Movies'];
    const maxItemsPerCategory = 12;

    try {
        if (homepageResponseCache.payload && homepageResponseCache.expiresAt > Date.now()) {
            return res.json(homepageResponseCache.payload);
        }

        if (!homepageResponseCache.promise) {
            homepageResponseCache.promise = (async () => {
                const progress = await readProgressFile();
                const homepageContent = {};

                for (const category of categories) {
                    const categoryPath = category;
                    const requestedPath = path.join(videosDirectory, categoryPath);
                    
                    try {
                        if (!fs.existsSync(requestedPath)) {
                            console.warn(`Category directory not found: "${requestedPath}". Skipping.`);
                            homepageContent[category] = [];
                            continue;
                        }

                        const entries = await fsp.readdir(requestedPath, { withFileTypes: true });
                        const validEntries = entries
                            .filter(e => e.isDirectory() || /\.(mp4|mkv|avi|mov)$/i.test(e.name))
                            .sort(naturalSort);

                        const items = await Promise.all(
                            validEntries
                                .slice(0, maxItemsPerCategory)
                                .map(entry => getEntryDetails(entry, categoryPath, progress, category === 'Movies'))
                        );

                        homepageContent[category] = items.filter(item => !item.error);

                    } catch (dirError) {
                        console.error(`Could not read category directory "${categoryPath}":`, dirError.message);
                        homepageContent[category] = [];
                    }
                }

                homepageResponseCache.payload = homepageContent;
                homepageResponseCache.expiresAt = Date.now() + LIBRARY_RESPONSE_CACHE_TTL_MS;
                return homepageContent;
            })().finally(() => {
                homepageResponseCache.promise = null;
            });
        }

        res.json(await homepageResponseCache.promise);

    } catch (error) {
        console.error('Error building homepage content:', error);
        res.status(500).json({ error: 'Failed to build homepage content.' });
    }
});

// API endpoint to get the list of videos and directories for a given path
app.get('/api/videos', async (req, res) => {
    const relativePath = req.query.path || '';
    const resolvedDirectory = resolveMediaPath(videosDirectory, relativePath, { mustExist: false });
    if (!resolvedDirectory) {
        return res.status(403).json({ error: 'Forbidden: Access is denied.' });
    }
    const requestedPath = resolvedDirectory.fullPath;
    const canonicalRelativePath = resolvedDirectory.relativePath === '.' ? '' : resolvedDirectory.relativePath;

    try {
        const cachedDirectory = getDirectoryCacheEntry(canonicalRelativePath);
        if (cachedDirectory?.payload && cachedDirectory.expiresAt > Date.now()) {
            return res.json(cachedDirectory.payload);
        }

        if (!cachedDirectory?.promise) {
            const buildPromise = (async () => {
                const [entries, progress] = await Promise.all([
                    fsp.readdir(requestedPath, { withFileTypes: true }),
                    readProgressFile()
                ]);
        
                const isMoviePath = canonicalRelativePath.toLowerCase().startsWith('movies');

                let tmdbInfo = null;
                if (canonicalRelativePath) {
                    let pathToFetch = canonicalRelativePath;
                    const dirName = path.basename(canonicalRelativePath);
                    const parentDir = path.dirname(canonicalRelativePath);

                    // If the current folder is a season folder, we want the metadata of the parent series.
                    if (SEASON_PATTERN.test(dirName) && parentDir !== '.') {
                        pathToFetch = parentDir;
                    }
                    
                    const dirNameLower = path.basename(pathToFetch).toLowerCase();
                    const parentOfPathToFetch = path.dirname(pathToFetch);
                    const isRootCategory = IGNORED_ROOT_FOLDERS.includes(dirNameLower) && (parentOfPathToFetch === '.' || parentOfPathToFetch === '');

                    if (!isRootCategory) {
                        tmdbInfo = await getTmdbInfo(pathToFetch, isMoviePath ? 'movie' : 'tv');
                        await applyThumbnailOverride(pathToFetch, tmdbInfo);
                    }
                }

                const directoryEntries = entries.filter(entry => entry.isDirectory());
                const fileEntries = entries.filter(entry => !entry.isDirectory() && /\.(mp4|mkv|avi|mov)$/i.test(entry.name));

                const [directories, files] = await Promise.all([
                    Promise.all(directoryEntries.map(async (dir) => {
                const dirInfo = { name: dir.name };
                const dirFullPath = path.join(requestedPath, dir.name);

                // Check for single season folder to provide a direct link
                let urlPath = path.join(canonicalRelativePath, dir.name); // Default path
                try {
                    const subEntries = await fsp.readdir(dirFullPath, { withFileTypes: true });
                    const subDirs = subEntries.filter(e => e.isDirectory());
                    const videoFilesInRoot = subEntries.some(e => e.isFile() && /\.(mp4|mkv|avi|mov)$/i.test(e.name));

                    if (subDirs.length === 1 && !videoFilesInRoot && SEASON_PATTERN.test(subDirs[0].name)) {
                        urlPath = path.join(urlPath, subDirs[0].name);
                    }
                } catch (e) { /* ignore */ }
                dirInfo.url = urlPath.replace(/\\/g, '/');

                // 1. Check for a manually placed poster image (poster.jpg or poster.png).
                try {
                    const posterFiles = await fsp.readdir(dirFullPath);
                    const posterFileName = posterFiles.find(f => f.toLowerCase() === 'poster.jpg' || f.toLowerCase() === 'poster.png');

                    if (posterFileName) {
                        const posterRelativePath = path.join(canonicalRelativePath, dir.name, posterFileName).replace(/\\/g, '/');
                        dirInfo.posterUrl = `/videos/${posterRelativePath}`; // Served via the existing /videos static route
                    }
                } catch (e) { /* Ignore errors like permission denied, proceed without manual poster */ }

                // 2. If no manual poster, try TMDB (unless it's an explicitly ignored/season folder)
                if (!dirInfo.posterUrl) {
                    const isIgnored = SEASON_PATTERN.test(dir.name) || (!canonicalRelativePath && IGNORED_ROOT_FOLDERS.includes(dir.name.toLowerCase()));
                    if (!isIgnored) {
                        const type = isMoviePath ? 'movie' : 'tv';
                        const dirRelativePath = path.join(canonicalRelativePath, dir.name);
                        const tmdbData = await getTmdbInfo(dirRelativePath, type);
                        // Merge tmdbData into dirInfo, which will add posterUrl if found
                        Object.assign(dirInfo, tmdbData);
                    }
                }
                
                // 3. If there's STILL no poster, try to generate one from the first video file.
                // This now serves as a fallback for all folders, including seasons and ignored root folders.
                if (!dirInfo.posterUrl) {
                    try {
                        const folderRelativePath = path.join(canonicalRelativePath, dir.name).replace(/\\/g, '/');
                        const bestThumbnailSource = await getBestThumbnailSourceForDirectory(folderRelativePath);
                        if (bestThumbnailSource) {
                            const generated = await ensureGeneratedThumbnail(bestThumbnailSource, 'folder-thumbnails', `${folderRelativePath}:default`, ['35%']);
                            dirInfo.posterUrl = generated.thumbnailUrl;
                        }
                    } catch (thumbError) {
                        console.error(`Could not generate folder thumbnail for ${dir.name}:`, thumbError.message);
                    }
                }

                await applyThumbnailOverride(path.join(canonicalRelativePath, dir.name).replace(/\\/g, '/'), dirInfo);

                return dirInfo;
            })),
                    Promise.all(fileEntries.map(async (entry) => {
                const entryPath = path.join(canonicalRelativePath, entry.name);
                const filePath = path.join(videosDirectory, entryPath);
                
                // Generate a stable hash for the thumbnail filename
                const hash = crypto.createHash('md5').update(entryPath).digest('hex');
                const thumbnailFilename = `${hash}.jpg`;
                const thumbnailPath = path.join(thumbnailsDirectory, thumbnailFilename);
                const thumbnailUrl = `/thumbnails/${thumbnailFilename}`;

                try {
                    await ensureThumbnailFile(filePath, thumbnailPath, { timestamps: ['35%'] });
                } catch (thumbError) {
                    console.error(thumbError.message);
                }

                try {
                    const stats = await fsp.stat(filePath);
                    const durationInSeconds = await getCachedVideoDuration(filePath);
                    const fileProgress = progress[entryPath.replace(/\\/g, '/')];

                    return {
                        name: entry.name,
                        duration: formatDuration(durationInSeconds),
                        durationSeconds: durationInSeconds,
                        url: entryPath.replace(/\\/g, '/'),
                        size: stats.size,
                        modified: stats.mtime,
                        thumbnailUrl: thumbnailUrl,
                        progress: fileProgress ? fileProgress.time : 0
                    };
                } catch (error) {
                    console.error(`Could not get info for ${entry.name}:`, error);
                    return {
                        name: entry.name,
                        duration: 'Unknown',
                        url: entryPath.replace(/\\/g, '/'),
                        size: 0,
                        modified: null,
                        thumbnailUrl: null,
                        progress: 0
                    };
                }
                    }))
                ]);

                // Sort directories and files with natural sorting for episode numbers
                directories.sort(naturalSort);
                files.sort(naturalSort);

                return { path: canonicalRelativePath, directories, files, tmdbInfo };
            })().catch((error) => {
                directoryResponseCache.delete(canonicalRelativePath);
                throw error;
            });

            directoryResponseCache.set(canonicalRelativePath, {
                payload: null,
                expiresAt: 0,
                promise: buildPromise
            });
        }

        const directoryPayload = await directoryResponseCache.get(canonicalRelativePath).promise;
        directoryResponseCache.set(canonicalRelativePath, {
            payload: directoryPayload,
            expiresAt: Date.now() + LIBRARY_RESPONSE_CACHE_TTL_MS,
            promise: null
        });
        res.json(directoryPayload);

    } catch (error) {
        console.error('Error reading directory:', error);
        if (error.code === 'ENOENT') {
            return res.status(404).json({ error: 'Directory not found.' });
        }
        res.status(500).json({ error: 'Failed to retrieve directory contents.' });
    }
});

/**
 * Reads the progress data from the JSON file.
 * @returns {Promise<object>} A promise that resolves to the progress data.
 */
async function readProgressFile() {
    if (progressCache) {
        return progressCache;
    }

    if (!progressCacheLoadPromise) {
        progressCacheLoadPromise = (async () => {
            try {
                await fsp.access(progressFilePath);
                const data = await fsp.readFile(progressFilePath, 'utf-8');
                progressCache = JSON.parse(data || '{}');
            } catch (error) {
                progressCache = {};
            }

            return progressCache;
        })();
    }

    return progressCacheLoadPromise;
}

async function flushProgressCache() {
    if (!progressDirty) {
        return;
    }

    progressDirty = false;
    await fsp.writeFile(progressFilePath, JSON.stringify(progressCache || {}, null, 2));
}

async function flushProgressCacheOnShutdown() {
    try {
        if (progressFlushTimer) {
            clearTimeout(progressFlushTimer);
            progressFlushTimer = null;
        }
        await flushProgressCache();
    } catch (error) {
        console.error('Failed to flush progress cache during shutdown:', error);
    }
}

function scheduleProgressFlush() {
    progressDirty = true;

    if (progressFlushTimer) {
        return progressFlushPromise || Promise.resolve();
    }

    progressFlushPromise = new Promise((resolve, reject) => {
        progressFlushTimer = setTimeout(async () => {
            progressFlushTimer = null;
            try {
                await flushProgressCache();
                resolve();
            } catch (error) {
                reject(error);
            } finally {
                progressFlushPromise = null;
            }
        }, PROGRESS_FLUSH_DEBOUNCE_MS);
    });

    return progressFlushPromise;
}

/**
 * Writes the progress data to the JSON file.
 * @param {object} data - The data to write.
 */
async function writeProgressFile(data) {
    progressCache = data || {};
    progressDirty = false;
    if (progressFlushTimer) {
        clearTimeout(progressFlushTimer);
        progressFlushTimer = null;
    }
    await fsp.writeFile(progressFilePath, JSON.stringify(progressCache, null, 2));
    invalidateLibraryCaches();
    progressFlushPromise = null;
}

// -----------------------------------------------------------------------------
// --- WebSocket Handling for Real-time Communication ---
// -----------------------------------------------------------------------------

/**
 * Creates a unique, safe room name from a video file path.
 * @param {string} videoFile - The relative path to the video file.
 * @returns {string} A hashed room name.
 */
function getRoomFromVideoFile(videoFile) {
    // Use a clean hash for the room name to avoid issues with special characters in filenames
    return crypto.createHash('md5').update(videoFile || '').digest('hex');
}

function generateRoomCode() {
    let value = '';
    for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
        const randomIndex = crypto.randomInt(0, ROOM_CODE_ALPHABET.length);
        value += ROOM_CODE_ALPHABET[randomIndex];
    }
    return value;
}

function cleanupExpiredSharedRooms() {
    const now = Date.now();
    for (const [roomCode, room] of sharedRooms.entries()) {
        if ((now - room.lastUsedAt) <= ROOM_TTL_MS) {
            continue;
        }

        sharedRooms.delete(roomCode);
        clearPendingAction(room.roomKey);
        delete roomLeaders[room.roomKey];
        delete roomStates[room.roomKey];
    }
}

function createSharedRoom(videoFile) {
    cleanupExpiredSharedRooms();

    let roomCode = generateRoomCode();
    while (sharedRooms.has(roomCode)) {
        roomCode = generateRoomCode();
    }

    const now = Date.now();
    const roomKey = `share:${roomCode}`;
    const room = {
        roomCode,
        roomKey,
        videoFile,
        createdAt: now,
        lastUsedAt: now
    };

    sharedRooms.set(roomCode, room);
    scheduleRoomStatePersist();
    return room;
}

function getSharedRoom(roomCode) {
    if (!roomCode) {
        return null;
    }

    cleanupExpiredSharedRooms();
    const normalizedCode = String(roomCode).trim().toUpperCase();
    const room = sharedRooms.get(normalizedCode);
    if (!room) {
        return null;
    }

    room.lastUsedAt = Date.now();
    scheduleRoomStatePersist();
    return room;
}

function summarizeRoomDiagnostics(roomKey, metadata = {}) {
    const state = roomStates[roomKey];
    const clients = state?.clients || {};

    return {
        roomKey,
        roomCode: metadata.roomCode || null,
        videoFile: metadata.videoFile || state?.syncSnapshot?.videoFile || null,
        createdAt: metadata.createdAt || null,
        lastUsedAt: metadata.lastUsedAt || null,
        expiresInMs: metadata.expiresInMs ?? null,
        clientCount: Object.keys(clients).length,
        leaderSocketId: roomLeaders[roomKey] || null,
        pendingAction: state?.pendingAction
            ? {
                type: state.pendingAction.type || null,
                createdAt: state.pendingAction.createdAt || null
            }
            : null,
        syncSnapshot: getRoomSyncSnapshot(roomKey),
        clients: Object.entries(clients).map(([socketId, client]) => ({
            socketId,
            isReady: Boolean(client?.isReady),
            lastReadyUpdate: client?.lastReadyUpdate || 0,
            cameraEnabled: Boolean(client?.cameraEnabled)
        }))
    };
}

function clearPendingAction(room) {
    const state = roomStates[room];
    if (!state) {
        return;
    }

    if (state.pendingActionTimer) {
        clearTimeout(state.pendingActionTimer);
        state.pendingActionTimer = null;
    }

    state.pendingAction = null;
}

function clearPendingSnapshotFallback(targetSocketId) {
    const pending = pendingSnapshotFallbacks.get(targetSocketId);
    if (!pending) {
        return;
    }

    clearTimeout(pending.timer);
    pendingSnapshotFallbacks.delete(targetSocketId);
}

function getRoomClientCount(room) {
    return roomStates[room] ? Object.keys(roomStates[room].clients).length : 0;
}

function broadcastLeaderStatuses(room) {
    const state = roomStates[room];
    if (!state) {
        return;
    }

    const leaderSocketId = roomLeaders[room];
    for (const socketId of Object.keys(state.clients)) {
        io.to(socketId).emit('leaderStatus', { isLeader: socketId === leaderSocketId });
    }
}

function getRoomSyncSnapshot(room) {
    const snapshot = roomStates[room]?.syncSnapshot;
    if (!snapshot) {
        return null;
    }

    const now = Date.now();
    const baseTime = Math.max(0, Number(snapshot.time) || 0);
    const elapsedSeconds = snapshot.paused ? 0 : Math.max(0, (now - (snapshot.serverTimestamp || snapshot.updatedAt || now)) / 1000);

    return {
        ...snapshot,
        time: baseTime + elapsedSeconds,
        estimatedAt: now
    };
}

function updateRoomSyncSnapshot(room, patch = {}) {
    const state = roomStates[room];
    if (!state) {
        return null;
    }

    const currentSnapshot = getRoomSyncSnapshot(room) || {};
    const now = Date.now();
    const nextSnapshot = {
        videoFile: patch.videoFile ?? currentSnapshot.videoFile ?? null,
        time: Math.max(0, Number(patch.time ?? currentSnapshot.time) || 0),
        paused: patch.paused ?? currentSnapshot.paused ?? true,
        seekId: patch.seekId !== undefined ? (patch.seekId || null) : (currentSnapshot.seekId ?? null),
        subtitleUrl: patch.subtitleUrl !== undefined ? patch.subtitleUrl : (currentSnapshot.subtitleUrl ?? null),
        subtitleOffsetMs: Number.parseInt(patch.subtitleOffsetMs ?? currentSnapshot.subtitleOffsetMs ?? 0, 10) || 0,
        audioTrackIndex: patch.audioTrackIndex !== undefined ? patch.audioTrackIndex : (currentSnapshot.audioTrackIndex ?? null),
        sourceSocketId: patch.sourceSocketId ?? currentSnapshot.sourceSocketId ?? roomLeaders[room] ?? null,
        updatedAt: now,
        serverTimestamp: now
    };

    state.syncSnapshot = nextSnapshot;
    scheduleRoomStatePersist();
    return nextSnapshot;
}

function emitBootstrapSnapshot(socket, room) {
    if (!socket) {
        return;
    }

    const snapshot = getRoomSyncSnapshot(room);
    if (!snapshot) {
        return;
    }

    if ((Date.now() - (snapshot.updatedAt || 0)) > SNAPSHOT_FALLBACK_AGE_MS) {
        return;
    }

    socket.emit('roomSyncBootstrap', snapshot);
}

io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);

    socket.on('joinRoom', ({ videoFile, roomCode } = {}) => {
        let sharedRoom = null;
        let resolvedMedia = null;

        if (roomCode) {
            sharedRoom = getSharedRoom(roomCode);
            if (!sharedRoom) {
                socket.emit('roomNotFound');
                return;
            }

            resolvedMedia = resolveMediaPath(videosDirectory, sharedRoom.videoFile);
            if (!resolvedMedia) {
                socket.emit('roomNotFound');
                return;
            }

            if (videoFile) {
                const requestedMedia = resolveMediaPath(videosDirectory, videoFile);
                if (!requestedMedia || requestedMedia.relativePath !== resolvedMedia.relativePath) {
                    socket.emit('roomNotFound');
                    return;
                }
            }
        } else {
            if (!videoFile) {
                return;
            }

            resolvedMedia = resolveMediaPath(videosDirectory, videoFile);
            if (!resolvedMedia) {
                console.warn(`Rejected joinRoom for unknown video path: ${videoFile}`);
                return;
            }
        }

        socket.currentVideoFile = resolvedMedia.relativePath;
        socket.roomCode = sharedRoom?.roomCode || null;
        const room = sharedRoom?.roomKey || getRoomFromVideoFile(resolvedMedia.relativePath);
        const roomSize = io.sockets.adapter.rooms.get(room)?.size || 0;

        if (roomSize >= 2) {
            socket.emit('roomFull');
            return;
        }

        socket.join(room);
        socket.currentRoom = room;

        // Initialize room state if it doesn't exist
        if (!roomStates[room]) {
            roomStates[room] = {
                pendingAction: null,
                pendingActionTimer: null,
                clients: {},
                lastPartnerDisconnectAt: 0,
                syncSnapshot: {
                    videoFile: resolvedMedia.relativePath,
                    time: 0,
                    paused: true,
                    seekId: null,
                    subtitleUrl: null,
                    subtitleOffsetMs: 0,
                    audioTrackIndex: null,
                    sourceSocketId: null,
                    updatedAt: Date.now(),
                    serverTimestamp: Date.now()
                }
            };
            scheduleRoomStatePersist();
        }
        // Add client to the room state
        roomStates[room].clients[socket.id] = { isReady: false, lastReadyUpdate: 0, cameraEnabled: false };
        const wasReconnect = roomSize > 0 && roomStates[room].lastPartnerDisconnectAt > 0 && (Date.now() - roomStates[room].lastPartnerDisconnectAt) < 15000;

        // Leader election
        if (!roomLeaders[room]) {
            roomLeaders[room] = socket.id;
        }

        if (roomSize > 0) {
            socket.to(room).emit('presenceUpdate', {
                type: wasReconnect ? 'partner_rejoining' : 'partner_joining',
                timestamp: Date.now()
            });
        }

        io.to(room).emit('userCountUpdate', { count: roomSize + 1 });
        broadcastLeaderStatuses(room);
        if (roomSize > 0) {
            emitBootstrapSnapshot(socket, room);
            io.to(room).emit('presenceUpdate', {
                type: wasReconnect ? 'partner_reconnected' : 'partner_connected',
                timestamp: Date.now()
            });
        }
        socket.emit('joined', {
            roomCode: socket.roomCode,
            videoFile: socket.currentVideoFile,
            shareUrl: socket.roomCode ? `/player.html?video=${encodeURIComponent(socket.currentVideoFile)}&room=${encodeURIComponent(socket.roomCode)}` : null,
            participantCount: roomSize + 1,
            isLeader: roomLeaders[room] === socket.id
        });
        console.log(`A user joined room: ${room}`);
    });

    const findPreviousVideo = async (currentVideoFile) => {
        const currentVideoPath = path.join(videosDirectory, currentVideoFile);
        const dir = path.dirname(currentVideoPath);
        
        try {
            const entries = await fsp.readdir(dir);
            const videoFiles = entries
                .filter(file => /\.(mp4|mkv|avi|mov)$/i.test(file))
                .sort(naturalSort);

            const currentIndex = videoFiles.findIndex(file => path.join(dir, file) === currentVideoPath);

            if (currentIndex > 0) { // If it's not the first video
                const prevVideoName = videoFiles[currentIndex - 1];
                const prevVideoRelativePath = path.relative(videosDirectory, path.join(dir, prevVideoName));
                return prevVideoRelativePath.replace(/\\/g, '/');
            }
            return null; // No previous video found
        } catch (error) {
            console.error("Error finding previous video:", error);
            return null;
        }
    };

    const findNextVideo = async (currentVideoFile) => {
        const currentVideoPath = path.join(videosDirectory, currentVideoFile);
        const dir = path.dirname(currentVideoPath);
        
        try {
            const entries = await fsp.readdir(dir);
            const videoFiles = entries
                .filter(file => /\.(mp4|mkv|avi|mov)$/i.test(file))
                .sort(naturalSort);

            const currentIndex = videoFiles.findIndex(file => path.join(dir, file) === currentVideoPath);

            if (currentIndex !== -1 && currentIndex < videoFiles.length - 1) {
                const nextVideoName = videoFiles[currentIndex + 1];
                // Construct the relative path from the 'videos' directory
                const nextVideoRelativePath = path.relative(videosDirectory, path.join(dir, nextVideoName));
                return nextVideoRelativePath.replace(/\\/g, '/');
            }
            return null; // No next video found
        } catch (error) {
            console.error("Error finding next video:", error);
            return null;
        }
    };

    socket.on('checkPreviousVideo', async ({ videoFile }) => {
        const prevVideo = await findPreviousVideo(videoFile);
        if (prevVideo) {
            socket.emit('previousVideoAvailable', { available: true, video: prevVideo });
        } else {
            socket.emit('previousVideoAvailable', { available: false, video: null });
        }
    });

    socket.on('requestPreviousVideo', async ({ videoFile }) => {
        if (socket.currentRoom) {
            const prevVideo = await findPreviousVideo(videoFile);
            if (prevVideo) {
                io.to(socket.currentRoom).emit('loadPreviousVideo', { video: prevVideo });
            }
        }
    });

    socket.on('checkNextVideo', async ({ videoFile }) => {
        const nextVideo = await findNextVideo(videoFile);
        if (nextVideo) {
            socket.emit('nextVideoAvailable', { available: true, video: nextVideo });
        } else {
            socket.emit('nextVideoAvailable', { available: false, video: null });
        }
    });

    socket.on('requestNextVideo', async ({ videoFile }) => {
        if (socket.currentRoom) {
            const nextVideo = await findNextVideo(videoFile);
            if (nextVideo) {
                io.to(socket.currentRoom).emit('loadNextVideo', { video: nextVideo });
            }
        }
    });

    socket.on('startNextEpisodeCountdown', ({ video, countdownSeconds = 8 } = {}) => {
        if (!video) {
            return;
        }

        const room = socket.currentRoom;
        const payload = {
            video,
            countdownSeconds: Math.max(3, Math.min(Number(countdownSeconds) || 8, 15)),
            timestamp: Date.now()
        };

        if (room) {
            io.to(room).emit('nextEpisodeCountdownStart', payload);
            return;
        }

        socket.emit('nextEpisodeCountdownStart', payload);
    });

    socket.on('cancelNextEpisodeCountdown', () => {
        if (socket.currentRoom) {
            io.to(socket.currentRoom).emit('nextEpisodeCountdownCancel', { timestamp: Date.now() });
        } else {
            socket.emit('nextEpisodeCountdownCancel', { timestamp: Date.now() });
        }
    });

    socket.on('confirmNextEpisodeCountdown', ({ video } = {}) => {
        if (!video) {
            return;
        }

        if (socket.currentRoom) {
            io.to(socket.currentRoom).emit('loadNextVideo', { video });
        } else {
            socket.emit('loadNextVideo', { video });
        }
    });

    // --- Event Handlers for Video Sync ---
    socket.on('getProgress', async ({ videoFile }) => {
        try {
            const room = socket.currentRoom;
            const participantCount = room ? (io.sockets.adapter.rooms.get(room)?.size || 0) : 0;
            if (room && participantCount > 1) {
                socket.emit('loadProgress', { time: 0, ignoredForSharedRoom: true });
                return;
            }
            const progress = await readProgressFile();
            const resolvedMedia = resolveMediaPath(videosDirectory, videoFile);
            if (!resolvedMedia) {
                socket.emit('loadProgress', { time: 0 });
                return;
            }

            const canonicalVideoFile = resolvedMedia.relativePath;
            const videoProgress = progress[canonicalVideoFile];

            if (videoProgress && videoProgress.time) {
                const durationInSeconds = await getCachedVideoDuration(resolvedMedia.fullPath);

                // If watched for more than 95%, try to load the next episode.
                if (durationInSeconds > 0 && (videoProgress.time / durationInSeconds) >= 0.95) {
                    const nextVideo = await findNextVideo(canonicalVideoFile);
                    if (nextVideo) {
                        // We found a next episode, tell the client to load it.
                        socket.emit('loadNextVideo', { video: nextVideo });
                    } else {
                        // It was the last episode, so just start it from the beginning.
                        socket.emit('loadProgress', { time: 0 });
                    }
                } else {
                    // Standard resume.
                    socket.emit('loadProgress', videoProgress);
                }
            }
        } catch (error) {
            console.error(`Error in getProgress for ${videoFile}:`, error.message);
            // If something goes wrong (e.g., file not found), just start from the beginning.
            socket.emit('loadProgress', { time: 0 });
        }
    });

    // NEW HANDLER for client readiness updates with enhanced logging
    socket.on('readyStateUpdate', ({ isReady }) => {
        const room = socket.currentRoom;
        if (room && roomStates[room] && roomStates[room].clients[socket.id]) {
            const now = Date.now();
            const lastUpdate = roomStates[room].clients[socket.id].lastReadyUpdate || 0;
            const timeSinceLastUpdate = now - lastUpdate;
            
            console.log(`[STATE] Readiness update from ${socket.id} in room ${room}: ${isReady} (${timeSinceLastUpdate}ms since last update)`);
            
            roomStates[room].clients[socket.id].isReady = isReady;
            roomStates[room].clients[socket.id].lastReadyUpdate = now;
            socket.to(room).emit('partnerReadyState', {
                socketId: socket.id,
                isReady,
                timestamp: now
            });

            // If the client is ready, check if we can execute a pending action
            if (isReady) {
                checkAndExecutePendingAction(room);
            } else {
                // If client becomes not ready during a pending action, clear it
                if (roomStates[room].pendingAction) {
                    const actionAge = now - (roomStates[room].pendingAction.timestamp || 0);
                    if (actionAge < 2000) { // Only clear recent actions
                        console.log(`[STATE] Clearing recent pending action due to client not ready`);
                        clearPendingAction(room);
                    }
                }
            }
        }
    });

    // NEW: Connection health check
    socket.on('connectionHealthCheck', () => {
        socket.emit('connectionHealthResponse', { timestamp: Date.now() });
    });

    // NEW: Force ready state sync for recovery
    socket.on('requestReadyStateSync', () => {
        const room = socket.currentRoom;
        if (room && roomStates[room]) {
            const clientsInfo = Object.entries(roomStates[room].clients).map(([id, client]) => ({
                id: id,
                isReady: client.isReady,
                lastUpdate: client.lastReadyUpdate || 0
            }));
            socket.emit('readyStateSync', { 
                clients: clientsInfo,
                pendingAction: roomStates[room].pendingAction?.type || null,
                syncSnapshot: getRoomSyncSnapshot(room)
            });
        }
    });

    socket.on('requestWebcamStateSync', () => {
        const room = socket.currentRoom;
        if (!room || !roomStates[room]) {
            return;
        }

        const clientsInfo = Object.entries(roomStates[room].clients).map(([id, client]) => ({
            id,
            cameraEnabled: Boolean(client?.cameraEnabled)
        }));
        socket.emit('webcamStateSync', { clients: clientsInfo });
    });

    socket.on('webcamStateUpdate', ({ enabled } = {}) => {
        const room = socket.currentRoom;
        if (!room || !roomStates[room] || !roomStates[room].clients[socket.id]) {
            return;
        }

        roomStates[room].clients[socket.id].cameraEnabled = Boolean(enabled);
        socket.to(room).emit('partnerCameraState', {
            socketId: socket.id,
            cameraEnabled: Boolean(enabled),
            timestamp: Date.now()
        });
    });

    socket.on('webrtcOffer', ({ targetSocketId, description, reason } = {}) => {
        if (!socket.currentRoom || !targetSocketId || !description) {
            return;
        }
        io.to(targetSocketId).emit('webrtcOffer', {
            socketId: socket.id,
            description,
            reason,
            timestamp: Date.now()
        });
    });

    socket.on('webrtcAnswer', ({ targetSocketId, description } = {}) => {
        if (!socket.currentRoom || !targetSocketId || !description) {
            return;
        }
        io.to(targetSocketId).emit('webrtcAnswer', {
            socketId: socket.id,
            description,
            timestamp: Date.now()
        });
    });

    socket.on('webrtcIceCandidate', ({ targetSocketId, candidate } = {}) => {
        if (!socket.currentRoom || !targetSocketId || !candidate) {
            return;
        }
        io.to(targetSocketId).emit('webrtcIceCandidate', {
            socketId: socket.id,
            candidate,
            timestamp: Date.now()
        });
    });

    socket.on('webrtcHangup', ({ targetSocketId } = {}) => {
        if (!socket.currentRoom) {
            return;
        }
        const payload = {
            socketId: socket.id,
            timestamp: Date.now()
        };
        if (targetSocketId) {
            io.to(targetSocketId).emit('webrtcHangup', payload);
            return;
        }
        socket.to(socket.currentRoom).emit('webrtcHangup', payload);
    });

    // This generic handler broadcasts events to all clients in the room (including sender).
    const createBroadcastToAllHandler = (eventName) => {
        socket.on(eventName, (data) => {
            if (socket.currentRoom) {
                const now = Date.now();
                const latency = data.timestamp ? now - data.timestamp : 0;
                
                console.log(`[SERVER ${eventName.toUpperCase()}] Broadcasting ${eventName} from ${socket.id}:`, {
                    timestamp: now,
                    clientTimestamp: data.timestamp,
                    latency: latency + 'ms',
                    time: data.time,
                    room: socket.currentRoom,
                    clientCount: io.sockets.adapter.rooms.get(socket.currentRoom)?.size || 0
                });

                // We add the initiator's socket ID to the payload
                const payload = { 
                    ...data, 
                    initiator: socket.id,
                    serverTimestamp: now
                };

                if (eventName === 'pause') {
                    updateRoomSyncSnapshot(socket.currentRoom, {
                        videoFile: socket.currentVideoFile,
                        time: data.time,
                        paused: true,
                        sourceSocketId: socket.id
                    });
                }

                io.to(socket.currentRoom).emit(eventName, payload);
            }
            // Save progress on pause event
            if (eventName === 'pause' && data.videoFile && typeof data.time === 'number') {
                saveProgress(data.videoFile, data.time);
            }
        });
    };

    // This handler broadcasts to all OTHER clients in the room.
    const createBroadcastToOthersHandler = (eventName) => {
        socket.on(eventName, (data) => {
            if (socket.currentRoom) {
                const now = Date.now();
                const latency = data.timestamp ? now - data.timestamp : 0;
                
                console.log(`[SERVER ${eventName.toUpperCase()}] Broadcasting ${eventName} to others from ${socket.id}:`, {
                    timestamp: now,
                    clientTimestamp: data.timestamp,
                    latency: latency + 'ms',
                    time: data.time,
                    room: socket.currentRoom,
                    clientCount: io.sockets.adapter.rooms.get(socket.currentRoom)?.size || 0
                });

                const payload = { 
                    ...data,
                    serverTimestamp: now
                };

                if (eventName === 'seek') {
                    updateRoomSyncSnapshot(socket.currentRoom, {
                        videoFile: socket.currentVideoFile,
                        time: data.time,
                        seekId: data.seekId || null,
                        sourceSocketId: socket.id
                    });
                }

                socket.to(socket.currentRoom).emit(eventName, payload);
            }
        });
    };

    // Modified 'play' handler, now named 'requestPlay'
    socket.on('requestPlay', (data) => {
        const room = socket.currentRoom;
        if (room && roomStates[room]) {
            const now = Date.now();
            const latency = data.timestamp ? now - data.timestamp : 0;
            
            console.log(`[SERVER PLAY] Received requestPlay from ${socket.id} in room ${room}:`, {
                timestamp: now,
                clientTimestamp: data.timestamp,
                latency: latency + 'ms',
                time: data.time,
                initiator: socket.id,
                roomState: {
                    pendingAction: roomStates[room].pendingAction?.type,
                    clientCount: Object.keys(roomStates[room].clients).length,
                    allReady: Object.values(roomStates[room].clients).every(client => client.isReady)
                }
            });

            // Clear any stale pending actions older than 10 seconds
            if (roomStates[room].pendingAction && 
                (now - (roomStates[room].pendingAction.timestamp || 0)) > 10000) {
                console.log(`[SERVER PLAY] Clearing stale pending action`);
                clearPendingAction(room);
            }

            updateRoomSyncSnapshot(room, {
                videoFile: socket.currentVideoFile,
                time: data.time,
                paused: false,
                sourceSocketId: socket.id
            });

            roomStates[room].pendingAction = {
                type: 'play',
                timestamp: now,
                data: { 
                    ...data, 
                    initiator: socket.id,
                    serverTimestamp: now // Add server timestamp for client-side latency calculation
                }
            };
            checkAndExecutePendingAction(room, socket.id); // Pass initiatorId to notify them if waiting
        }
    });

    socket.on('saveProgress', ({ videoFile, time }) => {
        if (videoFile && typeof time === 'number') {
            saveProgress(videoFile, time);
        }
    });

    createBroadcastToAllHandler('pause'); // Pause can still be immediate and for everyone
    createBroadcastToOthersHandler('returnToLobby');
    createBroadcastToOthersHandler('seek');

    socket.on('subtitleOffsetUpdate', (data = {}) => {
        if (!socket.currentRoom) {
            return;
        }

        const resolvedMedia = resolveMediaPath(videosDirectory, data.videoFile || socket.currentVideoFile);
        const payload = {
            ...data,
            videoFile: resolvedMedia?.relativePath || socket.currentVideoFile,
            serverTimestamp: Date.now()
        };

        updateRoomSyncSnapshot(socket.currentRoom, {
            videoFile: payload.videoFile,
            subtitleOffsetMs: payload.offset,
            sourceSocketId: socket.id
        });

        socket.to(socket.currentRoom).emit('subtitleOffsetUpdate', payload);
    });

    socket.on('subtitleSelectionUpdate', (data = {}) => {
        if (!socket.currentRoom) {
            return;
        }

        const resolvedMedia = resolveMediaPath(videosDirectory, data.videoFile || socket.currentVideoFile);
        const payload = {
            ...data,
            videoFile: resolvedMedia?.relativePath || socket.currentVideoFile,
            serverTimestamp: Date.now()
        };

        updateRoomSyncSnapshot(socket.currentRoom, {
            videoFile: payload.videoFile,
            subtitleUrl: payload.subtitleUrl || null,
            sourceSocketId: socket.id
        });

        socket.to(socket.currentRoom).emit('subtitleSelectionUpdate', payload);
    });

    socket.on('audioTrackSelectionUpdate', (data = {}) => {
        if (!socket.currentRoom) {
            return;
        }

        const resolvedMedia = resolveMediaPath(videosDirectory, data.videoFile || socket.currentVideoFile);
        const payload = {
            ...data,
            videoFile: resolvedMedia?.relativePath || socket.currentVideoFile,
            serverTimestamp: Date.now()
        };

        updateRoomSyncSnapshot(socket.currentRoom, {
            videoFile: payload.videoFile,
            audioTrackIndex: payload.audioTrackIndex ?? null,
            sourceSocketId: socket.id
        });

        socket.to(socket.currentRoom).emit('audioTrackSelectionUpdate', payload);
    });

    socket.on('markVideo', async ({ videoFile, watched }) => {
        try {
            const result = await markVideoProgress(videoFile, watched);
            socket.emit('videoMarked', result); // Acknowledge with new time
        } catch (error) {
            console.error(`Error marking video ${videoFile}:`, error);
        }
    });

    socket.on('markFolder', async ({ folderPath, watched }) => {
        try {
            const resolvedFolder = getResolvedMediaOrThrow(folderPath);
            const fullFolderPath = resolvedFolder.fullPath;
            const entries = await fsp.readdir(fullFolderPath);
            const videoFiles = entries.filter(file => /\.(mp4|mkv|avi|mov)$/i.test(file));
            
            for (const file of videoFiles) {
                const videoRelativePath = path.join(resolvedFolder.relativePath, file).replace(/\\/g, '/');
                let newTime = 0;
                if (watched) {
                    const videoFullPath = path.join(fullFolderPath, file);
                    const durationInSeconds = await getCachedVideoDuration(videoFullPath);
                    newTime = durationInSeconds;
                }
                await saveProgress(videoRelativePath, newTime);
            }
            socket.emit('folderMarked', { folderPath: resolvedFolder.relativePath, watched }); // Acknowledge
        } catch (error) {
            console.error(`Error marking folder ${folderPath}:`, error);
        }
    });

    socket.on('leaderTimeUpdate', (data) => {
        if (socket.currentRoom && roomLeaders[socket.currentRoom] === socket.id) {
            updateRoomSyncSnapshot(socket.currentRoom, {
                videoFile: socket.currentVideoFile,
                time: data.time,
                paused: data.paused,
                sourceSocketId: socket.id
            });
            socket.to(socket.currentRoom).emit('syncTime', data);
        }
    });

    socket.on('requestSyncSnapshot', ({ requestId } = {}) => {
        const room = socket.currentRoom;
        if (!room) {
            return;
        }

        const fallbackSnapshot = getRoomSyncSnapshot(room);
        const freshFallbackSnapshot = fallbackSnapshot && (Date.now() - (fallbackSnapshot.updatedAt || 0)) <= SNAPSHOT_FALLBACK_AGE_MS
            ? fallbackSnapshot
            : null;

        if (!roomLeaders[room]) {
            if (freshFallbackSnapshot) {
                socket.emit('roomSyncBootstrap', {
                    ...freshFallbackSnapshot,
                    requestId: requestId || null,
                    snapshotSource: 'server-cache'
                });
            }
            return;
        }

        const leaderSocketId = roomLeaders[room];
        if (leaderSocketId === socket.id) {
            if (freshFallbackSnapshot) {
                socket.emit('roomSyncBootstrap', {
                    ...freshFallbackSnapshot,
                    requestId: requestId || null,
                    snapshotSource: 'server-cache'
                });
            }
            return;
        }

        clearPendingSnapshotFallback(socket.id);
        if (freshFallbackSnapshot) {
            const timer = setTimeout(() => {
                pendingSnapshotFallbacks.delete(socket.id);
                const targetSocket = io.sockets.sockets.get(socket.id);
                if (!targetSocket || targetSocket.currentRoom !== room) {
                    return;
                }
                targetSocket.emit('roomSyncBootstrap', {
                    ...freshFallbackSnapshot,
                    requestId: requestId || null,
                    snapshotSource: 'server-cache-deferred'
                });
            }, SNAPSHOT_LEADER_RESPONSE_GRACE_MS);
            pendingSnapshotFallbacks.set(socket.id, {
                room,
                timer
            });
        }

        io.to(leaderSocketId).emit('requestSyncSnapshot', {
            targetSocketId: socket.id,
            requestId: requestId || null,
            requestedAt: Date.now()
        });
    });

    socket.on('syncSnapshot', (data = {}) => {
        const room = socket.currentRoom;
        if (!room) {
            return;
        }

        const targetSocketId = data.targetSocketId;
        const payload = {
            ...data,
            videoFile: socket.currentVideoFile,
            sourceSocketId: socket.id,
            serverTimestamp: Date.now()
        };

        updateRoomSyncSnapshot(room, payload);

        if (targetSocketId) {
            clearPendingSnapshotFallback(targetSocketId);
            io.to(targetSocketId).emit('syncSnapshot', payload);
            return;
        }

        socket.to(room).emit('syncSnapshot', payload);
    });

    socket.on('disconnecting', () => {
        console.log(`User disconnecting: ${socket.id}`);
        clearPendingSnapshotFallback(socket.id);
        const currentRoom = Array.from(socket.rooms).find(room => room !== socket.id);
        
        if (currentRoom) {
            // Check if the disconnecting user was the leader
            const wasLeader = roomLeaders[currentRoom] === socket.id;
            const hadCameraEnabled = Boolean(roomStates[currentRoom]?.clients?.[socket.id]?.cameraEnabled);

            // Remove the disconnected client from our custom state management
            if (roomStates[currentRoom] && roomStates[currentRoom].clients[socket.id]) {
                delete roomStates[currentRoom].clients[socket.id];
            }

            const remainingClients = roomStates[currentRoom] ? Object.keys(roomStates[currentRoom].clients) : [];

            if (remainingClients.length <= 1) {
                clearPendingAction(currentRoom);
            }

            // If the leader left, we need to elect a new one
            if (wasLeader) {
                console.log(`Leader ${socket.id} is leaving room ${currentRoom}`);
                if (remainingClients.length > 0) {
                    const newLeaderId = remainingClients[0]; // Elect the first remaining client
                    roomLeaders[currentRoom] = newLeaderId;
                    updateRoomSyncSnapshot(currentRoom, {
                        sourceSocketId: newLeaderId
                    });
                    broadcastLeaderStatuses(currentRoom);
                    emitBootstrapSnapshot(io.sockets.sockets.get(newLeaderId), currentRoom);
                    console.log(`New leader for room ${currentRoom} is ${newLeaderId}`);
                } else {
                    // The room is now empty, so we clean up all state for it
                    console.log(`Room ${currentRoom} is now empty. Deleting leader and state info.`);
                    delete roomLeaders[currentRoom];
                    delete roomStates[currentRoom];
                    scheduleRoomStatePersist();
                }
            }
            
            // If there are still clients in the room, notify them
            if (remainingClients.length > 0) {
                if (hadCameraEnabled) {
                    socket.to(currentRoom).emit('partnerCameraState', {
                        socketId: socket.id,
                        cameraEnabled: false,
                        timestamp: Date.now()
                    });
                    socket.to(currentRoom).emit('webrtcHangup', {
                        socketId: socket.id,
                        timestamp: Date.now()
                    });
                }
                if (roomStates[currentRoom]) {
                    roomStates[currentRoom].lastPartnerDisconnectAt = Date.now();
                    scheduleRoomStatePersist();
                }
                socket.to(currentRoom).emit('partnerLeft');
                io.to(currentRoom).emit('userCountUpdate', { count: remainingClients.length });
                broadcastLeaderStatuses(currentRoom);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`User ${socket.id} has disconnected.`);
    });
});

/**
 * Saves the progress for a specific video file.
 * @param {string} videoFile - The relative path to the video file.
 * @param {number} time - The current time in seconds.
 */
async function saveProgress(videoFile, time) {
    try {
        const resolvedMedia = resolveMediaPath(videosDirectory, videoFile);
        if (!resolvedMedia || !Number.isFinite(time)) {
            return;
        }

        const canonicalVideoFile = resolvedMedia.relativePath;
        const sanitizedTime = Math.max(0, time);
        const progress = await readProgressFile();
        if (!progress[canonicalVideoFile]) {
            progress[canonicalVideoFile] = {}; // Create entry if not exists
        }

        progress[canonicalVideoFile].time = sanitizedTime;
        progress[canonicalVideoFile].lastWatched = Date.now();

        // If duration is not stored yet, get it and store it.
        if (!progress[canonicalVideoFile].duration) {
            try {
                const duration = await getCachedVideoDuration(resolvedMedia.fullPath);
                progress[canonicalVideoFile].duration = duration;
            } catch (durationError) {
                // If duration can't be fetched, we can still save progress time.
                console.error(`Could not get duration for ${canonicalVideoFile}:`, durationError.message);
            }
        }
        
        await scheduleProgressFlush();
        invalidateLibraryCaches();
    } catch (error) {
        console.error(`Failed to save progress for ${videoFile}:`, error);
    }
}

async function markVideoProgress(videoFile, watched) {
    const resolvedMedia = getResolvedMediaOrThrow(videoFile);
    let newTime = 0;
    if (Boolean(watched)) {
        newTime = await getCachedVideoDuration(resolvedMedia.fullPath);
    }
    await saveProgress(resolvedMedia.relativePath, newTime);
    return {
        videoFile: resolvedMedia.relativePath,
        watched: Boolean(watched),
        time: newTime
    };
}

async function collectTmdbHintFileNames(itemRelativePath, limit = 6) {
    const fullItemPath = path.join(videosDirectory, itemRelativePath);
    const hints = [];

    async function walk(currentPath, depth = 0) {
        if (hints.length >= limit || depth > 2) {
            return;
        }

        let entries;
        try {
            entries = await fsp.readdir(currentPath, { withFileTypes: true });
        } catch (error) {
            return;
        }

        entries.sort((a, b) => naturalSort(a.name, b.name));

        for (const entry of entries) {
            if (hints.length >= limit) {
                return;
            }

            const entryPath = path.join(currentPath, entry.name);
            if (entry.isFile() && DIRECT_MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                hints.push(entry.name);
                continue;
            }

            if (entry.isDirectory() && (depth === 0 || SEASON_PATTERN.test(entry.name))) {
                await walk(entryPath, depth + 1);
            }
        }
    }

    await walk(fullItemPath, 0);
    return hints;
}

function buildMetadataPayloadFromTmdbResult(itemName, result, type = 'tv') {
    if (!result) {
        return null;
    }

    const releaseDate = type === 'movie' ? result.release_date : result.first_air_date;
    const year = releaseDate ? new Date(releaseDate).getFullYear() : null;
    const displayTitle = type === 'movie'
        ? (result.title || result.original_title || itemName)
        : (result.name || result.original_name || itemName);

    return {
        tmdbId: result.id,
        matchedTitle: displayTitle,
        matchedOriginalTitle: type === 'movie' ? (result.original_title || displayTitle) : (result.original_name || displayTitle),
        name: itemName,
        rating: result.vote_average,
        description: result.overview,
        posterUrl: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
        backdropUrl: result.backdrop_path ? `https://image.tmdb.org/t/p/w1280${result.backdrop_path}` : null,
        year
    };
}

async function buildTmdbMetadataCandidates(itemRelativePath, type = 'tv') {
    const itemName = path.basename(itemRelativePath);
    if (!TMDB_API_KEY) {
        return [];
    }

    const sampleFileNames = await collectTmdbHintFileNames(itemRelativePath);
    const queryCandidates = buildTmdbQueryCandidates(itemName, sampleFileNames);
    const preferAnimation = /(?:^|[\\/])(anime|animated|cartoons?)(?:[\\/]|$)/i.test(itemRelativePath);
    const seenIds = new Set();
    const candidates = [];
    const pushCandidate = (result) => {
        if (!result?.id || seenIds.has(result.id)) {
            return;
        }
        seenIds.add(result.id);
        const data = buildMetadataPayloadFromTmdbResult(itemName, result, type);
        if (!data) {
            return;
        }
        candidates.push({
            ...data,
            source: 'tmdb-search',
            _rawResult: result
        });
    };

    const searchEndpoint = type === 'movie' ? 'search/movie' : 'search/tv';

    for (const queryName of queryCandidates.slice(0, 3)) {
        const searchResponse = await axios.get(`https://api.themoviedb.org/3/${searchEndpoint}`, {
            params: {
                api_key: TMDB_API_KEY,
                query: queryName,
                page: 1
            }
        });

        for (const result of (searchResponse.data?.results || []).slice(0, 8)) {
            pushCandidate(result);
        }
    }

    const collectionMatch = type === 'movie' ? itemName.match(/^(.*?)(?:\s+(\d+))$/) : null;
    if (collectionMatch) {
        try {
            const baseTitle = collectionMatch[1].trim();
            const collectionSearch = await axios.get('https://api.themoviedb.org/3/search/collection', {
                params: {
                    api_key: TMDB_API_KEY,
                    query: baseTitle,
                    page: 1
                }
            });
            const collectionResult = pickBestTmdbSearchResult(collectionSearch.data?.results || [], {
                type: 'tv',
                queryCandidates: [baseTitle]
            });
            if (collectionResult?.id) {
                const collectionDetails = await axios.get(`https://api.themoviedb.org/3/collection/${collectionResult.id}`, {
                    params: { api_key: TMDB_API_KEY }
                });
                for (const result of collectionDetails.data?.parts || []) {
                    pushCandidate(result);
                }
            }
        } catch (error) {
            if (error.response?.status !== 404) {
                console.error(`[TMDB] Failed to build collection candidates for "${itemName}":`, error.message);
            }
        }
    }

    const pool = [...candidates];
    const ranked = [];
    while (pool.length > 0) {
        const bestResult = pickBestTmdbSearchResult(pool.map(candidate => candidate._rawResult), {
            type,
            queryCandidates,
            preferAnimation
        });
        const bestIndex = pool.findIndex(candidate => candidate.tmdbId === bestResult?.id);
        const nextIndex = bestIndex >= 0 ? bestIndex : 0;
        ranked.push(pool.splice(nextIndex, 1)[0]);
    }

    return ranked.map(({ _rawResult, ...candidate }) => candidate);
}

async function getTmdbInfo(itemRelativePath, type = 'tv') {
    const itemName = path.basename(itemRelativePath);
    if (!TMDB_API_KEY) {
        return { name: itemName }; // Return default object if no key
    }

    const metadataOverride = await getMetadataOverride(itemRelativePath);
    if (metadataOverride) {
        return {
            ...metadataOverride,
            name: itemName,
            metadataOverride
        };
    }

    const cacheKey = createCacheHash(`${TMDB_CACHE_VERSION}:${type}:${itemRelativePath}`);
    const cachePath = path.join(tmdbCacheDirectory, `${cacheKey}.json`);
    try {
        const cached = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
        if (cached?.savedAt && cached.data && (Date.now() - cached.savedAt) < getTmdbCacheTtl(cached)) {
            return cached.data;
        }
    } catch (error) {
        // Cache miss or invalid cache file.
    }

    const fullItemPath = path.join(videosDirectory, itemRelativePath);
    const idFilePath = path.join(fullItemPath, '.tmdbid');
    let result = null;

    // 1. Prioritize .tmdbid file for 100% match
    try {
        const tmdbId = await fsp.readFile(idFilePath, 'utf-8');
        if (tmdbId.trim()) {
            console.log(`[TMDB] Found .tmdbid "${tmdbId.trim()}" for "${itemRelativePath}"`);
            const endpoint = type === 'movie' ? `/movie/${tmdbId.trim()}` : `/tv/${tmdbId.trim()}`;
            const response = await axios.get(`https://api.themoviedb.org/3${endpoint}`, {
                params: { api_key: TMDB_API_KEY }
            });
            result = response.data;
            result.__cacheKind = 'pinned';
        }
    } catch (e) {
        // .tmdbid file not found or unreadable, fall back to searching by name
    }

    // 2. If no .tmdbid result, search by name as a fallback
    if (!result) {
        const nameMatch = itemName.match(/^(.*?)\s*\((\d{4})\)\s*$/);
        const movieNumberMatch = type === 'movie' ? itemName.match(/^(.*?)(?:\s+(\d+))$/) : null;
        const sampleFileNames = await collectTmdbHintFileNames(itemRelativePath);
        const preferAnimation = /(?:^|[\\/])(anime|animated|cartoons?)(?:[\\/]|$)/i.test(itemRelativePath);
        const yearFromTitle = nameMatch ? nameMatch[2] : null;
        const collectionIndex = movieNumberMatch ? Number.parseInt(movieNumberMatch[2], 10) : null;
        const collectionBaseTitle = movieNumberMatch ? movieNumberMatch[1].trim() : null;
        const queryCandidates = buildTmdbQueryCandidates(nameMatch ? nameMatch[1].trim() : itemName, sampleFileNames);
        const endpoint = type === 'movie' ? 'search/movie' : 'search/tv';
        const yearParam = type === 'movie' ? 'primary_release_year' : 'first_air_date_year';

        if (type === 'movie' && collectionIndex && collectionBaseTitle) {
            try {
                const collectionSearch = await axios.get('https://api.themoviedb.org/3/search/collection', {
                    params: {
                        api_key: TMDB_API_KEY,
                        query: collectionBaseTitle,
                        page: 1
                    }
                });
                const collectionResult = pickBestTmdbSearchResult(collectionSearch.data?.results || [], {
                    type: 'tv',
                    queryCandidates: [collectionBaseTitle, ...queryCandidates]
                });
                if (collectionResult?.id) {
                    const collectionDetails = await axios.get(`https://api.themoviedb.org/3/collection/${collectionResult.id}`, {
                        params: { api_key: TMDB_API_KEY }
                    });
                    result = pickMovieCollectionPart(collectionDetails.data?.parts || [], collectionIndex);
                }
            } catch (error) {
                if (error.response?.status !== 404) {
                    console.error(`Error fetching TMDB collection for "${itemName}":`, error.message);
                }
            }
        }

        if (!result) {
            try {
                const aggregatedResults = [];
                const seenResultIds = new Set();

                for (const queryName of queryCandidates.slice(0, 3)) {
                    const params = {
                        api_key: TMDB_API_KEY,
                        query: queryName,
                        page: 1
                    };
                    if (yearFromTitle) {
                        params[yearParam] = yearFromTitle;
                    }

                    const searchResponse = await axios.get(`https://api.themoviedb.org/3/${endpoint}`, { params });
                    for (const entry of searchResponse.data?.results || []) {
                        if (seenResultIds.has(entry.id)) {
                            continue;
                        }
                        seenResultIds.add(entry.id);
                        aggregatedResults.push(entry);
                    }
                }

                result = pickBestTmdbSearchResult(aggregatedResults, {
                    type,
                    queryCandidates,
                    preferAnimation,
                    year: yearFromTitle
                });
            } catch (error) {
                if (error.response?.status !== 404) {
                    console.error(`Error fetching TMDB data for "${itemName}" (type: ${type}):`, error.message);
                }
                // Continue to final fallback
            }
        }
    }

    // 3. Process the result if one was found
    if (result) {
        const data = buildMetadataPayloadFromTmdbResult(itemName, result, type);
        await writeTmdbCacheEntry(cachePath, data, result.__cacheKind || 'success');
        return data;
    }
    
    // 4. Final fallback if no result from any method
    const fallbackNameMatch = itemName.match(/^(.*?)\s*\((\d{4})\)\s*$/);
    const fallback = { name: itemName, year: fallbackNameMatch ? (fallbackNameMatch[2] || null) : null };
    await writeTmdbCacheEntry(cachePath, fallback, 'miss');
    return fallback;
}

// NEW function to check readiness and execute actions
function checkAndExecutePendingAction(room, initiatorId = null) {
    const state = roomStates[room];
    if (!state || !state.pendingAction) {
        return;
    }

    const clients = state.clients;
    const now = Date.now();
    const hasMultipleClients = Object.keys(clients).length > 1;

    // Check for stale ready states (older than 15 seconds) and reset them
    let staleClientsFound = false;
    Object.entries(clients).forEach(([id, client]) => {
        if (client.lastReadyUpdate && (now - client.lastReadyUpdate) > 15000) {
            console.log(`[SERVER STALE] Resetting stale ready state for client ${id} (${Math.round((now - client.lastReadyUpdate)/1000)}s old)`);
            client.isReady = false;
            staleClientsFound = true;
        }
    });

    const allReady = Object.values(clients).every(client => client.isReady);

    console.log(`[SERVER CHECK] Checking room ${room}:`, {
        timestamp: now,
        actionType: state.pendingAction.type,
        allReady: allReady,
        multipleClients: hasMultipleClients,
        clientCount: Object.keys(clients).length,
        staleClientsFound: staleClientsFound,
        clientStates: Object.entries(clients).map(([id, client]) => ({
            id: id,
            isReady: client.isReady,
            lastUpdate: client.lastReadyUpdate || 0,
            ageSeconds: client.lastReadyUpdate ? (now - client.lastReadyUpdate) / 1000 : 'unknown'
        })),
        initiatorId: initiatorId
    });

    // Play should only be synchronized if there's more than one person.
    // If a user is alone, their play request should be instant.
    if (state.pendingAction.type === 'play' && (allReady || !hasMultipleClients)) {
        console.log(`[SERVER EXECUTE] Executing play in room ${room}:`, {
            timestamp: now,
            reason: allReady ? 'all_ready' : 'single_client',
            clientCount: Object.keys(clients).length,
            actionData: state.pendingAction.data
        });
        
        io.to(room).emit('play', state.pendingAction.data);
        clearPendingAction(room);
    } else if (initiatorId && hasMultipleClients) {
        // If not everyone is ready, inform the user who requested the action.
        console.log(`[SERVER WAIT] Waiting for clients to be ready in room ${room}:`, {
            timestamp: now,
            initiatorId: initiatorId,
            notReadyClients: Object.entries(clients)
                .filter(([id, client]) => !client.isReady)
                .map(([id, client]) => ({
                    id: id,
                    ageSeconds: client.lastReadyUpdate ? (now - client.lastReadyUpdate) / 1000 : 'unknown'
                }))
        });
        
        io.to(initiatorId).emit('waitingForPartner');
        
        // If we found stale clients, request a ready state sync from all clients
        if (staleClientsFound) {
            console.log(`[SERVER RECOVERY] Requesting ready state sync due to stale clients`);
            io.to(room).emit('requestReadyStateUpdate');
        }

        if (!state.pendingActionTimer) {
            state.pendingActionTimer = setTimeout(() => {
                const currentState = roomStates[room];
                if (!currentState?.pendingAction || currentState.pendingAction.type !== 'play') {
                    return;
                }

                const waitTime = Date.now() - (currentState.pendingAction.timestamp || 0);
                console.log(`[SERVER TIMEOUT] Cancelling pending play after ${waitTime}ms because the room never became ready.`);

                const currentInitiatorId = currentState.pendingAction.data?.initiator;
                if (currentInitiatorId) {
                    io.to(currentInitiatorId).emit('playRequestTimedOut', { waitTime });
                }

                io.to(room).emit('requestReadyStateUpdate');
                clearPendingAction(room);
            }, PENDING_PLAY_TIMEOUT_MS);
        }
    }
}

server.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        await flushProgressCacheOnShutdown();
        process.exit(0);
    });
}
