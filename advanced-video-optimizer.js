const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const readline = require('readline');

// FFmpeg paths
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

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Quality presets - much better than the old optimizer
const qualityPresets = {
    'ultra': {
        crf: 16,
        preset: 'slower',
        audioBitrate: '320k',
        maxrate: null,
        bufsize: null,
        description: 'Ultra High Quality (Large files, perfect quality)'
    },
    'high': {
        crf: 18,
        preset: 'slow',
        audioBitrate: '256k',
        maxrate: '8M',
        bufsize: '16M',
        description: 'High Quality (Recommended for local streaming)'
    },
    'balanced': {
        crf: 20,
        preset: 'medium',
        audioBitrate: '192k',
        maxrate: '5M',
        bufsize: '10M',
        description: 'Balanced Quality/Size (Good for most uses)'
    },
    'streaming': {
        crf: 22,
        preset: 'fast',
        audioBitrate: '160k',
        maxrate: '3M',
        bufsize: '6M',
        description: 'Internet Streaming (Smaller files, still good quality)'
    },
    'mobile': {
        crf: 24,
        preset: 'fast',
        audioBitrate: '128k',
        maxrate: '2M',
        bufsize: '4M',
        description: 'Mobile/Low bandwidth (Smallest files)'
    }
};

/**
 * Get video metadata and determine best settings
 */
function analyzeVideo(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            
            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
            
            const analysis = {
                duration: metadata.format.duration,
                size: metadata.format.size,
                bitrate: metadata.format.bit_rate,
                container: path.extname(filePath).toLowerCase(),
                video: {
                    codec: videoStream?.codec_name,
                    width: videoStream?.width,
                    height: videoStream?.height,
                    fps: eval(videoStream?.r_frame_rate) || 0,
                    bitrate: videoStream?.bit_rate
                },
                audio: {
                    codec: audioStream?.codec_name,
                    channels: audioStream?.channels,
                    sampleRate: audioStream?.sample_rate,
                    bitrate: audioStream?.bit_rate
                }
            };
            
            // Determine if optimization is needed
            const needsOptimization = 
                analysis.container === '.mkv' ||
                analysis.video.codec === 'hevc' ||
                analysis.video.codec !== 'h264' ||
                analysis.audio.codec !== 'aac';
            
            analysis.needsOptimization = needsOptimization;
            resolve(analysis);
        });
    });
}

/**
 * Advanced video optimization with quality preservation
 */
function optimizeVideoAdvanced(inputPath, outputPath, preset = 'high', targetResolution = null) {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Optimizing: ${path.basename(inputPath)} (${preset} quality)`);
        
        // Create backup directory
        const inputDir = path.dirname(inputPath);
        const backupDir = path.join(inputDir, 'originals');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        
        const settings = qualityPresets[preset];
        if (!settings) {
            return reject(new Error(`Unknown preset: ${preset}`));
        }
        
        const command = ffmpeg(inputPath)
            .videoCodec('libx264')
            .outputOptions([
                `-preset ${settings.preset}`,
                `-crf ${settings.crf}`,
                '-profile:v high',      // Better compression than 'main'
                '-level 4.0',          // Higher level for better quality
                '-pix_fmt yuv420p',
                '-movflags +faststart',
                '-tune film',          // Better for video content
                '-x264opts keyint=240:min-keyint=24'  // Better keyframe intervals
            ])
            .audioCodec('aac')
            .audioBitrate(settings.audioBitrate)
            .audioChannels(2)
            .audioFrequency(48000)  // Higher sample rate
            .format('mp4');

        // Add bitrate limiting only if specified (for streaming presets)
        if (settings.maxrate) {
            command.outputOptions([
                `-maxrate ${settings.maxrate}`,
                `-bufsize ${settings.bufsize}`
            ]);
        }

        // Handle resolution scaling
        if (targetResolution) {
            if (targetResolution === '4K') {
                command.videoFilter('scale=-2:2160');
            } else if (targetResolution === '1440p') {
                command.videoFilter('scale=-2:1440');
            } else if (targetResolution === '1080p') {
                command.videoFilter('scale=-2:1080');
            } else if (targetResolution === '720p') {
                command.videoFilter('scale=-2:720');
            } else if (targetResolution === '480p') {
                command.videoFilter('scale=-2:480');
            }
        }

        let lastPercent = 0;
        const startTime = Date.now();
        
        command
            .on('progress', (progress) => {
                const percent = Math.round(progress.percent || 0);
                if (percent > lastPercent + 1) {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    const eta = percent > 0 ? Math.round((elapsed / percent) * (100 - percent)) : 0;
                    process.stdout.write(`\r⏳ ${percent}% - ${progress.timemark || 'Processing...'} (ETA: ${eta}s)`);
                    lastPercent = percent;
                }
            })
            .on('end', () => {
                try {
                    // Move original to backup
                    const originalName = path.basename(inputPath);
                    const backupPath = path.join(backupDir, originalName);
                    fs.renameSync(inputPath, backupPath);
                    
                    // Rename optimized file to original name
                    const finalPath = inputPath.replace(/\.[^.]+$/, '.mp4');
                    fs.renameSync(outputPath, finalPath);
                    
                    console.log(`\n✅ Optimized and backed up to: originals/${originalName}`);
                    resolve({ finalPath, backupPath });
                } catch (err) {
                    console.error(`\n❌ Error organizing files: ${err.message}`);
                    reject(err);
                }
            })
            .on('error', (err) => {
                console.error(`\n❌ Optimization failed: ${err.message}`);
                reject(err);
            })
            .save(outputPath);
    });
}

/**
 * Two-pass optimization for even better quality (slower but superior)
 */
function optimizeVideoTwoPass(inputPath, outputPath, preset = 'high', targetResolution = null) {
    return new Promise((resolve, reject) => {
        console.log(`🔄🔄 Two-pass optimization: ${path.basename(inputPath)} (${preset} quality)`);
        
        const settings = qualityPresets[preset];
        const passLogFile = path.join(path.dirname(outputPath), 'ffmpeg2pass');
        
        // First pass
        console.log('📊 Starting first pass (analysis)...');
        let firstPassCommand = ffmpeg(inputPath)
            .videoCodec('libx264')
            .outputOptions([
                `-preset ${settings.preset}`,
                `-crf ${settings.crf}`,
                '-profile:v high',
                '-level 4.0',
                '-pix_fmt yuv420p',
                '-tune film',
                '-pass 1',
                `-passlogfile ${passLogFile}`,
                '-f null'
            ]);

        if (targetResolution) {
            if (targetResolution === '1080p') firstPassCommand.videoFilter('scale=-2:1080');
            else if (targetResolution === '720p') firstPassCommand.videoFilter('scale=-2:720');
            else if (targetResolution === '480p') firstPassCommand.videoFilter('scale=-2:480');
        }

        firstPassCommand
            .on('end', () => {
                console.log('\n✅ First pass complete. Starting second pass...');
                
                // Second pass
                let secondPassCommand = ffmpeg(inputPath)
                    .videoCodec('libx264')
                    .outputOptions([
                        `-preset ${settings.preset}`,
                        `-crf ${settings.crf}`,
                        '-profile:v high',
                        '-level 4.0',
                        '-pix_fmt yuv420p',
                        '-movflags +faststart',
                        '-tune film',
                        '-pass 2',
                        `-passlogfile ${passLogFile}`
                    ])
                    .audioCodec('aac')
                    .audioBitrate(settings.audioBitrate)
                    .audioChannels(2)
                    .audioFrequency(48000)
                    .format('mp4');

                if (settings.maxrate) {
                    secondPassCommand.outputOptions([
                        `-maxrate ${settings.maxrate}`,
                        `-bufsize ${settings.bufsize}`
                    ]);
                }

                if (targetResolution) {
                    if (targetResolution === '1080p') secondPassCommand.videoFilter('scale=-2:1080');
                    else if (targetResolution === '720p') secondPassCommand.videoFilter('scale=-2:720');
                    else if (targetResolution === '480p') secondPassCommand.videoFilter('scale=-2:480');
                }

                let lastPercent = 0;
                secondPassCommand
                    .on('progress', (progress) => {
                        const percent = Math.round(progress.percent || 0);
                        if (percent > lastPercent + 1) {
                            process.stdout.write(`\r🎬 Pass 2: ${percent}% - ${progress.timemark || 'Processing...'}`);
                            lastPercent = percent;
                        }
                    })
                    .on('end', () => {
                        // Cleanup pass files
                        try {
                            fs.unlinkSync(`${passLogFile}-0.log`);
                            fs.unlinkSync(`${passLogFile}-0.log.mbtree`);
                        } catch (e) {}
                        
                        console.log('\n✅ Two-pass optimization complete!');
                        resolve();
                    })
                    .on('error', reject)
                    .save(outputPath);
            })
            .on('error', reject)
            .save('NUL'); // Null output for first pass on Windows
    });
}

/**
 * Interactive menu system
 */
async function askQuestion(question) {
    return new Promise((resolve) => {
        rl.question(question, resolve);
    });
}

function displayQualityMenu() {
    console.log('\n🎥 Select Quality Preset:');
    console.log('========================');
    
    Object.entries(qualityPresets).forEach(([key, preset], index) => {
        const marker = key === 'high' ? ' (RECOMMENDED)' : '';
        console.log(`${index + 1}. ${key.toUpperCase()}${marker}`);
        console.log(`   ${preset.description}`);
        console.log(`   CRF: ${preset.crf}, Audio: ${preset.audioBitrate}`);
        console.log('');
    });
}

function displayResolutionMenu() {
    console.log('\n📐 Select Target Resolution:');
    console.log('============================');
    console.log('1. Keep Original (No scaling)');
    console.log('2. 4K (2160p)');
    console.log('3. 1440p (2K)');
    console.log('4. 1080p (Full HD)');
    console.log('5. 720p (HD)');
    console.log('6. 480p (SD)');
    console.log('');
}

async function processFile(filePath) {
    try {
        console.log('\n🔍 Analyzing video...');
        const analysis = await analyzeVideo(filePath);
        
        console.log('\n📊 Video Analysis:');
        console.log('==================');
        console.log(`File: ${path.basename(filePath)}`);
        console.log(`Container: ${analysis.container}`);
        console.log(`Video: ${analysis.video.codec} ${analysis.video.width}x${analysis.video.height} @${Math.round(analysis.video.fps)}fps`);
        console.log(`Audio: ${analysis.audio.codec} ${analysis.audio.channels}ch @${analysis.audio.sampleRate}Hz`);
        console.log(`Duration: ${Math.round(analysis.duration / 60)} minutes`);
        console.log(`Size: ${Math.round(analysis.size / 1024 / 1024)} MB`);
        console.log(`Needs optimization: ${analysis.needsOptimization ? '❌ Yes' : '✅ No'}`);
        
        if (!analysis.needsOptimization) {
            const proceed = await askQuestion('\n⚠️  Video is already optimized. Continue anyway? (y/N): ');
            if (proceed.toLowerCase() !== 'y') {
                return;
            }
        }
        
        displayQualityMenu();
        const qualityChoice = await askQuestion('Select quality (1-5, default: 2 for HIGH): ') || '2';
        const qualityKeys = Object.keys(qualityPresets);
        const selectedQuality = qualityKeys[parseInt(qualityChoice) - 1] || 'high';
        
        displayResolutionMenu();
        const resChoice = await askQuestion('Select resolution (1-6, default: 1 for original): ') || '1';
        const resolutions = [null, '4K', '1440p', '1080p', '720p', '480p'];
        const selectedResolution = resolutions[parseInt(resChoice) - 1];
        
        const twoPassChoice = await askQuestion('\n🔄 Use two-pass encoding for better quality? (slower) (y/N): ');
        const useTwoPass = twoPassChoice.toLowerCase() === 'y';
        
        const outputPath = filePath.replace(/\.[^.]+$/, '_optimized.mp4');
        
        console.log('\n🚀 Starting optimization...');
        console.log(`Quality: ${selectedQuality.toUpperCase()}`);
        console.log(`Resolution: ${selectedResolution || 'Original'}`);
        console.log(`Mode: ${useTwoPass ? 'Two-pass' : 'Single-pass'}`);
        console.log('');
        
        const startTime = Date.now();
        
        if (useTwoPass) {
            await optimizeVideoTwoPass(filePath, outputPath, selectedQuality, selectedResolution);
        } else {
            await optimizeVideoAdvanced(filePath, outputPath, selectedQuality, selectedResolution);
        }
        
        const endTime = Date.now();
        const duration = Math.round((endTime - startTime) / 1000 / 60);
        
        console.log('\n🎉 Optimization Complete!');
        console.log(`⏱️  Time taken: ${duration} minutes`);
        
        // Show file size comparison
        try {
            const backupDir = path.join(path.dirname(filePath), 'originals');
            const originalFile = path.join(backupDir, path.basename(filePath));
            const newFile = filePath.replace(/\.[^.]+$/, '.mp4');
            
            const originalSize = fs.statSync(originalFile).size;
            const newSize = fs.statSync(newFile).size;
            const compression = Math.round((1 - newSize / originalSize) * 100);
            
            console.log(`📊 Original: ${Math.round(originalSize / 1024 / 1024)} MB`);
            console.log(`📊 Optimized: ${Math.round(newSize / 1024 / 1024)} MB`);
            console.log(`📊 ${compression > 0 ? 'Compression' : 'Size increase'}: ${Math.abs(compression)}%`);
        } catch (e) {
            console.log('📊 Size comparison unavailable');
        }
        
    } catch (error) {
        console.error(`\n❌ Error processing file: ${error.message}`);
    }
}

async function main() {
    console.log('🎬 Advanced Video Optimizer');
    console.log('============================');
    console.log('High-quality video optimization with advanced settings');
    console.log('Preserves video quality while ensuring compatibility\n');
    
    const filePath = process.argv[2];
    
    if (!filePath) {
        console.log('Usage: node advanced-video-optimizer.js <video-file>');
        console.log('\nExample:');
        console.log('node advanced-video-optimizer.js "movie.mkv"');
        rl.close();
        return;
    }
    
    if (!fs.existsSync(filePath)) {
        console.error('❌ File not found:', filePath);
        rl.close();
        return;
    }
    
    await processFile(filePath);
    rl.close();
}

if (require.main === module) {
    main();
}

module.exports = { 
    optimizeVideoAdvanced, 
    optimizeVideoTwoPass, 
    analyzeVideo, 
    qualityPresets 
}; 