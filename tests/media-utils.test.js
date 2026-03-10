const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildTmdbQueryCandidates,
    cleanMediaTitleCandidate,
    findExternalSubtitleMatches,
    humanizeSubtitleLanguage,
    normalizeForComparison,
    pickBestTmdbSearchResult,
    pickMovieCollectionPart,
    reconcileProgressEntries,
    repairLikelyMojibake,
    resolveMediaPath
} = require('../lib/media-utils');

test('repairLikelyMojibake repairs UTF-8 text decoded as latin1', () => {
    assert.equal(repairLikelyMojibake('PokÃ©mon'), 'Pokémon');
});

test('normalizeForComparison ignores casing and separators', () => {
    assert.equal(
        normalizeForComparison('MobLand.S01E01 Stick or Twist'),
        normalizeForComparison('Mobland S01e01 Stick Or Twist')
    );
});

test('cleanMediaTitleCandidate extracts a series title from episodic filenames', () => {
    assert.equal(
        cleanMediaTitleCandidate('Avatar- The Last Airbender.S01E12.The Storm.mkv'),
        'Avatar The Last Airbender'
    );
});

test('buildTmdbQueryCandidates prefers richer sample titles over short folder names', () => {
    assert.deepEqual(
        buildTmdbQueryCandidates('Avatar', [
            'Avatar- The Last Airbender.S01E12.The Storm.mkv',
            'Avatar- The Last Airbender.S01E13.The Blue Spirit.mkv'
        ]),
        ['Avatar The Last Airbender', 'Avatar']
    );
});

test('humanizeSubtitleLanguage maps common subtitle codes to readable labels', () => {
    assert.equal(humanizeSubtitleLanguage('eng'), 'English');
    assert.equal(humanizeSubtitleLanguage('nld'), 'Nederlands');
    assert.equal(humanizeSubtitleLanguage('', 'Track 2'), 'Track 2');
});

test('findExternalSubtitleMatches finds case-variant subtitle files', () => {
    const matches = findExternalSubtitleMatches(
        'Series/Mobland/Season 1/Mobland S01e01 Stick Or Twist 1080P Amzn Web-Dl Ddp5 1 H 264-Flux.mp4',
        [
            'MobLand S01E01 Stick or Twist 1080p AMZN WEB-DL DDP5 1 H 264-FLUX.srt',
            'MobLand S01E01 Stick or Twist 1080p AMZN WEB-DL DDP5 1 H 264-FLUX.nl.srt'
        ]
    );

    assert.deepEqual(matches, [
        {
            fileName: 'MobLand S01E01 Stick or Twist 1080p AMZN WEB-DL DDP5 1 H 264-FLUX.srt',
            lang: 'External SRT'
        },
        {
            fileName: 'MobLand S01E01 Stick or Twist 1080p AMZN WEB-DL DDP5 1 H 264-FLUX.nl.srt',
            lang: 'Nederlands'
        }
    ]);
});

test('pickBestTmdbSearchResult prefers the intended Avatar series over The King\'s Avatar', () => {
    const result = pickBestTmdbSearchResult([
        {
            id: 1,
            name: "The King's Avatar",
            original_name: "The King's Avatar",
            first_air_date: '2017-04-07',
            genre_ids: [16, 10759],
            vote_average: 7.7,
            vote_count: 320
        },
        {
            id: 2,
            name: 'Avatar: The Last Airbender',
            original_name: 'Avatar: The Last Airbender',
            first_air_date: '2005-02-21',
            genre_ids: [16, 10759, 10765],
            vote_average: 8.8,
            vote_count: 4200
        }
    ], {
        type: 'tv',
        queryCandidates: ['Avatar The Last Airbender', 'Avatar'],
        preferAnimation: true
    });

    assert.equal(result?.id, 2);
});

test('pickMovieCollectionPart selects the correct numbered movie within a collection', () => {
    const result = pickMovieCollectionPart([
        { id: 2, title: 'The Return of Jafar', release_date: '1994-05-20' },
        { id: 1, title: 'Aladdin', release_date: '1992-11-25' },
        { id: 3, title: 'Aladdin and the King of Thieves', release_date: '1996-08-13' }
    ], 2);

    assert.equal(result?.title, 'The Return of Jafar');
});

test('resolveMediaPath repairs stored mojibake paths and blocks traversal', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'togethervideo-media-'));
    const animeDir = path.join(tempRoot, 'Anime', 'Pokémon');
    fs.mkdirSync(animeDir, { recursive: true });
    fs.writeFileSync(path.join(animeDir, 'episode.mp4'), '');

    const resolved = resolveMediaPath(tempRoot, 'Anime/PokÃ©mon/episode.mp4');
    assert.ok(resolved);
    assert.equal(resolved.relativePath, 'Anime/Pokémon/episode.mp4');

    assert.equal(resolveMediaPath(tempRoot, '..\\secret.txt'), null);

    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('reconcileProgressEntries removes missing entries and canonicalizes keys', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'togethervideo-progress-'));
    const animeDir = path.join(tempRoot, 'Anime', 'Pokémon');
    fs.mkdirSync(animeDir, { recursive: true });
    fs.writeFileSync(path.join(animeDir, 'episode.mp4'), '');

    const { progress, changed } = reconcileProgressEntries({
        'Anime/PokÃ©mon/episode.mp4': {
            time: 12,
            lastWatched: 20,
            duration: 100
        },
        'missing/file.mp4': {
            time: 1,
            lastWatched: 1,
            duration: 10
        }
    }, tempRoot);

    assert.equal(changed, true);
    assert.deepEqual(progress, {
        'Anime/Pokémon/episode.mp4': {
            time: 12,
            lastWatched: 20,
            duration: 100
        }
    });

    fs.rmSync(tempRoot, { recursive: true, force: true });
});
