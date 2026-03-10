const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

// FFmpeg paths (same as in server.js)
const ffmpegPath = 'C:\\Users\\Joey\\Documents\\Code\\TogetherVideo\\FFMPEG\\bin\\ffmpeg.exe';
const ffprobePath = 'C:\\Users\\Joey\\Documents\\Code\\TogetherVideo\\FFMPEG\\bin\\ffprobe.exe';

try {
    fs.accessSync(ffmpegPath);
    fs.accessSync(ffprobePath);
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
    console.log('✅ FFmpeg configured');
} catch (error) {
    console.error('❌ FFmpeg not found. Please install FFmpeg first.');
    process.exit(1);
}

/**
 * Convert video to VideoStack optimized format
 */
function optimizeVideo(inputPath, outputPath, quality = 'auto') {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Optimizing: ${path.basename(inputPath)}`);
        
        // Create "oud" directory in the same folder as the input
        const inputDir = path.dirname(inputPath);
        const oldDir = path.join(inputDir, 'oud');
        if (!fs.existsSync(oldDir)) {
            fs.mkdirSync(oldDir, { recursive: true });
            console.log(`📁 Created directory: ${path.relative(process.cwd(), oldDir)}`);
        }
        
        const command = ffmpeg(inputPath)
            .videoCodec('libx264')
            .outputOptions([
                '-preset slow',          // Better compression for internet streaming
                '-crf 23',               // Lower bitrate for internet (23 = good quality/size balance)
                '-profile:v main',       // Good balance between compatibility and compression
                '-level 3.1',            // Good for web streaming
                '-pix_fmt yuv420p',      // Most compatible pixel format
                '-movflags +faststart',  // Enable progressive download
                '-maxrate 3M',           // Limit max bitrate for 5G streaming
                '-bufsize 6M'            // Buffer size for consistent streaming
            ])
            .audioCodec('aac')
            .audioBitrate('128k')       // Standard web audio bitrate
            .format('mp4');

        // Quality settings - matches server's qualityMap
        if (quality === '1080p') command.videoFilter('scale=-2:1080');
        else if (quality === '720p') command.videoFilter('scale=-2:720');
        else if (quality === '480p') command.videoFilter('scale=-2:480');

        let lastPercent = 0;
        
        command
            .on('progress', (progress) => {
                const percent = Math.round(progress.percent || 0);
                if (percent > lastPercent + 2) {
                    process.stdout.write(`\r⏳ ${percent}% - ${progress.timemark || 'Processing...'}`);
                    lastPercent = percent;
                }
            })
            .on('end', () => {
                try {
                    // Move original file to "oud" directory
                    const originalName = path.basename(inputPath);
                    const oldFilePath = path.join(oldDir, originalName);
                    fs.renameSync(inputPath, oldFilePath);
                    console.log(`📦 Moved original to: oud/${originalName}`);
                    
                    // Rename optimized file to original name (without _optimized)
                    const finalPath = inputPath.replace(/\.[^.]+$/, '.mp4');
                    fs.renameSync(outputPath, finalPath);
                    console.log(`✅ Optimized file renamed to: ${path.basename(finalPath)}`);
                    
                    resolve();
                } catch (err) {
                    console.error(`❌ Error organizing files: ${err.message}`);
                    reject(err);
                }
            })
            .on('error', (err) => {
                console.error(`\n❌ Error: ${err.message}`);
                reject(err);
            })
            .save(outputPath);
    });
}

/**
 * Check if video needs optimization (based on server's isProblematic logic)
 */
function needsOptimization(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            
            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
            const ext = path.extname(filePath).toLowerCase();
            
            // Exact same logic as server.js "isProblematic"
            const isMKV = ext === '.mkv';
            const isHEVC = videoStream?.codec_name === 'hevc';
            const isNotH264 = videoStream && videoStream.codec_name !== 'h264';
            const isNotAAC = audioStream && audioStream.codec_name !== 'aac';
            
            const needsWork = isMKV || isHEVC || isNotH264 || isNotAAC;
            
            console.log(`📊 ${path.basename(filePath)}:`);
            console.log(`   Container: ${ext} ${isMKV ? '❌' : '✅'}`);
            console.log(`   Video: ${videoStream?.codec_name || 'unknown'} ${(isHEVC || isNotH264) ? '❌' : '✅'}`);
            console.log(`   Audio: ${audioStream?.codec_name || 'unknown'} ${isNotAAC ? '❌' : '✅'}`);
            console.log(`   Status: ${needsWork ? '❌ Needs optimization' : '✅ Already optimal'}\n`);
            
            resolve(needsWork);
        });
    });
}

/**
 * Scan and optimize directory
 */
async function optimizeDirectory(dirPath, quality, recursive = false) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    let stats = { total: 0, optimized: 0, skipped: 0, errors: 0 };
    
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory() && recursive) {
            console.log(`📁 Entering directory: ${entry.name}`);
            const subStats = await optimizeDirectory(fullPath, quality, recursive);
            stats.total += subStats.total;
            stats.optimized += subStats.optimized;
            stats.skipped += subStats.skipped;
            stats.errors += subStats.errors;
        } else if (/\.(mp4|mkv|avi|mov)$/i.test(entry.name)) {
            stats.total++;
            
            try {
                // Check if already optimized by looking for original in "oud" directory
                const dirPath = path.dirname(fullPath);
                const oldDir = path.join(dirPath, 'oud');
                const originalInOld = path.join(oldDir, entry.name);
                
                if (fs.existsSync(originalInOld)) {
                    console.log(`⏭️  Skipping ${entry.name} (already optimized - original in oud/)\n`);
                    stats.skipped++;
                } else if (await needsOptimization(fullPath)) {
                    const outputPath = fullPath.replace(/\.[^.]+$/, '_optimized.mp4');
                    await optimizeVideo(fullPath, outputPath, quality);
                    stats.optimized++;
                    console.log(''); // Empty line for readability
                } else {
                    console.log(`✅ ${entry.name} (already optimal format)\n`);
                    stats.skipped++;
                }
            } catch (error) {
                console.error(`❌ Failed to process ${entry.name}: ${error.message}\n`);
                stats.errors++;
            }
        }
    }
    
    return stats;
}

// CLI Interface
async function main() {
    const [,, inputPath, quality = '720p', ...flags] = process.argv;
    const recursive = flags.includes('-r') || flags.includes('--recursive');
    
    if (!inputPath) {
        console.log(`
🎬 VideoStack Optimizer
=======================

Usage: node video-optimizer.js <path> [quality] [flags]

 Parameters:
   path      File or directory path
   quality   720p | 1080p | 480p | auto (default: 720p - recommended for internet)
  
Flags:
  -r, --recursive    Process subdirectories

 Examples:
   node video-optimizer.js "movie.mkv"                    # 720p default
   node video-optimizer.js "E:\\Media\\Anime" 1080p -r     # High quality
   node video-optimizer.js "series" --recursive            # 720p for all

 What this tool does:
   ✅ Optimized for internet/5G streaming (max 3Mbps)
   ✅ Converts to MP4 container (no more MKV transcoding)
   ✅ H.264 with efficient compression (slower encode, better streaming)
   ✅ AAC audio codec (web compatible)
   ✅ Creates "oud" folder and moves originals there
   ✅ Optimized files get the original filename
   ✅ Perfect for 2 simultaneous external users

 Result: Clean organization + smooth streaming without server transcoding!
        `);
        return;
    }
    
    if (!fs.existsSync(inputPath)) {
        console.error('❌ Path not found:', inputPath);
        return;
    }
    
    console.log('🎬 VideoStack Optimizer');
    console.log('=======================\n');
    console.log(`Input: ${inputPath}`);
    console.log(`Quality: ${quality}`);
    console.log(`Recursive: ${recursive ? 'Yes' : 'No'}\n`);
    
    const startTime = Date.now();
    
    try {
        if (fs.statSync(inputPath).isDirectory()) {
            const stats = await optimizeDirectory(inputPath, quality, recursive);
            console.log('📊 Final Results:');
            console.log('================');
            console.log(`Total files processed: ${stats.total}`);
            console.log(`Successfully optimized: ${stats.optimized}`);
            console.log(`Skipped (already optimal): ${stats.skipped}`);
            console.log(`Errors: ${stats.errors}`);
        } else {
            // Check if single file already optimized
            const dirPath = path.dirname(inputPath);
            const filename = path.basename(inputPath);
            const oldDir = path.join(dirPath, 'oud');
            const originalInOld = path.join(oldDir, filename);
            
            if (fs.existsSync(originalInOld)) {
                console.log('⏭️  File already optimized (original found in oud/ directory)');
            } else if (await needsOptimization(inputPath)) {
                const output = inputPath.replace(/\.[^.]+$/, '_optimized.mp4');
                await optimizeVideo(inputPath, output, quality);
                console.log('✅ Single file optimization completed!');
            } else {
                console.log('✅ File already in optimal format!');
            }
        }
    } catch (error) {
        console.error('❌ Optimization failed:', error.message);
    }
    
    const minutes = Math.round((Date.now() - startTime) / 60000);
    console.log(`\n⏱️  Total time: ${minutes} minute${minutes !== 1 ? 's' : ''}`);
    console.log('\n🎯 Pro tip: Optimized videos will stream instantly in VideoStack!');
}

if (require.main === module) main();

module.exports = { optimizeVideo, needsOptimization, optimizeDirectory }; 