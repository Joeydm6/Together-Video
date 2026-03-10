const fs = require('fs');
const path = require('path');

const videosDirectory = 'E:\\Media';
const videoRelativePath = 'Series/Mobland/Season 1/01. Stick Or Twist.mp4';
const videoFullPath = path.join(videosDirectory, videoRelativePath);
const videoDir = path.dirname(videoFullPath);
const videoBaseName = path.basename(videoFullPath, path.extname(videoFullPath));

console.log(`Checking for subtitles for: ${videoRelativePath}`);
console.log(`Video directory: ${videoDir}`);
console.log(`Video base name: ${videoBaseName}`);

// Check if directory exists
if (!fs.existsSync(videoDir)) {
    console.error('Directory does not exist:', videoDir);
    process.exit(1);
}

// List all files in the directory
console.log('\nAll files in directory:');
const allFiles = fs.readdirSync(videoDir);
allFiles.forEach(file => {
    console.log(`  ${file}`);
});

// Look for external subtitle files
console.log('\nLooking for external subtitle files...');
const subtitleExtensions = ['.srt', '.vtt', '.ass', '.ssa', '.sub'];
const potentialSubtitles = [];

subtitleExtensions.forEach(ext => {
    // Check for exact match
    const exactMatch = `${videoBaseName}${ext}`;
    if (allFiles.includes(exactMatch)) {
        potentialSubtitles.push(exactMatch);
        console.log(`✓ Found: ${exactMatch}`);
    }
    
    // Check for language variations
    const languageVariations = [
        `${videoBaseName}.en${ext}`,
        `${videoBaseName}.eng${ext}`,
        `${videoBaseName}.english${ext}`,
        `${videoBaseName}.nl${ext}`,
        `${videoBaseName}.dutch${ext}`
    ];
    
    languageVariations.forEach(variation => {
        if (allFiles.includes(variation)) {
            potentialSubtitles.push(variation);
            console.log(`✓ Found: ${variation}`);
        }
    });
});

if (potentialSubtitles.length === 0) {
    console.log('✗ No external subtitle files found');
    
    // Check if there are any subtitle files at all
    const anySubtitles = allFiles.filter(file => 
        subtitleExtensions.some(ext => file.toLowerCase().endsWith(ext.toLowerCase()))
    );
    
    if (anySubtitles.length > 0) {
        console.log('\nOther subtitle files in directory:');
        anySubtitles.forEach(file => {
            console.log(`  ${file}`);
        });
    }
} else {
    console.log(`\nFound ${potentialSubtitles.length} potential subtitle file(s)`);
    
    // Check content of first subtitle file
    const firstSubtitle = path.join(videoDir, potentialSubtitles[0]);
    try {
        const content = fs.readFileSync(firstSubtitle, 'utf8');
        console.log(`\nFirst 300 characters of ${potentialSubtitles[0]}:`);
        console.log(content.substring(0, 300));
    } catch (error) {
        console.error(`Error reading ${potentialSubtitles[0]}:`, error.message);
    }
} 