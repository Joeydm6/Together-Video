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

function installCameraMock(page) {
    return page.addInitScript(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const context = canvas.getContext('2d');
        let frame = 0;
        const paint = () => {
            if (!context) {
                return;
            }
            context.fillStyle = frame % 2 === 0 ? '#5b2b36' : '#2f4458';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = '#ffeef2';
            context.font = '16px sans-serif';
            context.fillText('Cam', 16, 48);
            frame += 1;
        };
        paint();
        setInterval(paint, 140);
        const baseStream = canvas.captureStream(8);
        if (!navigator.mediaDevices) {
            Object.defineProperty(navigator, 'mediaDevices', {
                configurable: true,
                value: {}
            });
        }
        navigator.mediaDevices.getUserMedia = async () => baseStream.clone();
    });
}

function installDelayedCameraMock(page, delayMs = 180) {
    return page.addInitScript((startupDelay) => {
        window.__tvCameraRequests = 0;
        window.__tvCameraStops = 0;
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const context = canvas.getContext('2d');
        if (context) {
            context.fillStyle = '#35516b';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = '#f7d4de';
            context.font = '16px sans-serif';
            context.fillText('Delayed Cam', 16, 48);
        }
        const baseStream = canvas.captureStream(8);
        const decorateStream = (stream) => {
            for (const track of stream.getTracks()) {
                const originalStop = track.stop.bind(track);
                track.stop = () => {
                    window.__tvCameraStops += 1;
                    return originalStop();
                };
            }
            return stream;
        };
        if (!navigator.mediaDevices) {
            Object.defineProperty(navigator, 'mediaDevices', {
                configurable: true,
                value: {}
            });
        }
        navigator.mediaDevices.getUserMedia = async () => {
            window.__tvCameraRequests += 1;
            await new Promise(resolve => window.setTimeout(resolve, startupDelay));
            return decorateStream(baseStream.clone());
        };
    }, delayMs);
}

test('homepage and player stay usable on mobile-sized screens', { timeout: 120_000 }, async (t) => {
    assert.ok(fs.existsSync(ffmpegPath), `FFmpeg fixture generator not found at ${ffmpegPath}`);
    assert.ok(fs.existsSync(chromePath), `Chrome not found at ${chromePath}`);

    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'togethervideo-responsive-'));
    const mediaRoot = path.join(tempRoot, 'media');
    const cacheRoot = path.join(tempRoot, 'cache');
    const progressPath = path.join(tempRoot, 'progress.json');
    const seasonDir = path.join(mediaRoot, 'Series', 'Pocket Show', 'Season 1');
    const secondSeasonDir = path.join(mediaRoot, 'Series', 'Second Pocket Show', 'Season 1');
    const episodeOne = path.join(seasonDir, 'Pocket Show S01E01 A Long Episode Name For Small Screens.mp4');
    const episodeTwo = path.join(seasonDir, 'Pocket Show S01E02 Another Long Episode Name.mp4');
    const secondShowEpisode = path.join(secondSeasonDir, 'Second Pocket Show S01E01 Another Episode For Grid Coverage.mp4');
    const englishSubtitle = path.join(seasonDir, 'Pocket Show S01E01 A Long Episode Name For Small Screens.en.srt');
    const assSubtitle = path.join(secondSeasonDir, 'Second Pocket Show S01E01 Another Episode For Grid Coverage.en.ass');

    await fsp.mkdir(seasonDir, { recursive: true });
    await fsp.mkdir(secondSeasonDir, { recursive: true });
    await fsp.mkdir(cacheRoot, { recursive: true });
    await fsp.writeFile(progressPath, '{}');
    createFixtureVideo(episodeOne);
    createFixtureVideo(episodeTwo);
    createFixtureVideo(secondShowEpisode);
    await fsp.writeFile(
        englishSubtitle,
        '1\n00:00:00,000 --> 00:00:10,000\nResponsive subtitle check.\n'
    );
    await fsp.writeFile(
        assSubtitle,
        '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,ASS subtitle check.\\NSecond line.\n'
    );

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

    const desktopContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        screen: { width: 1440, height: 900 }
    });
    const desktopPage = await desktopContext.newPage();
    await installMediaMock(desktopPage);

    t.after(async () => {
        await desktopContext.close();
    });

    const mobileContext = await browser.newContext({
        ...devices['iPhone 13']
    });
    const mobilePage = await mobileContext.newPage();
    await installMediaMock(mobilePage);
    await installCameraMock(mobilePage);

    t.after(async () => {
        await mobileContext.close();
    });

    await mobilePage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await mobilePage.waitForSelector('.category-row .card');

    const homepageLayout = await mobilePage.evaluate(() => ({
        scrollFits: document.documentElement.scrollWidth <= window.innerWidth + 2,
        cardCount: document.querySelectorAll('.category-row .card').length,
        fullyVisibleCardsInTwoUpRow: (() => {
            const scroller = Array.from(document.querySelectorAll('.category-row .items-scroller')).find(node => (
                node.querySelectorAll('.card').length >= 2
            ));
            if (!scroller) {
                return 0;
            }
            return Array.from(scroller.querySelectorAll('.card')).filter(card => {
                const rect = card.getBoundingClientRect();
                return rect.left >= -1 && rect.right <= window.innerWidth + 1;
            }).length;
        })(),
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
    assert.ok(homepageLayout.fullyVisibleCardsInTwoUpRow >= 2, 'Homepage no longer keeps two cards visible on small mobile screens');
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
    const joinLayout = await mobilePage.evaluate(() => {
        const menu = document.querySelector('.app-menu')?.getBoundingClientRect();
        const panel = document.querySelector('.join-panel')?.getBoundingClientRect();
        return {
            alignedLeft: !!menu && !!panel && Math.abs(menu.left - panel.left) <= 2,
            alignedRight: !!menu && !!panel && Math.abs(menu.right - panel.right) <= 2,
            bottomGap: !!panel ? Math.max(0, window.innerHeight - panel.bottom) : Number.POSITIVE_INFINITY
        };
    });
    assert.equal(joinLayout.alignedLeft, true, 'Join panel no longer aligns with the mobile menu on the left side');
    assert.equal(joinLayout.alignedRight, true, 'Join panel no longer aligns with the mobile menu on the right side');
    assert.ok(joinLayout.bottomGap <= 56, `Join panel leaves too much empty space below the actions on mobile (${joinLayout.bottomGap}px)`);
    await mobilePage.locator('#join-button').click();
    await mobilePage.waitForFunction(() => document.getElementById('join-button').textContent.includes('Start Watching'));
    await mobilePage.locator('#join-button').click();
    await mobilePage.waitForFunction(() => document.getElementById('join-overlay').style.display === 'none');
    await mobilePage.waitForFunction(() => document.getElementById('video-player').readyState >= 2);
    await mobilePage.waitForFunction(() => document.body.classList.contains('fullscreen-active'));
    await mobilePage.waitForFunction(() => document.getElementById('subtitle-container').textContent.includes('Responsive subtitle check.'));
    const portraitPlayback = await mobilePage.evaluate(() => {
        const gate = document.getElementById('portrait-player-gate');
        const backButton = document.getElementById('fullscreen-back-button');
        const presence = document.getElementById('presence-status');
        const syncBadge = document.getElementById('sync-status-badge');
        return {
            fullscreenActive: document.body.classList.contains('fullscreen-active'),
            gateHidden: gate.hidden || gate.getBoundingClientRect().height === 0,
            noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 2,
            startsUnmuted: document.getElementById('video-player').muted === false,
            pipAllowed: document.getElementById('video-player').disablePictureInPicture === false,
            closeButtonVisible: !!backButton && backButton.getBoundingClientRect().width >= 18 && backButton.getBoundingClientRect().height >= 18,
            presenceHidden: window.getComputedStyle(presence).display === 'none',
            syncBadgeHidden: window.getComputedStyle(syncBadge).display === 'none'
        };
    });

    assert.equal(portraitPlayback.fullscreenActive, true, 'Mobile play did not switch into fullscreen landscape mode');
    assert.equal(portraitPlayback.gateHidden, true, 'Portrait gate should not be shown once playback starts');
    assert.equal(portraitPlayback.noHorizontalOverflow, true, 'Portrait mobile playback overflows horizontally');
    assert.equal(portraitPlayback.startsUnmuted, true, 'Player starts muted on mobile after joining');
    assert.equal(portraitPlayback.pipAllowed, true, 'Video element still disables Picture-in-Picture');
    assert.equal(portraitPlayback.closeButtonVisible, true, 'Fullscreen close button is not visible on mobile');
    assert.equal(portraitPlayback.presenceHidden, true, 'Partner status should be hidden during fullscreen playback');
    assert.equal(portraitPlayback.syncBadgeHidden, true, 'Sync badge should be hidden during fullscreen playback');

    await mobilePage.evaluate(() => document.getElementById('fullscreen-button').click());
    await mobilePage.waitForFunction(() => document.getElementById('join-overlay').style.display !== 'none');
    await mobilePage.waitForFunction(() => document.getElementById('video-player').paused === true);
    await mobilePage.waitForFunction(() => !document.body.classList.contains('portrait-player-gate'));
    await mobilePage.waitForFunction(() => document.getElementById('join-button').textContent.includes('Start Watching'));
    await mobilePage.locator('#join-button').click();
    await mobilePage.waitForFunction(() => document.getElementById('join-overlay').style.display === 'none');
    await mobilePage.waitForFunction(() => document.body.classList.contains('fullscreen-active'));

    await mobilePage.locator('#settings-button').click();
    await mobilePage.locator('#settings-home-playback').click();
    await mobilePage.locator('#webcam-toggle-button').click();
    await mobilePage.waitForFunction(() => {
        const dock = document.getElementById('webcam-dock');
        const localCard = document.getElementById('webcam-local-card');
        const localVideo = document.getElementById('webcam-local-video');
        return dock.classList.contains('is-visible') && !localCard.hidden && Boolean(localVideo.srcObject);
    });
    await mobilePage.waitForFunction(() => document.getElementById('webcam-status-copy').textContent.includes('Camera is live'));
    await mobilePage.locator('#close-settings-button').click();

    await mobilePage.evaluate(() => {
        document.getElementById('click-interceptor').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await mobilePage.waitForFunction(() => !document.getElementById('video-wrapper').classList.contains('ui-visible'));
    const tapHideState = await mobilePage.evaluate(() => ({
        paused: document.getElementById('video-player').paused,
        controlsHidden: !document.getElementById('video-wrapper').classList.contains('ui-visible')
    }));
    assert.equal(tapHideState.paused, false, 'Tapping the fullscreen video should not pause playback');
    assert.equal(tapHideState.controlsHidden, true, 'Tapping the fullscreen video should hide the controls');

    await mobilePage.evaluate(() => {
        document.getElementById('click-interceptor').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await mobilePage.waitForFunction(() => document.getElementById('video-wrapper').classList.contains('ui-visible'));

    const pipCaptionState = await mobilePage.evaluate(async () => {
        const video = document.getElementById('video-player');
        await video.requestPictureInPicture();
        const track = video.textTracks?.[0] || null;
        const firstCue = track?.cues?.[0] || null;
        return {
            pipActive: document.pictureInPictureElement === video,
            trackMode: track?.mode || null,
            cueLine: firstCue?.line ?? null
        };
    });
    assert.equal(pipCaptionState.pipActive, true, 'Picture-in-Picture should activate in the responsive smoke test');
    assert.equal(pipCaptionState.trackMode, 'showing', 'Native subtitle track should be showing in Picture-in-Picture');
    assert.equal(pipCaptionState.cueLine, 65, 'Picture-in-Picture subtitles should use the fixed standard height');

    await mobilePage.evaluate(() => document.exitPictureInPicture());

    await mobilePage.locator('#fullscreen-back-button').click();
    await mobilePage.waitForFunction(() => document.getElementById('join-overlay').style.display !== 'none');
    await mobilePage.waitForFunction(() => !document.body.classList.contains('fullscreen-active'));

    const assVideoParam = encodeURIComponent('Series/Second Pocket Show/Season 1/Second Pocket Show S01E01 Another Episode For Grid Coverage.mp4');
    await mobilePage.goto(`http://127.0.0.1:${port}/player.html?video=${assVideoParam}`, { waitUntil: 'domcontentloaded' });
    await mobilePage.locator('#join-button').click();
    await mobilePage.waitForFunction(() => document.getElementById('join-button').textContent.includes('Start Watching'));
    await mobilePage.locator('#join-button').click();
    await mobilePage.waitForFunction(() => document.getElementById('join-overlay').style.display === 'none');
    await mobilePage.waitForFunction(() => document.getElementById('subtitle-container').textContent.includes('ASS subtitle check.'));
    await mobilePage.waitForFunction(() => document.getElementById('subtitle-container').innerHTML.includes('<br>'));

    await desktopPage.goto(`http://127.0.0.1:${port}/player.html?video=${videoParam}`, { waitUntil: 'domcontentloaded' });
    await desktopPage.waitForFunction(() => document.getElementById('join-button').getBoundingClientRect().height > 0);
    await desktopPage.locator('#join-button').click();
    await desktopPage.waitForFunction(() => document.getElementById('join-button').textContent.includes('Start Watching'));
    await desktopPage.locator('#join-button').click();
    await desktopPage.waitForFunction(() => document.getElementById('join-overlay').style.display === 'none');
    await desktopPage.waitForFunction(() => document.body.classList.contains('fullscreen-active'));
    const desktopFullscreenLayout = await desktopPage.evaluate(() => {
        const backButton = document.getElementById('fullscreen-back-button').getBoundingClientRect();
        const userCount = document.getElementById('user-count-display').getBoundingClientRect();
        const presence = document.getElementById('presence-status');
        const syncBadge = document.getElementById('sync-status-badge');
        return {
            fullscreenActive: document.body.classList.contains('fullscreen-active'),
            presenceHidden: window.getComputedStyle(presence).display === 'none',
            syncHidden: window.getComputedStyle(syncBadge).display === 'none',
            alignedTop: Math.abs(backButton.top - userCount.top) <= 2,
            leftInset: backButton.left >= 16,
            rightInset: (window.innerWidth - userCount.right) >= 16
        };
    });
    assert.equal(desktopFullscreenLayout.fullscreenActive, true, 'Desktop playback did not enter fullscreen or immersive mode');
    assert.equal(desktopFullscreenLayout.presenceHidden, true, 'Partner status should be hidden in desktop fullscreen playback');
    assert.equal(desktopFullscreenLayout.syncHidden, true, 'Sync badge should be hidden in desktop fullscreen playback');
    assert.equal(desktopFullscreenLayout.alignedTop, true, 'Desktop fullscreen back button and viewer badge are vertically misaligned');
    assert.equal(desktopFullscreenLayout.leftInset, true, 'Desktop fullscreen back button sits too close to the left edge');
    assert.equal(desktopFullscreenLayout.rightInset, true, 'Desktop fullscreen viewer badge sits too close to the right edge');

    const tabletContext = await browser.newContext({
        ...devices['iPad Pro 11']
    });
    const tabletPage = await tabletContext.newPage();
    await installMediaMock(tabletPage);
    await tabletPage.route('**/api/video-info?**', async route => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                duration: 30,
                isProblematic: false,
                bitrateKbps: 6800,
                width: 1920,
                height: 1080,
                videoCodec: 'h264',
                audioCodec: 'aac',
                audioTracks: [],
                supportedFormats: ['mp4', 'webm'],
                transcodingAvailable: true
            })
        });
    });

    t.after(async () => {
        await tabletContext.close();
    });

    await tabletPage.goto(`http://127.0.0.1:${port}/player.html?video=${videoParam}`, { waitUntil: 'domcontentloaded' });
    await tabletPage.waitForFunction(() => {
        const select = document.getElementById('playback-mode-select');
        const video = document.getElementById('video-player');
        return select?.value === 'data-saver' && String(video.currentSrc || video.src).includes('mode=data-saver');
    });
    const tabletAutoMode = await tabletPage.evaluate(() => ({
        mode: document.getElementById('playback-mode-select')?.value || '',
        src: String(document.getElementById('video-player').currentSrc || document.getElementById('video-player').src || ''),
        joinMeta: document.getElementById('join-meta-mode')?.textContent?.trim() || ''
    }));
    assert.equal(tabletAutoMode.mode, 'data-saver', 'Tablet did not default to Data Save Mode for heavy media');
    assert.equal(tabletAutoMode.src.includes('mode=data-saver'), true, 'Tablet player did not request a data-saver stream for heavy media');
    assert.equal(tabletAutoMode.joinMeta.includes('Data Save Mode'), true, 'Tablet join state did not reflect the automatic data-saver choice');

    const storageGuardContext = await browser.newContext({
        ...devices['iPhone 13']
    });
    const storageGuardPage = await storageGuardContext.newPage();
    await installMediaMock(storageGuardPage);
    await storageGuardPage.addInitScript(() => {
        const originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function setItem(key, value) {
            if (this === window.localStorage || this === window.sessionStorage) {
                throw new Error('storage blocked');
            }
            return originalSetItem.call(this, key, value);
        };
    });

    t.after(async () => {
        await storageGuardContext.close();
    });

    await storageGuardPage.goto(`http://127.0.0.1:${port}/player.html?video=${videoParam}`, { waitUntil: 'domcontentloaded' });
    await storageGuardPage.waitForFunction(() => {
        const roomCode = document.getElementById('join-room-code')?.textContent || '';
        const title = document.getElementById('join-video-title')?.textContent || '';
        return roomCode.trim() !== '------' && !title.includes('Loading video');
    });
    const storageGuardState = await storageGuardPage.evaluate(() => ({
        roomCode: document.getElementById('join-room-code')?.textContent?.trim() || '',
        title: document.getElementById('join-video-title')?.textContent?.trim() || '',
        meta: document.getElementById('join-meta-mode')?.textContent?.trim() || ''
    }));
    assert.notEqual(storageGuardState.roomCode, '------', 'Player should still create and show a room when storage writes fail');
    assert.notEqual(storageGuardState.title, 'Loading video...', 'Player should still resolve the current video when storage writes fail');

    const autoplayGuardContext = await browser.newContext({
        ...devices['iPhone 13']
    });
    const autoplayGuardPage = await autoplayGuardContext.newPage();
    await installMediaMock(autoplayGuardPage);
    await autoplayGuardPage.addInitScript(() => {
        for (const key of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen', 'mozRequestFullScreen', 'msRequestFullscreen']) {
            Object.defineProperty(Element.prototype, key, {
                configurable: true,
                value: undefined
            });
            Object.defineProperty(HTMLElement.prototype, key, {
                configurable: true,
                value: undefined
            });
        }
        localStorage.setItem('tv-has-interacted', 'true');
        sessionStorage.setItem('hasInteracted', 'true');
    });

    t.after(async () => {
        await autoplayGuardContext.close();
    });

    await autoplayGuardPage.goto(`http://127.0.0.1:${port}/player.html?video=${videoParam}&autoplay=true`, { waitUntil: 'domcontentloaded' });
    await autoplayGuardPage.waitForFunction(() => document.getElementById('video-player').readyState >= 2);
    await delay(1200);
    const autoplayGuardState = await autoplayGuardPage.evaluate(() => {
        const joinVisible = document.getElementById('join-overlay').style.display !== 'none';
        const gateVisible = document.body.classList.contains('portrait-player-gate') && !document.getElementById('portrait-player-gate').hidden;
        return {
            joinVisible,
            gateVisible,
            fullscreenActive: document.body.classList.contains('fullscreen-active') || !!document.fullscreenElement || !!document.webkitFullscreenElement
        };
    });
    assert.equal(autoplayGuardState.fullscreenActive, false, 'Autoplay guard test unexpectedly entered fullscreen');
    assert.equal(autoplayGuardState.joinVisible || autoplayGuardState.gateVisible, true, 'Mobile autoplay should not expose a free portrait player when fullscreen is unavailable');

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
    await landscapePage.waitForFunction(() => document.getElementById('join-button').textContent.includes('Start Watching'));
    await landscapePage.locator('#join-button').click();
    await landscapePage.waitForFunction(() => document.getElementById('join-overlay').style.display === 'none');
    await landscapePage.waitForFunction(() => document.getElementById('video-player').readyState >= 2);
    await landscapePage.waitForFunction(() => document.body.classList.contains('compact-landscape'));
    await landscapePage.waitForFunction(() => document.getElementById('video-player').getBoundingClientRect().height > 180);
    await landscapePage.evaluate(() => document.getElementById('video-wrapper').classList.add('ui-visible'));
    await landscapePage.waitForFunction(() => document.getElementById('player-ui-container').getBoundingClientRect().height > 0);
    await landscapePage.evaluate(() => document.getElementById('settings-button').click());
    await landscapePage.waitForFunction(() => document.body.classList.contains('settings-open'));
    const landscapeSettings = await landscapePage.evaluate(() => {
        const panel = document.getElementById('combined-settings-panel').getBoundingClientRect();
        const playButton = document.getElementById('play-pause-button').getBoundingClientRect();
        return {
            panelFits: panel.left >= 0 && panel.right <= window.innerWidth && panel.bottom <= window.innerHeight,
            playButtonLargeEnough: playButton.width >= 44 && playButton.height >= 44,
            playbackModePresent: !!document.getElementById('playback-mode-select'),
            subtitleStylePresent: !!document.getElementById('subtitle-style-size'),
            pipButtonMissing: !document.getElementById('pip-button')
        };
    });
    assert.equal(landscapeSettings.panelFits, true, 'Landscape settings panel overflows the viewport');
    assert.equal(landscapeSettings.playButtonLargeEnough, true, 'Landscape play button is too small on mobile');
    assert.equal(landscapeSettings.playbackModePresent, true, 'Playback mode selector is missing in landscape');
    assert.equal(landscapeSettings.subtitleStylePresent, true, 'Subtitle style controls are missing in landscape');
    assert.equal(landscapeSettings.pipButtonMissing, true, 'PiP button should not be shown in the mobile player UI');
    await landscapePage.evaluate(() => document.getElementById('close-settings-button').click());
    await landscapePage.waitForFunction(() => !document.body.classList.contains('settings-open'));

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

test('camera startup cleanup does not leave a stale stream behind', { timeout: 90_000 }, async (t) => {
    assert.ok(fs.existsSync(ffmpegPath), `FFmpeg fixture generator not found at ${ffmpegPath}`);
    assert.ok(fs.existsSync(chromePath), `Chrome not found at ${chromePath}`);

    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'togethervideo-camera-race-'));
    const mediaRoot = path.join(tempRoot, 'media');
    const cacheRoot = path.join(tempRoot, 'cache');
    const progressPath = path.join(tempRoot, 'progress.json');
    const seasonDir = path.join(mediaRoot, 'Series', 'Camera Race', 'Season 1');
    const episodeOne = path.join(seasonDir, 'Camera Race S01E01.mp4');

    await fsp.mkdir(seasonDir, { recursive: true });
    await fsp.mkdir(cacheRoot, { recursive: true });
    await fsp.writeFile(progressPath, '{}');
    createFixtureVideo(episodeOne);

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

    const page = await browser.newPage();
    await installDelayedCameraMock(page, 220);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(async () => {
        const module = await import('/js/player/webrtc.js');
        const states = [];
        const toasts = [];
        const emitted = [];
        const socket = {
            connected: true,
            id: 'local-socket',
            emit(event, payload) {
                emitted.push({ event, payload });
            }
        };
        const controller = module.createWebcamController({
            socket,
            onStateChange(state) {
                states.push({
                    busy: state.busy,
                    localEnabled: state.localEnabled,
                    connected: state.connected,
                    statusLabel: state.statusLabel
                });
            },
            onToast(message) {
                toasts.push(message);
            }
        });
        controller.setJoined(true);
        const startPromise = controller.toggleCamera();
        await new Promise(resolve => window.setTimeout(resolve, 40));
        await controller.cleanup();
        const started = await startPromise;
        await new Promise(resolve => window.setTimeout(resolve, 260));
        return {
            started,
            states,
            toasts,
            emitted,
            cameraRequests: window.__tvCameraRequests,
            cameraStops: window.__tvCameraStops
        };
    });

    assert.equal(result.cameraRequests, 1, 'Expected exactly one delayed camera request');
    assert.ok(result.cameraStops >= 1, `Expected delayed camera stream to be stopped after cleanup.\n${JSON.stringify(result, null, 2)}`);
    assert.equal(result.started, false, `Camera start should not complete after cleanup.\n${JSON.stringify(result, null, 2)}`);
    assert.equal(result.states.at(-1)?.localEnabled, false, `Camera controller ended with local camera still enabled.\n${JSON.stringify(result, null, 2)}`);
    assert.equal(result.states.at(-1)?.busy, false, `Camera controller stayed stuck in a busy state.\n${JSON.stringify(result, null, 2)}`);
    assert.ok(
        result.emitted.some(entry => entry.event === 'requestWebcamStateSync'),
        `Joined webcam controller never requested a state sync.\n${JSON.stringify(result, null, 2)}`
    );
});
