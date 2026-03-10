const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const readline = require('readline');

// Import the advanced optimizer functions
const { optimizeVideoAdvanced, analyzeVideo, qualityPresets } = require('./advanced-video-optimizer');

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

/**
 * Scan directory for video files
 */
function scanForVideos(dirPath, recursive = true) {
    const videoFiles = [];
    
    function scan(currentPath) {
        try {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                
                if (entry.isDirectory() && recursive && entry.name !== 'originals' && entry.name !== 'oud') {
                    scan(fullPath);
                } else if (entry.isFile() && /\.(mp4|mkv|avi|mov|m4v|flv|wmv)$/i.test(entry.name)) {
                    // Check if already processed
                    const backupDir = path.join(path.dirname(fullPath), 'originals');
                    const originalBackup = path.join(backupDir, entry.name);
                    
                    if (!fs.existsSync(originalBackup)) {
                        videoFiles.push(fullPath);
                    }
                }
            }
        } catch (error) {
            console.warn(`⚠️  Cannot access directory: ${currentPath}`);
        }
    }
    
    scan(dirPath);
    return videoFiles;
}

/**
 * Display progress for batch processing
 */
function displayBatchProgress(current, total, fileName) {
    const percentage = Math.round((current / total) * 100);
    const barLength = 30;
    const filledLength = Math.round((percentage / 100) * barLength);
    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
    
    console.log(`\n📊 Progress: [${bar}] ${percentage}% (${current}/${total})`);
    console.log(`🎬 Processing: ${fileName}`);
}

/**
 * Process directory with batch optimization
 */
async function processBatch(dirPath, preset = 'high', targetResolution = null, recursive = true) {
    console.log('\n🔍 Scanning for video files...');
    const videoFiles = scanForVideos(dirPath, recursive);
    
    if (videoFiles.length === 0) {
        console.log('✅ No video files need optimization in this directory.');
        return { processed: 0, skipped: 0, errors: 0 };
    }
    
    console.log(`\n📁 Found ${videoFiles.length} video files to process`);
    console.log(`🎥 Quality preset: ${preset.toUpperCase()}`);
    console.log(`📐 Target resolution: ${targetResolution || 'Original'}`);
    console.log(`🔄 Recursive: ${recursive ? 'Yes' : 'No'}`);
    
    const stats = {
        processed: 0,
        skipped: 0,
        errors: 0,
        totalSize: 0,
        optimizedSize: 0
    };
    
    for (let i = 0; i < videoFiles.length; i++) {
        const videoFile = videoFiles[i];
        const fileName = path.basename(videoFile);
        
        displayBatchProgress(i + 1, videoFiles.length, fileName);
        
        try {
            // Analyze video first
            const analysis = await analyzeVideo(videoFile);
            
            console.log(`📊 ${fileName}:`);
            console.log(`   Format: ${analysis.container} | ${analysis.video.codec} | ${analysis.audio.codec}`);
            console.log(`   Resolution: ${analysis.video.width}x${analysis.video.height}`);
            console.log(`   Size: ${Math.round(analysis.size / 1024 / 1024)} MB`);
            
            if (!analysis.needsOptimization) {
                console.log(`   ✅ Already optimized, skipping...`);
                stats.skipped++;
                continue;
            }
            
            const outputPath = videoFile.replace(/\.[^.]+$/, '_optimized.mp4');
            
            console.log(`   🔄 Optimizing with ${preset} quality...`);
            const originalSize = analysis.size;
            
            await optimizeVideoAdvanced(videoFile, outputPath, preset, targetResolution);
            
            // Calculate new size
            const newFile = videoFile.replace(/\.[^.]+$/, '.mp4');
            const newSize = fs.existsSync(newFile) ? fs.statSync(newFile).size : originalSize;
            
            stats.totalSize += originalSize;
            stats.optimizedSize += newSize;
            stats.processed++;
            
            console.log(`   ✅ Completed successfully!`);
            
        } catch (error) {
            console.error(`   ❌ Error: ${error.message}`);
            stats.errors++;
        }
        
        // Small delay to prevent overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    return stats;
}

/**
 * Interactive menu functions
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

/**
 * Display final statistics
 */
function displayStats(stats, duration) {
    console.log('\n🎉 Batch Processing Complete!');
    console.log('===============================');
    console.log(`✅ Successfully processed: ${stats.processed} files`);
    console.log(`⏭️  Skipped (already optimized): ${stats.skipped} files`);
    console.log(`❌ Errors encountered: ${stats.errors} files`);
    console.log(`⏱️  Total time: ${Math.round(duration / 60)} minutes`);
    
    if (stats.totalSize > 0 && stats.optimizedSize > 0) {
        const originalGB = Math.round(stats.totalSize / 1024 / 1024 / 1024 * 10) / 10;
        const optimizedGB = Math.round(stats.optimizedSize / 1024 / 1024 / 1024 * 10) / 10;
        const savings = Math.round((1 - stats.optimizedSize / stats.totalSize) * 100);
        
        console.log(`\n📊 Storage Statistics:`);
        console.log(`   Original total: ${originalGB} GB`);
        console.log(`   Optimized total: ${optimizedGB} GB`);
        console.log(`   Space ${savings > 0 ? 'saved' : 'used'}: ${Math.abs(savings)}%`);
    }
    
    console.log('\n🚀 All files are now optimized for streaming!');
}

/**
 * Main function
 */
async function main() {
    console.log('🎬 Batch Video Optimizer');
    console.log('=========================');
    console.log('High-quality batch video optimization');
    console.log('Process entire directories while preserving quality\n');
    
    let dirPath = process.argv[2];
    
    if (!dirPath) {
        console.log('Usage: node batch-video-optimizer.js <directory-path>');
        console.log('\nExample:');
        console.log('node batch-video-optimizer.js "E:\\Media\\Series\\My Show"');
        console.log('node batch-video-optimizer.js "E:\\Media\\Movies"');
        rl.close();
        return;
    }
    
    if (!fs.existsSync(dirPath)) {
        console.error('❌ Directory not found:', dirPath);
        rl.close();
        return;
    }
    
    if (!fs.statSync(dirPath).isDirectory()) {
        console.error('❌ Path is not a directory:', dirPath);
        rl.close();
        return;
    }
    
    console.log(`📁 Target directory: ${dirPath}`);
    
    // Quick scan to show what we'll process
    console.log('\n🔍 Quick scan...');
    const videoFiles = scanForVideos(dirPath, true);
    console.log(`📊 Found ${videoFiles.length} video files that need optimization`);
    
    if (videoFiles.length === 0) {
        console.log('✅ No videos need optimization. All done!');
        rl.close();
        return;
    }
    
    // Show some example files
    console.log('\nExample files to process:');
    videoFiles.slice(0, 5).forEach(file => {
        console.log(`   • ${path.relative(dirPath, file)}`);
    });
    if (videoFiles.length > 5) {
        console.log(`   ... and ${videoFiles.length - 5} more files`);
    }
    
    const proceed = await askQuestion('\n🚀 Continue with batch optimization? (y/N): ');
    if (proceed.toLowerCase() !== 'y') {
        console.log('👋 Operation cancelled.');
        rl.close();
        return;
    }
    
    // Get settings
    displayQualityMenu();
    const qualityChoice = await askQuestion('Select quality (1-5, default: 2 for HIGH): ') || '2';
    const qualityKeys = Object.keys(qualityPresets);
    const selectedQuality = qualityKeys[parseInt(qualityChoice) - 1] || 'high';
    
    displayResolutionMenu();
    const resChoice = await askQuestion('Select resolution (1-6, default: 1 for original): ') || '1';
    const resolutions = [null, '4K', '1440p', '1080p', '720p', '480p'];
    const selectedResolution = resolutions[parseInt(resChoice) - 1];
    
    const recursiveChoice = await askQuestion('\n📁 Process subdirectories recursively? (Y/n): ') || 'y';
    const recursive = recursiveChoice.toLowerCase() !== 'n';
    
    console.log('\n🚀 Starting batch processing...');
    console.log(`⚙️  Settings:`);
    console.log(`   Quality: ${selectedQuality.toUpperCase()}`);
    console.log(`   Resolution: ${selectedResolution || 'Original'}`);
    console.log(`   Recursive: ${recursive ? 'Yes' : 'No'}`);
    console.log('');
    
    const startTime = Date.now();
    
    try {
        const stats = await processBatch(dirPath, selectedQuality, selectedResolution, recursive);
        const duration = Date.now() - startTime;
        
        displayStats(stats, duration);
        
    } catch (error) {
        console.error('\n❌ Batch processing failed:', error.message);
    }
    
    rl.close();
}

if (require.main === module) {
    main();
}

module.exports = { processBatch, scanForVideos }; 