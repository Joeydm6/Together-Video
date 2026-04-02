const fs = require('fs');
const path = require('path');

const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const TITLE_STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'of', 'to', 'in', 'on']);
const RELEASE_TAG_PATTERN = /\b(2160p|1080p|720p|480p|x264|x265|h264|h265|hevc|bluray|brrip|bdrip|webrip|web[\s._-]?dl|web[\s._-]?rip|amzn|nf|ddp\d(?:\.\d)?|aac(?:\d(?:\.\d)?)?|ac3|dts|hdr|dv|proper|repack|extended|remux|flux)\b/ig;

function normalizeRelativePath(inputPath) {
    if (typeof inputPath !== 'string') {
        return '';
    }

    return inputPath
        .replace(/[\\/]+/g, path.sep)
        .replace(new RegExp(`\\${path.sep}+`, 'g'), path.sep)
        .trim();
}

function repairLikelyMojibake(value) {
    if (typeof value !== 'string' || !/[ÃÂâ€œâ€\uFFFD]/.test(value)) {
        return typeof value === 'string' ? value.normalize('NFC') : '';
    }

    try {
        const repaired = Buffer.from(value, 'latin1').toString('utf8');
        if (repaired.includes('\uFFFD')) {
            return value.normalize('NFC');
        }
        return repaired.normalize('NFC');
    } catch (error) {
        return value.normalize('NFC');
    }
}

function normalizeForComparison(value) {
    return repairLikelyMojibake(value)
        .toLowerCase()
        .normalize('NFC')
        .replace(/[\s._-]+/g, ' ')
        .replace(/[^\p{L}\p{N} ]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanMediaTitleCandidate(value) {
    let title = repairLikelyMojibake(path.basename(String(value || ''), path.extname(String(value || ''))));

    const episodicPatterns = [
        /^(.*?)[\s._-]*S\d{1,2}E\d{1,3}\b/i,
        /^(.*?)[\s._-]*\d{1,2}x\d{1,3}\b/i,
        /^(.*?)[\s._-]*Season[\s._-]*\d+[\s._-]*Episode[\s._-]*\d+\b/i
    ];
    for (const pattern of episodicPatterns) {
        const match = title.match(pattern);
        if (match?.[1]) {
            title = match[1];
            break;
        }
    }

    return title
        .replace(RELEASE_TAG_PATTERN, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/[._]+/g, ' ')
        .replace(/\s*-\s*/g, ' ')
        .replace(/\b(?:part|pt|disc)\s*\d+\b/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitTitleTokens(value) {
    return normalizeForComparison(value)
        .split(' ')
        .filter(token => token && !TITLE_STOP_WORDS.has(token));
}

function parseCollectionIndex(value) {
    const cleaned = cleanMediaTitleCandidate(value);
    const match = cleaned.match(/^(.*?)(?:\s+(\d+))$/);
    if (!match) {
        return {
            baseTitle: cleaned,
            collectionIndex: null
        };
    }

    return {
        baseTitle: match[1].trim(),
        collectionIndex: Number.parseInt(match[2], 10)
    };
}

function buildTmdbQueryCandidates(itemName, sampleFileNames = []) {
    const cleanedItemName = cleanMediaTitleCandidate(itemName);
    const { baseTitle, collectionIndex } = parseCollectionIndex(cleanedItemName);
    const normalizedItemName = normalizeForComparison(cleanedItemName);
    const candidateMap = new Map();

    const pushCandidate = (title, source) => {
        const cleanedTitle = cleanMediaTitleCandidate(title);
        const normalizedTitle = normalizeForComparison(cleanedTitle);
        if (!normalizedTitle) {
            return;
        }

        const existing = candidateMap.get(normalizedTitle);
        if (existing) {
            existing.count += 1;
            return;
        }

        const startsWithFolderName = normalizedItemName && normalizedTitle !== normalizedItemName && normalizedTitle.startsWith(`${normalizedItemName} `);
        candidateMap.set(normalizedTitle, {
            title: cleanedTitle,
            source,
            count: 1,
            startsWithFolderName
        });
    };

    if (collectionIndex && baseTitle) {
        pushCandidate(baseTitle, 'collection-base');
    }

    for (const fileName of sampleFileNames) {
        pushCandidate(fileName, 'sample');
    }

    pushCandidate(cleanedItemName, 'folder');

    return [...candidateMap.values()]
        .sort((a, b) => {
            const sourcePriority = (entry) => {
                if (entry.source === 'collection-base') return 4;
                if (entry.startsWithFolderName) return 3;
                if (entry.source === 'sample') return 2;
                return 1;
            };
            return (
                sourcePriority(b) - sourcePriority(a) ||
                b.count - a.count ||
                b.title.length - a.title.length ||
                a.title.localeCompare(b.title)
            );
        })
        .map(entry => entry.title);
}

function scoreTitleMatch(resultTitle, queryTitle) {
    const normalizedResult = normalizeForComparison(resultTitle);
    const normalizedQuery = normalizeForComparison(queryTitle);
    if (!normalizedResult || !normalizedQuery) {
        return Number.NEGATIVE_INFINITY;
    }

    const resultTokens = splitTitleTokens(resultTitle);
    const queryTokens = splitTitleTokens(queryTitle);
    const resultSet = new Set(resultTokens);
    const querySet = new Set(queryTokens);
    const overlapCount = [...querySet].filter(token => resultSet.has(token)).length;
    const missingCount = queryTokens.length - overlapCount;
    const extraCount = resultTokens.length - overlapCount;

    let score = 0;

    if (normalizedResult === normalizedQuery) {
        score += 5000;
    }
    if (normalizedResult.startsWith(`${normalizedQuery} `)) {
        score += 900;
    } else if (normalizedResult.startsWith(normalizedQuery)) {
        score += 650;
    }
    if (normalizedResult.includes(` ${normalizedQuery} `) || normalizedResult.endsWith(` ${normalizedQuery}`)) {
        score += 350;
    } else if (normalizedResult.includes(normalizedQuery)) {
        score += 200;
    }
    if (queryTokens.length > 0 && overlapCount === queryTokens.length) {
        score += 1300;
    }

    score += overlapCount * 250;
    score -= missingCount * 500;
    score -= extraCount * 120;

    return score;
}

function pickBestTmdbSearchResult(results, {
    type = 'tv',
    queryCandidates = [],
    preferAnimation = false,
    year = null
} = {}) {
    const titleKeys = type === 'movie'
        ? ['title', 'original_title']
        : ['name', 'original_name'];
    let bestEntry = null;

    for (const result of results || []) {
        const titles = titleKeys
            .map(key => result?.[key])
            .filter(Boolean);
        if (titles.length === 0) {
            continue;
        }

        let score = Number.NEGATIVE_INFINITY;
        for (const queryTitle of queryCandidates) {
            for (const title of titles) {
                score = Math.max(score, scoreTitleMatch(title, queryTitle));
            }
        }

        const resultDate = type === 'movie' ? result.release_date : result.first_air_date;
        const resultYear = resultDate ? new Date(resultDate).getFullYear() : null;
        if (year && resultYear === Number(year)) {
            score += 1200;
        }

        if (preferAnimation) {
            score += Array.isArray(result.genre_ids) && result.genre_ids.includes(16) ? 700 : -200;
        }

        score += Math.min(result.vote_count || 0, 5000) / 25;
        score += (result.vote_average || 0) * 20;

        if (!bestEntry || score > bestEntry.score) {
            bestEntry = { result, score };
        }
    }

    return bestEntry?.result || null;
}

function pickMovieCollectionPart(parts, collectionIndex = 1) {
    const sortedParts = [...(parts || [])]
        .filter(part => part?.title)
        .sort((a, b) => {
            const aDate = a.release_date ? Date.parse(a.release_date) : Number.MAX_SAFE_INTEGER;
            const bDate = b.release_date ? Date.parse(b.release_date) : Number.MAX_SAFE_INTEGER;
            if (aDate !== bDate) {
                return aDate - bDate;
            }
            return (a.title || '').localeCompare(b.title || '');
        });

    if (sortedParts.length === 0) {
        return null;
    }

    const safeIndex = Math.max(1, collectionIndex || 1) - 1;
    return sortedParts[safeIndex] || sortedParts[0];
}

function buildRelativePathCandidates(inputPath) {
    const normalizedPath = normalizeRelativePath(inputPath);
    if (!normalizedPath) {
        return [];
    }

    const candidates = new Set([normalizedPath, normalizedPath.normalize('NFC')]);
    const repairedWholePath = repairLikelyMojibake(normalizedPath);
    candidates.add(repairedWholePath);

    const repairedSegments = normalizedPath
        .split(path.sep)
        .map(segment => repairLikelyMojibake(segment))
        .join(path.sep);
    candidates.add(repairedSegments);

    return [...candidates].filter(Boolean);
}

function isPathInsideBase(baseDir, targetPath) {
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(targetPath);
    const normalizedBase = resolvedBase.toLowerCase();
    const normalizedTarget = resolvedTarget.toLowerCase();

    return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`.toLowerCase());
}

function resolveMediaPath(baseDir, requestedPath, { mustExist = true } = {}) {
    for (const candidate of buildRelativePathCandidates(requestedPath)) {
        const fullPath = path.resolve(baseDir, candidate);
        if (!isPathInsideBase(baseDir, fullPath)) {
            continue;
        }

        if (!mustExist || fs.existsSync(fullPath)) {
            return {
                fullPath,
                relativePath: path.relative(baseDir, fullPath).replace(/\\/g, '/')
            };
        }
    }

    return null;
}

function getSubtitleLanguageLabel(baseName, videoBaseName) {
    const suffix = baseName.slice(videoBaseName.length);
    const cleanedSuffix = suffix.replace(/^[.\s_-]+/, '').toLowerCase();

    if (!cleanedSuffix) return null;
    if (/^(en|eng|english)$/.test(cleanedSuffix)) return 'English';
    if (/^(nl|nld|dut|dutch|nederlands)$/.test(cleanedSuffix)) return 'Nederlands';

    return cleanedSuffix.charAt(0).toUpperCase() + cleanedSuffix.slice(1);
}

function humanizeSubtitleLanguage(language, fallback = null) {
    const normalized = (language || '').trim().toLowerCase();

    if (!normalized) {
        return fallback;
    }

    if (/^(en|eng|english)$/.test(normalized)) return 'English';
    if (/^(nl|nld|dut|dutch|nederlands)$/.test(normalized)) return 'Nederlands';
    if (/^(es|spa|spanish)$/.test(normalized)) return 'Español';
    if (/^(fr|fre|fra|french)$/.test(normalized)) return 'Français';
    if (/^(de|ger|deu|german)$/.test(normalized)) return 'Deutsch';

    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function findExternalSubtitleMatches(videoRelativePath, dirFiles) {
    const videoBaseName = path.basename(videoRelativePath, path.extname(videoRelativePath));
    const normalizedVideoBase = normalizeForComparison(videoBaseName);

    return dirFiles
        .filter(fileName => SUBTITLE_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
        .map(fileName => {
            const subtitleBaseName = path.basename(fileName, path.extname(fileName));
            const normalizedSubtitleBase = normalizeForComparison(subtitleBaseName);

            if (!normalizedSubtitleBase.startsWith(normalizedVideoBase)) {
                return null;
            }

            const language = getSubtitleLanguageLabel(subtitleBaseName, videoBaseName);

            return {
                fileName,
                lang: language || `External ${path.extname(fileName).slice(1).toUpperCase()}`
            };
        })
        .filter(Boolean);
}

function mergeProgressEntries(currentEntry = {}, nextEntry = {}) {
    const currentLastWatched = currentEntry.lastWatched || 0;
    const nextLastWatched = nextEntry.lastWatched || 0;

    if (nextLastWatched >= currentLastWatched) {
        return {
            ...currentEntry,
            ...nextEntry,
            duration: nextEntry.duration || currentEntry.duration || 0,
            time: typeof nextEntry.time === 'number' ? nextEntry.time : (currentEntry.time || 0)
        };
    }

    return {
        ...nextEntry,
        ...currentEntry,
        duration: currentEntry.duration || nextEntry.duration || 0,
        time: typeof currentEntry.time === 'number' ? currentEntry.time : (nextEntry.time || 0)
    };
}

function reconcileProgressEntries(progressData, baseDir) {
    const reconciled = {};
    let changed = false;

    for (const [storedPath, entry] of Object.entries(progressData || {})) {
        const resolvedMedia = resolveMediaPath(baseDir, storedPath);
        if (!resolvedMedia) {
            changed = true;
            continue;
        }

        if (resolvedMedia.relativePath !== storedPath) {
            changed = true;
        }

        reconciled[resolvedMedia.relativePath] = mergeProgressEntries(
            reconciled[resolvedMedia.relativePath],
            entry
        );
    }

    return { progress: reconciled, changed };
}

module.exports = {
    buildTmdbQueryCandidates,
    cleanMediaTitleCandidate,
    findExternalSubtitleMatches,
    humanizeSubtitleLanguage,
    normalizeForComparison,
    normalizeRelativePath,
    pickBestTmdbSearchResult,
    pickMovieCollectionPart,
    reconcileProgressEntries,
    repairLikelyMojibake,
    resolveMediaPath
};
