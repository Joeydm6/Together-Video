const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

// FFmpeg paths (same as server.js)
const ffmpegPath = 'C:\\Users\\Joey\\Documents\\Code\\TogetherVideo\\FFMPEG\\bin\\ffmpeg.exe';
const ffprobePath = 'C:\\Users\\Joey\\Documents\\Code\\TogetherVideo\\FFMPEG\\bin\\ffprobe.exe';

try {
    fs.accessSync(ffmpegPath);
    fs.accessSync(ffprobePath);
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
    console.log('✓ FFmpeg paths configured successfully');
} catch (error) {
    console.error('✗ FFmpeg not found:', error.message);
    process.exit(1);
}

const videosDirectory = 'E:\\Media';

// Get video path from command line argument
const videoRelativePath = process.argv[2];
if (!videoRelativePath) {
    console.log('Usage: node test-subtitles.js "Series/ShowName/Season 1/01. Episode.mkv"');
    process.exit(1);
}

const videoFullPath = path.join(videosDirectory, videoRelativePath);

console.log(`Testing subtitles for: ${videoRelativePath}`);
console.log(`Full path: ${videoFullPath}`);

// Check if file exists
if (!fs.existsSync(videoFullPath)) {
    console.error('✗ Video file not found:', videoFullPath);
    process.exit(1);
}

console.log('✓ Video file exists');

// Probe the video file
console.log('Probing video with ffprobe...');
ffmpeg.ffprobe(videoFullPath, (err, metadata) => {
    if (err) {
        console.error('✗ ffprobe failed:', err.message);
        process.exit(1);
    }
    
    console.log('✓ ffprobe successful');
    console.log(`Total streams: ${metadata.streams.length}`);
    
    // List all streams
    metadata.streams.forEach((stream, index) => {
        console.log(`Stream ${index}: type=${stream.codec_type}, codec=${stream.codec_name}, lang=${stream.tags?.language || 'unknown'}`);
    });
    
    // Find subtitle streams
    const subtitleStreams = metadata.streams.filter(s => s.codec_type === 'subtitle');
    console.log(`\nSubtitle streams found: ${subtitleStreams.length}`);
    
    if (subtitleStreams.length === 0) {
        console.log('No embedded subtitles found in this video');
        process.exit(0);
    }
    
    // Test extracting first subtitle
    const firstSub = subtitleStreams[0];
    console.log(`\nTesting extraction of subtitle stream ${firstSub.index} (${firstSub.tags?.language || 'unknown'})...`);
    
    const outputPath = path.join(__dirname, 'test-subtitle.vtt');
    
    ffmpeg(videoFullPath)
        .outputOptions([
            `-map 0:${firstSub.index}`,
            '-c:s webvtt'
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
            console.log('FFmpeg command:', commandLine);
        })
        .on('end', () => {
            console.log('✓ Subtitle extraction successful!');
            
            // Show first few lines of the subtitle file
            if (fs.existsSync(outputPath)) {
                const content = fs.readFileSync(outputPath, 'utf8');
                console.log('\nFirst 500 characters of subtitle:');
                console.log(content.substring(0, 500));
                
                // Clean up test file
                fs.unlinkSync(outputPath);
            }
        })
        .on('error', (err) => {
            console.error('✗ Subtitle extraction failed:', err.message);
        })
        .run();
}); 