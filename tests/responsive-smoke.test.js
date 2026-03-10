const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium, devices } = require('playwright');

const repoRoot = path.join(__dirname, '..');
const ffmpegPath = path.join(repoRoot, 'FFMPEG', 'bin', 'ffmpeg.exe');
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1');
        server.on('listening', () => {
            const address = server.address();
            server.close(() => resolve(address.port));
        });
        server.on('error', reject);
    });
}

function createFixtureVideo(outputPath, durationSeconds = 30) {
    const result = spawnSync(
        ffmpegPath,
        [
            '-y',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', `color=c=black:s=320x240:d=${durationSeconds}`,
            '-f', 'lavfi',
            '-i', 'anullsrc=r=48000:cl=stereo',
            '-shortest',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            outputPath
        ],
        { cwd: repoRoot, encoding: 'utf8' }
    );

    assert.equal(result.status, 0, `Failed to create fixture video: ${result.stderr || result.stdout}`);
}

async function waitForServer(url, timeoutMs = 20_000) {
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
        } catch {
            // Still starting.
        }
        await delay(200);
    }

    throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

function installMediaMock(page) {
    return page.addInitScript(() => {
        const stateSymbol = Symbol('tv-media-state');
        const timerSymbol = Symbol('tv-media-timer');
        let pictureInPictureElement = null;

        const ensureState = (element) => {
            if (!element[stateSymbol]) {
                element[stateSymbol] = {
                    currentTime: 0,
                    duration: 30,
                    paused: true,
                    readyState: 4,
                    volume: 1,
                    muted: false
                };
            }
            return element[stateSymbol];
        };

        const emit = (element, eventName) => {
            element.dispatchEvent(new Event(eventName));
        };

        Object.defineProperties(HTMLMediaElement.prototype, {
            currentTime: {
                configurable: true,
                get() {
                    return ensureState(this).currentTime;
                },
                set(value) {
                    const state = ensureState(this);
                    state.currentTime = Math.max(0, Math.min(Number(value) || 0, state.duration));
                    emit(this, 'timeupdate');
                }
            },
            duration: {
                configurable: true,
                get() {
                    return ensureState(this).duration;
                }
            },
            paused: {
                configurable: true,
                get() {
                    return ensureState(this).paused;
                }
            },
            readyState: {
                configurable: true,
                get() {
                    return ensureState(this).readyState;
                }
            }
        });

        HTMLMediaElement.prototype.load = function load() {
            const state = ensureState(this);
            state.readyState = 4;
            queueMicrotask(() => {
                ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough'].forEach(name => emit(this, name));
            });
        };

        HTMLMediaElement.prototype.play = function play() {
            const state = ensureState(this);
            state.paused = false;
            clearInterval(this[timerSymbol]);
            emit(this, 'play');
            this[timerSymbol] = setInterval(() => {
                if (state.paused) {
                    return;
                }
                state.currentTime = Math.min(state.duration, state.currentTime + 0.25);
                emit(this, 'timeupdate');
            }, 250);
            return Promise.resolve();
        };

        HTMLMediaElement.prototype.pause = function pause() {
            const state = ensureState(this);
            if (state.paused) {
                return;
            }
            state.paused = true;
            clearInterval(this[timerSymbol]);
            emit(this, 'pause');
        };

        HTMLMediaElement.prototype.canPlayType = () => 'probably';
        Object.defineProperty(document, 'pictureInPictureEnabled', {
            configurable: true,
            get: () => true
        });
        Object.defineProperty(document, 'pictureInPictureElement', {
            configurable: true,
            get: () => pictureInPictureElement
        });
        HTMLVideoElement.prototype.requestPictureInPicture = function requestPictureInPicture() {
            pictureInPictureElement = this;
            emit(this, 'enterpictureinpicture');
            return Promise.resolve(this);
        };
        document.exitPictureInPicture = () => {
            const active = pictureInPictureElement;
            pictureInPictureElement = null;
            if (active) {
                emit(active, 'leavepictureinpicture');
            }
            return Promise.resolve();
        };
    });
}

test('homepage and player stay usable on mobile-sized screens', { timeout: 120_000 }, async (t) => {
    assert.ok(fs.existsSync(ffmpegPath), `FFmpeg fixture generator not found at ${ffmpegPath}`);
    assert.ok(fs.existsSync(chromePath), `Chrome not found at ${chromePath}`);

    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'togethervideo-responsive-'));
    const mediaRoot = path.join(tempRoot, 'media');
    const cacheRoot = path.join(tempRoot, 'cache');
    const progressPath = path.join(tempRoot, 'progress.json');
    const seasonDir = path.join(mediaRoot, 'Series', 'Pocket Show', 'Season 1');
    const episodeOne = path.join(seasonDir, 'Pocket Show S01E01 A Long Episode Name For Small Screens.mp4');
    const episodeTwo = path.join(seasonDir, 'Pocket Show S01E02 Another Long Episode Name.mp4');

    await fsp.mkdir(seasonDir, { recursive: true });
    await fsp.mkdir(cacheRoot, { recursive: true });
    await fsp.writeFile(progressPath, '{}');
    createFixtureVideo(episodeOne);
    createFixtureVideo(episodeTwo);

    const port = await getFreePort();
    const serverProcess = spawn(process.execPath, ['server.js'], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PORT: String(port),
            VIDEOS_DIRECTORY: mediaRoot,
            CACHE_DIRECTORY: cacheRoot,
            PROGRESS_FILE_PATH: progressPath,
            TMDB_API_KEY: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const cleanup = async () => {
        if (!serverProcess.killed) {
            serverProcess.kill('SIGTERM');
            await delay(500);
            if (!serverProcess.killed) {
                serverProcess.kill('SIGKILL');
            }
        }
        await fsp.rm(tempRoot, { recursive: true, force: true });
    };

    t.after(cleanup);

    await waitForServer(`http://127.0.0.1:${port}/`);

    const browser = await chromium.launch({
        executablePath: chromePath,
        headless: true
    });

    t.after(async () => {
        await browser.close();
    });

    const mobileContext = await browser.newContext({
        ...devices['iPhone 13']
    });
    const mobilePage = await mobileContext.newPage();
    await installMediaMock(mobilePage);

    t.after(async () => {
        await mobileContext.close();
    });

    await mobilePage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await mobilePage.waitForSelector('.category-row .card');

    const homepageLayout = await mobilePage.evaluate(() => ({
        scrollFits: document.documentElement.scrollWidth <= window.innerWidth + 2,
        cardCount: document.querySelectorAll('.category-row .card').length,
        arrowTouchSize: Array.from(document.querySelectorAll('.scroll-arrow')).every(button => {
            const rect = button.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44;
        }),
        searchVisible: (() => {
            const shell = document.querySelector('.app-menu-search-shell');
            if (!shell) {
                return false;
            }
            const styles = window.getComputedStyle(shell);
            return styles.display !== 'none' && shell.getBoundingClientRect().width > 0;
        })(),
        favoriteVisible: (() => {
            const button = document.querySelector('.favorite-toggle');
            if (!button) {
                return false;
            }
            const styles = window.getComputedStyle(button);
            return styles.opacity !== '0' && button.getBoundingClientRect().width >= 32;
        })()
    }));

    assert.equal(homepageLayout.scrollFits, true, 'Homepage overflows horizontally on mobile');
    assert.ok(homepageLayout.cardCount >= 1, 'Homepage did not render expected cards');
    assert.equal(homepageLayout.arrowTouchSize, true, 'Row arrows are too small for touch input');
    assert.equal(homepageLayout.searchVisible, true, 'Search UI is not visible on mobile homepage');
    assert.equal(homepageLayout.favoriteVisible, true, 'Favorite toggle is not visible on mobile');

    await mobilePage.locator('.favorite-toggle').first().click();
    await mobilePage.waitForFunction(() => document.getElementById('favorites-row').style.display !== 'none');

    await mobilePage.goto(`http://127.0.0.1:${port}/?path=${encodeURIComponent('Series/Pocket Show/Season 1')}`, { waitUntil: 'domcontentloaded' });
    await mobilePage.waitForSelector('#folder-options-button');
    await mobilePage.locator('#folder-options-button').click();
    await mobilePage.waitForSelector('#folder-options-menu [data-action="change-thumbnail"]:not([hidden])');
    await mobilePage.locator('#folder-options-menu [data-action="change-thumbnail"]').click();
    await mobilePage.waitForFunction(() => document.getElementById('thumbnail-picker').style.display === 'flex');
    await mobilePage.waitForFunction(() => document.querySelectorAll('#thumbnail-picker-grid .thumbnail-option').length >= 1);
    await mobilePage.locator('#close-thumbnail-picker').click();

    const videoParam = encodeURIComponent('Series/Pocket Show/Season 1/Pocket Show S01E01 A Long Episode Name For Small Screens.mp4');
    await mobilePage.goto(`http://127.0.0.1:${port}/player.html?video=${videoParam}`, { waitUntil: 'domcontentloaded' });
    await mobilePage.locator('#join-button').click();
    await mobilePage.waitForFunction(() => document.getElementById('video-player').readyState >= 2);
    await mobilePage.evaluate(() => document.getElementById('video-wrapper').classList.add('ui-visible'));
    const videoRect = await mobilePage.locator('#video-player').boundingBox();
    assert.ok(videoRect, 'Video element did not render on mobile');
    await mobilePage.evaluate(() => document.getElementById('video-player').click());
    await mobilePage.waitForFunction(() => !document.getElementById('video-wrapper').classList.contains('ui-visible'));
    await mobilePage.evaluate(() => document.getElementById('video-player').click());
    await mobilePage.waitForFunction(() => document.getElementById('video-wrapper').classList.contains('ui-visible'));
    await mobilePage.evaluate(() => document.getElementById('settings-button').click());
    await mobilePage.evaluate(() => document.getElementById('close-settings-button').click());
    await mobilePage.waitForFunction(() => document.getElementById('combined-settings-panel').style.display !== 'block');
    await mobilePage.evaluate(() => document.getElementById('settings-button').click());

    const playerLayout = await mobilePage.evaluate(() => {
        const panel = document.getElementById('combined-settings-panel').getBoundingClientRect();
        const playButton = document.getElementById('play-pause-button').getBoundingClientRect();
        const statusBadge = document.getElementById('sync-status-badge').getBoundingClientRect();
        const userCount = document.getElementById('user-count-display').getBoundingClientRect();
        const presence = document.getElementById('presence-status').getBoundingClientRect();
        const statusMessage = document.getElementById('status-message').getBoundingClientRect();
        const statusMessageVisible = document.getElementById('status-message').classList.contains('visible');
        const video = document.getElementById('video-player').getBoundingClientRect();
        const controls = document.getElementById('player-ui-container').getBoundingClientRect();
        const isFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
        const settingsOpen = document.body.classList.contains('settings-open');
        return {
            panelFits: panel.left >= 0 && panel.right <= window.innerWidth && panel.bottom <= window.innerHeight,
            playButtonLargeEnough: playButton.width >= 44 && playButton.height >= 44,
            statusVisible: statusBadge.width > 0 && statusBadge.top >= 0,
            statusEmpty: document.getElementById('sync-status-badge').classList.contains('is-empty'),
            noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 2,
            startsUnmuted: document.getElementById('video-player').muted === false,
            playbackModePresent: !!document.getElementById('playback-mode-select'),
            subtitleStylePresent: !!document.getElementById('subtitle-style-size'),
            mobilePlayTogglePresent: !!document.getElementById('mobile-play-toggle'),
            titleVisible: document.getElementById('video-title').getBoundingClientRect().height > 0,
            isFullscreen,
            settingsOpen,
            controlsBelowVideo: isFullscreen || controls.top >= video.bottom - 1,
            syncBadgeBelowVideo: isFullscreen || settingsOpen || statusBadge.top >= video.bottom - 1 || document.getElementById('sync-status-badge').classList.contains('is-empty'),
            userCountBelowVideo: isFullscreen || settingsOpen || userCount.top >= video.bottom - 1,
            presenceBelowVideo: isFullscreen || settingsOpen || presence.top >= video.bottom - 1,
            statusBelowVideo: isFullscreen || settingsOpen || !statusMessageVisible || statusMessage.top >= video.bottom - 1,
            presenceLabel: document.getElementById('presence-status').textContent,
            presenceClickable: document.getElementById('presence-status')?.dataset?.clickable === 'true'
        };
    });

    assert.equal(playerLayout.panelFits, true, 'Settings panel overflows the mobile viewport');
    assert.equal(playerLayout.playButtonLargeEnough, true, 'Play button is too small on mobile');
    assert.equal(playerLayout.statusVisible || playerLayout.statusEmpty, true, 'Sync badge state is invalid on mobile player');
    assert.equal(playerLayout.noHorizontalOverflow, true, 'Player overflows horizontally on mobile');
    assert.equal(playerLayout.startsUnmuted, true, 'Player starts muted on mobile after joining');
    assert.equal(playerLayout.playbackModePresent, true, 'Playback mode selector is missing');
    assert.equal(playerLayout.subtitleStylePresent, true, 'Subtitle style controls are missing');
    assert.equal(playerLayout.mobilePlayTogglePresent, true, 'Mobile center play/pause control is missing');
    assert.equal(playerLayout.titleVisible, true, 'Video title is not visible on mobile');
    assert.equal(playerLayout.controlsBelowVideo, true, 'Mobile controls still overlap the video');
    assert.equal(playerLayout.syncBadgeBelowVideo, true, 'Sync badge still overlaps the video on mobile');
    assert.equal(playerLayout.userCountBelowVideo, true, 'User count still overlaps the video on mobile');
    assert.equal(playerLayout.presenceBelowVideo, true, 'Presence text still overlaps the video on mobile');
    assert.equal(playerLayout.statusBelowVideo, true, 'Status message still overlaps the video on mobile');
    assert.ok(playerLayout.presenceLabel.length > 0, 'Presence label did not render');
    assert.equal(playerLayout.presenceClickable, true, 'Invite badge is not clickable while waiting alone');

    const landscapeContext = await browser.newContext({
        ...devices['iPhone 13'],
        viewport: { width: 844, height: 390 },
        screen: { width: 844, height: 390 }
    });
    const landscapePage = await landscapeContext.newPage();
    await installMediaMock(landscapePage);

    t.after(async () => {
        await landscapeContext.close();
    });

    await landscapePage.goto(`http://127.0.0.1:${port}/player.html?video=${videoParam}`, { waitUntil: 'domcontentloaded' });
    await landscapePage.waitForFunction(() => document.getElementById('join-button').getBoundingClientRect().height > 0);
    await landscapePage.locator('#join-button').click();
    await landscapePage.waitForFunction(() => document.getElementById('video-player').readyState >= 2);
    await landscapePage.waitForFunction(() => document.body.classList.contains('compact-landscape'));
    await landscapePage.waitForFunction(() => document.getElementById('video-player').getBoundingClientRect().height > 180);
    await landscapePage.evaluate(() => document.getElementById('video-wrapper').classList.add('ui-visible'));
    await landscapePage.waitForFunction(() => document.getElementById('player-ui-container').getBoundingClientRect().height > 0);
    await landscapePage.evaluate(() => document.getElementById('fullscreen-button').click());
    await landscapePage.waitForFunction(() => document.body.classList.contains('fullscreen-active') || !!document.fullscreenElement || !!document.webkitFullscreenElement);

    const landscapeLayout = await landscapePage.evaluate(() => {
        const video = document.getElementById('video-player').getBoundingClientRect();
        const controls = document.getElementById('player-ui-container').getBoundingClientRect();
        const joinHidden = document.getElementById('join-overlay').style.display === 'none';
        return {
            joinHidden,
            videoTallEnough: video.height > 180,
            controlsVisible: controls.height > 0,
            mobileShellHidden: window.getComputedStyle(document.getElementById('mobile-player-shell')).display === 'none',
            immersiveLandscape: document.body.classList.contains('compact-landscape') || document.body.classList.contains('fullscreen-active') || !!document.fullscreenElement || !!document.webkitFullscreenElement,
            horizontalOverflowFree: document.documentElement.scrollWidth <= window.innerWidth + 2
        };
    });

    assert.equal(landscapeLayout.joinHidden, true, 'Landscape join overlay did not dismiss');
    assert.equal(landscapeLayout.videoTallEnough, true, 'Landscape video area is too small');
    assert.equal(landscapeLayout.controlsVisible, true, 'Landscape controls are not visible');
    assert.equal(landscapeLayout.mobileShellHidden, true, 'Landscape mobile shell should stay hidden');
    assert.equal(landscapeLayout.immersiveLandscape, true, 'Landscape mode did not enter an immersive player layout');
    assert.equal(landscapeLayout.horizontalOverflowFree, true, 'Landscape player overflows horizontally');
});
