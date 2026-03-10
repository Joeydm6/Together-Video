const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const readline = require('readline');

// FFmpeg paths (same as server.js)
const ffmpegPath = 'C:\\Users\\Joey\\Documents\\Code\\TogetherVideo\\FFMPEG\\bin\\ffmpeg.exe';
const ffprobePath = 'C:\\Users\\Joey\\Documents\\Code\\TogetherVideo\\FFMPEG\\bin\\ffprobe.exe';

try {
    fs.accessSync(ffmpegPath);
    fs.accessSync(ffprobePath);
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
} catch (error) {
    console.error('❌ FFmpeg not found. Please install FFmpeg first.');
    process.exit(1);
}

const mediaPath = 'E:\\Media';
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Colors for better visual experience
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

function colorize(text, color) {
    return `${colors[color]}${text}${colors.reset}`;
}

function showHeader() {
    console.clear();
    console.log(colorize('╔═══════════════════════════════════════════════════════════════╗', 'cyan'));
    console.log(colorize('║                   🎬 VideoStack Optimizer                     ║', 'cyan'));
    console.log(colorize('║                     Interactive Series Manager               ║', 'cyan'));
    console.log(colorize('╚═══════════════════════════════════════════════════════════════╝', 'cyan'));
    console.log('');
}

function showProgressBar(current, total, label = '') {
    const percentage = Math.round((current / total) * 100);
    const barLength = 30;
    const filledLength = Math.round((percentage / 100) * barLength);
    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
    
    process.stdout.write(`\r${colorize('⏳', 'yellow')} ${label} [${colorize(bar, 'green')}] ${colorize(percentage + '%', 'bright')}`);
}

async function scanForSeries() {
    const categories = ['Series', 'Anime', 'Movies'];
    const allSeries = [];
    
    console.log(colorize('🔍 Scanning for series...', 'yellow'));
    
    for (const category of categories) {
        const categoryPath = path.join(mediaPath, category);
        if (!fs.existsSync(categoryPath)) continue;
        
        try {
            const entries = fs.readdirSync(categoryPath, { withFileTypes: true });
            const series = entries
                .filter(entry => entry.isDirectory())
                .map(entry => ({
                    name: entry.name,
                    category: category,
                    path: path.join(categoryPath, entry.name),
                    needsOptimization: null // Will be checked later
                }));
            
            allSeries.push(...series);
        } catch (error) {
            console.log(colorize(`⚠️  Could not scan ${category}`, 'yellow'));
        }
    }
    
    return allSeries;
}

async function checkOptimizationStatus(seriesPath) {
    try {
        const entries = fs.readdirSync(seriesPath, { withFileTypes: true });
        let hasVideos = false;
        let needsWork = false;
        
        for (const entry of entries) {
            const fullPath = path.join(seriesPath, entry.name);
            
            if (entry.isDirectory()) {
                // Check subdirectories (seasons)
                const subResult = await checkOptimizationStatus(fullPath);
                if (subResult.hasVideos) hasVideos = true;
                if (subResult.needsWork) needsWork = true;
            } else if (/\.(mp4|mkv|avi|mov)$/i.test(entry.name)) {
                hasVideos = true;
                
                // Check if original is in "oud" folder (already optimized)
                const dirPath = path.dirname(fullPath);
                const oldDir = path.join(dirPath, 'oud');
                const originalInOld = path.join(oldDir, entry.name);
                
                if (fs.existsSync(originalInOld)) {
                    // Already optimized
                    continue;
                } else if (entry.name.endsWith('.mkv') || entry.name.includes('hevc')) {
                    needsWork = true;
                }
            }
        }
        
        return { hasVideos, needsWork };
    } catch (error) {
        return { hasVideos: false, needsWork: false };
    }
}

function displaySeriesMenu(series) {
    showHeader();
    console.log(colorize('📺 Select a series to optimize:', 'bright'));
    console.log('');
    
    series.forEach((serie, index) => {
        const number = colorize(`${index + 1}.`, 'cyan');
        const category = colorize(`[${serie.category}]`, 'magenta');
        const name = colorize(serie.name, 'white');
        
        let status = '';
        if (serie.needsOptimization === true) {
            status = colorize('🔄 Needs optimization', 'yellow');
        } else if (serie.needsOptimization === false) {
            status = colorize('✅ Already optimized', 'green');
        } else {
            status = colorize('❓ Unknown', 'blue');
        }
        
        console.log(`${number} ${category} ${name} - ${status}`);
    });
    
    console.log('');
    console.log(colorize('0.', 'cyan') + colorize(' Exit', 'red'));
    console.log('');
}

function askQuestion(question) {
    return new Promise((resolve) => {
        rl.question(colorize(question, 'bright'), resolve);
    });
}

async function selectQuality() {
    showHeader();
    console.log(colorize('🎥 Select quality for optimization:', 'bright'));
    console.log('');
    console.log(colorize('1.', 'cyan') + ' 720p ' + colorize('(Recommended for 5G/Internet)', 'green'));
    console.log(colorize('2.', 'cyan') + ' 1080p ' + colorize('(High quality)', 'yellow'));
    console.log(colorize('3.', 'cyan') + ' 480p ' + colorize('(Lower bandwidth)', 'blue'));
    console.log(colorize('4.', 'cyan') + ' Auto ' + colorize('(Keep original resolution)', 'magenta'));
    console.log('');
    
    const choice = await askQuestion('Select quality (1-4): ');
    
    switch (choice) {
        case '1': return '720p';
        case '2': return '1080p';
        case '3': return '480p';
        case '4': return 'auto';
        default: return '720p';
    }
}

async function optimizeVideo(inputPath, outputPath, quality) {
    return new Promise((resolve, reject) => {
        const inputDir = path.dirname(inputPath);
        const oldDir = path.join(inputDir, 'oud');
        if (!fs.existsSync(oldDir)) {
            fs.mkdirSync(oldDir, { recursive: true });
        }
        
        const command = ffmpeg(inputPath)
            .videoCodec('libx264')
            .outputOptions([
                '-preset slow',
                '-crf 23',
                '-profile:v main',
                '-level 3.1',
                '-pix_fmt yuv420p',
                '-movflags +faststart',
                '-maxrate 3M',
                '-bufsize 6M'
            ])
            .audioCodec('aac')
            .audioBitrate('128k')
            .format('mp4');

        if (quality === '1080p') command.videoFilter('scale=-2:1080');
        else if (quality === '720p') command.videoFilter('scale=-2:720');
        else if (quality === '480p') command.videoFilter('scale=-2:480');

        let lastPercent = 0;
        
        command
            .on('progress', (progress) => {
                const percent = Math.round(progress.percent || 0);
                if (percent > lastPercent) {
                    showProgressBar(percent, 100, `${path.basename(inputPath)}`);
                    lastPercent = percent;
                }
            })
            .on('end', () => {
                try {
                    const originalName = path.basename(inputPath);
                    const oldFilePath = path.join(oldDir, originalName);
                    fs.renameSync(inputPath, oldFilePath);
                    
                    const finalPath = inputPath.replace(/\.[^.]+$/, '.mp4');
                    fs.renameSync(outputPath, finalPath);
                    
                    console.log('');
                    console.log(colorize(`✅ ${originalName} optimized successfully!`, 'green'));
                    resolve();
                } catch (err) {
                    reject(err);
                }
            })
            .on('error', reject)
            .save(outputPath);
    });
}

async function optimizeSeries(seriesPath, quality) {
    showHeader();
    console.log(colorize(`🔄 Optimizing: ${path.basename(seriesPath)}`, 'bright'));
    console.log(colorize(`📊 Quality: ${quality}`, 'cyan'));
    console.log('');
    
    const videoFiles = [];
    
    // Recursively find all video files
    function findVideos(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory() && entry.name !== 'oud') {
                findVideos(fullPath);
            } else if (/\.(mp4|mkv|avi|mov)$/i.test(entry.name)) {
                // Check if already optimized
                const dirPath = path.dirname(fullPath);
                const oldDir = path.join(dirPath, 'oud');
                const originalInOld = path.join(oldDir, entry.name);
                
                if (!fs.existsSync(originalInOld)) {
                    videoFiles.push(fullPath);
                }
            }
        }
    }
    
    findVideos(seriesPath);
    
    if (videoFiles.length === 0) {
        console.log(colorize('✅ All videos are already optimized!', 'green'));
        await askQuestion('Press Enter to continue...');
        return;
    }
    
    console.log(colorize(`📁 Found ${videoFiles.length} videos to optimize`, 'yellow'));
    console.log('');
    
    let completed = 0;
    
    for (const videoFile of videoFiles) {
        try {
            const outputPath = videoFile.replace(/\.[^.]+$/, '_optimized.mp4');
            await optimizeVideo(videoFile, outputPath, quality);
            completed++;
        } catch (error) {
            console.log('');
            console.log(colorize(`❌ Error optimizing ${path.basename(videoFile)}: ${error.message}`, 'red'));
        }
    }
    
    console.log('');
    console.log(colorize('🎉 Optimization Complete!', 'green'));
    console.log(colorize(`✅ Successfully optimized: ${completed}/${videoFiles.length} videos`, 'bright'));
    console.log('');
    await askQuestion('Press Enter to continue...');
}

async function main() {
    try {
        showHeader();
        console.log(colorize('🔍 Scanning for series in your media library...', 'yellow'));
        
        const series = await scanForSeries();
        
        if (series.length === 0) {
            console.log(colorize('❌ No series found in E:\\Media', 'red'));
            rl.close();
            return;
        }
        
        // Check optimization status for each series
        console.log(colorize('📊 Checking optimization status...', 'yellow'));
        for (let i = 0; i < series.length; i++) {
            showProgressBar(i + 1, series.length, 'Analyzing series');
            const status = await checkOptimizationStatus(series[i].path);
            series[i].needsOptimization = status.needsWork;
        }
        console.log('');
        
        while (true) {
            displaySeriesMenu(series);
            
            const choice = await askQuestion('Select a series (number): ');
            const index = parseInt(choice) - 1;
            
            if (choice === '0') {
                console.log(colorize('👋 Goodbye!', 'cyan'));
                break;
            }
            
            if (index >= 0 && index < series.length) {
                const selectedSeries = series[index];
                
                if (selectedSeries.needsOptimization === false) {
                    showHeader();
                    console.log(colorize(`✅ ${selectedSeries.name} is already optimized!`, 'green'));
                    await askQuestion('Press Enter to continue...');
                    continue;
                }
                
                const quality = await selectQuality();
                await optimizeSeries(selectedSeries.path, quality);
                
                // Update status after optimization
                const status = await checkOptimizationStatus(selectedSeries.path);
                selectedSeries.needsOptimization = status.needsWork;
            } else {
                console.log(colorize('❌ Invalid selection!', 'red'));
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    } catch (error) {
        console.error(colorize('❌ Error:', 'red'), error.message);
    } finally {
        rl.close();
    }
}

if (require.main === module) {
    main();
} 