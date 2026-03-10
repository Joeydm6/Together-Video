const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
require('dotenv').config();

// --- CONFIGURATION ---
const DRY_RUN = true; 
const MEDIA_ROOT = 'E:\\Media'; 
const FOLDERS_TO_SCAN = ['Series', 'Anime', 'Movies']; 
const TMDB_API_KEY = process.env.TMDB_API_KEY;
// --- END CONFIGURATION ---

// --- SCRIPT STATE ---
const stats = {
    proposedChanges: [],
    alreadyCorrect: 0,
    errors: [],
};
// --- END SCRIPT STATE ---

if (!TMDB_API_KEY) {
    throw new Error("TMDB_API_KEY is not defined in your .env file.");
}

const tmdb = axios.create({
    baseURL: 'https://api.themoviedb.org/3',
    params: { api_key: TMDB_API_KEY },
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function searchTmdb(name, type, year = null) {
    try {
        const endpoint = type === 'movie' ? 'search/movie' : 'search/tv';
        const yearParam = type === 'movie' ? 'primary_release_year' : 'first_air_date_year';
        
        const params = { query: name, language: 'en-US' };
        if (year) {
            params[yearParam] = year;
        }

        const response = await tmdb.get(endpoint, { params });
        await sleep(300); // Rate limit
        
        const results = response.data.results;
        if (!results || results.length === 0) return null;

        // Try for an exact match first
        const titleKey = type === 'movie' ? 'title' : 'name';
        const exactMatch = results.find(r => r[titleKey].toLowerCase() === name.toLowerCase());
        
        return exactMatch || results[0]; // Return exact match or the most likely one
    } catch (error) {
        console.error(`[ERROR] Could not search TMDB for "${name}":`, error.response ? error.response.statusText : error.message);
        return null;
    }
}

async function fetchAllEpisodesForSeries(seriesId) {
    try {
        const seriesDetails = await tmdb.get(`/tv/${seriesId}`);
        await sleep(300);
        const seasonCount = seriesDetails.data.number_of_seasons;
        const episodesMap = {};

        for (let i = 1; i <= seasonCount; i++) {
            try {
                const seasonDetails = await tmdb.get(`/tv/${seriesId}/season/${i}`);
                await sleep(300);
                for (const episode of seasonDetails.data.episodes) {
                    const key = `S${String(i).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`;
                    episodesMap[key] = {
                        number: episode.episode_number,
                        name: episode.name.replace(/[/\\?%*:|"<>]/g, '-'), // Sanitize filename
                    };
                }
            } catch (error) {
                console.warn(`[WARN] Could not fetch season ${i} for series ${seriesId}. Skipping.`);
            }
        }
        return episodesMap;
    } catch (error) {
         console.error(`[ERROR] Failed to fetch series details for ID ${seriesId}:`, error.message);
         return {};
    }
}

function extractEpisodeInfo(filename) {
    const match = filename.match(/[._\s-][Ss](\d{1,2})[Ee](\d{1,3})[._\s-]/i) || filename.match(/(\d{1,2})x(\d{1,2})/i);
    if (match) {
        const season = parseInt(match[1], 10);
        const episode = parseInt(match[2], 10);
        return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    }
    return null;
}

async function tagAndRenameItem(itemDir, type) {
    const originalFolderName = path.basename(itemDir);
    let finalNameForFolder = null;
    let itemId = null;
    
    // Wrapped in a try-catch to handle errors for a single item without stopping the whole script
    try {
        console.log(`\nProcessing: ${originalFolderName}`);
        console.log('='.repeat(40));

        // Step 1: Handle TMDB ID
        const idFilePath = path.join(itemDir, '.tmdbid');
        
        try {
            const existingId = await fs.readFile(idFilePath, 'utf-8');
            itemId = existingId.trim();
            console.log(`[INFO] Found existing .tmdbid: ${itemId}`);
            
            const detailsEndpoint = type === 'movie' ? `/movie/${itemId}` : `/tv/${itemId}`;
            const details = await tmdb.get(detailsEndpoint);
            await sleep(300);
            finalNameForFolder = type === 'movie' ? details.data.title : details.data.name;

        } catch (e) {
            const nameMatch = originalFolderName.match(/^(.*?)\s*\((\d{4})\)\s*$/);
            if (!nameMatch) {
                const errorMsg = `[ERROR] Folder "${originalFolderName}" must follow "Name (Year)" format. Skipping.`;
                console.error(errorMsg);
                stats.errors.push({ item: originalFolderName, reason: errorMsg });
                return;
            }
            
            const nameWithNumber = nameMatch[1].trim();
            const year = nameMatch[2];
            
            const searchName = nameWithNumber.replace(/\s1$/, ''); 

            const result = await searchTmdb(searchName, type, year);
            if (result) {
                itemId = result.id;
                finalNameForFolder = type === 'movie' ? result.title : result.name; 
                console.log(`[TMDB] Found ${type}: "${finalNameForFolder}" (ID: ${itemId})`);
                
                stats.proposedChanges.push({
                    type: 'Create .tmdbid',
                    item: originalFolderName,
                    details: `Would write .tmdbid file with ID: ${itemId}`
                });

                if (!DRY_RUN) {
                    await fs.writeFile(idFilePath, String(itemId));
                    console.log(`[SUCCESS] Wrote .tmdbid file.`);
                }
            } else {
                const errorMsg = `[ERROR] Could not find ${type} "${searchName} (${year})" on TMDB. Skipping.`;
                console.error(errorMsg);
                stats.errors.push({ item: originalFolderName, reason: errorMsg });
                return;
            }
        }

        // Step 2: Handle file renaming for SERIES ONLY
        if (type === 'tv' && itemId) {
            console.log('[INFO] Fetching all episode data from TMDB...');
            const episodesMap = await fetchAllEpisodesForSeries(itemId);
            if (Object.keys(episodesMap).length > 0) {
                console.log(`[INFO] Found ${Object.keys(episodesMap).length} episodes.`);
                const entries = await fs.readdir(itemDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const subEntries = await fs.readdir(path.join(itemDir, entry.name), { withFileTypes: true });
                        for (const subEntry of subEntries) {
                            if (subEntry.isFile() && /\.(mp4|mkv|avi|mov)$/i.test(subEntry.name)) {
                                await renameEpisodeFile(path.join(itemDir, entry.name, subEntry.name), episodesMap, originalFolderName);
                            }
                        }
                    } else if (entry.isFile() && /\.(mp4|mkv|avi|mov)$/i.test(entry.name)) {
                        await renameEpisodeFile(path.join(itemDir, entry.name), episodesMap, originalFolderName);
                    }
                }
            } else {
                console.warn(`[WARN] No episode data found for series ID ${itemId}. Skipping file renaming.`);
            }
        }

        // Step 3: Rename the root item folder
        if (finalNameForFolder) {
            const yearMatch = originalFolderName.match(/\((\d{4})\)/);
            const yearSuffix = yearMatch ? ` (${yearMatch[1]})` : '';
            const newFolderName = `${finalNameForFolder.replace(/[/\\?%*:|"<>]/g, '-')}${yearSuffix}`;

            const parentDir = path.dirname(itemDir);
            const newPath = path.join(parentDir, newFolderName);
            
            if (itemDir.toLowerCase() !== newPath.toLowerCase()) {
                stats.proposedChanges.push({
                    type: 'Rename Folder',
                    item: originalFolderName,
                    from: originalFolderName,
                    to: newFolderName
                });
                
                if (!DRY_RUN) {
                    try {
                        await fs.rename(itemDir, newPath);
                        console.log(`[SUCCESS] Renamed item folder: ${originalFolderName} -> ${newFolderName}`);
                    } catch (err) {
                        const errorMsg = `[ERROR] Could not rename item folder: ${err.message}`;
                        console.error(errorMsg);
                        stats.errors.push({ item: originalFolderName, reason: errorMsg });
                    }
                }
            } else {
                stats.alreadyCorrect++;
            }
        }
    } catch (error) {
        const errorMsg = `[FATAL] A critical error occurred while processing ${originalFolderName}: ${error.message}`;
        console.error(errorMsg);
        stats.errors.push({ item: originalFolderName, reason: errorMsg });
    }
}

async function renameEpisodeFile(filePath, episodesMap, seriesName) {
    const filename = path.basename(filePath);
    const key = extractEpisodeInfo(filename);
    
    if (key && episodesMap[key]) {
        const episodeData = episodesMap[key];
        const episodeStr = String(episodeData.number).padStart(2, '0');
        const newName = `${episodeStr}. ${episodeData.name}${path.extname(filename)}`;
        
        if (filename.toLowerCase() !== newName.toLowerCase()) {
             stats.proposedChanges.push({
                type: 'Rename File',
                item: seriesName,
                from: filename,
                to: newName
            });

            if (!DRY_RUN) {
                try {
                    await fs.rename(filePath, path.join(path.dirname(filePath), newName));
                } catch (err) {
                    const errorMsg = `Rename failed for ${filename}: ${err.message}`;
                    console.error(`  [ERROR] ${errorMsg}`);
                    stats.errors.push({ item: filename, reason: errorMsg });
                }
            }
        } else {
            stats.alreadyCorrect++;
        }
    } else {
        console.log(`  [SKIP] Could not find episode match for: ${filename}`);
    }
}

function printSummary() {
    console.log('\n\n--- SCRIPT SUMMARY ---');
    console.log('='.repeat(40));

    if (DRY_RUN) {
        console.log('*** DRY RUN MODE WAS ENABLED. NO CHANGES WERE MADE. ***\n');
    }

    const changesCount = stats.proposedChanges.length;
    const correctCount = stats.alreadyCorrect;
    const errorCount = stats.errors.length;

    console.log(`Scan complete. Found:`);
    console.log(`  - ${changesCount} potential change(s).`);
    console.log(`  - ${correctCount} item(s) already correct.`);
    console.log(`  - ${errorCount} error(s).`);

    if (changesCount > 0) {
        console.log('\n--- Proposed Changes ---');
        const changesByType = stats.proposedChanges.reduce((acc, change) => {
            const key = change.item; // Group by series/movie folder
            if (!acc[key]) {
                acc[key] = [];
            }
            acc[key].push(change);
            return acc;
        }, {});

        for (const item in changesByType) {
            console.log(`\n[${item}]`);
            changesByType[item].forEach(change => {
                if (change.type === 'Rename Folder' || change.type === 'Rename File') {
                    console.log(`  - ${change.type}:`);
                    console.log(`      From: ${change.from}`);
                    console.log(`      To:   ${change.to}`);
                } else {
                    console.log(`  - ${change.type}: ${change.details}`);
                }
            });
        }
    }

    if (errorCount > 0) {
        console.log('\n--- Errors Encountered ---');
        stats.errors.forEach(err => {
            console.log(`- Item: ${err.item}\n  Reason: ${err.reason}`);
        });
    }

    console.log('\n--- Script Finished ---');
}


async function run() {
    console.log('--- Media Renamer and ID Tagger ---');
    console.log('-'.repeat(40));

    for (const folder of FOLDERS_TO_SCAN) {
        const baseDir = path.join(MEDIA_ROOT, folder);
        const type = (folder === 'Movies') ? 'movie' : 'tv';
        console.log(`\n>>> Scanning [${folder}] folder (type: ${type}) <<<`);
        try {
            const dirs = await fs.readdir(baseDir, { withFileTypes: true });
            for (const dir of dirs) {
                if (dir.isDirectory()) {
                    await tagAndRenameItem(path.join(baseDir, dir.name), type);
                }
            }
        } catch (error) {
            console.error(`[FATAL] Error processing base directory ${baseDir}:`, error.message);
        }
    }
    printSummary();
}

run();