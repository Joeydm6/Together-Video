const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { getVideoDurationInSeconds } = require('get-video-duration');
const http = require('http');
const { Server } = require("socket.io");
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');

// --- FFmpeg Path Configuration ---
// If you installed FFmpeg to a different location, update this path.
// Ensure you use double backslashes (\\) in the path.
const ffmpegPath = 'C:\\Users\\Joey\\Documents\\Code\\TogetherVideo\\FFMPEG\\bin\\ffmpeg.exe';
const ffprobePath = 'C:\\Users\\Joey\\Documents\\Code\\TogetherVideo\\FFMPEG\\bin\\ffprobe.exe';
try {
    fs.accessSync(ffmpegPath);
    fs.accessSync(ffprobePath);
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
} catch (error) {
    console.warn(
        'FFmpeg not found at the specified path. Please install FFmpeg to "C:\\ffmpeg" ' +
        'or update the path in server.js'
    );
}
// --- End Configuration ---

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const port = 8000;
const progressFilePath = path.join(__dirname, 'progress.json');
const cacheDirectory = path.join(__dirname, '.cache');
const thumbnailsDirectory = path.join(cacheDirectory, 'thumbnails');
const subtitlesCacheDirectory = path.join(cacheDirectory, 'subtitles');

// Create cache and thumbnails directories if they don't exist
if (!fs.existsSync(cacheDirectory)) fs.mkdirSync(cacheDirectory);
if (!fs.existsSync(thumbnailsDirectory)) fs.mkdirSync(thumbnailsDirectory);
if (!fs.existsSync(subtitlesCacheDirectory)) fs.mkdirSync(subtitlesCacheDirectory);

const videosDirectory = 'E:\\Media';
const publicDirectory = path.join(__dirname, 'public');

// Serve static files from the 'public' directory
app.use(express.static(publicDirectory));

// --- Smart Transcoding Middleware for HEVC ---
// This middleware intercepts requests for video files. It checks if the video is
// encoded in HEVC (H.265). If it is, it transcodes the video on-the-fly to
// the browser-compatible H.264 format. Otherwise, it passes the request to the
// standard static file server. This provides compatibility for difficult formats
// without sacrificing performance for standard files.
app.use('/videos/:videoPath(*)', (req, res, next) => {
    const videoRelativePath = req.params.videoPath;
    const decodedRelativePath = decodeURIComponent(videoRelativePath);
    const videoFullPath = path.join(videosDirectory, decodedRelativePath);

    console.log(`[REQUEST] Received request for: ${decodedRelativePath}`);
    console.log(`[PATH] Full constructed path: ${videoFullPath}`);

    if (!fs.existsSync(videoFullPath)) {
        console.error(`[ERROR] File not found at path: ${videoFullPath}`);
        // Let the default 404 handler catch it if the file doesn't exist.
        return next();
    }
    
    console.log('[PROBE] Probing file with ffprobe...');
    ffmpeg.ffprobe(videoFullPath, (err, metadata) => {
        if (err) {
            console.error(`[PROBE_ERROR] ffprobe failed for ${decodedRelativePath}:`, err.message);
            // Can't probe, maybe it's not a video file or it's corrupted.
            // Let the static handler try to serve it as is.
            return next();
        }
        console.log(`[PROBE_SUCCESS] ffprobe successful for: ${decodedRelativePath}`);

        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        const isProblematic = videoStream && (videoStream.codec_name === 'hevc' || decodedRelativePath.endsWith('.mkv'));

        if (isProblematic) {
            console.log(`[TRANSCODE] Problematic video detected: ${decodedRelativePath}`);
            
            // This is our new, robust seeking mechanism. We no longer rely on byte-range estimations.
            // The client will add `?t=` to the URL to specify the start time.
            const seekTime = parseFloat(req.query.t || '0');
            
            if (seekTime > 0) {
                console.log(`[SEEK] Received seek request via query parameter. Starting stream at ${seekTime}s.`);
            }

            res.status(200).contentType('video/mp4');

            const ffmpegCommand = ffmpeg(videoFullPath)
                // Use -ss as an INPUT option for much faster (near-instant) seeking.
                // This is less accurate than output seeking but essential for a good user experience.
                .inputOptions([`-ss ${seekTime}`])
                .videoCodec('libx264')
                .audioCodec('aac')
                .outputOptions([
                    //-ss was here, moved to inputOptions for speed.
                    '-preset ultrafast', 
                    '-tune zerolatency', 
                    // This flag is essential for playback to start before the transcode is finished.
                    '-movflags frag_keyframe+empty_moov'
                ])
                .format('mp4')
                .on('start', (commandLine) => {
                    console.log('[FFMPEG] Spawned ffmpeg with command: ' + commandLine);
                })
                .on('error', (err, stdout, stderr) => {
                    if (err.message.includes('SIGKILL') || err.message.includes('pipe:0')) {
                        console.log(`[FFMPEG] Process killed as expected (client disconnected/seeked).`);
                    } else {
                        console.error('An unexpected transcoding error occurred:', err.message);
                        // Avoid logging the full stderr object which can be huge.
                        if (stderr) {
                            const lastLines = stderr.split('\n').slice(-5).join('\n');
                            console.error('[FFMPEG STDERR (last 5 lines)]:', lastLines);
                        }
                    }
                });

            ffmpegCommand.pipe(res, { end: true });

            req.on('close', () => {
                ffmpegCommand.kill('SIGKILL');
            });

        } else {
            console.log(`[STATIC] Standard file detected. Passing to static handler.`);
            return next();
        }
    });
});

// The standard static server for all non-problematic videos.
app.use('/videos', express.static(videosDirectory));
app.use('/thumbnails', express.static(thumbnailsDirectory));
app.use('/subtitles', express.static(subtitlesCacheDirectory));

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

/**
 * Generates a thumbnail for a video file.
 * @param {string} videoPath - The full path to the video file.
 * @param {string} thumbnailPath - The full path where the thumbnail should be saved.
 * @returns {Promise<void>}
 */
function generateThumbnail(videoPath, thumbnailPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(new Error(`Error generating thumbnail: ${err.message}`)))
            .screenshots({
                timestamps: ['5%'],
                filename: path.basename(thumbnailPath),
                folder: path.dirname(thumbnailPath),
                size: '320x?'
            });
    });
}

// API endpoint to automatically extract and serve subtitles
app.get('/api/subtitles', async (req, res) => {
    const videoRelativePath = req.query.video || '';
    if (!videoRelativePath) {
        return res.status(400).json({ error: 'Video path is required.' });
    }

    const videoFullPath = path.join(videosDirectory, videoRelativePath);
    const resolvedPath = path.resolve(videoFullPath);
    if (!resolvedPath.startsWith(path.resolve(videosDirectory))) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    try {
        const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoFullPath, (err, data) => {
                if (err) return reject(err);
                resolve(data);
            });
        });

        const subtitleStreams = metadata.streams.filter(s => s.codec_type === 'subtitle');
        if (subtitleStreams.length === 0) {
            return res.json({ subtitles: [] }); // No subtitle streams found
        }
        
        const preparedSubtitles = subtitleStreams.map(stream => {
            const streamIndex = stream.index;
            const lang = stream.tags?.language || `Track ${streamIndex}`;
            const hash = crypto.createHash('md5').update(`${videoRelativePath}-${streamIndex}`).digest('hex');
            const subtitleFilename = `${hash}.vtt`;
            const subtitleCachePath = path.join(subtitlesCacheDirectory, subtitleFilename);
            const subtitleUrl = `/subtitles/${subtitleFilename}`;
            return { lang, url: subtitleUrl, streamIndex, subtitleCachePath };
        });

        const extractAndCache = (sub) => {
            return new Promise((resolve, reject) => {
                // If it's already cached, resolve immediately.
                if (fs.existsSync(sub.subtitleCachePath)) {
                    return resolve();
                }
                
                // If not cached, extract it.
                ffmpeg(videoFullPath)
                    .outputOptions([
                        `-map 0:${sub.streamIndex}`,
                        '-c:s webvtt'
                    ])
                    .output(sub.subtitleCachePath)
                    .on('end', resolve)
                    .on('error', (err) => {
                         console.error(`ffmpeg extraction error for ${videoRelativePath} stream ${sub.streamIndex}:`, err.message);
                         reject(err);
                    })
                    .run();
            });
        };

        // Wait for the first subtitle track to be ready (if it isn't already cached).
        if (preparedSubtitles.length > 0) {
            await extractAndCache(preparedSubtitles[0]);
        }
        
        // Respond to the client immediately with the full list.
        // The first track is guaranteed to be available.
        res.json({ subtitles: preparedSubtitles.map(s => ({ lang: s.lang, url: s.url })) });
        
        // Trigger the extraction for the remaining tracks in the background.
        // We start from the second track (index 1) and don't await them.
        for (let i = 1; i < preparedSubtitles.length; i++) {
            extractAndCache(preparedSubtitles[i]).catch(err => {
                console.error(`Background subtitle extraction for ${preparedSubtitles[i].lang} failed:`, err.message);
            });
        }

    } catch (err) {
        console.error(`Error processing subtitles for ${videoRelativePath}:`, err.message);
        res.status(500).json({ error: 'Could not process subtitles for video file.' });
    }
});

app.get('/api/video-info', async (req, res) => {
    const videoRelativePath = req.query.video;
    if (!videoRelativePath) {
        return res.status(400).json({ error: 'Video path required' });
    }
    const videoFullPath = path.join(videosDirectory, videoRelativePath);
    if (!fs.existsSync(videoFullPath)) {
        return res.status(404).json({ error: 'Video not found' });
    }
    
    try {
        ffmpeg.ffprobe(videoFullPath, (err, metadata) => {
            if (err) {
                return res.status(500).json({ error: 'Could not probe video file.' });
            }
            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            const isProblematic = videoStream && (videoStream.codec_name === 'hevc' || videoRelativePath.endsWith('.mkv'));
            
            res.json({
                duration: metadata.format.duration,
                isProblematic: isProblematic 
            });
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error while getting video info.' });
    }
});

app.get('/api/recently-watched', async (req, res) => {
    try {
        const progress = await readProgressFile();
        const allProgress = Object.entries(progress).map(([videoFile, data]) => ({
            videoFile,
            ...data
        }));

        const partiallyWatched = allProgress
            .filter(item => item.time && item.duration && (item.time / item.duration) < 0.95)
            .sort((a, b) => b.lastWatched - a.lastWatched)
            .slice(0, 10); // Limit to the 10 most recent

        const result = [];
        for (const item of partiallyWatched) {
            try {
                const videoFullPath = path.join(videosDirectory, item.videoFile);
                const name = path.basename(item.videoFile);
                const hash = crypto.createHash('md5').update(item.videoFile).digest('hex');
                const thumbnailFilename = `${hash}.jpg`;
                const thumbnailPath = path.join(thumbnailsDirectory, thumbnailFilename);
                const thumbnailUrl = `/thumbnails/${thumbnailFilename}`;

                // Check if thumbnail exists, if not, generate it
                try {
                    await fsp.access(thumbnailPath);
                } catch {
                    await generateThumbnail(videoFullPath, thumbnailPath);
                }

                result.push({
                    name: name,
                    duration: formatDuration(item.duration),
                    durationSeconds: item.duration,
                    url: item.videoFile,
                    thumbnailUrl: thumbnailUrl,
                    progress: item.time
                });
            } catch (e) {
                // Ignore files that might have been deleted but still exist in progress.json
            }
        }
        res.json(result);
    } catch (error) {
        console.error('Error fetching recently watched:', error);
        res.status(500).json({ error: 'Could not fetch recently watched videos.' });
    }
});

// API endpoint to get the list of videos and directories for a given path
app.get('/api/videos', async (req, res) => {
    const relativePath = req.query.path || '';
    const requestedPath = path.join(videosDirectory, relativePath);

    // Security check: ensure the requested path is still within the videos directory
    const resolvedPath = path.resolve(requestedPath);
    if (!resolvedPath.startsWith(path.resolve(videosDirectory))) {
        return res.status(403).json({ error: 'Forbidden: Access is denied.' });
    }

    try {
        const [entries, progress] = await Promise.all([
            fsp.readdir(requestedPath, { withFileTypes: true }),
            readProgressFile()
        ]);
        
        const directories = [];
        const files = [];

        for (const entry of entries) {
            const entryPath = path.join(relativePath, entry.name);
            if (entry.isDirectory()) {
                directories.push(entry.name);
            } else if (/\.(mp4|mkv|avi|mov)$/i.test(entry.name)) {
                const filePath = path.join(videosDirectory, entryPath);
                
                // Generate a stable hash for the thumbnail filename
                const hash = crypto.createHash('md5').update(entryPath).digest('hex');
                const thumbnailFilename = `${hash}.jpg`;
                const thumbnailPath = path.join(thumbnailsDirectory, thumbnailFilename);
                const thumbnailUrl = `/thumbnails/${thumbnailFilename}`;

                try {
                    // Check if thumbnail exists, if not, generate it
                    await fsp.access(thumbnailPath);
                } catch {
                    try {
                        await generateThumbnail(filePath, thumbnailPath);
                    } catch (thumbError) {
                        console.error(thumbError.message);
                    }
                }

                try {
                    const stats = await fsp.stat(filePath);
                    const durationInSeconds = await getVideoDurationInSeconds(filePath);
                    const fileProgress = progress[entryPath.replace(/\\/g, '/')];

                    files.push({
                        name: entry.name,
                        duration: formatDuration(durationInSeconds),
                        durationSeconds: durationInSeconds,
                        url: entryPath.replace(/\\/g, '/'),
                        size: stats.size,
                        modified: stats.mtime,
                        thumbnailUrl: thumbnailUrl,
                        progress: fileProgress ? fileProgress.time : 0
                    });
                } catch (error) {
                    console.error(`Could not get info for ${entry.name}:`, error);
                    files.push({
                        name: entry.name,
                        duration: 'Unknown',
                        url: entryPath.replace(/\\/g, '/'),
                        size: 0,
                        modified: null,
                        thumbnailUrl: null,
                        progress: 0
                    });
                }
            }
        }

        // Sort directories and files alphabetically
        directories.sort((a, b) => a.localeCompare(b));
        files.sort((a, b) => a.name.localeCompare(b.name));

        res.json({ path: relativePath, directories, files });

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
    try {
        await fsp.access(progressFilePath);
        const data = await fsp.readFile(progressFilePath, 'utf-8');
        return JSON.parse(data || '{}');
    } catch (error) {
        // If file doesn't exist or is empty, return empty object
        return {};
    }
}

/**
 * Writes the progress data to the JSON file.
 * @param {object} data - The data to write.
 */
async function writeProgressFile(data) {
    await fsp.writeFile(progressFilePath, JSON.stringify(data, null, 2));
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

io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);

    socket.on('joinRoom', ({ videoFile }) => {
        if (!videoFile) return;

        const room = getRoomFromVideoFile(videoFile);
        const roomSize = io.sockets.adapter.rooms.get(room)?.size || 0;

        if (roomSize >= 2) {
            socket.emit('roomFull');
            return;
        }

        socket.join(room);
        socket.currentRoom = room;
        io.to(room).emit('userCountUpdate', { count: roomSize + 1 });
        socket.emit('joined');
        console.log(`A user joined room: ${room}`);

        socket.on('disconnect', () => {
            io.to(room).emit('userCountUpdate', { count: io.sockets.adapter.rooms.get(room)?.size || 0 });
            io.to(room).emit('partnerLeft');
            console.log(`A user left room: ${room}`);
        });
    });

    const findNextVideo = async (currentVideoFile) => {
        const currentVideoPath = path.join(videosDirectory, currentVideoFile);
        const dir = path.dirname(currentVideoPath);
        
        try {
            const entries = await fsp.readdir(dir);
            const videoFiles = entries
                .filter(file => /\.(mp4|mkv|avi|mov)$/i.test(file))
                .sort((a, b) => a.localeCompare(b));

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

    socket.on('checkNextVideo', async ({ videoFile }) => {
        const nextVideo = await findNextVideo(videoFile);
        if (nextVideo) {
            socket.emit('nextVideoAvailable', { available: true });
        } else {
            socket.emit('nextVideoAvailable', { available: false });
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

    // --- Event Handlers for Video Sync ---
    socket.on('getProgress', async ({ videoFile }) => {
        try {
            const progress = await readProgressFile();
            const videoProgress = progress[videoFile];

            if (videoProgress && videoProgress.time) {
                const videoFullPath = path.join(videosDirectory, videoFile);
                await fsp.access(videoFullPath); // Check if file exists
                const durationInSeconds = await getVideoDurationInSeconds(videoFullPath);

                // If watched for more than 95%, start from the beginning. Otherwise, resume.
                if (durationInSeconds > 0 && (videoProgress.time / durationInSeconds) >= 0.95) {
                    socket.emit('loadProgress', { time: 0 });
                } else {
                    socket.emit('loadProgress', videoProgress);
                }
            }
        } catch (error) {
            console.error(`Error in getProgress for ${videoFile}:`, error.message);
            // If something goes wrong (e.g., file not found), just start from the beginning.
            socket.emit('loadProgress', { time: 0 });
        }
    });

    // This generic handler broadcasts events to the other client in the room.
    const createBroadcastHandler = (eventName) => {
        socket.on(eventName, (data) => {
            if (socket.currentRoom) {
                socket.to(socket.currentRoom).emit(eventName, data);
            }
            // Save progress on pause event
            if (eventName === 'pause' && data.videoFile && typeof data.time === 'number') {
                saveProgress(data.videoFile, data.time);
            }
        });
    };

    socket.on('saveProgress', ({ videoFile, time }) => {
        if (videoFile && typeof time === 'number') {
            saveProgress(videoFile, time);
        }
    });

    createBroadcastHandler('play');
    createBroadcastHandler('pause');
    createBroadcastHandler('seek');

    socket.on('markVideo', async ({ videoFile, watched }) => {
        try {
            let newTime = 0;
            if (watched) {
                const videoFullPath = path.join(videosDirectory, videoFile);
                await fsp.access(videoFullPath);
                const durationInSeconds = await getVideoDurationInSeconds(videoFullPath);
                newTime = durationInSeconds;
            }
            await saveProgress(videoFile, newTime);
            socket.emit('videoMarked', { videoFile, watched, time: newTime }); // Acknowledge with new time
        } catch (error) {
            console.error(`Error marking video ${videoFile}:`, error);
        }
    });

    socket.on('markFolder', async ({ folderPath, watched }) => {
        try {
            const fullFolderPath = path.join(videosDirectory, folderPath);
            const entries = await fsp.readdir(fullFolderPath);
            const videoFiles = entries.filter(file => /\.(mp4|mkv|avi|mov)$/i.test(file));
            
            for (const file of videoFiles) {
                const videoRelativePath = path.join(folderPath, file).replace(/\\/g, '/');
                let newTime = 0;
                if (watched) {
                    const videoFullPath = path.join(fullFolderPath, file);
                    const durationInSeconds = await getVideoDurationInSeconds(videoFullPath);
                    newTime = durationInSeconds;
                }
                await saveProgress(videoRelativePath, newTime);
            }
            socket.emit('folderMarked', { folderPath, watched }); // Acknowledge
        } catch (error) {
            console.error(`Error marking folder ${folderPath}:`, error);
        }
    });

    socket.on('disconnecting', () => {
        console.log(`User disconnecting: ${socket.id}`);
        // Find the room the socket is about to leave.
        const currentRoom = Array.from(socket.rooms).find(room => room !== socket.id);
        
        if (currentRoom) {
            console.log(`User was in room "${currentRoom}". Notifying partner.`);
            // Broadcast to the other user in the room.
            socket.to(currentRoom).emit('partnerLeft');
            socket.to(currentRoom).emit('userCountUpdate', { count: 1 });
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
        const progress = await readProgressFile();
        if (!progress[videoFile]) {
            progress[videoFile] = {}; // Create entry if not exists
        }

        progress[videoFile].time = time;
        progress[videoFile].lastWatched = Date.now();

        // If duration is not stored yet, get it and store it.
        if (!progress[videoFile].duration) {
            try {
                const fullPath = path.join(videosDirectory, videoFile);
                const duration = await getVideoDurationInSeconds(fullPath);
                progress[videoFile].duration = duration;
            } catch (durationError) {
                // If duration can't be fetched, we can still save progress time.
                console.error(`Could not get duration for ${videoFile}:`, durationError.message);
            }
        }
        
        await writeProgressFile(progress);
    } catch (error) {
        console.error(`Failed to save progress for ${videoFile}:`, error);
    }
}

server.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
}); 